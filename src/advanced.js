'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const { loadHistory, groupBySession, HISTORY_PATH } = require('./codex_history.js');
const { APP_HOME, HOOK_LOG, memoryDirFor, projectDirFor } = require('./paths.js');
const { listSnapshots, searchSnapshots, tokenize } = require('./search.js');
const { latestSnapshot, writeSnapshot } = require('./snapshot.js');
const { readEvents, eventPathFor, parseEventsText } = require('./events.js');
const { estimateTokens, detectLevel } = require('./token.js');
const { CACHE_DIR, maybeCached } = require('./cache.js');
const memory = require('./memory.js');

function fmtBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isoFromTs(ts) {
  const ms = Number(ts || 0) * 1000;
  return ms > 0 ? new Date(ms).toISOString() : '-';
}

function safeRead(filePath, fallback = '') {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return fallback; }
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          out.push({ path: full, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
  }
  return out;
}

function historyStats(config = {}) {
  const rows = loadHistory(Number(config?.analysis?.history_limit || 1000));
  const sessions = groupBySession(rows);
  const text = rows.map(r => r.text).join('\n');
  const tokens = estimateTokens(text, config);
  const metric = detectLevel(tokens, config);
  const days = new Set(rows.map(r => isoFromTs(r.ts).slice(0, 10)).filter(Boolean));
  const words = tokenize(text, config).filter(w => w.length > 2);
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const topTerms = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  return { rows, sessions, tokens, metric, activeDays: days.size, topTerms };
}

function snapshotStats(cwd, config = {}) {
  const snapshots = listSnapshots(memoryDirFor(cwd, config));
  const bytes = snapshots.reduce((sum, s) => sum + Buffer.byteLength(s.body || ''), 0);
  return { snapshots, bytes, latest: snapshots[0] || null };
}

function cacheStats() {
  const files = walkFiles(CACHE_DIR).sort((a, b) => b.size - a.size);
  return {
    files,
    bytes: files.reduce((sum, f) => sum + f.size, 0),
  };
}

function buildReport(cwd, config = {}) {
  const h = historyStats(config);
  const s = snapshotStats(cwd, config);
  const c = cacheStats();
  const latestSession = h.sessions[0];
  const lines = [
    '# Codex Ctx Report',
    '',
    `project: ${cwd}`,
    `history: ${HISTORY_PATH}`,
    `prompts: ${h.rows.length}`,
    `sessions: ${h.sessions.length}`,
    `active_days: ${h.activeDays}`,
    `estimated_tokens: ${h.tokens}/${h.metric.ceiling} (${Math.round(h.metric.pct * 100)}%)`,
    `level: ${h.metric.level}`,
    `snapshots: ${s.snapshots.length} (${fmtBytes(s.bytes)})`,
    `cache: ${c.files.length} files (${fmtBytes(c.bytes)})`,
    `latest_session: ${latestSession ? `${latestSession.session_id} ${isoFromTs(latestSession.last_ts)}` : '(none)'}`,
    `latest_snapshot: ${s.latest ? s.latest.path : '(none)'}`,
    '',
    '## Top Terms',
    h.topTerms.length ? h.topTerms.slice(0, 12).map(([w, n]) => `- ${w}: ${n}`).join('\n') : '- (none)',
    '',
    '## Recent Sessions',
    h.sessions.slice(0, 8).map(sess => `- ${isoFromTs(sess.last_ts)} ${sess.session_id} prompts=${sess.items.length}`).join('\n') || '- (none)',
  ];
  return lines.join('\n');
}

function buildTimeline(cwd, config = {}, opts = {}) {
  const h = historyStats(config);
  const snaps = snapshotStats(cwd, config).snapshots;
  const items = [];
  for (const s of h.sessions) {
    items.push({
      type: 'session',
      ts: s.last_ts * 1000,
      id: s.session_id,
      count: s.items.length,
      preview: s.items.at(-1)?.text || '',
    });
  }
  for (const snap of snaps) {
    items.push({
      type: 'snapshot',
      ts: snap.mtime,
      id: snap.name,
      count: Buffer.byteLength(snap.body || ''),
      preview: snap.body.split('\n').find(line => line.startsWith('# ')) || snap.name,
    });
  }
  items.sort((a, b) => b.ts - a.ts);
  if (opts.json) return JSON.stringify(items, null, 2);
  return items.slice(0, opts.limit || 40).map(item => {
    const stamp = item.ts ? new Date(item.ts).toISOString() : '-';
    const count = item.type === 'session' ? `prompts=${item.count}` : `bytes=${item.count}`;
    return `${stamp}  ${item.type.padEnd(8)}  ${count.padEnd(12)}  ${item.id}\n  ${String(item.preview).replace(/\s+/g, ' ').slice(0, 180)}`;
  }).join('\n') || 'no timeline items';
}

