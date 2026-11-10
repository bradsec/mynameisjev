const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-exec-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
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
  assert.ok(!updates.safeRemote('https://user:pass@example.com/repo.git', 'HEAD'));
  assert.ok(!updates.safeRemote('https://token@example.com/repo.git', 'HEAD'));
  assert.ok(updates.safeRemote('ssh://git@example.com/repo.git', 'HEAD'));
  assert.ok(!updates.safeRemote('ssh://user:pass@example.com/repo.git', 'HEAD'));
  assert.ok(!updates.safeRemote('--upload-pack=touch /tmp/pwned', 'HEAD'));
  assert.ok(!updates.safeRemote('https://github.com/a/b.git', '--upload-pack=x'));
  assert.ok(!updates.safeRemote('https://example.com/a b', 'HEAD'));
  assert.ok(!updates.safeRemote('file:///etc', 'HEAD'));
});

test('run() works for a real executable without a shell', async () => {
  const out = await exec.run(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.strictEqual(out, 'ok');
});

// ── Executable lookup never uses the current directory ───────────────────────
// A relative or empty PATH entry means the current directory, and Windows also
// searches it first for a bare executable name. Hooks and the status line run
// in the project directory, so a file planted in a project must not start.
const { execFileSync } = require('child_process');
const scripts = path.join(__dirname, '..', 'plugin', 'scripts');
const decoyDir = path.join(tmp, 'project');
const binDir = path.join(tmp, 'bin');
for (const dir of [decoyDir, path.join(decoyDir, 'rel'), binDir]) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['git', 'git.exe', 'decoy', 'decoy.exe']) fs.writeFileSync(path.join(dir, name), '');
}
const relativePath = ['.', '', 'rel'].join(path.delimiter);

// Records every process start instead of making it.
const recorder = path.join(tmp, 'recorder.js');
fs.writeFileSync(recorder, `
if (process.env.JEV_TEST_PLATFORM) Object.defineProperty(process, 'platform', { value: process.env.JEV_TEST_PLATFORM });
const cp = require('child_process');
const note = (file) => require('fs').appendFileSync(process.env.JEV_TEST_RECORD, file + '\\n');
cp.execFileSync = (file) => { note(file); return ''; };
cp.spawnSync = (file) => { note(file); return { status: 0, stdout: '', stderr: '' }; };
cp.execFile = (file, args, opts, cb) => { note(file); (cb || opts)(null, '', ''); };
`);

// Runs `code` in a child with the recorder loaded, in the decoy project
// directory. Returns its stdout and the executables it tried to start.
function probe(code, env) {
  const record = path.join(tmp, 'starts.txt');
  fs.rmSync(record, { force: true });
  const out = execFileSync(process.execPath, ['-r', recorder, '-e', code], {
    cwd: decoyDir,
    env: { HOME: tmp, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), PATHEXT: '.exe', JEV_TEST_RECORD: record, ...env },
  }).toString();
  return { out, started: fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : [] };
}

test('findOnPath skips empty and relative PATH entries', () => {
  const code = `process.stdout.write(String(require(${JSON.stringify(path.join(scripts, 'jev-exec.js'))}).findOnPath('decoy')))`;
  assert.strictEqual(probe(code, { PATH: relativePath }).out, 'null');
  const found = probe(code, { PATH: [relativePath, binDir].join(path.delimiter) }).out;
  assert.strictEqual(path.dirname(found), binDir);
});

test('run() on Windows refuses a command that is not on PATH instead of starting a bare name', () => {
  const code = `require(${JSON.stringify(path.join(scripts, 'jev-exec.js'))}).run('git', ['--version']).then(() => process.stdout.write('ran'), (e) => process.stdout.write(e.message))`;
  const missing = probe(code, { JEV_TEST_PLATFORM: 'win32', PATH: relativePath });
  assert.deepStrictEqual(missing.started, []);
  assert.match(missing.out, /git not found on PATH/);
  const present = probe(code, { JEV_TEST_PLATFORM: 'win32', PATH: binDir });
  assert.deepStrictEqual(present.started, [path.join(binDir, 'git.exe')]);
  assert.strictEqual(present.out, 'ran');
});

test('sync: the project root lookup starts git by full path, or not at all', () => {
  const code = `require(${JSON.stringify(path.join(scripts, 'jev-sync.js'))}).projectInstructions(process.cwd())`;
  for (const platform of ['win32', 'linux']) {
    assert.deepStrictEqual(probe(code, { JEV_TEST_PLATFORM: platform, PATH: relativePath }).started, [], platform);
    const [git] = probe(code, { JEV_TEST_PLATFORM: platform, PATH: binDir }).started;
    assert.strictEqual(path.dirname(git), binDir, platform);
  }
});
