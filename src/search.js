'use strict';

const fs = require('fs');
const path = require('path');
const { memoryDirFor } = require('./paths.js');

function tokenize(text, config = {}) {
  const stops = new Set([...(config?.stopwords?.tr || []), ...(config?.stopwords?.en || [])]);
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(w => w.length > 1 && !stops.has(w));
}

function listSnapshots(memoryDir) {
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch { return []; }
  return names
    .filter(n => n.endsWith('.md') && n !== 'MEMORY.md')
    .map(n => {
      const full = path.join(memoryDir, n);
      const st = fs.statSync(full);
      return { path: full, name: n, mtime: st.mtimeMs, body: fs.readFileSync(full, 'utf8') };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function score(queryTokens, snapshot, config = {}) {
  const bodyTokens = tokenize(snapshot.body, config);
  if (!queryTokens.length || !bodyTokens.length) return 0;
  const counts = new Map();
  for (const t of bodyTokens) counts.set(t, (counts.get(t) || 0) + 1);
  let hits = 0;
  for (const q of queryTokens) hits += counts.get(q) || 0;
  const keyword = hits / Math.sqrt(bodyTokens.length);
  const ageDays = Math.max(0, (Date.now() - snapshot.mtime) / 86400000);
  const halfLife = Number(config?.retrieval?.recency_half_life_days || 60);
  const recency = Math.pow(0.5, ageDays / Math.max(1, halfLife));
  return keyword + (0.15 * recency);
}

function searchSnapshots(cwd, query, config = {}) {
  const q = tokenize(query, config);
  const minScore = Number(config?.retrieval?.min_score || 0.1);
  const topN = Number(config?.retrieval?.top_n || 3);
  return listSnapshots(memoryDirFor(cwd, config))
    .map(s => ({ ...s, score: score(q, s, config) }))
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

module.exports = {
  tokenize,
  listSnapshots,
  searchSnapshots,
};