function buildMetrics(cwd, config = {}) {
  const h = historyStats(config);
  const s = snapshotStats(cwd, config);
  const c = cacheStats();
  const events = readEvents(cwd, { limit: config?.events?.snapshot_limit || 250 });
  return {
    project: cwd,
    prompts: h.rows.length,
    sessions: h.sessions.length,
    active_days: h.activeDays,
    estimated_tokens: h.tokens,
    quality_ceiling: h.metric.ceiling,
    context_pct: h.metric.pct,
    level: h.metric.level,
    snapshots: s.snapshots.length,
    snapshot_bytes: s.bytes,
    cache_files: c.files.length,
    cache_bytes: c.bytes,
    events: events.length,
    events_path: eventPathFor(cwd),
    latest_snapshot: s.latest?.path || null,
    top_terms: h.topTerms.slice(0, 20).map(([term, count]) => ({ term, count })),
  };
}

function buildHeavy(cwd, config = {}, opts = {}) {
  const snapshotFiles = snapshotStats(cwd, config).snapshots.map(s => ({
    path: s.path,
    size: Buffer.byteLength(s.body || ''),
    kind: 'snapshot',
  }));
  const cacheFiles = cacheStats().files.map(f => ({ ...f, kind: 'cache' }));
  const files = [...snapshotFiles, ...cacheFiles].sort((a, b) => b.size - a.size).slice(0, opts.limit || 20);
  if (!files.length) return 'no heavy files';
  return files.map(f => `${fmtBytes(f.size).padStart(9)}  ${f.kind.padEnd(8)}  ${f.path}`).join('\n');
}

function buildBloat(cwd, config = {}) {
  const metrics = buildMetrics(cwd, config);
  const hookLogBytes = Buffer.byteLength(safeRead(HOOK_LOG));
  const warnings = [];
  if (metrics.level !== 'comfortable') warnings.push(`context level is ${metrics.level}`);
  if (metrics.cache_bytes > 20 * 1024 * 1024) warnings.push(`cache is ${fmtBytes(metrics.cache_bytes)}`);
  if (metrics.snapshot_bytes > 10 * 1024 * 1024) warnings.push(`snapshots are ${fmtBytes(metrics.snapshot_bytes)}`);
  if (hookLogBytes > 5 * 1024 * 1024) warnings.push(`hook log is ${fmtBytes(hookLogBytes)}`);
  return [
    `context: ${metrics.level} (${Math.round(metrics.context_pct * 100)}%)`,
    `snapshots: ${metrics.snapshots} (${fmtBytes(metrics.snapshot_bytes)})`,
    `cache: ${metrics.cache_files} (${fmtBytes(metrics.cache_bytes)})`,
    `hook_log: ${fmtBytes(hookLogBytes)}`,
    '',
    warnings.length ? warnings.map(w => `warning: ${w}`).join('\n') : 'no obvious bloat',
  ].join('\n');
}

function buildStatusline(cwd, config = {}) {
  const metrics = buildMetrics(cwd, config);
  const pct = Math.round(metrics.context_pct * 100);
  const latest = metrics.latest_snapshot ? path.basename(metrics.latest_snapshot) : 'no-snapshot';
  const icon = metrics.level === 'critical' ? 'CRIT'
    : metrics.level === 'urgent' ? 'URG'
    : metrics.level === 'compact' ? 'CMP'
    : metrics.level === 'watch' ? 'WATCH'
    : 'OK';
  return `cctx ${icon} ${pct}% prompts=${metrics.prompts} events=${metrics.events} snapshots=${metrics.snapshots} cache=${fmtBytes(metrics.cache_bytes)} latest=${latest}`;
}

function buildEvents(cwd, config = {}, opts = {}) {
  const rows = readEvents(cwd, { limit: opts.limit || 50 });
  if (opts.json) return JSON.stringify(rows, null, 2);
  return rows.map(e => {
    const detail = e.command || e.prompt || e.reason || e.snapshot_path || e.cache_ref || '';
    return `${e.ts || '-'}  ${String(e.type || '-').padEnd(22)}  ${String(e.tool_name || '').padEnd(10)} ${String(detail).replace(/\s+/g, ' ').slice(0, 180)}`;
  }).join('\n') || 'no events';
}

