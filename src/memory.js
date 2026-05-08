'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectDirFor } = require('./paths.js');
const { readEvents } = require('./events.js');
const { tokenize, isGenericPrompt } = require('./search.js');

function factDirFor(cwd) {
  return path.join(projectDirFor(cwd), 'facts');
}

function factPathFor(cwd) {
  return path.join(factDirFor(cwd), 'facts.jsonl');
}

function factId(cwd, kind, text) {
  return crypto.createHash('sha1').update(`${cwd}\n${kind}\n${text}`).digest('hex').slice(0, 20);
}

function normalizeText(text, max = 220) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isNoisyFactText(text) {
  return /^\s*\*\*\* Begin Patch/.test(String(text || ''))
    || /\b(apply_patch|Begin Patch|End Patch)\b/.test(String(text || ''))
    || /^snapshot\s+stop-/i.test(String(text || ''))
    || /\b(UserPromptSubmit|PostToolUse|PreToolUse)\s+hook\s+\((completed|blocked|failed)\)/i.test(String(text || ''))
    || /\bhook context:/i.test(String(text || ''));
}

function isTestLikeCommand(command) {
  const cmd = String(command || '').trim();
  return /^(?:npm|pnpm|yarn|npx|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck|tsc)\b/i.test(cmd)
    || /^(?:jest|vitest|mocha|pytest|cargo\s+test|go\s+test|tsc|biome|eslint|prettier)\b/i.test(cmd);
}

function factWeight(kind, text) {
  const t = String(text || '');
  let w = 1;
  if (kind === 'decision') w += 2;
  if (kind === 'error' || kind === 'guard') w += 1.5;
  if (kind === 'test') w += 1;
  if (/\b(fix|decision|decided|use|avoid|error|failed|root cause|deploy|auth|api|database|migration)\b/i.test(t)) w += 1;
  return w;
}

function extractPaths(text) {
  const paths = [];
  const re = /(?:^|\s)((?:\.{0,2}\/)?[\w@./-]+\.(?:js|jsx|ts|tsx|json|md|py|go|rs|css|html|sql|yml|yaml))/g;
  let m;
  while ((m = re.exec(String(text || ''))) && paths.length < 8) paths.push(m[1]);
  return [...new Set(paths)];
}

function factQuality(kind, text) {
  const t = String(text || '');
  let q = 0.4;
  if (kind === 'decision' || kind === 'bug' || kind === 'constraint' || kind === 'workflow') q += 0.35;
  if (/\b(decision|decided|use|avoid|because|root cause|fix|failed|known|must|should|prefer)\b/i.test(t)) q += 0.2;
  if (extractPaths(t).length) q += 0.1;
  if (/^(sed|nl|cat|rg|grep|tail|head)\b/i.test(t)) q -= 0.25;
  if (/bytes=\d+|\d+\s+bytes/i.test(t)) q -= 0.15;
  if (isNoisyFactText(t)) q = 0;
  return Math.max(0, Math.min(1, q));
}

