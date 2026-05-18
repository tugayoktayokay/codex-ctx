'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
const { appendEvent } = require('../events.js');
const memory = require('../memory.js');

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
  assert.match(advanced.buildSavings({ cwd: '/tmp/project', config: {}, json: false }), /Codex Ctx Savings/);
});

test('project savings are calculated from project event ledger', () => {
  const cwd = '/tmp/project-savings';
  appendEvent(cwd, { type: 'cache_write', cache_ref: 'abc', bytes: 10000, command: 'big' }, {});
  appendEvent(cwd, { type: 'pre_tool_use_decision', decision: 'block', command: 'cat package-lock.json' }, {});
  const report = advanced.parseProjectSavings(cwd, { limits: { chars_per_token: 4 }, cache: { summary_bytes: 1000 } });
  assert.equal(report.scope, 'project');
  assert.equal(report.cached_outputs, 1);
  assert.equal(report.gross_tokens_avoided, 2500);
  assert.equal(report.replacement_tokens, 295);
  assert.equal(report.cache_saved_tokens, 2205);
  assert.equal(report.cache_saved_tokens_optimistic, 2205);
  assert.equal(report.cache_saved_tokens_realistic, 2205);
  assert.equal(report.savings_mode, 'blocked_repeat_realistic');
  assert.equal(report.pre_tool_blocks, 1);
  assert.match(advanced.buildSavings(cwd, {}, {}), /Codex Ctx Savings \(project\)/);
  assert.match(advanced.buildSavings(cwd, {}, {}), /cache_saved_tokens_realistic/);
});

test('project savings distinguish optimistic cache writes from realistic repeats', () => {
  const cwd = '/tmp/project-savings-realistic';
  appendEvent(cwd, { type: 'cache_write', cache_ref: 'abc', bytes: 10000, command: 'big-a' }, {});
  appendEvent(cwd, { type: 'cache_write', cache_ref: 'def', bytes: 10000, command: 'big-b' }, {});
  appendEvent(cwd, { type: 'pre_tool_use_decision', decision: 'block', command: 'big-a' }, {});
  const report = advanced.parseProjectSavings(cwd, { limits: { chars_per_token: 4 }, cache: { summary_bytes: 1000 } });
  assert.equal(report.cache_saved_tokens_optimistic, 4410);
  assert.equal(report.cache_saved_tokens_realistic, 2205);
  assert.equal(report.cache_saved_tokens, 2205);
});

test('project savings count actual cache read reuse', () => {
  const cwd = '/tmp/project-savings-cache-read';
  appendEvent(cwd, { type: 'cache_write', cache_ref: 'abc', bytes: 10000, command: 'big-a' }, {});
  appendEvent(cwd, { type: 'cache_read', cache_ref: 'abc', result: 'hit', bytes: 1000, total: 10000 }, {});
  const report = advanced.parseProjectSavings(cwd, { limits: { chars_per_token: 4 }, cache: { summary_bytes: 1000 } });
  assert.equal(report.cache_read_hits, 1);
  assert.equal(report.cache_read_misses, 0);
  assert.equal(report.cache_reuse_rate, 1);
  assert.equal(report.cache_saved_tokens_from_reads, 2205);
  assert.equal(report.cache_saved_tokens, 2205);
  assert.match(advanced.buildSavings(cwd, {}, {}), /cache_read_hits: 1/);
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

test('working set and repo map produce compact project context', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-project-'));
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export function start() { return 1; }\nclass LocalThing {}\n');
  appendEvent(cwd, { type: 'pre_tool_use', command: "sed -n '1,80p' src/app.ts" }, {});
  appendEvent(cwd, { type: 'cache_write', cache_ref: 'abc', bytes: 8000, command: 'npm test' }, {});
  const ws = advanced.buildWorkingSet(cwd, {});
  assert.match(ws, /src\/app\.ts/);
  assert.match(ws, /abc/);
  const map = advanced.buildRepoMap(cwd, {}, { limit: 20 });
  assert.match(map, /src\/app\.ts: start, LocalThing/);
});

test('working set includes git status changes', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-git-project-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  fs.writeFileSync(path.join(cwd, 'active.ts'), 'export const active = true;\n');
  const ws = advanced.buildWorkingSet(cwd, {});
  assert.match(ws, /## Git Changes/);
  assert.match(ws, /\?\? active\.ts/);
  assert.match(ws, /active\.ts/);
});

test('ask combines snapshots facts events and git commits', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-ask-project-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
  fs.writeFileSync(path.join(cwd, 'README.md'), 'stripe webhook repo note\n');
  execFileSync('git', ['add', 'README.md'], { cwd });
  execFileSync('git', ['commit', '-m', 'add stripe webhook repo note'], { cwd, stdio: 'ignore' });
  const config = { snapshot: { memory_dir: path.join(cwd, 'memory'), history_limit: 10 }, retrieval: { min_score: 0.01 } };
  fs.mkdirSync(path.join(cwd, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'memory', 'stripe-webhook-fix.md'), '# Stripe webhook fix\n\nUse raw body verification for the API route.');
  memory.rememberFact(cwd, 'decision: stripe webhook API uses raw body verification', config, { kind: 'decision' });
  appendEvent(cwd, { type: 'pre_tool_use_decision', decision: 'block', reason: 'stripe webhook command was repeated', command: 'npm test stripe' }, {});
  const out = advanced.buildAsk(cwd, 'stripe webhook api', config);
  assert.match(out, /\[snapshot\]/);
  assert.match(out, /\[fact:decision\]/);
  assert.match(out, /\[event\]/);
  assert.match(out, /\[git\]/);
});

test('ask supports since filters', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-ask-since-'));
  const config = { snapshot: { memory_dir: path.join(cwd, 'memory'), history_limit: 10 } };
  fs.mkdirSync(path.join(cwd, 'memory'), { recursive: true });
  const oldSnap = path.join(cwd, 'memory', 'old-auth.md');
  const newSnap = path.join(cwd, 'memory', 'new-auth.md');
  fs.writeFileSync(oldSnap, '# Old auth\n\nlegacy auth note');
  fs.writeFileSync(newSnap, '# New auth\n\nfresh auth note');
  const old = Date.now() - 10 * 86400000;
  fs.utimesSync(oldSnap, old / 1000, old / 1000);
  const out = advanced.buildAsk(cwd, 'fresh auth note', config, { since: '1d' });
  assert.doesNotMatch(out, /old-auth/);
  assert.match(out, /new-auth/);
});

test('snapshot diff is grouped by markdown section', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-diff-'));
  const memoryDir = path.join(cwd, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, '1-old.md'), '# Old\n\n## Decisions\n\n- old decision\n\n## Changed Files\n\n- old.ts\n');
  fs.writeFileSync(path.join(memoryDir, '2-new.md'), '# New\n\n## Decisions\n\n- new decision\n\n## Changed Files\n\n- new.ts\n');
  const out = advanced.diffLatestSnapshots(cwd, { snapshot: { memory_dir: memoryDir } });
  assert.match(out, /## Decisions/);
  assert.match(out, /\+ - new decision/);
  assert.match(out, /- - old decision/);
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
