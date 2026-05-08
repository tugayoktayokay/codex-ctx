'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-memory-'));
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.CCTX_HOME = path.join(tmp, 'cctx');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const { appendEvent } = require('../events.js');
const memory = require('../memory.js');

test('memory retains and recalls project facts from events', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-project-'));
  appendEvent(cwd, { type: 'user_prompt_submit', prompt: 'decision: use JWT refresh tokens for auth' }, {});
  appendEvent(cwd, { type: 'cache_write', cache_ref: 'abc123', bytes: 12000, command: 'npm test' }, {});
  const retained = memory.retainFacts(cwd, {});
  assert.equal(retained.extracted >= 2, true);
  assert.equal(typeof retained.duration_ms, 'number');
  assert.equal(typeof retained.timed_out, 'boolean');
  const hits = memory.recallFacts(cwd, 'auth refresh token decision', {});
  assert.equal(hits.length >= 1, true);
  assert.match(hits[0].text, /refresh tokens|JWT/i);
  assert.equal(typeof hits[0].quality, 'number');
  assert.match(memory.buildRecall(cwd, 'npm test cache', {}), /abc123|npm test/);
});

test('memory recall skips generic prompts', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-project-generic-'));
  assert.deepEqual(memory.recallFacts(cwd, 'devam', {}), []);
});

test('memory can disable passive prompt extraction', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-project-passive-'));
  appendEvent(cwd, { type: 'user_prompt_submit', prompt: 'decision: use Redis for queue state' }, {});
  appendEvent(cwd, { type: 'pre_tool_use', command: 'curl -sS http://localhost:3001/health' }, {});
  memory.retainFacts(cwd, { memory: { passive_prompt_extraction: false } });
  assert.equal(memory.recallFacts(cwd, 'Redis queue state', {}).length, 0);
  assert.match(memory.buildRecall(cwd, 'localhost health endpoint', {}), /localhost:3001/);
});

test('memory supports explicit remember and forget', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-project-manual-'));
  const remembered = memory.rememberFact(cwd, 'we use Postgres for analytics, not Mongo', {}, { kind: 'constraint' });
  assert.equal(remembered.ok, true);
  assert.match(memory.buildRecall(cwd, 'Postgres analytics database', {}), /Postgres/);
  const dry = memory.forgetFacts(cwd, 'Postgres', {}, { dryRun: true });
  assert.equal(dry.removed, 1);
  assert.match(memory.buildRecall(cwd, 'Postgres analytics database', {}), /Postgres/);
  const exactMiss = memory.forgetFacts(cwd, 'Postgres', {}, { dryRun: true, exact: true });
  assert.equal(exactMiss.removed, 0);
  const idDry = memory.forgetFacts(cwd, remembered.fact.id, {}, { dryRun: true, id: true });
  assert.equal(idDry.removed, 1);
  const deleted = memory.forgetFacts(cwd, 'Postgres', {}, { dryRun: false });
  assert.equal(deleted.removed, 1);
  assert.equal(memory.recallFacts(cwd, 'Postgres analytics database', {}).length, 0);
});

test('memory path boost and audit/prune work', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-project-path-'));
  memory.writeFacts(cwd, [
    {
      id: 'pathfact',
      cwd,
      kind: 'decision',
      text: 'decision: src/auth.ts uses refresh token rotation',
      paths: ['src/auth.ts'],
      ts: new Date().toISOString(),
      weight: 3,
      quality: 0.9,
      seen: 1,
    },
    {
      id: 'noisy',
      cwd,
      kind: 'test',
      text: 'sed -n 1,20p src/noise.ts bytes=20',
      paths: ['src/noise.ts'],
      ts: new Date().toISOString(),
      weight: 1,
      quality: 0.3,
      seen: 1,
    },
    {
      id: 'dupe1',
      cwd,
      kind: 'decision',
      text: 'decision: duplicate memory fact',
      paths: [],
      ts: new Date().toISOString(),
      weight: 2,
      quality: 0.8,
      seen: 1,
    },
    {
      id: 'dupe2',
      cwd,
      kind: 'decision',
      text: 'decision: duplicate memory fact',
      paths: [],
      ts: new Date().toISOString(),
      weight: 2,
      quality: 0.8,
      seen: 1,
    },
    {
      id: 'residue',
      cwd,
      kind: 'decision',
      text: 'review note: testler yeşil ship-ready previous hook discussion',
      paths: [],
      ts: new Date().toISOString(),
      weight: 1,
      quality: 0.8,
      seen: 1,
    },
  ]);
  const hits = memory.recallFacts(cwd, 'auth refresh token', {}, { paths: ['src/auth.ts'] });
  assert.equal(hits[0].id, 'pathfact');
  const audit = memory.auditFacts(cwd, {});
  assert.match(audit, /low_quality:/);
  assert.match(audit, /duplicate_groups: 1/);
  assert.match(audit, /conversation_residue: 1/);
  const dry = memory.pruneFacts(cwd, { memory: { prune_quality_below: 0.5 } }, { dryRun: true });
  assert.equal(dry.removed >= 1, true);
  const thresholdDry = memory.pruneFacts(cwd, {}, { qualityBelow: 0.31, dryRun: true });
  assert.equal(thresholdDry.quality_below, 0.31);
  const pruned = memory.pruneFacts(cwd, { memory: { prune_quality_below: 0.5 } }, { dryRun: false });
  assert.equal(pruned.removed >= 1, true);
});

test('memory auto-seeds endpoints and workflows from commands', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-project-seed-'));
  appendEvent(cwd, { type: 'pre_tool_use', command: 'curl -sS http://localhost:3001/health' }, {});
  appendEvent(cwd, { type: 'pre_tool_use', command: 'curl -sS https://hakliyim.co/api/v1/education/tips' }, {});
  appendEvent(cwd, { type: 'pre_tool_use', command: 'npx tsx src/index.ts > /tmp/hakliyim-server-dev.log 2>&1' }, {});
  appendEvent(cwd, { type: 'pre_tool_use', command: 'npx expo start --dev-client --port 8082 --host lan' }, {});
  appendEvent(cwd, { type: 'pre_tool_use', command: "sed -n '1,80p' hakliyim-server/src/routes/education.ts" }, {});
  memory.retainFacts(cwd, {});
  assert.match(memory.buildRecall(cwd, 'education tips endpoint', {}), /education\/tips/);
  assert.match(memory.buildRecall(cwd, 'backend dev server', {}), /npx tsx src\/index\.ts/);
  assert.match(memory.buildRecall(cwd, 'expo mobile dev client', {}), /Expo dev client/);
  assert.match(memory.buildRecall(cwd, 'education route file', {}), /routes\/education\.ts/);
});
