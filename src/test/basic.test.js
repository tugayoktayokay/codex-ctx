'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../search.js');
const { estimateTokens, detectLevel } = require('../token.js');
const { summarize } = require('../cache.js');
const { makeServer } = require('../mcp.js');

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