function prune(cwd, config = {}, opts = {}) {
  const days = Number(opts.days || config?.prune?.older_than_days || 30);
  const dryRun = opts.dryRun !== false;
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const targets = [
    ...cacheStats().files,
    ...snapshotStats(cwd, config).snapshots.map(s => ({ path: s.path, mtime: s.mtime, size: Buffer.byteLength(s.body || '') })),
  ].filter(f => f.mtime < cutoff);
  let removed = 0;
  let bytes = 0;
  for (const t of targets) {
    bytes += t.size || 0;
    if (!dryRun) {
      try { fs.unlinkSync(t.path); removed++; } catch {}
    }
  }
  return { dryRun, days, matched: targets.length, removed: dryRun ? 0 : removed, bytes, files: targets.map(t => t.path) };
}

function backupHistory(cwd, config = {}, opts = {}) {
  const dir = path.join(projectDirFor(cwd), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(dir, `${stamp}-history.jsonl.gz`);
  const raw = safeRead(HISTORY_PATH);
  if (!raw) return null;
  fs.writeFileSync(outPath, zlib.gzipSync(raw));
  if (opts.snapshot) writeSnapshot(cwd, config, { name: 'backup' });
  return { outPath, bytes: fs.statSync(outPath).size };
}

function listBackups(cwd) {
  const dir = path.join(projectDirFor(cwd), 'backups');
  return walkFiles(dir).filter(f => f.path.endsWith('.gz')).sort((a, b) => b.mtime - a.mtime);
}

function diffLatestSnapshots(cwd, config = {}) {
  const snaps = snapshotStats(cwd, config).snapshots.slice(0, 2);
  if (snaps.length < 2) return 'need at least two snapshots';
  const [a, b] = snaps;
  const sectionsA = markdownSections(a.body);
  const sectionsB = markdownSections(b.body);
  const sectionNames = [...new Set([...Object.keys(sectionsA), ...Object.keys(sectionsB)])]
    .filter(name => /^(Decisions|Open Problems|Failed Attempts|Next Steps|Changed Files|Important Commands|Cache References)$/i.test(name));
  const sectionDiffs = sectionNames.map(name => {
    const aLines = new Set((sectionsA[name] || []).map(x => x.trim()).filter(Boolean));
    const bLines = new Set((sectionsB[name] || []).map(x => x.trim()).filter(Boolean));
    const added = [...aLines].filter(x => !bLines.has(x)).slice(0, 20);
    const removed = [...bLines].filter(x => !aLines.has(x)).slice(0, 20);
    if (!added.length && !removed.length) return null;
    return [`## ${name}`, ...added.map(x => `+ ${x}`), ...removed.map(x => `- ${x}`)].join('\n');
  }).filter(Boolean);
  return [
    `new: ${a.path}`,
    `old: ${b.path}`,
    '',
    sectionDiffs.join('\n\n') || '(no section changes)',
  ].join('\n');
}

function markdownSections(body) {
  const out = {};
  let current = 'Preamble';
  out[current] = [];
  for (const line of String(body || '').split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      current = m[1];
      out[current] = out[current] || [];
      continue;
    }
    out[current].push(line);
  }
  return out;
}

