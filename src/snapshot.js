'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { memoryDirFor } = require('./paths.js');
const { latestSession } = require('./codex_history.js');
const { estimateTokens, detectLevel } = require('./token.js');
const { summarizeEvents } = require('./events.js');

function slugify(s) {
  return String(s || 'snapshot')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'snapshot';
}

function summarizeSession(session, config = {}) {
  const items = session?.items || [];
  const text = items.map(i => i.text).join('\n');
  const tokens = estimateTokens(text, config);
  const decision = detectLevel(tokens, config);
  return {
    session_id: session?.session_id || '-',
    first_ts: session?.first_ts || 0,
    last_ts: session?.last_ts || 0,
    prompt_count: items.length,
    text,
    tokens,
    decision,
    recent_prompts: items.slice(-12).map(i => i.text),
  };
}

function listLines(items, map = x => x, empty = '- (none)') {
  const lines = (items || []).filter(Boolean).map(map).filter(Boolean);
  return lines.length ? lines.join('\n') : empty;
}

function isMechanicalName(name) {
  return /^(stop-(events-\d+|no-snapshot|stale|watch|compact|urgent|critical)|checkpoint|snapshot)$/i.test(String(name || '').trim());
}

function isWeakPrompt(prompt) {
  return /^(devam|continue|tamam|ok|peki|başka ne kaldı|ne kaldı|yap|sıradan devam et)$/i.test(String(prompt || '').trim());
}

function snapshotTitle(summary, eventSummary = {}, requestedName = null) {
  if (requestedName && !isMechanicalName(requestedName)) return requestedName;
  const prompt = [...(summary.recent_prompts || [])]
    .reverse()
    .map(p => String(p || '').replace(/\s+/g, ' ').trim())
    .find(p => p.length >= 10 && !isWeakPrompt(p));
  if (prompt) return prompt.slice(0, 80);

  const touched = [...(eventSummary.files || [])].reverse().find(Boolean);
  if (touched) return `work on ${path.basename(String(touched))}`;

  const command = [...(eventSummary.commands || [])]
    .reverse()
    .map(c => String(c || '').trim())
    .find(c => c && !/^(git status|pwd|ls\b)/.test(c));
  if (command) return command.replace(/\s+/g, ' ').slice(0, 80);

  return requestedName || 'codex snapshot';
}

