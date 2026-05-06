'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_HOME } = require('./paths.js');

const CACHE_DIR = path.join(APP_HOME, 'mcp-cache');

function writeCache(content) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const ref = crypto.createHash('sha256').update(`${Date.now()}:${Math.random()}:${content}`).digest('hex').slice(0, 20);
  const file = path.join(CACHE_DIR, `${ref}.txt`);
  fs.writeFileSync(file, String(content || ''));
  return { ref, file, bytes: Buffer.byteLength(String(content || '')) };
}

function readCache(ref, offset = 0, limit = 5000) {
  const safe = String(ref || '').replace(/[^a-f0-9]/g, '');
  if (!safe) return null;
  const file = path.join(CACHE_DIR, `${safe}.txt`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const start = Math.max(0, Number(offset) || 0);
  const end = Math.min(text.length, start + Math.max(1, Number(limit) || 5000));
  return { ref: safe, offset: start, next_offset: end < text.length ? end : null, total: text.length, text: text.slice(start, end) };
}

function summarize(content, summaryBytes = 1200) {
  const text = String(content || '');
  if (Buffer.byteLength(text) <= summaryBytes) return text;
  const half = Math.floor(summaryBytes / 2);
  return `${text.slice(0, half)}\n\n... omitted ${text.length - summaryBytes} chars ...\n\n${text.slice(-half)}`;
}

function maybeCached(content, config = {}) {
  const text = String(content || '');
  const inlineLimit = Number(config?.cache?.inline_limit_bytes || 5000);
  if (Buffer.byteLength(text) <= inlineLimit) return text;
  const cached = writeCache(text);
  const summary = summarize(text, Number(config?.cache?.summary_bytes || 1200));
  return `[codex-ctx cached ref=${cached.ref} bytes=${cached.bytes}]\n${summary}\n\nUse codex_ctx_cache_get({ "ref": "${cached.ref}", "offset": 0, "limit": 5000 }) to page the full output.`;
}

module.exports = {
  CACHE_DIR,
  writeCache,
  readCache,
  summarize,
  maybeCached,
};