function sinceCutoff(since) {
  const raw = String(since || '').trim();
  if (!raw) return 0;
  const rel = raw.match(/^(\d+)(min|mo|[hdwm])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = (unit === 'm' || unit === 'min') ? 60000
      : unit === 'h' ? 3600000
      : unit === 'd' ? 86400000
      : unit === 'w' ? 7 * 86400000
      : 30 * 86400000;
    return Date.now() - n * ms;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readProjectFile(filePath, config = {}) {
  return maybeCached(fs.readFileSync(filePath, 'utf8'), config);
}

function writeNote(cwd, text) {
  const dir = path.join(projectDirFor(cwd), 'notes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'NOTES.md');
  fs.appendFileSync(file, `\n- ${new Date().toISOString()} ${String(text || '').trim()}\n`);
  return file;
}

function readNotes(cwd) {
  return safeRead(path.join(projectDirFor(cwd), 'notes', 'NOTES.md'), '(no notes)');
}

function parseHookSavings(config = {}) {
  const log = safeRead(HOOK_LOG);
  const charsPerToken = Number(config?.limits?.chars_per_token || 4);
  const summaryBytes = Number(config?.cache?.summary_bytes || 900);
  const cached = [...log.matchAll(/post_tool cached ref=([a-f0-9]+) bytes=(\d+)/g)]
    .map(m => ({ ref: m[1], bytes: Number(m[2]) || 0 }));
  const cachedBytes = cached.reduce((sum, c) => sum + c.bytes, 0);
  const replacementBytes = cached.reduce((sum, c) => sum + Math.min(c.bytes, summaryBytes) + 180, 0);
  const grossTokensAvoided = Math.ceil(cachedBytes / charsPerToken);
  const replacementTokens = Math.ceil(replacementBytes / charsPerToken);
  const optimisticCacheSavedTokens = Math.max(0, grossTokensAvoided - replacementTokens);

  const snapshotByBase = new Map();
  const projectsDir = path.join(APP_HOME, 'projects');
  for (const file of walkFiles(projectsDir)) {
    if (file.path.endsWith('.md') && !file.path.endsWith('MEMORY.md')) snapshotByBase.set(path.basename(file.path), file.path);
  }
  let recallBytes = 0;
  let recallCount = 0;
  for (const m of log.matchAll(/auto_retrieve score=[0-9.]+ file="([^"]+)"/g)) {
    recallCount++;
    const file = snapshotByBase.get(m[1]);
    if (!file) {
      recallBytes += Number(config?.savings?.missing_recall_bytes || 1200);
      continue;
    }
    const preview = safeRead(file).split('\n').slice(0, 42).join('\n');
    recallBytes += Buffer.byteLength(`[codex-ctx] Relevant project memory from ${m[1]}:\n\n${preview}`);
  }
  let sessionBytes = 0;
  let sessionCount = 0;
  for (const m of log.matchAll(/session_start restored="([^"]+)" bytes=(\d+)/g)) {
    sessionCount++;
    sessionBytes += Number(m[2]) || 0;
  }
  const memoryOverheadTokens = Math.ceil((recallBytes + sessionBytes) / charsPerToken);
  const preToolBlocks = (log.match(/pre_tool (?:block|duplicate_bash)/g) || []).length;
  const averageSavedPerBlockedRepeat = cached.length ? Math.ceil(optimisticCacheSavedTokens / cached.length) : 0;
  const realisticCacheSavedTokens = Math.min(
    optimisticCacheSavedTokens,
    preToolBlocks * averageSavedPerBlockedRepeat,
  );
  const snapshots = (log.match(/snapshot file|post_tool snapshot/g) || []).length;
  return {
    cached_outputs: cached.length,
    cached_bytes: cachedBytes,
    gross_tokens_avoided: grossTokensAvoided,
    replacement_tokens: replacementTokens,
    cache_saved_tokens: realisticCacheSavedTokens,
    cache_saved_tokens_optimistic: optimisticCacheSavedTokens,
    cache_saved_tokens_realistic: realisticCacheSavedTokens,
    estimated_cache_saved_tokens: realisticCacheSavedTokens,
    savings_mode: 'blocked_repeat_realistic',
    auto_retrieve_count: recallCount,
    session_restore_count: sessionCount,
    memory_overhead_tokens: memoryOverheadTokens,
    net_saved_tokens: realisticCacheSavedTokens - memoryOverheadTokens,
    pre_tool_blocks: preToolBlocks,
    snapshots,
    largest_cached: cached.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
  };
}

function cacheSavingsByCommand(cached, summaryBytes, charsPerToken) {
  const byCommand = new Map();
  for (const item of cached) {
    const gross = Math.ceil(item.bytes / charsPerToken);
    const replacement = Math.ceil((Math.min(item.bytes, summaryBytes) + 180) / charsPerToken);
    const saved = Math.max(0, gross - replacement);
    const key = item.command || '-';
    const current = byCommand.get(key) || { count: 0, saved: 0 };
    byCommand.set(key, { count: current.count + 1, saved: current.saved + saved });
  }
  return byCommand;
}

function realisticCacheSavings(cached, blockedEvents, optimisticCacheSavedTokens, summaryBytes, charsPerToken) {
  if (!cached.length || !blockedEvents.length) return 0;
  const byCommand = cacheSavingsByCommand(cached, summaryBytes, charsPerToken);
  const averageSavedPerCache = Math.ceil(optimisticCacheSavedTokens / cached.length);
  let saved = 0;
  for (const event of blockedEvents) {
    const command = event.command || '-';
    const matched = byCommand.get(command);
    saved += matched ? Math.ceil(matched.saved / matched.count) : averageSavedPerCache;
  }
  return Math.min(optimisticCacheSavedTokens, saved);
}

function parseProjectSavings(cwd, config = {}) {
  const charsPerToken = Number(config?.limits?.chars_per_token || 4);
  const summaryBytes = Number(config?.cache?.summary_bytes || 900);
  const events = parseEventsText(safeRead(eventPathFor(cwd)));
  const cached = events
    .filter(e => e.type === 'cache_write')
    .map(e => ({
      ref: e.cache_ref || e.ref || '-',
      bytes: Number(e.bytes) || 0,
      command: e.command || '',
    }));
  const cachedBytes = cached.reduce((sum, c) => sum + c.bytes, 0);
  const replacementBytes = cached.reduce((sum, c) => sum + Math.min(c.bytes, summaryBytes) + 180, 0);
  const grossTokensAvoided = Math.ceil(cachedBytes / charsPerToken);
  const replacementTokens = Math.ceil(replacementBytes / charsPerToken);
  const optimisticCacheSavedTokens = Math.max(0, grossTokensAvoided - replacementTokens);

  let recallBytes = 0;
  for (const e of events.filter(e => e.type === 'auto_retrieve')) {
    const file = e.snapshot_path || e.path;
    if (!file) {
      recallBytes += Number(config?.savings?.missing_recall_bytes || 1200);
      continue;
    }
    const preview = safeRead(file).split('\n').slice(0, 42).join('\n');
    recallBytes += Buffer.byteLength(`[codex-ctx] Relevant project memory from ${path.basename(file)}:\n\n${preview}`);
  }
  const sessionBytes = events
    .filter(e => e.type === 'session_start')
    .reduce((sum, e) => sum + (Number(e.bytes) || 0), 0);
  const memoryOverheadTokens = Math.ceil((recallBytes + sessionBytes) / charsPerToken);
  const snapshots = listSnapshots(memoryDirFor(cwd, config));
  const snapshotStorageBytes = snapshots.reduce((sum, s) => sum + Buffer.byteLength(s.body || ''), 0);
  const snapshotStorageTokens = Math.ceil(snapshotStorageBytes / charsPerToken);
  const blockedPreToolEvents = events.filter(e => e.type === 'pre_tool_use_decision' && e.decision === 'block');
  const preToolBlocks = blockedPreToolEvents.length;
  const realisticCacheSavedTokens = realisticCacheSavings(
    cached,
    blockedPreToolEvents,
    optimisticCacheSavedTokens,
    summaryBytes,
    charsPerToken,
  );

  return {
    scope: 'project',
    project: cwd,
    events: events.length,
    cached_outputs: cached.length,
    cached_bytes: cachedBytes,
    gross_tokens_avoided: grossTokensAvoided,
    replacement_tokens: replacementTokens,
    cache_saved_tokens: realisticCacheSavedTokens,
    cache_saved_tokens_optimistic: optimisticCacheSavedTokens,
    cache_saved_tokens_realistic: realisticCacheSavedTokens,
    estimated_cache_saved_tokens: realisticCacheSavedTokens,
    savings_mode: 'blocked_repeat_realistic',
    auto_retrieve_count: events.filter(e => e.type === 'auto_retrieve').length,
    session_restore_count: events.filter(e => e.type === 'session_start').length,
    memory_overhead_tokens: memoryOverheadTokens,
    net_saved_tokens: realisticCacheSavedTokens - memoryOverheadTokens,
    snapshot_storage_tokens: snapshotStorageTokens,
    net_after_snapshot_storage_tokens: realisticCacheSavedTokens - memoryOverheadTokens - snapshotStorageTokens,
    pre_tool_blocks: preToolBlocks,
    permission_requests: events.filter(e => e.type === 'permission_request').length,
    snapshots: snapshots.length,
    largest_cached: cached.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
  };
}

function normalizeSavingsArgs(cwdOrConfig = process.cwd(), configOrOpts = {}, maybeOpts = {}) {
  if (cwdOrConfig && typeof cwdOrConfig === 'object' && (cwdOrConfig.cwd || cwdOrConfig.config || cwdOrConfig.opts)) {
    return {
      cwd: cwdOrConfig.cwd || process.cwd(),
      config: cwdOrConfig.config || {},
      opts: cwdOrConfig.opts || cwdOrConfig,
    };
  }
  if (typeof cwdOrConfig !== 'string') {
    return { cwd: process.cwd(), config: cwdOrConfig || {}, opts: configOrOpts || {} };
  }
  return { cwd: cwdOrConfig, config: configOrOpts || {}, opts: maybeOpts || {} };
}

function buildSavings(cwdOrConfig = process.cwd(), configOrOpts = {}, maybeOpts = {}) {
  const { cwd, config, opts } = normalizeSavingsArgs(cwdOrConfig, configOrOpts, maybeOpts);
  const data = opts.global ? parseHookSavings(config) : parseProjectSavings(cwd, config);
  if (opts.json) return JSON.stringify(data, null, 2);
  return [
    `Codex Ctx Savings (${data.scope || 'global'})`,
    '',
    data.project ? `project: ${data.project}` : null,
    typeof data.events === 'number' ? `events: ${data.events}` : null,
    `cached_outputs: ${data.cached_outputs}`,
    `cached_bytes: ${fmtBytes(data.cached_bytes)}`,
    `gross_tokens_avoided: ${data.gross_tokens_avoided}`,
    `replacement_tokens: ${data.replacement_tokens}`,
    `cache_saved_tokens: ${data.cache_saved_tokens}`,
    typeof data.cache_saved_tokens_optimistic === 'number' ? `cache_saved_tokens_optimistic: ${data.cache_saved_tokens_optimistic}` : null,
    typeof data.cache_saved_tokens_realistic === 'number' ? `cache_saved_tokens_realistic: ${data.cache_saved_tokens_realistic}` : null,
    data.savings_mode ? `savings_mode: ${data.savings_mode}` : null,
    `note: realistic cache savings count blocked repeated tool calls; optimistic savings count all cached large outputs.`,
    `memory_overhead_tokens: ${data.memory_overhead_tokens}`,
    `net_saved_tokens: ${data.net_saved_tokens}`,
    typeof data.snapshot_storage_tokens === 'number' ? `snapshot_storage_tokens: ${data.snapshot_storage_tokens}` : null,
    typeof data.net_after_snapshot_storage_tokens === 'number' ? `net_after_snapshot_storage_tokens: ${data.net_after_snapshot_storage_tokens}` : null,
    `auto_retrieve_count: ${data.auto_retrieve_count}`,
    typeof data.session_restore_count === 'number' ? `session_restore_count: ${data.session_restore_count}` : null,
    `pre_tool_blocks: ${data.pre_tool_blocks}`,
    typeof data.permission_requests === 'number' ? `permission_requests: ${data.permission_requests}` : null,
    `snapshots: ${data.snapshots}`,
    '',
    'Largest cached outputs:',
    data.largest_cached.map(c => `- ${c.ref} ${fmtBytes(c.bytes)}`).join('\n') || '- (none)',
  ].filter(line => line !== null).join('\n');
}

function relativeProjectPath(cwd, filePath) {
  const rel = path.relative(cwd, filePath);
  return rel && !rel.startsWith('..') ? rel : filePath;
}

function eventFilePath(event) {
  const input = event.tool_input || {};
  const direct = event.file_path || input.file_path || input.path || input.filename;
  if (direct) return direct;
  const cmd = String(event.command || '');
  const match = cmd.match(/(?:sed|nl|cat|rg|grep|tail|head)\b[^;&|]*\s((?:\.{0,2}\/)?[\w@./-]+\.(?:js|jsx|ts|tsx|json|md|py|go|rs|css|html|sql|yml|yaml))/);
  return match ? match[1] : null;
}

function isNoisyCommand(command) {
  return /^\s*\*\*\* Begin Patch/.test(String(command || ''));
}

function gitLines(cwd, args, maxBytes = 12000) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, maxBuffer: maxBytes, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function gitStatus(cwd) {
  const branch = gitLines(cwd, ['branch', '--show-current']).trim();
  const upstream = gitLines(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = gitLines(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).trim().split(/\s+/);
    behind = Number(counts[0] || 0);
    ahead = Number(counts[1] || 0);
  }
  const files = gitLines(cwd, ['status', '--porcelain=v1', '-uno'])
    .split('\n')
    .filter(Boolean)
    .slice(0, 40)
    .map(line => ({ status: line.slice(0, 2), path: line.slice(3) }));
  const untracked = gitLines(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .filter(line => line.startsWith('?? '))
    .slice(0, 40)
    .map(line => ({ status: '??', path: line.slice(3) }));
  return { branch, upstream, ahead, behind, files: [...files, ...untracked] };
}

function buildWorkingSet(cwd, config = {}, opts = {}) {
  const limit = Number(opts.limit || 80);
  const events = readEvents(cwd, { limit: Math.max(limit, 120) });
  const files = new Map();
  const commands = [];
  let lastTest = null;
  let lastError = null;
  let lastCache = null;
  for (const e of events) {
    const fp = eventFilePath(e);
    if (fp && fs.existsSync(path.resolve(cwd, fp))) files.set(fp, { path: fp, ts: e.ts, event: e.type });
    if (e.command && !isNoisyCommand(e.command) && (e.type === 'pre_tool_use' || e.type === 'post_tool_use')) commands.push(e.command);
    if (memory.isTestLikeCommand(e.command || '')) lastTest = e;
    if (e.decision === 'block' || /error|failed|exception/i.test(e.reason || e.command || '')) lastError = e;
    if (e.type === 'cache_write') lastCache = e;
  }
  const git = gitStatus(cwd);
  for (const f of git.files) {
    if (f.path && fs.existsSync(path.resolve(cwd, f.path))) files.set(f.path, { path: f.path, ts: 'git', event: `git ${f.status.trim() || 'modified'}` });
  }
  const rows = [
    '# Codex Ctx Working Set',
    '',
    `project: ${cwd}`,
    `events_scanned: ${events.length}`,
    git.branch ? `branch: ${git.branch}${git.upstream ? ` -> ${git.upstream}` : ''}${git.ahead || git.behind ? ` (ahead ${git.ahead}, behind ${git.behind})` : ''}` : null,
    '',
    '## Git Changes',
    git.files.slice(0, 16).map(f => `- ${f.status} ${f.path}`).join('\n') || '- (none)',
    '',
    '## Active Files',
    [...files.values()].slice(-12).reverse().map(f => `- ${f.path} (${f.event})`).join('\n') || '- (none)',
    '',
    '## Recent Commands',
    [...new Set(commands)].slice(-8).reverse().map(c => `- \`${String(c).replace(/`/g, '\\`').slice(0, 180)}\``).join('\n') || '- (none)',
    '',
    '## Last Test Or Build',
    lastTest ? `- ${lastTest.ts || '-'} \`${String(lastTest.command || '').replace(/`/g, '\\`').slice(0, 180)}\` bytes=${lastTest.bytes || 0}` : '- (none)',
    '',
    '## Last Guard Or Error',
    lastError && !isNoisyCommand(lastError.command) ? `- ${lastError.ts || '-'} ${String(lastError.reason || lastError.command || '').replace(/\s+/g, ' ').slice(0, 220)}` : '- (none)',
    '',
    '## Last Cache',
    lastCache ? `- ${lastCache.cache_ref} ${fmtBytes(lastCache.bytes)} \`${String(lastCache.command || '').replace(/`/g, '\\`').slice(0, 160)}\`` : '- (none)',
  ];
  return rows.filter(line => line !== null).join('\n');
}

