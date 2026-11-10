// S2: wrap mode must run the user's status line command through the shell
// Claude Code itself uses. On Windows that is Git Bash when it is installed
// and PowerShell otherwise, never cmd.exe
// (https://code.claude.com/docs/en/statusline#windows-configuration).
//
// These tests run the real script with process.platform stubbed to win32 and
// spawnSync replaced by a recorder, so they show which shell would start
// without needing Windows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const script = path.join(__dirname, '..', 'plugin', 'scripts', 'cc-statusline.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-statusline-s2-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const claudeDir = path.join(tmp, 'claude');
fs.mkdirSync(path.join(claudeDir, 'mynameisjev'), { recursive: true });
const record = path.join(tmp, 'spawn.json');
const preload = path.join(tmp, 'win32-stub.js');
fs.writeFileSync(preload, `
Object.defineProperty(process, 'platform', { value: process.env.JEV_S2_PLATFORM });
if (process.env.JEV_S2_SYSTEMROOT) process.env.SystemRoot = process.env.JEV_S2_SYSTEMROOT;
else delete process.env.SystemRoot;
require('child_process').spawnSync = (file, args, options) => {
  if (!Array.isArray(args)) { options = args; args = []; }
  require('fs').writeFileSync(process.env.JEV_S2_RECORD, JSON.stringify({ file, args, shell: options.shell || false }));
  return { status: 0, stdout: 'MINE\\n', stderr: '' };
};
require('child_process').execFileSync = (file) => {
  require('fs').appendFileSync(process.env.JEV_S2_RECORD + '.git', file + '\\n');
  return '# branch.head main\\n';
};
`);

const COMMAND = '~/.claude/statusline.sh --flag "a b"';

// Runs the status line in wrap mode on a stubbed platform; returns what it
// printed and the spawnSync call it made for the wrapped command.
function wrapped(platform, extraEnv, cwd = tmp) {
  fs.rmSync(record, { force: true });
  fs.writeFileSync(path.join(claudeDir, 'mynameisjev', 'state.json'), JSON.stringify({
    enabled: true, statusLineMode: 'wrap', previousStatusLine: { type: 'command', command: COMMAND },
  }));
  // A bare environment: nothing from the host can supply a shell. On real
  // Windows node itself cannot start without the real SystemRoot, so the
  // child keeps it and the preload swaps in the test's value (or none) before
  // the script runs.
  const { SystemRoot: testRoot, ...rest } = extraEnv || {};
  const env = {
    HOME: tmp, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex'),
    PATH: path.join(tmp, 'empty'), PATHEXT: '.exe',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    JEV_S2_SYSTEMROOT: testRoot || '',
    JEV_S2_PLATFORM: platform, JEV_S2_RECORD: record, ...rest,
  };
  const out = execFileSync(process.execPath, ['-r', preload, script], { input: '{"model":{"display_name":"Opus 5.5"}}', env, cwd }).toString();
  return { out, call: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null };
}