function buildMarkdown(summary, opts = {}) {
  const created = new Date().toISOString();
  const title = snapshotTitle(summary, opts.eventSummary || {}, opts.name);
  const fp = crypto.createHash('sha256').update(summary.text).digest('hex').slice(0, 16);
  const prompts = summary.recent_prompts.map(p => `- ${p.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const eventSummary = opts.eventSummary || {};
  const cacheRefs = listLines(eventSummary.cacheRefs, c => `- ${c.ref} ${c.bytes || 0} bytes ${c.tool || '-'} ${String(c.command || '').slice(0, 120)}`);
  const decisions = listLines(eventSummary.decisions, d => `- ${String(d).replace(/\s+/g, ' ').slice(0, 240)}`);
  const commands = listLines(eventSummary.commands, c => `- \`${String(c).replace(/`/g, '\\`').slice(0, 180)}\``);
  const files = listLines(eventSummary.files, f => `- ${String(f).slice(0, 220)}`);
  const blocked = listLines(eventSummary.blocked, e => `- ${e.ts || '-'} ${e.type || '-'} ${String(e.reason || e.command || '').replace(/\s+/g, ' ').slice(0, 220)}`);
  const failedAttempts = listLines((eventSummary.events || []).filter(e => e.failed || /error|failed|exception/i.test(`${e.reason || ''} ${e.command || ''}`)).slice(-12), e => `- ${e.ts || '-'} ${String(e.command || e.reason || '').replace(/\s+/g, ' ').slice(0, 220)}`);
  const openProblems = listLines((eventSummary.decisions || []).filter(d => /\b(todo|next|kaldı|open|problem|sorun|issue|blocked)\b/i.test(String(d))).slice(-10), d => `- ${String(d).replace(/\s+/g, ' ').slice(0, 220)}`);
  const importantCommands = listLines((eventSummary.events || []).filter(e => e.command && (e.failed || e.cache_ref || Number(e.duration_ms || 0) > 5000 || /\b(test|build|deploy|migration|commit|push)\b/i.test(e.command))).slice(-14), e => `- ${e.ts || '-'} \`${String(e.command || '').replace(/`/g, '\\`').slice(0, 180)}\`${e.duration_ms ? ` (${e.duration_ms}ms)` : ''}`);
  const nextSteps = listLines(summary.recent_prompts.filter(p => /\b(next|todo|kaldı|devam|yap|fix|düzelt|implement)\b/i.test(String(p))).slice(-6), p => `- ${String(p).replace(/\s+/g, ' ').slice(0, 220)}`);
  const recentEvents = listLines((eventSummary.events || []).slice(-25), e => {
    const parts = [e.ts, e.type, e.tool_name, e.command || e.prompt || e.reason].filter(Boolean);
    return `- ${parts.join(' | ').replace(/\s+/g, ' ').slice(0, 240)}`;
  });
  return `---\ncreated: ${created}\nsession_id: ${summary.session_id}\nfingerprint: ${fp}\nprompt_count: ${summary.prompt_count}\ntokens_est: ${summary.tokens}\nlevel: ${summary.decision.level}\n---\n\n# ${title}\n\n## Context\n\n- Estimated tokens: ${summary.tokens}\n- Context level: ${summary.decision.level}\n- Session: ${summary.session_id}\n- Event count: ${(eventSummary.events || []).length}\n\n## Decisions\n\n${decisions}\n\n## Open Problems\n\n${openProblems}\n\n## Failed Attempts\n\n${failedAttempts}\n\n## Next Steps\n\n${nextSteps}\n\n## Changed Files\n\n${files}\n\n## Important Commands\n\n${importantCommands}\n\n## Commands\n\n${commands}\n\n## Blocked Or Guarded Actions\n\n${blocked}\n\n## Cache References\n\n${cacheRefs}\n\n## Recent Prompts\n\n${prompts || '- (none)'}\n\n## Recent Events\n\n${recentEvents}\n\n## Raw Prompt Text\n\n\`\`\`text\n${summary.text.slice(-12000)}\n\`\`\`\n`;
}

function rewriteIndex(memoryDir) {
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch {}
  for (const n of names.filter(n => n.endsWith('.md') && n !== 'MEMORY.md').sort().reverse()) {
    rows.push(`- [${n}](./${n})`);
  }
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `# Codex Ctx Memory\n\n${rows.join('\n')}\n`);
}

function writeSnapshot(cwd, config = {}, opts = {}) {
  const session = opts.session || latestSession(config?.snapshot?.history_limit || 80);
  if (!session) return null;
  const summary = summarizeSession(session, config);
  const memoryDir = memoryDirFor(cwd, config);
  fs.mkdirSync(memoryDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const eventSummary = summarizeEvents(cwd, config, { limit: config?.events?.snapshot_limit || 250 });
  const inferredName = snapshotTitle(summary, eventSummary, opts.name);
  const finalName = opts.name && !isMechanicalName(opts.name) ? opts.name : inferredName;
  const finalPath = path.join(memoryDir, `${stamp}-${slugify(finalName)}.md`);
  fs.writeFileSync(finalPath, buildMarkdown(summary, { ...opts, name: finalName, eventSummary }));
  rewriteIndex(memoryDir);
  return { outPath: finalPath, summary };
}

function latestSnapshot(cwd, config = {}) {
  const memoryDir = memoryDirFor(cwd, config);
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch { return null; }
  const files = names
    .filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    .map(n => {
      const full = path.join(memoryDir, n);
      return { path: full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] || null;
}

module.exports = {
  slugify,
  summarizeSession,
  snapshotTitle,
  buildMarkdown,
  writeSnapshot,
  latestSnapshot,
};
