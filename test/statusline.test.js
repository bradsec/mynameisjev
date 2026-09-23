const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const script = path.join(__dirname, '..', 'plugin', 'scripts', 'cc-statusline.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-statusline-'));
const claudeDir = path.join(tmp, 'claude');
fs.mkdirSync(path.join(claudeDir, 'mynameisjev'), { recursive: true });

// Render the status line with a given router state and key, returning line 1
// without colors.
function line1(state, key) {
  fs.writeFileSync(path.join(claudeDir, 'mynameisjev', 'state.json'), JSON.stringify(state));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex') };
  delete env.OPENROUTER_API_KEY;
  if (key) env.OPENROUTER_API_KEY = key;
  const out = execFileSync(process.execPath, [script], { input: '{"model":{"display_name":"Opus 5.5"}}', env, cwd: tmp }).toString();
  return out.split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '');
}

test('router off', () => {
  assert.match(line1({ enabled: false }, 'sk-test'), /JEV off/);
});

test('router on without a key', () => {
  assert.match(line1({ enabled: true }, null), /JEV no key/);
});

test('router on, no call yet', () => {
  assert.match(line1({ enabled: true }, 'sk-test'), /JEV on/);
});

test('router on, last call failed', () => {
  assert.match(line1({ enabled: true, lastCall: { ok: false, error: 'HTTP 401' } }, 'sk-test'), /JEV HTTP 401/);
});

test('router on, last call worked', () => {
  assert.match(line1({ enabled: true, lastCall: { ok: true } }, 'sk-test'), /JEV ✓/);
});
