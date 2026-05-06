'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tokenize } = require('../search.js');
const { estimateTokens, detectLevel } = require('../token.js');
const { summarize } = require('../cache.js');
const { makeServer } = require('../mcp.js');
const { parseJSONLText } = require('../codex_history.js');

test('tokenize removes stopwords and keeps Turkish words', () => {
  const got = tokenize('bu proje için context hafızası lazım', { stopwords: { tr: ['bu', 'için'], en: [] } });
  assert.deepEqual(got, ['proje', 'context', 'hafızası', 'lazım']);
});

test('token estimate and level are stable', () => {
  const config = { limits: { chars_per_token: 4, thresholds: { watch: 0.4, compact: 0.55, urgent: 0.75, critical: 0.9 }, models: { default: { quality_ceiling: 10 } } } };
  const tokens = estimateTokens('x'.repeat(24), config);
  assert.equal(tokens, 6);
  assert.equal(detectLevel(tokens, config).level, 'compact');
});

test('summarize keeps head and tail for long content', () => {
  const out = summarize('a'.repeat(100) + 'b'.repeat(100), 40);
  assert.match(out, /omitted/);
  assert.ok(out.startsWith('a'));
  assert.ok(out.endsWith('b'.repeat(20)));
});

test('mcp tools/list returns tools', async () => {
  const server = makeServer([{ name: 'x', description: 'x tool', inputSchema: { type: 'object' }, handler: async () => 'ok' }], {});
  const res = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(res.result.tools[0].name, 'x');
});

test('mcp tools/list includes event tool in production set', async () => {
  const { allTools } = require('../mcp_tools.js');
  assert.ok(allTools().some(t => t.name === 'codex_ctx_events'));
  assert.ok(allTools().some(t => t.name === 'codex_ctx_savings'));
});

test('parseJSONLText skips malformed rows', () => {
  const rows = parseJSONLText('{"text":"ok"}\nnot-json\n{"text":"again"}\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].text, 'again');
});

test('ensureUserConfig merges new default fields into existing config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-config-'));
  process.env.CCTX_HOME = tmp;
  delete require.cache[require.resolve('../config.js')];
  const config = require('../config.js');
  fs.mkdirSync(path.dirname(config.USER_PATH), { recursive: true });
  fs.writeFileSync(config.USER_PATH, JSON.stringify({ cache: { summary_bytes: 777 } }, null, 2) + '\n');
  assert.equal(config.ensureUserConfig(), true);
  const got = JSON.parse(fs.readFileSync(config.USER_PATH, 'utf8'));
  assert.equal(got.cache.summary_bytes, 777);
  assert.equal(got.hooks.stop.snapshot_if_no_project_snapshot, true);
  assert.equal(got.hooks.stop.snapshot_event_threshold, 100);
});
