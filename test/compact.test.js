const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compact-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const dataDir = path.join(tmp, 'claude', 'mynameisjev');
fs.mkdirSync(dataDir, { recursive: true });
const compact = require('../plugin/scripts/jev-compact');

const user = (content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });
const edit = (name, file) => ({ type: 'tool_use', name, input: { file_path: file } });

const transcript = [
  user('old request before the last compaction'),
  assistant([edit('Edit', '/p/old.js')]),
  JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
  user('This session is being continued from a previous conversation...', { isCompactSummary: true }),
  user('<command-name>/effort</command-name>'),
  user('<task-notification> <task-id>a1</task-id> done</task-notification>'),
  user('Add a retry to the fetch helper'),
  assistant([{ type: 'text', text: 'Looking.' }, edit('Edit', '/p/fetch.js')]),
  user([{ type: 'tool_result', content: 'ok' }]),
  user([{ type: 'text', text: 'Now   cover it\nwith a test' }]),
  assistant([edit('Write', '/p/fetch.test.js'), edit('Edit', '/p/fetch.js'), edit('Read', '/p/other.js')]),
  JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'subagent prompt' } }),
  assistant([{ type: 'text', text: 'Tests pass. Next: wire it into the CLI.' }]),
  '{"cut',
].join('\n');

test('digest: requests, edited files and last reply since the last compaction', () => {
  const d = compact.buildDigest(transcript);
  assert.match(d, /Latest requests from the user \(oldest first\):\n- Add a retry to the fetch helper\n- Now cover it with a test/);
  assert.match(d, /Files edited or written \(most recent last\): \/p\/fetch\.test\.js, \/p\/fetch\.js\n/);
  assert.match(d, /Your last reply ended with: Tests pass\. Next: wire it into the CLI\./);
  assert.doesNotMatch(d, /old request|old\.js|effort|subagent prompt|continued from|other\.js/);
});

test('digest: paths under cwd are relative', () => {
  assert.match(compact.buildDigest(transcript, '/p'), /\(most recent last\): fetch\.test\.js, fetch\.js\n/);
  assert.match(compact.buildDigest(transcript, '/elsewhere'), /: \/p\/fetch\.test\.js/);
});

test('digest: nothing worth keeping gives null', () => {
  assert.strictEqual(compact.buildDigest(assistant([{ type: 'text', text: 'hi' }])), null);
});

test('save then restore hands the digest over once, only on compact', () => {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true }));
  const file = path.join(tmp, 't.jsonl');
  fs.writeFileSync(file, transcript);
  compact.save({ session_id: 's1', transcript_path: file });
  assert.strictEqual(compact.restore({ session_id: 's1', source: 'startup' }), null);
  const out = compact.restore({ session_id: 's1', source: 'compact' });
  assert.match(out.hookSpecificOutput.additionalContext, /Add a retry/);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.strictEqual(compact.restore({ session_id: 's1', source: 'compact' }), null, 'used once');
});

test('does nothing with the router off', () => {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: false }));
  const file = path.join(tmp, 't.jsonl');
  compact.save({ session_id: 's2', transcript_path: file });
  assert.ok(!fs.existsSync(compact.digestPath('s2')));
});
