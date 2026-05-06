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
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /cached wrapper/);
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
  assert.match(post.reason, /ref: [a-f0-9]{20}/);
  const pre = await hooks.handle('pre-tool-use', {
    cwd: '/tmp/project',
    tool_name: 'Bash',
    tool_input: { command: 'printf big' },
  }, config);
  assert.equal(pre.decision, 'block');
  assert.match(pre.reason, /duplicate Bash command/);
  assert.match(pre.reason, /codex_ctx_cache_get/);
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
  assert.match(out.hookSpecificOutput.additionalContext, /Stripe webhook fix/);
});

test('post-tool-use caches large output and replaces inline content', async () => {
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
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /codex_ctx_cache_get/);
  assert.match(out.reason, /ref: [a-f0-9]{20}/);
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

test('ensurePluginConfig enables local marketplace and plugin idempotently', () => {
  const { ensurePluginConfig } = require('../hooks_install.js');
  const once = ensurePluginConfig('model = "gpt-5.5"\n');
  const twice = ensurePluginConfig(once);
  assert.equal(twice, once);
  assert.match(once, /\[marketplaces\.local-tools\]/);
  assert.match(once, /\[plugins\."codex-ctx@local-tools"\]/);
  assert.match(once, /enabled = true/);
});
