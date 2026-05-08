'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-hooks-home-'));
process.env.CODEX_HOME = path.join(home, 'codex');
process.env.CCTX_HOME = path.join(home, 'cctx');

test('pre-tool-use blocks recursive grep', async () => {
  const hooks = require('../hooks.js');
  const config = {
    hooks: {
      pre_tool_use: {
        enabled: true,
        rules: [{ tool: 'Bash', match: '^\\s*grep\\s+-r', reason: 'use cached wrapper' }],
      },
    },
  };
  const out = await hooks.handle('pre-tool-use', {
    tool_name: 'Bash',
    tool_input: { command: 'grep -r foo .' },
  }, config);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /cached wrapper/);
});

test('pre-tool-use blocks noisy default commands', async () => {
  const hooks = require('../hooks.js');
  const { loadConfig } = require('../config.js');
  const out = await hooks.handle('pre-tool-use', {
    tool_name: 'Bash',
    tool_input: { command: 'cat package-lock.json' },
  }, loadConfig());
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Lockfiles are too large/);
});

test('pre-tool-use dedups repeated Bash command after post-tool-use records it', async () => {
  const hooks = require('../hooks.js');
  const config = {
    cache: { post_tool_replace_large_output: true },
    hooks: {
      pre_tool_use: { enabled: true, dedup: { enabled: true, window_sec: 90, min_bytes: 20 }, rules: [] },
      post_tool_use: { large_output_bytes: 20 },
    },
  };
  const input = {
    cwd: '/tmp/project',
    tool_name: 'Bash',
    tool_input: { command: 'printf big' },
    tool_response: { stdout: 'x'.repeat(100) },
  };
  const post = await hooks.handle('post-tool-use', input, config);
  assert.match(post.hookSpecificOutput.additionalContext, /ref: [a-f0-9]{20}/);
  const pre = await hooks.handle('pre-tool-use', {
    cwd: '/tmp/project',
    tool_name: 'Bash',
    tool_input: { command: 'printf big' },
  }, config);
  assert.equal(pre.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(pre.hookSpecificOutput.permissionDecisionReason, /duplicate Bash command/);
  assert.match(pre.hookSpecificOutput.permissionDecisionReason, /codex_ctx_cache_get/);
});

test('user-prompt-submit injects matching snapshot context', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-hooks-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const memoryDir = path.join(tmp, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'snap.md'), '# Stripe webhook fix\n\nUse raw body verification.');

  const hooks = require('../hooks.js');
  const config = {
    snapshot: { memory_dir: memoryDir },
    retrieval: { top_n: 1, min_score: 0.01, recency_half_life_days: 60 },
    stopwords: { tr: [], en: [] },
    hooks: { user_prompt_submit: { auto_retrieve: { enabled: true, min_score: 0.01, top_n: 1 } } },
  };
  const out = await hooks.handle('user-prompt-submit', { cwd, prompt: 'stripe webhook verify body' }, config);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Memory hit/);
  assert.match(out.hookSpecificOutput.additionalContext, /Stripe webhook fix/);
});

test('user-prompt-submit scales memory injection with context budget', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-hooks-budget-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const memoryDir = path.join(tmp, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'snap-a.md'), '# Stripe webhook fix\n\nDecision: use raw body verification.');
  fs.writeFileSync(path.join(memoryDir, 'snap-b.md'), '# Stripe retry policy\n\nNext: retry failed webhook delivery.');
  const memory = require('../memory.js');
  memory.rememberFact(cwd, 'decision: stripe webhook route uses raw body', {}, { kind: 'decision' });

  const hooks = require('../hooks.js');
  const out = await hooks.handle('user-prompt-submit', { cwd, prompt: 'stripe webhook raw body retry route' }, {
    snapshot: { memory_dir: memoryDir },
    limits: {
      chars_per_token: 4,
      thresholds: { watch: 0.4, compact: 0.55, urgent: 0.75, critical: 0.9 },
      models: { default: { quality_ceiling: 100000 } },
    },
    retrieval: { top_n: 3, min_score: 0.01, recency_half_life_days: 60 },
    stopwords: { tr: [], en: [] },
    hooks: { user_prompt_submit: { auto_retrieve: { enabled: true, min_score: 0.01, top_n: 3, budget_snapshot_top_n: 2, fact_top_n: 3 } } },
  });
  assert.match(out.hookSpecificOutput.additionalContext, /Memory budget/);
  assert.match(out.hookSpecificOutput.additionalContext, /Snapshot snap-a\.md/);
  assert.match(out.hookSpecificOutput.additionalContext, /Facts/);
});

test('user-prompt-submit skips generic prompts', async () => {
  const hooks = require('../hooks.js');
  const out = await hooks.handle('user-prompt-submit', {
    cwd: '/tmp/project',
    prompt: 'devam',
  }, {
    retrieval: { generic_prompts: ['devam'], generic_min_tokens: 3 },
    hooks: { user_prompt_submit: { auto_retrieve: { enabled: true, min_score: 0.01, top_n: 1 } } },
  });
  assert.equal(out, null);
});

