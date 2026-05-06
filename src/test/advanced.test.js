'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-advanced-'));
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.CCTX_HOME = path.join(tmp, 'cctx');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'history.jsonl'), [
  JSON.stringify({ session_id: 's1', ts: 1700000000, text: 'build OCR upload flow' }),
  JSON.stringify({ session_id: 's1', ts: 1700000060, text: 'fix S3 bucket config' }),
  JSON.stringify({ session_id: 's2', ts: 1700001000, text: 'write marketplace plugin hooks' }),
].join('\n') + '\n');

const advanced = require('../advanced.js');
const { writeSnapshot } = require('../snapshot.js');
const { writeCache } = require('../cache.js');

test('advanced metrics summarize Codex history', () => {
  const metrics = advanced.buildMetrics('/tmp/project', {});
  assert.equal(metrics.prompts, 3);
  assert.equal(metrics.sessions, 2);
  assert.equal(metrics.level, 'comfortable');
  assert.ok(metrics.top_terms.some(t => t.term === 'build'));
  assert.match(advanced.buildStatusline('/tmp/project', {}), /^cctx OK /);
});

test('savings report returns token accounting fields', () => {
  const report = advanced.parseHookSavings({});
  assert.equal(typeof report.cached_outputs, 'number');
  assert.equal(typeof report.net_saved_tokens, 'number');
  assert.match(advanced.buildSavings({}, {}), /Codex Ctx Savings/);
});

test('report and timeline include sessions and snapshots', () => {
  const config = { snapshot: { memory_dir: '{project_dir}/memory', history_limit: 10 } };
  const snap = writeSnapshot('/tmp/project', config, { name: 'test snapshot' });
  assert.ok(snap.outPath.endsWith('.md'));
  const report = advanced.buildReport('/tmp/project', config);
  assert.match(report, /Codex Ctx Report/);
  assert.match(report, /snapshots: 1/);
  const timeline = advanced.buildTimeline('/tmp/project', config);
  assert.match(timeline, /snapshot/);
  assert.match(timeline, /session/);
});

test('prune defaults to dry-run and does not delete files', () => {
  const cached = writeCache('x'.repeat(100));
  const old = Date.now() - 90 * 86400000;
  fs.utimesSync(cached.file, old / 1000, old / 1000);
  const result = advanced.prune('/tmp/project', {}, { days: 30 });
  assert.equal(result.dryRun, true);
  assert.equal(result.matched >= 1, true);
  assert.equal(fs.existsSync(cached.file), true);
});
