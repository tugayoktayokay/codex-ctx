'use strict';

const fs = require('fs');
const path = require('path');
const { CODEX_HOME } = require('./paths.js');

const HISTORY_PATH = path.join(CODEX_HOME, 'history.jsonl');

function parseJSONL(filePath) {
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  return parseJSONLText(raw);
}

function parseJSONLText(raw) {
  const rows = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function loadHistory(limit = 200) {
  const requested = Math.max(1, Number(limit) || 200);
  const tailBytes = Math.max(256 * 1024, requested * 4096);
  let raw = '';
  try {
    const fd = fs.openSync(HISTORY_PATH, 'r');
    try {
      const st = fs.fstatSync(fd);
      const start = Math.max(0, st.size - tailBytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString('utf8');
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    raw = '';
  }
  const rows = parseJSONLText(raw)
    .filter(r => r && typeof r.text === 'string')
    .map(r => ({
      session_id: String(r.session_id || '-'),
      ts: Number(r.ts || 0),
      text: r.text.trim(),
    }))
    .filter(r => r.text);
  return rows.slice(Math.max(0, rows.length - requested));
}

function groupBySession(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.session_id)) map.set(r.session_id, []);
    map.get(r.session_id).push(r);
  }
  return [...map.entries()].map(([session_id, items]) => ({
    session_id,
    items,
    first_ts: items[0]?.ts || 0,
    last_ts: items[items.length - 1]?.ts || 0,
    text: items.map(i => i.text).join('\n'),
  })).sort((a, b) => b.last_ts - a.last_ts);
}

function latestSession(limit = 200) {
  return groupBySession(loadHistory(limit))[0] || null;
}

module.exports = {
  HISTORY_PATH,
  parseJSONL,
  parseJSONLText,
  loadHistory,
  groupBySession,
  latestSession,
};
