const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-run-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const scripts = path.join(tmp, 'plugins/cache/openai-codex/codex/1.0.0/scripts');
fs.mkdirSync(scripts, { recursive: true });
const companion = path.join(scripts, 'codex-companion.mjs');
const wrapper = path.join(__dirname, '../plugin/scripts/jev-codex-run.js');
const run = (source, flags = [], input = '', cwd = undefined) => {
  fs.writeFileSync(companion, source);
  return spawnSync(process.execPath, [wrapper, ...flags], {
    encoding: 'utf8', input, cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: tmp },
  });
};

test('success passes stdout and prints only the first thread line', () => {
  const result = run(`process.stdout.write('job-123\\n');
    process.stderr.write('progress\\n[codex] Thread ready (first).\\n[codex] Thread ready (second).\\n');`);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, 'job-123\n[codex] Thread ready (first).\n', '']);
});

test('success without a thread line hides all progress stderr', () => {
  const result = run("process.stderr.write('progress\\n');");
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
});

test('passes flags and shell-sensitive stdin unchanged to companion task', () => {
  const input = '"quoted" \'single\' $HOME `backticks`\nsecond line';
  const result = run(`if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['task', '--background', '--write'])) process.exit(9);
    process.stdin.pipe(process.stdout);`, ['--background', '--write'], input);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, input, '']);
});

for (const command of ['status', 'result']) {
  for (const status of [0, 7]) {
    test(`${command} passes args, stdin, stdout and unfiltered stderr with exit ${status}`, () => {
      const result = run(`process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');
        process.stdin.pipe(process.stdout);
        process.stderr.write('progress\\n[codex] Thread ready (unchanged).\\n' + 'line\\n'.repeat(25));
        process.exitCode = ${status};`, [command, 'job-123'], 'stdin');
      assert.deepEqual([result.status, result.stdout, result.stderr], [status,
        `["${command}","job-123"]\nstdin`,
        'progress\n[codex] Thread ready (unchanged).\n' + 'line\n'.repeat(25)]);
    });
  }
}

test('failure prints the last 20 stderr lines and keeps exit status', () => {
  const result = run(`process.stdout.write('partial output');
    process.stderr.write(Array.from({length: 25}, (_, i) => 'line ' + (i + 1)).join('\\n') + '\\n');
    process.exitCode = 7;`);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'partial output');
  assert.equal(result.stderr, Array.from({ length: 20 }, (_, i) => `line ${i + 6}\n`).join(''));
});

test('failure preserves a final stderr line without newline', () => {
  const result = run("process.stderr.write('fatal'); process.exitCode = 3;");
  assert.deepEqual([result.status, result.stderr], [3, 'fatal']);
});

test('early child exit preserves failure while stdin is still being piped', () => {
  const result = run("process.stderr.write('blocked\\n'); process.exit(7);", [], 'x'.repeat(1024 * 1024));
  assert.deepEqual([result.status, result.stderr], [7, 'blocked\n']);
});

test('child signal produces a non-zero status', () => {
  const result = run("process.kill(process.pid, 'SIGTERM');");
  assert.ok(result.status !== null && result.status !== 0);
});

test('missing companion reports an error and fails', () => {
  fs.rmSync(companion);
  const result = spawnSync(process.execPath, [wrapper], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: tmp },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /companion.*not found/i);
});

// A repository with one committed file left dirty, so the report must leave
// out changes made before the task.
function repo() {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a dirty\n');
  return dir;
}
const edit = "import fs from 'fs'; fs.writeFileSync('b.txt', 'b changed\\n'); fs.writeFileSync('c.txt', 'new\\n');";

test('a foreground --write task reports only the files it changed, with their diff', () => {
  const result = run(edit, ['--write'], '', repo());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^M b\.txt$/m);
  assert.match(result.stdout, /^\? c\.txt \(new, untracked\)$/m);
  assert.match(result.stdout, /^\+b changed$/m);
  assert.doesNotMatch(result.stdout, /a\.txt|a dirty/);
});

test('read-only, background and failed tasks print no change report', () => {
  for (const flags of [[], ['--write', '--background']]) {
    assert.doesNotMatch(run(edit, flags, '', repo()).stdout, /Jev: /);
  }
  assert.doesNotMatch(run(`${edit} process.exit(3);`, ['--write'], '', repo()).stdout, /Jev: /);
});

test('a --write task that changes nothing says so', () => {
  assert.match(run('', ['--write'], '', repo()).stdout, /Jev: the task changed no files\./);
});

test('outside a git repository the change report is skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-norepo-'));
  try {
    const result = run('', ['--write'], '', dir);
    assert.deepEqual([result.status, result.stdout], [0, '']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
