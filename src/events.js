'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectDirFor } = require('./paths.js');

function eventDirFor(cwd) {
  return path.join(projectDirFor(cwd), 'events');
}

function eventPathFor(cwd) {
  return path.join(eventDirFor(cwd), 'events.jsonl');
}

function stableId(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 16);
}

function trimValue(value, maxString = 1200, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}...[truncated ${value.length - maxString} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth > 3) return `[array ${value.length}]`;
    return value.slice(0, 20).map(v => trimValue(v, maxString, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth > 3) return '[object]';
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = trimValue(v, maxString, depth + 1);
    return out;
  }
  return String(value);
}

function appendEvent(cwd, event = {}, config = {}) {
  if (config?.events?.enabled === false) return null;
  const dir = eventDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const row = {
    ts: event.ts || now,
    id: event.id || stableId(`${now}:${Math.random()}:${event.type || 'event'}`),
    cwd,
    type: event.type || 'event',
    session_id: event.session_id || event.sessionId || null,
    ...trimValue(event, Number(config?.events?.max_string || 1200)),
  };
  fs.appendFileSync(eventPathFor(cwd), JSON.stringify(row) + '\n');
  return row;
}

function parseEventsText(raw) {
  const rows = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function readEvents(cwd, opts = {}) {
  const limit = Math.max(1, Number(opts.limit || 500));
  const tailBytes = Math.max(128 * 1024, limit * 2048);
  const file = eventPathFor(cwd);
  let raw = '';
  try {
    const fd = fs.openSync(file, 'r');
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
    return [];
  }
  return parseEventsText(raw).slice(-limit);
}

function summarizeEvents(cwd, config = {}, opts = {}) {
  const events = readEvents(cwd, { limit: opts.limit || config?.events?.snapshot_limit || 250 });
  const toolCalls = events.filter(e => e.type === 'post_tool_use' || e.type === 'pre_tool_use');
  const prompts = events.filter(e => e.type === 'user_prompt_submit');
  const cacheRefs = events.filter(e => e.cache_ref).map(e => ({
    ref: e.cache_ref,
    bytes: e.bytes || 0,
    tool: e.tool_name || '-',
    command: e.command || '',
  }));
  const blocked = events.filter(e => e.decision === 'block' || e.permission_decision === 'deny');
  const commands = [];
  const files = new Set();
  for (const e of events) {
    if (e.command && !commands.includes(e.command)) commands.push(e.command);
    const input = e.tool_input || {};
    const fp = e.file_path || input.file_path || input.path || input.filename;
    if (fp) files.add(fp);
  }
  const decisions = [];
  const importantRe = /(?:karar|decision|sonuç|result|hata|error|çözüm|solution|fix|todo|next|kaldı|problem|sorun)/i;
  for (const e of events) {
    const text = [e.prompt, e.reason, e.additional_context, e.command].filter(Boolean).join(' ');
    if (importantRe.test(text)) decisions.push(text.replace(/\s+/g, ' ').slice(0, 240));
  }
  return {
    events,
    prompts,
    toolCalls,
    blocked,
    cacheRefs,
    commands: commands.slice(-20),
    files: [...files].slice(-40),
    decisions: [...new Set(decisions)].slice(-20),
  };
}

module.exports = {
  eventDirFor,
  eventPathFor,
  appendEvent,
  parseEventsText,
  readEvents,
  summarizeEvents,
};
