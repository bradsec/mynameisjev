// P-F6: a typed prompt that opens with a tag (pasted HTML or XML) is the
// user's request, not a harness message.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compact-pf6-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
fs.mkdirSync(path.join(tmp, 'claude', 'mynameisjev'), { recursive: true });
const compact = require('../plugin/scripts/jev-compact');
const check = require('../plugin/scripts/jev-check');

const user = (content) => ({ type: 'user', message: { role: 'user', content } });
const HTML = '<div class="card">Title</div> make this markup accessible and add tests';

test('P-F6: userText keeps a typed prompt that opens with a tag', () => {
  assert.strictEqual(compact.userText(user(HTML)), HTML);
  assert.strictEqual(compact.userText(user('<p>fix this paragraph</p>')), '<p>fix this paragraph</p>');
  assert.strictEqual(compact.userText(user('  <my-widget> is broken, fix it')), '<my-widget> is broken, fix it');
  assert.strictEqual(compact.userText(user([{ type: 'text', text: HTML }])), HTML);
});

test('P-F6: userText still drops harness messages', () => {
  const harness = [
    '<command-name>/effort</command-name>',
    '<command-message>effort</command-message>\n<command-name>/effort</command-name>',
    '<command-args>high</command-args>',
    '<local-command-stdout>Set effort to high</local-command-stdout>',
    '<local-command-stderr>failed</local-command-stderr>',
    '<local-command-caveat>Caveat: the messages below</local-command-caveat>',
    '<bash-input>ls</bash-input>',
    '<bash-stdout>a.js</bash-stdout><bash-stderr></bash-stderr>',
    '<bash-stderr>no such file</bash-stderr>',
    '<task-notification> <task-id>a1</task-id> done</task-notification>',
    '<task-notification>\n<task-id>a1</task-id>\n</task-notification>',
    '  <system-reminder>\nKeep going.\n</system-reminder>',
  ];
  for (const text of harness) assert.strictEqual(compact.userText(user(text)), null, text);
});

test('P-F6: the compaction digest keeps a request that opens with a tag', () => {
  const lines = [
    user('<command-name>/effort</command-name>'),
    user(HTML),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const digest = compact.buildDigest(lines);
  assert.ok(digest, 'digest is built');
  assert.ok(digest.includes(`- ${HTML}`), digest);
  assert.doesNotMatch(digest, /effort/);
});

test('P-F6: the completeness check sees a request that opens with a tag', () => {
  const file = path.join(tmp, 't.jsonl');
  fs.writeFileSync(file, [
    user(HTML),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.html' } }] } },
  ].map((e) => JSON.stringify(e)).join('\n'));
  assert.strictEqual(check.lastTurn(file, '/p').request, HTML);
});