function touch(...parts) {
  const file = path.join(tmp, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

// A stand-in Windows directory holding Windows PowerShell 5.1.
const SystemRoot = path.join(tmp, 'Windows');
const powershell = touch('Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// With no usable SystemRoot the script falls back to C:\Windows. That file
// exists only on real Windows; elsewhere nothing starts.
const fallback = ['C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'].join(path.sep);
const fallbackCall = path.isAbsolute(fallback) && fs.existsSync(fallback)
  ? { file: fallback, args: ['-NoProfile', '-NonInteractive', '-Command', COMMAND], shell: false }
  : null;

test('S2: on Windows the wrapped command runs through Git Bash, not cmd.exe', () => {
  const bash = touch('set', 'bin', 'bash.exe');
  const { out, call } = wrapped('win32', { CLAUDE_CODE_GIT_BASH_PATH: bash });
  assert.strictEqual(out, 'MINE');
  // shell: true on win32 is cmd.exe (ComSpec), which is not what Claude Code uses.
  assert.strictEqual(call.shell, false, 'must not go through cmd.exe');
  assert.deepStrictEqual(call, { file: bash, args: ['-c', COMMAND], shell: false });
});

test('S2: Git Bash is found next to git on PATH', () => {
  const git = touch('Git', 'cmd', 'git.exe');
  const bash = touch('Git', 'bin', 'bash.exe');
  const { call } = wrapped('win32', { PATH: path.dirname(git) });
  assert.deepStrictEqual(call, { file: bash, args: ['-c', COMMAND], shell: false });
});

test('S2: a CLAUDE_CODE_GIT_BASH_PATH that is missing or not bash is ignored', () => {
  const notBash = touch('set', 'bin', 'zsh.exe');
  for (const value of [notBash, path.join(tmp, 'nowhere', 'bash.exe')]) {
    const { call } = wrapped('win32', { SystemRoot, CLAUDE_CODE_GIT_BASH_PATH: value });
    assert.strictEqual(call.file, powershell, value);
  }
});

test('S2: on Windows without Git Bash the wrapped command runs through PowerShell', () => {
  const args = ['-NoProfile', '-NonInteractive', '-Command', COMMAND];
  assert.deepStrictEqual(wrapped('win32', { SystemRoot }).call, { file: powershell, args, shell: false });
  // PowerShell 7 wins over Windows PowerShell 5.1 when it is installed.
  const pwsh = touch('ps7', 'pwsh.exe');
  assert.deepStrictEqual(wrapped('win32', { SystemRoot, PATH: path.dirname(pwsh) }).call, { file: pwsh, args, shell: false });
});

test('S2: off Windows the wrapped command still runs through the default shell', () => {
  assert.deepStrictEqual(wrapped('linux').call, { file: COMMAND, args: [], shell: true });
});

// P1: Windows searches the current directory before PATH for a bare executable
// name, and the status line runs in the project directory, so a file planted
// in a project must never be what starts.
test('S2/P1: a decoy shell in the working directory is never started', () => {
  const proj = path.join(tmp, 'proj', 'root');
  for (const name of ['powershell.exe', 'pwsh.exe', 'bash.exe', 'git.exe']) touch('proj', 'root', name);
  touch('proj', 'bin', 'bash.exe'); // where "next to git" lands for a git found through PATH "."
  touch('proj', 'root', 'rel', 'pwsh.exe');
  touch('proj', 'root', 'Git', 'bin', 'bash.exe');
  const relativePaths = ['.', '', 'rel'].join(path.delimiter);
  const hostile = {
    SystemRoot, PATH: relativePaths, CLAUDE_CODE_GIT_BASH_PATH: 'bash.exe',
    ProgramFiles: '.', 'ProgramFiles(x86)': '', LOCALAPPDATA: '.',
  };
  const { call } = wrapped('win32', hostile, proj);
  assert.ok(path.isAbsolute(call.file), `started ${call.file}`);
  assert.strictEqual(call.file, powershell);
  // No environment at all still gives an absolute path, never a bare name:
  // only the real Windows PowerShell, or nothing where it does not exist.
  assert.deepStrictEqual(wrapped('win32', { PATH: '' }, proj).call, fallbackCall, 'only PowerShell where Windows keeps it may start');
  // A relative SystemRoot is not trusted either.
  assert.deepStrictEqual(wrapped('win32', { SystemRoot: '.', PATH: '' }, proj).call, fallbackCall);
});

test('S2/P1: with no usable shell, wrap mode says so and starts nothing', () => {
  const { out, call } = wrapped('win32', { SystemRoot: path.join(tmp, 'empty') });
  assert.strictEqual(call, null);
  assert.match(out, /mynameisjev: no shell found to run your status line command/);
});

// P1-a: the normal status line starts git on every refresh.
test('S2/P1-a: git runs by full path from PATH, and a decoy in the working directory never starts', () => {
  const proj = path.join(tmp, 'gitproj');
  touch('gitproj', 'git.exe');
  touch('gitproj', 'rel', 'git.exe');
  const git = touch('gitbin', 'git.exe');
  const gitRecord = record + '.git';
  const run = (PATH) => {
    fs.rmSync(gitRecord, { force: true });
    fs.writeFileSync(path.join(claudeDir, 'mynameisjev', 'state.json'), JSON.stringify({ enabled: true }));
    const env = { HOME: tmp, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex'), PATH, PATHEXT: '.exe', JEV_S2_PLATFORM: 'win32', JEV_S2_RECORD: record };
    const out = execFileSync(process.execPath, ['-r', preload, script], { input: JSON.stringify({ model: { display_name: 'Opus 5.5' }, cwd: proj }), env, cwd: proj }).toString();
    return { out, started: fs.existsSync(gitRecord) ? [...new Set(fs.readFileSync(gitRecord, 'utf8').split('\n').filter(Boolean))] : [] };
  };
  const none = run(['.', '', 'rel'].join(path.delimiter));
  assert.deepStrictEqual(none.started, [], 'no git on an absolute PATH entry: nothing starts');
  assert.doesNotMatch(none.out, /GIT/);
  const found = run(['.', path.dirname(git)].join(path.delimiter));
  assert.deepStrictEqual(found.started, [git]);
  assert.match(found.out, /GIT/);
});
