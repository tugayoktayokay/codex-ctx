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

function buildMarkdown(summary, opts = {}) {
  const created = new Date().toISOString();
  const title = opts.name || summary.recent_prompts.at(-1) || 'codex snapshot';
  const fp = crypto.createHash('sha256').update(summary.text).digest('hex').slice(0, 16);
  const prompts = summary.recent_prompts.map(p => `- ${p.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const eventSummary = opts.eventSummary || {};
  const cacheRefs = listLines(eventSummary.cacheRefs, c => `- ${c.ref} ${c.bytes || 0} bytes ${c.tool || '-'} ${String(c.command || '').slice(0, 120)}`);
  const decisions = listLines(eventSummary.decisions, d => `- ${String(d).replace(/\s+/g, ' ').slice(0, 240)}`);
  const commands = listLines(eventSummary.commands, c => `- \`${String(c).replace(/`/g, '\\`').slice(0, 180)}\``);
  const files = listLines(eventSummary.files, f => `- ${String(f).slice(0, 220)}`);
  const blocked = listLines(eventSummary.blocked, e => `- ${e.ts || '-'} ${e.type || '-'} ${String(e.reason || e.command || '').replace(/\s+/g, ' ').slice(0, 220)}`);
  const recentEvents = listLines((eventSummary.events || []).slice(-25), e => {
    const parts = [e.ts, e.type, e.tool_name, e.command || e.prompt || e.reason].filter(Boolean);
    return `- ${parts.join(' | ').replace(/\s+/g, ' ').slice(0, 240)}`;
  });
  return `---\ncreated: ${created}\nsession_id: ${summary.session_id}\nfingerprint: ${fp}\nprompt_count: ${summary.prompt_count}\ntokens_est: ${summary.tokens}\nlevel: ${summary.decision.level}\n---\n\n# ${title}\n\n## Context\n\n- Estimated tokens: ${summary.tokens}\n- Context level: ${summary.decision.level}\n- Session: ${summary.session_id}\n- Event count: ${(eventSummary.events || []).length}\n\n## Decisions And Signals\n\n${decisions}\n\n## Files Mentioned Or Touched\n\n${files}\n\n## Commands\n\n${commands}\n\n## Blocked Or Guarded Actions\n\n${blocked}\n\n## Cache References\n\n${cacheRefs}\n\n## Recent Prompts\n\n${prompts || '- (none)'}\n\n## Recent Events\n\n${recentEvents}\n\n## Raw Prompt Text\n\n\`\`\`text\n${summary.text.slice(-12000)}\n\`\`\`\n`;
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
  const name = `${stamp}-${slugify(opts.name || summary.recent_prompts.at(-1))}.md`;
  const outPath = path.join(memoryDir, name);
  const eventSummary = summarizeEvents(cwd, config, { limit: config?.events?.snapshot_limit || 250 });
  fs.writeFileSync(outPath, buildMarkdown(summary, { ...opts, eventSummary }));
  rewriteIndex(memoryDir);
  return { outPath, summary };
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
  buildMarkdown,
  writeSnapshot,
  latestSnapshot,
};
