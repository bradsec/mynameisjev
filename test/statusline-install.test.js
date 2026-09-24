// Runs /mynameisjev:statusline through the CLI against a throwaway config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const cli = path.join(__dirname, '..', 'plugin', 'scripts', 'jev-cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sl-install-'));
const claudeDir = path.join(tmp, 'claude');
const project = path.join(tmp, 'project');
const settingsPath = path.join(claudeDir, 'settings.json');
const statePath = path.join(claudeDir, 'mynameisjev', 'state.json');
fs.mkdirSync(path.join(project, '.claude'), { recursive: true });

function run(...args) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex'), CLAUDE_PROJECT_DIR: project, HOME: tmp, USERPROFILE: tmp };
  return execFileSync(process.execPath, [cli, 'statusline', ...args], { env, cwd: project }).toString();
}
const settings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const reset = (s) => {
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  if (s !== undefined) fs.writeFileSync(settingsPath, typeof s === 'string' ? s : JSON.stringify(s));
};

test('install works without a settings.json', () => {
  reset();
  assert.match(run('install'), /Status line installed\./);
  assert.match(settings().statusLine.command, /statusline\.js"$/);
  assert.strictEqual(state().statusLineMode, 'full');
});

test('an unreadable settings.json is left alone', () => {
  reset('{ "theme": ');
  assert.match(run('install'), /is not valid JSON/);
  assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{ "theme": ');
});

test('wrap needs a status line of your own', () => {
  reset({});
  assert.match(run('wrap'), /no status line of your own to wrap/);
  assert.strictEqual(settings().statusLine, undefined);
});

test('wrap keeps your settings, install and uninstall restore them', () => {
  const mine = { type: 'command', command: 'my-status', padding: 2 };
  reset({ theme: 'dark', statusLine: mine });
  assert.match(run('wrap'), /wrapping your own \(my-status\)/);
  assert.strictEqual(settings().statusLine.padding, 2);
  assert.notStrictEqual(settings().statusLine.command, 'my-status');
  assert.deepStrictEqual([state().statusLineMode, state().previousStatusLine], ['wrap', mine]);
  assert.match(run(), /installed, wrapping your own \(my-status\)/);

  run('install');
  assert.strictEqual(state().statusLineMode, 'full');
  assert.deepStrictEqual(state().previousStatusLine, mine, 'switching modes keeps the saved one');
  assert.strictEqual(settings().statusLine.padding, undefined);

  assert.match(run('uninstall'), /previous one is restored/);
  assert.deepStrictEqual(settings(), { theme: 'dark', statusLine: mine });
  assert.strictEqual(state().statusLineMode, null);
});

test('warns when the project sets its own status line', () => {
  reset({});
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'x' } }));
  assert.match(run('install'), /WARNING: .*settings\.local\.json sets its own statusLine/);
  fs.rmSync(path.join(project, '.claude', 'settings.local.json'));
  assert.doesNotMatch(run(), /WARNING/);
});
