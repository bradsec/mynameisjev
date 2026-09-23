const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-exec-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');

const exec = require('../plugin/scripts/jev-exec');
const updates = require('../plugin/scripts/jev-updates');

test('Windows shell arguments: ids and paths pass, metacharacters are refused', () => {
  for (const ok of ['plugin', 'caveman@caveman', 'C:\\Users\\a b\\x.jsonl', '/tmp/x-1.jsonl', '--json']) {
    assert.ok(exec.shellSafe(ok), ok);
  }
  for (const bad of ['a"b', 'a&calc', 'a|b', 'a>b', '%PATH%', 'a^b', 'a!b', '(x)']) {
    assert.ok(!exec.shellSafe(bad), bad);
  }
});

test('git remotes from marketplace files: plain remotes pass, option injection is refused', () => {
  assert.ok(updates.safeRemote('https://github.com/obra/superpowers.git', 'HEAD'));
  assert.ok(updates.safeRemote('git@github.com:org/repo.git', 'release/v2'));
  assert.ok(!updates.safeRemote('--upload-pack=touch /tmp/pwned', 'HEAD'));
  assert.ok(!updates.safeRemote('https://github.com/a/b.git', '--upload-pack=x'));
  assert.ok(!updates.safeRemote('https://example.com/a b', 'HEAD'));
  assert.ok(!updates.safeRemote('file:///etc', 'HEAD'));
});

test('run() works for a real executable without a shell', async () => {
  const out = await exec.run(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.strictEqual(out, 'ok');
});