function readFacts(cwd) {
  let raw = '';
  try { raw = fs.readFileSync(factPathFor(cwd), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function writeFacts(cwd, facts, config = {}) {
  const dir = factDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const byId = new Map(readFacts(cwd).map(f => [f.id, f]));
  const threshold = Number(config?.memory?.prune_quality_below || 0.25);
  const maxFacts = Number.isFinite(Number(process.env.CCTX_MAX_FACTS)) && Number(process.env.CCTX_MAX_FACTS) > 0
    ? Number(process.env.CCTX_MAX_FACTS)
    : 1000;
  for (const f of facts) {
    const prior = byId.get(f.id);
    byId.set(f.id, prior ? { ...prior, ...f, seen: Number(prior.seen || 1) + 1 } : f);
  }
  const rows = [...byId.values()]
    .filter(f => !isNoisyFactText(f.text) && Number(f.quality ?? factQuality(f.kind, f.text)) >= threshold)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    .slice(-maxFacts);
  fs.writeFileSync(factPathFor(cwd), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return rows.length;
}

function rememberFact(cwd, text, config = {}, opts = {}) {
  const kind = opts.kind || 'note';
  const clean = normalizeText(text, 500);
  if (!clean) return { ok: false, reason: 'empty fact' };
  const fact = {
    id: factId(cwd, kind, clean),
    cwd,
    kind,
    text: clean,
    paths: extractPaths(clean),
    source: 'manual',
    ts: new Date().toISOString(),
    weight: factWeight(kind, clean) + 1,
    quality: Math.max(0.8, factQuality(kind, clean)),
    seen: 1,
  };
  const total = writeFacts(cwd, [fact], config);
  return { ok: true, fact, total, path: factPathFor(cwd) };
}

function forgetFacts(cwd, query, config = {}, opts = {}) {
  const facts = readFacts(cwd);
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { before: facts.length, after: facts.length, removed: 0, dryRun: Boolean(opts.dryRun) };
  const mode = opts.id ? 'id' : opts.exact ? 'exact' : 'contains';
  const matches = facts.filter(f => {
    const id = String(f.id || '').toLowerCase();
    const text = String(f.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (mode === 'id') return id === needle;
    if (mode === 'exact') return text === needle;
    return text.includes(needle) || id === needle;
  });
  const keep = facts.filter(f => !matches.includes(f));
  if (!opts.dryRun) {
    fs.mkdirSync(factDirFor(cwd), { recursive: true });
    fs.writeFileSync(factPathFor(cwd), keep.map(f => JSON.stringify(f)).join('\n') + (keep.length ? '\n' : ''));
  }
  return {
    before: facts.length,
    after: opts.dryRun ? facts.length : keep.length,
    removed: matches.length,
    dryRun: Boolean(opts.dryRun),
    mode,
    matches: matches.slice(0, Number(opts.limit || 10)).map(f => ({ id: f.id, kind: f.kind, text: f.text })),
  };
}

function eventToFacts(cwd, event, config = {}) {
  const facts = [];
  const ts = event.ts || new Date().toISOString();
  const add = (kind, text, source = event.type) => {
    const clean = normalizeText(text);
    if (isNoisyFactText(clean)) return;
    if (!clean || clean.length < 12) return;
    facts.push({
      id: factId(cwd, kind, clean),
      cwd,
      kind,
      text: clean,
      paths: extractPaths(clean),
      source,
      ts,
      weight: factWeight(kind, clean),
      quality: factQuality(kind, clean),
      seen: 1,
    });
  };

  if (event.type === 'user_prompt_submit' && config?.memory?.passive_prompt_extraction !== false) {
    const prompt = normalizeText(event.prompt, 260);
    if (/(karar|decision|decided|fix|hata|error|root cause|sorun|todo|kaldı|deploy|prod|local|test|auth|api|database|migration|prefer|avoid|must|should)/i.test(prompt)) {
      const kind = /(karar|decision|decided|prefer|avoid|must|should)/i.test(prompt) ? 'decision' : 'prompt';
      add(kind, prompt);
    }
  }
  if (event.type === 'pre_tool_use_decision' && event.decision === 'block') add('guard', event.reason || event.command);
  if (event.type === 'permission_request' && event.decision === 'block') add('guard', event.command);
  if (event.type === 'post_tool_use' && isTestLikeCommand(event.command)) {
    add('test', `command: ${String(event.command).trim()}`);
  }
  if (event.type === 'cache_write' && Number(event.bytes || 0) >= 10000) {
    add('cache', `${event.cache_ref} ${event.bytes} bytes ${event.command || ''}`);
  }
  const cmd = String(event.command || '');
  if (event.type === 'pre_tool_use' || event.type === 'post_tool_use' || event.type === 'cache_write') {
    const curl = cmd.match(/\bcurl\b[^'"\n]*\shttps?:\/\/([^/\s'"]+)(\/[^\s'"]*)?/i);
    if (curl) {
      const host = curl[1];
      const endpoint = (curl[2] || '/').replace(/[?'"].*$/, '');
      const env = /localhost|127\.0\.0\.1/.test(host) ? 'local' : 'remote';
      const kind = endpoint === '/health' ? 'workflow' : 'endpoint';
      add(kind, `${kind}: ${env} ${host}${endpoint} checked with curl`, 'auto_seed');
    }
    if (/\bnpx\s+tsx\s+src\/index\.ts\b/.test(cmd)) add('workflow', 'workflow: backend dev server starts with npx tsx src/index.ts', 'auto_seed');
    if (/\bnpm\s+run\s+dev\b/.test(cmd) && /hakliyim-server|server-dev|src\/index/.test(cmd)) add('workflow', 'workflow: backend dev server uses npm run dev or npx tsx src/index.ts', 'auto_seed');
    if (/\bnpx\s+expo\s+start\b/.test(cmd)) {
      const port = cmd.match(/--port\s+(\d+)/)?.[1];
      add('workflow', `workflow: mobile Expo dev client starts with npx expo start${port ? ` on port ${port}` : ''}`, 'auto_seed');
    }
    const log = cmd.match(/\btail\b[^;&|]*\s(\/tmp\/[\w.-]+\.log)/);
    if (log) add('workflow', `workflow: read runtime logs from ${log[1]}`, 'auto_seed');
    for (const p of extractPaths(cmd)) {
      if (/routes\/([^/]+)\.ts$/.test(p)) add('route', `route file: ${p}`, 'auto_seed');
      if (/screens\/([^/]+Screen)\.tsx$/.test(p)) add('screen', `screen file: ${p}`, 'auto_seed');
    }
  }
  return facts;
}

function retainFacts(cwd, config = {}, opts = {}) {
  if (config?.memory?.enabled === false) return { extracted: 0, total: readFacts(cwd).length };
  const events = readEvents(cwd, { limit: opts.limit || config?.memory?.retain_event_limit || 250 });
  const facts = [];
  const start = Date.now();
  const maxMs = Number(opts.maxMs || config?.memory?.retain_max_ms || 250);
  let scanned = 0;
  let timedOut = false;
  for (let i = events.length - 1; i >= 0; i--) {
    if (Date.now() - start > maxMs) {
      timedOut = true;
      break;
    }
    scanned++;
    facts.push(...eventToFacts(cwd, events[i], config));
  }
  const total = writeFacts(cwd, facts, config);
  return { extracted: facts.length, total, path: factPathFor(cwd), scanned, timed_out: timedOut, duration_ms: Date.now() - start };
}

function scoreFact(queryTokens, fact, config = {}) {
  const bodyTokens = tokenize(fact.text, config);
  if (!queryTokens.length || !bodyTokens.length) return 0;
  const body = new Set(bodyTokens);
  const hits = queryTokens.filter(t => body.has(t)).length;
  const coverage = hits / Math.max(1, queryTokens.length);
  const weight = Number(fact.weight || 1);
  const seenBoost = Math.min(1, Math.log2(Number(fact.seen || 1) + 1) / 4);
  const ageDays = Math.max(0, (Date.now() - Date.parse(fact.ts || 0)) / 86400000);
  const halfLife = Number(config?.memory?.recency_half_life_days || 45);
  const recency = Math.pow(0.5, ageDays / Math.max(1, halfLife));
  const quality = Number(fact.quality ?? factQuality(fact.kind, fact.text));
  return ((coverage * 4 + hits * 0.25 + seenBoost) * weight * Math.max(0.1, quality)) + 0.1 * recency;
}

function recallFacts(cwd, query, config = {}, opts = {}) {
  const tokens = tokenize(query, config);
  const normalized = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const configuredGeneric = (config?.retrieval?.generic_prompts || []).map(s => String(s).toLowerCase());
  if (!tokens.length || configuredGeneric.includes(normalized) || (tokens.length < 2 && isGenericPrompt(query, config))) return [];
  const queryText = String(query || '');
  const wantsCache = /\b(cache|cached|ref|output|çıktı|log)\b/i.test(queryText);
  const minScore = Number(opts.minScore || config?.memory?.min_score || 0.6);
  const limit = Number(opts.limit || config?.memory?.top_n || 5);
  const activePaths = new Set((opts.paths || []).map(String));
  return readFacts(cwd)
    .filter(f => f.kind !== 'cache' || wantsCache)
    .map(f => {
      const pathBoost = (f.paths || []).some(p => activePaths.has(p)) ? Number(config?.memory?.path_boost || 1.5) : 0;
      return { ...f, score: scoreFact(tokens, f, config) + pathBoost };
    })
    .filter(f => f.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildRecall(cwd, query, config = {}, opts = {}) {
  const facts = recallFacts(cwd, query, config, opts);
  if (opts.json) return JSON.stringify(facts, null, 2);
  if (!facts.length) return 'no memory facts matched';
  return facts.map((f, i) => `#${i + 1} score=${f.score.toFixed(2)} ${f.kind} ${f.ts}\n${f.text}`).join('\n\n');
}

function buildNudge(cwd, query, config = {}) {
  const facts = recallFacts(cwd, query, config, { limit: 3 });
  if (!facts.length) return null;
  return `[codex-ctx] ${facts.length} relevant memory facts available. Use codex_ctx_memory_recall if needed.`;
}

function auditFacts(cwd, config = {}, opts = {}) {
  const threshold = Number(config?.memory?.prune_quality_below || 0.25);
  const staleDays = Number(opts.staleDays || config?.memory?.stale_days || 90);
  const facts = readFacts(cwd).map(f => ({
    ...f,
    quality: Number(f.quality ?? factQuality(f.kind, f.text)),
    noisy: isNoisyFactText(f.text),
  }));
  const lowQuality = facts.filter(f => f.noisy || f.quality < threshold);
  const secretRisk = facts.filter(f => /sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}|(?:bearer|password|api[_-]?key|secret_key|client_secret)\s*[:=]\s*['"]?[A-Za-z0-9._=\-+/]{12,}/i.test(f.text));
  const byText = new Map();
  for (const f of facts) {
    const key = String(f.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(f);
  }
  const duplicates = [...byText.values()].filter(group => group.length > 1);
  const staleCutoff = Date.now() - staleDays * 86400000;
  const stale = facts.filter(f => Date.parse(f.ts || 0) > 0 && Date.parse(f.ts || 0) < staleCutoff);
  const conversationResidue = facts.filter(f => {
    const t = String(f.text || '');
    return /\b(testler\s+yeşil|tüm\s+testler|ship-ready|önceki\s+bulgu|önceki\s+review|düzeltildi|review'a\s+göre)\b/i.test(t)
      || /^[⏺#]\s/.test(t);
  });
  const highSeenLowQuality = facts.filter(f => Number(f.seen || 0) >= 3 && (f.noisy || f.quality < Math.max(threshold, 0.45)));
  const out = {
    total: facts.length,
    low_quality: lowQuality.length,
    secret_risk: secretRisk.length,
    duplicate_groups: duplicates.length,
    stale: stale.length,
    conversation_residue: conversationResidue.length,
    high_seen_low_quality: highSeenLowQuality.length,
    low_quality_examples: lowQuality.slice(0, Number(opts.limit || 10)).map(f => ({ id: f.id, kind: f.kind, quality: f.quality, text: f.text })),
    duplicate_examples: duplicates.slice(0, Number(opts.limit || 10)).map(group => ({ count: group.length, ids: group.map(f => f.id), text: group[0].text })),
    conversation_residue_examples: conversationResidue.slice(0, Number(opts.limit || 10)).map(f => ({ id: f.id, kind: f.kind, text: f.text })),
  };
  if (opts.json) return JSON.stringify(out, null, 2);
  return [
    '# Codex Ctx Memory Audit',
    '',
    `total: ${out.total}`,
    `low_quality: ${out.low_quality}`,
    `secret_risk: ${out.secret_risk}`,
    `duplicate_groups: ${out.duplicate_groups}`,
    `stale: ${out.stale}`,
    `conversation_residue: ${out.conversation_residue}`,
    `high_seen_low_quality: ${out.high_seen_low_quality}`,
    '',
    '## Low Quality Examples',
    out.low_quality_examples.map(f => `- ${f.quality.toFixed(2)} ${f.kind} ${f.text}`).join('\n') || '- (none)',
    '',
    '## Duplicate Examples',
    out.duplicate_examples.map(f => `- x${f.count} ${f.text}`).join('\n') || '- (none)',
    '',
    '## Conversation Residue Examples',
    out.conversation_residue_examples.map(f => `- ${f.kind} ${f.text}`).join('\n') || '- (none)',
  ].join('\n');
}

function pruneFacts(cwd, config = {}, opts = {}) {
  const threshold = Number(opts.qualityBelow || config?.memory?.prune_quality_below || 0.25);
  const facts = readFacts(cwd);
  const keep = facts.filter(f => !isNoisyFactText(f.text) && Number(f.quality ?? factQuality(f.kind, f.text)) >= threshold);
  if (!opts.dryRun) {
    fs.mkdirSync(factDirFor(cwd), { recursive: true });
    fs.writeFileSync(factPathFor(cwd), keep.map(f => JSON.stringify(f)).join('\n') + (keep.length ? '\n' : ''));
  }
  return { dryRun: Boolean(opts.dryRun), before: facts.length, after: keep.length, removed: facts.length - keep.length, quality_below: threshold };
}

module.exports = {
  factDirFor,
  factPathFor,
  readFacts,
  writeFacts,
  rememberFact,
  forgetFacts,
  retainFacts,
  recallFacts,
  buildRecall,
  buildNudge,
  auditFacts,
  pruneFacts,
  isTestLikeCommand,
};