test('user-prompt-submit emits compact hint at configured levels', async () => {
  const hooks = require('../hooks.js');
  const config = {
    limits: {
      chars_per_token: 1,
      thresholds: { watch: 0.1, compact: 0.2, urgent: 0.6, critical: 0.9 },
      models: { default: { quality_ceiling: 10 } },
    },
    hooks: {
      user_prompt_submit: {
        auto_retrieve: { enabled: false },
        compact_hint_levels: ['compact', 'urgent', 'critical'],
      },
    },
    snapshot: { history_limit: 10 },
  };
  const historyPath = path.join(process.env.CODEX_HOME, 'history.jsonl');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify({ session_id: 'compact', ts: 1700000000, text: 'x'.repeat(5) }) + '\n');
  const out = await hooks.handle('user-prompt-submit', { prompt: 'continue' }, config);
  assert.match(out.hookSpecificOutput.additionalContext, /Context level is compact/);
});

test('post-tool-use caches large output and annotates with cache ref', async () => {
  const hooks = require('../hooks.js');
  const config = {
    cache: { post_tool_replace_large_output: true, summary_bytes: 60 },
    hooks: { post_tool_use: { large_output_bytes: 20 } },
  };
  const out = await hooks.handle('post-tool-use', {
    tool_name: 'Bash',
    tool_input: { command: 'yes' },
    tool_response: { stdout: 'x'.repeat(100) },
  }, config);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /codex_ctx_cache_get/);
  assert.match(out.hookSpecificOutput.additionalContext, /ref: [a-f0-9]{20}/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /x{20}/);
});

test('post-tool-use records runtime profiling fields', async () => {
  const hooks = require('../hooks.js');
  const { readEvents } = require('../events.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-profile-'));
  const config = { hooks: { pre_tool_use: { enabled: true, rules: [], cost_advice: { enabled: false } }, post_tool_use: { large_output_bytes: 999999 } } };
  await hooks.handle('pre-tool-use', { cwd, session_id: 's-prof', tool_name: 'Bash', tool_input: { command: 'npm test -- --watch=false' } }, config);
  await hooks.handle('post-tool-use', { cwd, session_id: 's-prof', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok', exit_code: 0 } }, config);
  const post = readEvents(cwd, { limit: 10 }).find(e => e.type === 'post_tool_use');
  assert.equal(post.normalized_command, 'npm test');
  assert.equal(typeof post.duration_ms, 'number');
  assert.equal(post.failed, false);
});

test('pre-tool-use records cost-aware advice without unsupported context output', async () => {
  const hooks = require('../hooks.js');
  const { readEvents } = require('../events.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-advice-'));
  const config = {
    cache: { post_tool_replace_large_output: false, inline_limit_bytes: 20 },
    hooks: {
      pre_tool_use: { enabled: true, rules: [], cost_advice: { enabled: true, min_runs: 2, large_output_bytes: 20 } },
      post_tool_use: { large_output_bytes: 20 },
    },
  };
  await hooks.handle('post-tool-use', { cwd, tool_name: 'Bash', tool_input: { command: 'npm run test --silent' }, tool_response: { stdout: 'x'.repeat(100) } }, config);
  await hooks.handle('post-tool-use', { cwd, tool_name: 'Bash', tool_input: { command: 'pnpm test' }, tool_response: { stdout: 'x'.repeat(120) } }, config);
  const out = await hooks.handle('pre-tool-use', { cwd, tool_name: 'Bash', tool_input: { command: 'npm test' } }, config);
  assert.equal(out, null);
  const advice = readEvents(cwd, { limit: 10 }).find(e => e.type === 'pre_tool_use_advice');
  assert.match(advice.advice, /Cost-aware command advice/);
  assert.match(advice.advice, /large output history/);
});

test('post-tool-use recalls similar prior context on failure', async () => {
  const hooks = require('../hooks.js');
  const memory = require('../memory.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-failure-'));
  memory.rememberFact(cwd, 'fix: vite import failure is solved by clearing Expo metro cache', {}, { kind: 'error' });
  const out = await hooks.handle('post-tool-use', {
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stderr: 'Error: vite import failure', exit_code: 1 },
  }, { hooks: { post_tool_use: { large_output_bytes: 999999, failure_recall: { enabled: true, min_score: 0.2 } } } });
  assert.match(out.hookSpecificOutput.additionalContext, /Similar prior failure/);
  assert.match(out.hookSpecificOutput.additionalContext, /metro cache/);
});