function gitLogMatches(cwd, query, config = {}, limit = 5, opts = {}) {
  const tokens = tokenize(query, config);
  if (!tokens.length) return [];
  const args = ['log', '--date=short', '--pretty=format:%h%x09%ad%x09%s', '-n', '80'];
  if (opts.since) args.splice(1, 0, `--since=${opts.since}`);
  return gitLines(cwd, args)
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, date, ...rest] = line.split('\t');
      const subject = rest.join('\t');
      const lower = subject.toLowerCase();
      const hits = tokens.filter(t => lower.includes(t)).length;
      return { source: 'git', score: hits, title: subject, ref: hash, ts: date, text: subject };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function eventMatches(cwd, query, config = {}, limit = 5, opts = {}) {
  const tokens = tokenize(query, config);
  if (!tokens.length) return [];
  const cutoff = sinceCutoff(opts.since);
  return readEvents(cwd, { limit: 400 })
    .filter(e => !cutoff || Date.parse(e.ts || 0) >= cutoff)
    .map(e => {
      const text = [e.reason, e.prompt, e.command, e.additional_context].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 260);
      const lower = text.toLowerCase();
      const hits = tokens.filter(t => lower.includes(t)).length;
      const boost = e.type === 'pre_tool_use_decision' || e.type === 'permission_request' ? 1 : 0;
      return { source: 'event', score: hits + boost, title: e.type, ref: e.ts, ts: e.ts, text };
    })
    .filter(r => r.text && r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildAsk(cwd, query, config = {}, opts = {}) {
  const limit = Number(opts.limit || 8);
  const cutoff = sinceCutoff(opts.since);
  const snapshots = searchSnapshots(cwd, query, config)
    .filter(r => !cutoff || fs.statSync(r.path).mtimeMs >= cutoff)
    .slice(0, limit).map(r => ({
    source: 'snapshot',
    score: r.score,
    title: path.basename(r.path),
    ref: r.path,
    ts: '',
    text: r.body.split('\n').filter(Boolean).slice(0, 5).join(' ').slice(0, 320),
  }));
  const facts = memory.recallFacts(cwd, query, config, { limit })
    .filter(f => !cutoff || Date.parse(f.ts || 0) >= cutoff)
    .map(f => ({
    source: `fact:${f.kind}`,
    score: f.score,
    title: f.kind,
    ref: f.id,
    ts: f.ts,
    text: f.text,
  }));
  const events = eventMatches(cwd, query, config, limit, opts);
  const git = gitLogMatches(cwd, query, config, limit, opts);
  const results = [...snapshots, ...facts, ...events, ...git]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (opts.json) return JSON.stringify(results, null, 2);
  if (!results.length) return 'no matches';
  return results.map((r, i) => [
    `#${i + 1} [${r.source}] score=${Number(r.score || 0).toFixed(2)} ${r.title || r.ref || ''}`.trim(),
    r.ts ? `date: ${r.ts}` : null,
    r.ref ? `ref: ${r.ref}` : null,
    r.text,
  ].filter(Boolean).join('\n')).join('\n\n');
}

function shouldSkipRepoPath(rel) {
  return /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.expo|Pods|DerivedData|vendor|tmp|temp|__pycache__|mcp-cache)(\/|$)/.test(rel)
    || /\.(lock|png|jpe?g|gif|webp|pdf|zip|gz|mp4|mov|sqlite|db)$/i.test(rel);
}

