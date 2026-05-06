'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadHistory, groupBySession, HISTORY_PATH } = require('./codex_history.js');
const { APP_HOME, HOOK_LOG, memoryDirFor, projectDirFor } = require('./paths.js');
const { listSnapshots } = require('./search.js');
const { latestSnapshot, writeSnapshot } = require('./snapshot.js');
const { estimateTokens, detectLevel } = require('./token.js');
const { CACHE_DIR, maybeCached } = require('./cache.js');
const { tokenize } = require('./search.js');
const { readEvents, eventPathFor } = require('./events.js');

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
  const aLines = new Set(a.body.split('\n').map(x => x.trim()).filter(Boolean));
  const bLines = new Set(b.body.split('\n').map(x => x.trim()).filter(Boolean));
  const added = [...aLines].filter(x => !bLines.has(x)).slice(0, 40);
  const removed = [...bLines].filter(x => !aLines.has(x)).slice(0, 40);
  return [
    `new: ${a.path}`,
    `old: ${b.path}`,
    '',
    '## Added',
    added.map(x => `+ ${x}`).join('\n') || '(none)',
    '',
    '## Removed',
    removed.map(x => `- ${x}`).join('\n') || '(none)',
  ].join('\n');
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
  prune,
  backupHistory,
  listBackups,
  diffLatestSnapshots,
  readProjectFile,
  writeNote,
  readNotes,
  isoFromTs,
};
