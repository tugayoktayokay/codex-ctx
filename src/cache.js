'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_HOME } = require('./paths.js');

const CACHE_DIR = path.join(APP_HOME, 'mcp-cache');

function listCacheFiles() {
  let names = [];
  try { names = fs.readdirSync(CACHE_DIR); } catch { return []; }
  return names
    .filter(n => n.endsWith('.txt'))
    .map(n => {
      const file = path.join(CACHE_DIR, n);
      try {
        const st = fs.statSync(file);
        return { file, ref: n.slice(0, -4), size: st.size, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sweepCache(config = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const ttlHours = Number(config?.cache?.gc?.ttl_hours || 24 * 7);
  const maxBytes = Number(config?.cache?.gc?.max_bytes || 100 * 1024 * 1024);
  const cutoff = Date.now() - Math.max(1, ttlHours) * 3600 * 1000;
  const files = listCacheFiles().sort((a, b) => a.mtime - b.mtime);
  let swept = 0;
  let bytesFreed = 0;
  const remove = (f) => {
    try { fs.unlinkSync(f.file); } catch {}
    try { fs.unlinkSync(f.file + '.meta'); } catch {}
    swept++;
    bytesFreed += f.size;
  };
  const survivors = [];
  for (const f of files) {
    if (f.mtime < cutoff) remove(f);
    else survivors.push(f);
  }
  let total = survivors.reduce((sum, f) => sum + f.size, 0);
  while (total > maxBytes && survivors.length) {
    const f = survivors.shift();
    remove(f);
    total -= f.size;
  }
  return { swept, bytes_freed: bytesFreed };
}

function maybeSweep(config = {}, deps = {}) {
  const gc = config?.cache?.gc || {};
  if (gc.enabled === false) return { swept: 0, bytes_freed: 0 };
  const probability = typeof gc.sweep_probability === 'number' ? gc.sweep_probability : 0.03;
  const rand = deps.random || Math.random;
  if (rand() > probability) return { swept: 0, bytes_freed: 0 };
  try { return sweepCache(config); } catch { return { swept: 0, bytes_freed: 0 }; }
}

function writeCache(content, config = {}, deps = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  maybeSweep(config, deps);
  const ref = crypto.createHash('sha256').update(`${Date.now()}:${Math.random()}:${content}`).digest('hex').slice(0, 20);
  const file = path.join(CACHE_DIR, `${ref}.txt`);
  const text = String(content || '');
  fs.writeFileSync(file, text);
  const bytes = Buffer.byteLength(text);
  const ttlHours = Number(config?.cache?.gc?.ttl_hours || 24 * 7);
  fs.writeFileSync(file + '.meta', JSON.stringify({ ref, bytes, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttlHours * 3600 * 1000).toISOString() }) + '\n');
  return { ref, file, bytes };
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
  const cached = writeCache(text, config);
  const summary = summarize(text, Number(config?.cache?.summary_bytes || 1200));
  return `[codex-ctx cached ref=${cached.ref} bytes=${cached.bytes}]\n${summary}\n\nUse codex_ctx_cache_get({ "ref": "${cached.ref}", "offset": 0, "limit": 5000 }) to page the full output.`;
}

module.exports = {
  CACHE_DIR,
  listCacheFiles,
  sweepCache,
  writeCache,
  readCache,
  summarize,
  maybeCached,
};