function projectFiles(cwd, opts = {}) {
  const maxFiles = Number(opts.maxFiles || 240);
  const out = [];
  const stack = [cwd];
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, ent.name);
      const rel = relativeProjectPath(cwd, full);
      if (shouldSkipRepoPath(rel)) continue;
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          if (st.size <= Number(opts.maxBytes || 200000)) out.push({ path: full, rel, size: st.size });
        } catch {}
      }
    }
  }
  return out;
}

function extractSymbols(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  const lines = String(text || '').split('\n');
  const symbols = [];
  const patterns = ext === '.py'
    ? [/^\s*(class|def)\s+([A-Za-z_][\w]*)/]
    : [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
        /^\s*(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
        /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=/,
        /^\s*const\s+([A-Z][A-Za-z0-9_$]*)\s*=/,
      ];
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m) {
        symbols.push(m[m.length - 1]);
        break;
      }
    }
    if (symbols.length >= 8) break;
  }
  return symbols;
}

function buildRepoMap(cwd, config = {}, opts = {}) {
  const cacheDir = path.join(projectDirFor(cwd), 'repomap');
  const cacheFile = path.join(cacheDir, 'repomap.txt');
  const ttlMs = Math.max(0, Number(config?.repomap?.ttl_sec ?? 300)) * 1000;
  if (!opts.noCache && ttlMs > 0) {
    try {
      const st = fs.statSync(cacheFile);
      if (Date.now() - st.mtimeMs < ttlMs) return fs.readFileSync(cacheFile, 'utf8');
    } catch {}
  }
  const files = projectFiles(cwd, { maxFiles: opts.limit || config?.repomap?.max_files || 180 });
  const rows = ['# Codex Ctx Repo Map', '', `project: ${cwd}`, `files: ${files.length}`, ''];
  for (const f of files) {
    let body = '';
    try { body = fs.readFileSync(f.path, 'utf8'); } catch {}
    const symbols = extractSymbols(f.rel, body);
    if (symbols.length) rows.push(`${f.rel}: ${symbols.join(', ')}`);
    else if (/package\.json$|README|AGENTS\.md|CLAUDE\.md/i.test(f.rel)) rows.push(`${f.rel}: ${fmtBytes(f.size)}`);
  }
  const out = rows.join('\n');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
  } catch {}
  return out;
}

module.exports = {
  fmtBytes,
  historyStats,
  snapshotStats,
  cacheStats,
  buildReport,
  buildTimeline,
  buildMetrics,
  buildHeavy,
  buildBloat,
  buildStatusline,
  buildEvents,
  buildAsk,
  buildWorkingSet,
  buildRepoMap,
  parseHookSavings,
  parseProjectSavings,
  buildSavings,
  prune,
  backupHistory,
  listBackups,
  diffLatestSnapshots,
  readProjectFile,
  writeNote,
  readNotes,
  isoFromTs,
};