test('stop snapshots when project has no snapshot', async () => {
  const hooks = require('../hooks.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-stop-nosnap-'));
  const historyPath = path.join(process.env.CODEX_HOME, 'history.jsonl');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify({ session_id: 'stop-no', ts: 1700000000, text: 'checkpoint me' }) + '\n');
  await hooks.handle('stop', { cwd, session_id: 'stop-no' }, {
    snapshot: { history_limit: 10 },
    hooks: { stop: { snapshot_on: [], snapshot_if_no_project_snapshot: true, snapshot_event_threshold: 0 } },
  });
  const { latestSnapshot } = require('../snapshot.js');
  const latest = latestSnapshot(cwd, { snapshot: { history_limit: 10 } });
  assert.ok(latest);
  assert.match(path.basename(latest.path), /checkpoint-me/);
});

test('stop snapshots when event threshold is reached', async () => {
  const hooks = require('../hooks.js');
  const { appendEvent } = require('../events.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-stop-events-'));
  const historyPath = path.join(process.env.CODEX_HOME, 'history.jsonl');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify({ session_id: 'stop-events', ts: 1700000000, text: 'many events' }) + '\n');
  const config = {
    snapshot: { history_limit: 10 },
    hooks: { stop: { snapshot_on: [], snapshot_if_no_project_snapshot: false, snapshot_event_threshold: 3 } },
  };
  for (let i = 0; i < 3; i++) appendEvent(cwd, { type: 'post_tool_use', command: `echo ${i}` }, config);
  await hooks.handle('stop', { cwd, session_id: 'stop-events' }, config);
  const { latestSnapshot } = require('../snapshot.js');
  const latest = latestSnapshot(cwd, config);
  assert.ok(latest);
  assert.match(path.basename(latest.path), /many-events/);
});

test('ensureFeatureFlag inserts codex_hooks under features', () => {
  const { ensureFeatureFlag } = require('../hooks_install.js');
  const out = ensureFeatureFlag('approvals_reviewer = "user"\n\n[features]\nfoo = true\n');
  assert.match(out, /\[features\]\ncodex_hooks = true\nfoo = true/);
});

test('mergeHooks preserves foreign hooks and replaces cctx hooks', () => {
  const { mergeHooks } = require('../hooks_install.js');
  const existing = JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'foreign hook' }] },
        { hooks: [{ type: 'command', command: '/Users/x/tools/codex-ctx/bin/cctx hook pre-tool-use' }] },
      ],
    },
  });
  const source = JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: '/Users/t/tools/codex-ctx/bin/cctx hook pre-tool-use' }] },
      ],
      Stop: [
        { hooks: [{ type: 'command', command: '/Users/t/tools/codex-ctx/bin/cctx hook stop' }] },
      ],
    },
  });
  const out = JSON.parse(mergeHooks(existing, source));
  assert.equal(out.hooks.PreToolUse.length, 2);
  assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'foreign hook');
  assert.match(out.hooks.PreToolUse[1].hooks[0].command, /cctx hook pre-tool-use/);
  assert.match(out.hooks.Stop[0].hooks[0].command, /cctx hook stop/);
});

test('materializeSourceHooks replaces portable hook placeholder', () => {
  const { materializeSourceHooks } = require('../hooks_install.js');
  const out = materializeSourceHooks('{"command":"__CCTX_BIN__ hook stop"}');
  assert.match(out, /bin\/cctx hook stop/);
  assert.doesNotMatch(out, /__CCTX_BIN__/);
});

test('ensurePluginConfig enables local marketplace, plugin, and MCP idempotently', () => {
  const { ensurePluginConfig, ensureMcpConfig } = require('../hooks_install.js');
  const once = ensureMcpConfig(ensurePluginConfig('model = "gpt-5.5"\n'));
  const twice = ensureMcpConfig(ensurePluginConfig(once));
  assert.equal(twice, once);
  assert.match(once, /\[marketplaces\.local-tools\]/);
  assert.match(once, /\[plugins\."codex-ctx@local-tools"\]/);
  assert.match(once, /\[mcp_servers\.codex-ctx\]/);
  assert.match(once, /enabled = true/);
});

test('source hooks include Codex SessionStart matcher and command', () => {
  const { SOURCE_HOOKS } = require('../hooks_install.js');
  const source = JSON.parse(fs.readFileSync(SOURCE_HOOKS, 'utf8'));
  const groups = source.hooks.SessionStart;
  assert.ok(Array.isArray(groups));
  assert.equal(groups[0].matcher, 'startup|resume|clear');
  assert.match(groups[0].hooks[0].command, /__CCTX_BIN__ hook session-start/);
});

test('doctorDeep runs local smoke checks', () => {
  const { doctorDeep } = require('../hooks_install.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-doctor-deep-'));
  const result = doctorDeep(cwd, {});
  assert.equal(result.deep.cache_rw.ok, true);
  assert.equal(result.deep.events_rw.ok, true);
  assert.equal(result.deep.facts_rw.ok, true);
  assert.equal(result.deep.mcp_tools.ok, true);
  assert.equal(result.deep.hooks_source.ok, true);
  assert.equal(typeof result.deep.git_status.ok, 'boolean');
});
