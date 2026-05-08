'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cctx-events-'));
process.env.CODEX_HOME = path.join(tmp, 'codex');
process.env.CCTX_HOME = path.join(tmp, 'cctx');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'history.jsonl'), JSON.stringify({
  session_id: 'evt',
  ts: 1700000000,
  text: 'fix event ledger snapshot',
}) + '\n');

const events = require('../events.js');
const { writeSnapshot } = require('../snapshot.js');
const { writeCache, sweepCache } = require('../cache.js');

test('event ledger appends and reads trimmed structured events', () => {
  const row = events.appendEvent('/tmp/project', {
    type: 'post_tool_use',
    tool_name: 'Bash',
    command: 'npm test',
    output: 'x'.repeat(200),
  }, { events: { max_string: 20 } });
  assert.equal(row.type, 'post_tool_use');
  assert.match(row.output, /truncated/);
  const rows = events.readEvents('/tmp/project', { limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].command, 'npm test');
});

test('snapshot includes event-ledger sections', () => {
  events.appendEvent('/tmp/project', { type: 'user_prompt_submit', prompt: 'decision: use events' }, {});
  events.appendEvent('/tmp/project', { type: 'cache_write', cache_ref: 'abc123', bytes: 99, tool_name: 'Bash', command: 'big' }, {});
  const result = writeSnapshot('/tmp/project', { snapshot: { history_limit: 10 } }, { name: 'rich' });
  const body = fs.readFileSync(result.outPath, 'utf8');
  assert.match(body, /## Decisions/);
  assert.match(body, /decision: use events/);
  assert.match(body, /## Open Problems/);
  assert.match(body, /## Failed Attempts/);
  assert.match(body, /## Important Commands/);
  assert.match(body, /## Cache References/);
  assert.match(body, /abc123/);
});

test('cache writes metadata and sweep removes expired files', () => {
  const cached = writeCache('payload', { cache: { gc: { enabled: false, ttl_hours: 1 } } });
  assert.equal(fs.existsSync(cached.file + '.meta'), true);
  const old = Date.now() - 10 * 3600 * 1000;
  fs.utimesSync(cached.file, old / 1000, old / 1000);
  const result = sweepCache({ cache: { gc: { ttl_hours: 1, max_bytes: 1000000 } } });
  assert.equal(result.swept >= 1, true);
  assert.equal(fs.existsSync(cached.file), false);
});
