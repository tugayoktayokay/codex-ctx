'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { loadHistory, groupBySession, HISTORY_PATH } = require('./codex_history.js');
const { memoryDirFor } = require('./paths.js');
const { latestSnapshot, writeSnapshot } = require('./snapshot.js');
const { searchSnapshots } = require('./search.js');
const { maybeCached, readCache } = require('./cache.js');
const { estimateTokens, detectLevel } = require('./token.js');
const advanced = require('./advanced.js');

function statusText(cwd, config) {
  const rows = loadHistory(config?.snapshot?.history_limit || 80);
  const text = rows.map(r => r.text).join('\n');
  const metric = detectLevel(estimateTokens(text, config), config);
  const latest = latestSnapshot(cwd, config);
  return [
    `history: ${HISTORY_PATH}`,
    `recent prompts: ${rows.length}`,
    `estimated tokens: ${metric.tokens}/${metric.ceiling} (${Math.round(metric.pct * 100)}%)`,
    `level: ${metric.level}`,
    `memory: ${memoryDirFor(cwd, config)}`,
    `latest snapshot: ${latest ? latest.path : '(none)'}`,
  ].join('\n');
}

function allTools() {
  return [
    {
      name: 'codex_ctx_status',
      description: 'Return Codex Ctx local history, estimated context size, and latest project snapshot.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, { config }) => statusText(process.cwd(), config),
    },
    {
      name: 'codex_ctx_snapshot',
      description: 'Write a project memory snapshot from recent local Codex prompt history.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      handler: async (args, { config }) => {
        const result = writeSnapshot(process.cwd(), config, { name: args.name || null });
        return result ? `snapshot written: ${result.outPath}` : 'no Codex history found';
      },
    },
    {
      name: 'codex_ctx_ask',
      description: 'Search this project’s Codex Ctx memory snapshots for prior context.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, top_n: { type: 'integer' } }, required: ['query'] },
      handler: async (args, { config }) => {
        const cfg = args.top_n ? { ...config, retrieval: { ...config.retrieval, top_n: args.top_n } } : config;
        const results = searchSnapshots(process.cwd(), args.query, cfg);
        if (!results.length) return 'no matches';
        return results.map((r, i) => {
          const preview = r.body.split('\n').filter(Boolean).slice(0, 12).join('\n');
          return `#${i + 1} score=${r.score.toFixed(2)} path=${r.path}\n${preview}`;
        }).join('\n\n');
      },
    },
    {
      name: 'codex_ctx_history',
      description: 'Return recent local Codex prompt history grouped by session.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
      handler: async (args, { config }) => {
        const sessions = groupBySession(loadHistory(args.limit || config?.snapshot?.history_limit || 80)).slice(0, 10);
        return sessions.map(s => `${s.session_id} prompts=${s.items.length} last=${new Date(s.last_ts * 1000).toISOString()}\n${s.items.slice(-3).map(i => `  - ${i.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}`).join('\n\n') || 'no history';
      },
    },
    {
      name: 'codex_ctx_shell',
      description: 'Run a shell command and cache oversized output. Use for commands likely to produce more than a few KB.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['command'] },
      handler: async (args, { config }) => {
        const res = spawnSync(String(args.command), {
          shell: true,
          cwd: args.cwd || process.cwd(),
          timeout: args.timeout_ms || 30000,
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024,
        });
        const combined = `${res.stdout || ''}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ''}`;
        return maybeCached(`exit=${res.status == null ? '-' : res.status}\n${combined}`, config);
      },
    },
    {
      name: 'codex_ctx_read',
      description: 'Read a file and cache oversized content. Use for large files.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async (args, { config }) => maybeCached(fs.readFileSync(String(args.path), 'utf8'), config),
    },
    {
      name: 'codex_ctx_cache_get',
      description: 'Read a cached large output page by ref.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['ref'] },
      handler: async (args) => readCache(args.ref, args.offset || 0, args.limit || 5000) || 'cache miss',
    },
    {
      name: 'codex_ctx_report',
      description: 'Return a Codex Ctx project report with history, token, snapshot, cache, and recent-session metrics.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, { config }) => advanced.buildReport(process.cwd(), config),
    },
    {
      name: 'codex_ctx_timeline',
      description: 'Return a merged timeline of recent Codex sessions and memory snapshots.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, json: { type: 'boolean' } } },
      handler: async (args, { config }) => advanced.buildTimeline(process.cwd(), config, { limit: args.limit || 40, json: Boolean(args.json) }),
    },
    {
      name: 'codex_ctx_metrics',
      description: 'Return structured Codex Ctx metrics for this project.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, { config }) => JSON.stringify(advanced.buildMetrics(process.cwd(), config), null, 2),
    },
    {
      name: 'codex_ctx_heavy',
      description: 'List the largest Codex Ctx cache and snapshot files.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
      handler: async (args, { config }) => advanced.buildHeavy(process.cwd(), config, { limit: args.limit || 20 }),
    },
    {
      name: 'codex_ctx_bloat',
      description: 'Audit context, snapshot, cache, and hook-log bloat.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, { config }) => advanced.buildBloat(process.cwd(), config),
    },
    {
      name: 'codex_ctx_diff',
      description: 'Diff the two latest Codex Ctx memory snapshots.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, { config }) => advanced.diffLatestSnapshots(process.cwd(), config),
    },
    {
      name: 'codex_ctx_prune',
      description: 'Dry-run or delete old Codex Ctx cache and snapshot files.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer' }, dry_run: { type: 'boolean' } } },
      handler: async (args, { config }) => JSON.stringify(advanced.prune(process.cwd(), config, { days: args.days || 30, dryRun: args.dry_run !== false }), null, 2),
    },
  ];
}

module.exports = {
  allTools,
  statusText,
};
