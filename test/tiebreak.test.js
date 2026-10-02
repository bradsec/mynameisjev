const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tb = require('../plugin/scripts/jev-tiebreak');

test('claim refuses when tiebreak or the router is off', () => {
  for (const state of [{ enabled: true, tiebreak: false, promptAt: 't1' }, { enabled: false, tiebreak: true, promptAt: 't1' }]) {
    const r = tb.claim(state);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /decide yourself/i);
  }
});

test('claim allows MAX_PER_TURN calls per prompt, then resets on a new prompt', () => {
  const state = { enabled: true, tiebreak: true, promptAt: 't1', stats: {} };
  for (let i = 0; i < tb.MAX_PER_TURN; i++) assert.strictEqual(tb.claim(state).ok, true);
  const capped = tb.claim(state);
  assert.strictEqual(capped.ok, false);
  assert.match(capped.message, /limit/i);
  assert.strictEqual(state.stats.tiebreaks, tb.MAX_PER_TURN);
  state.promptAt = 't2';
  assert.strictEqual(tb.claim(state).ok, true);
});

test('statusLine reports off, or the calls left this turn', () => {
  assert.match(tb.statusLine({ enabled: true, tiebreak: false }), /^Tiebreak: off/);
  assert.match(tb.statusLine({ enabled: false, tiebreak: true }), /^Tiebreak: off \(router off\)/);
  assert.match(tb.statusLine({ enabled: true, tiebreak: true, promptAt: 't1' }), new RegExp(`^Tiebreak: on, ${tb.MAX_PER_TURN} calls left this turn`));
  assert.match(tb.statusLine({ enabled: true, tiebreak: true, promptAt: 't1', tiebreakTurn: { turn: 't1', count: tb.MAX_PER_TURN } }), /^Tiebreak: on, 0 calls left/);
});

test('skill file is Claude-only and runs the CLI with --auto', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'skills', 'jev-tiebreak', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: jev-tiebreak\ndescription: .+\nuser-invocable: false\n/);
  assert.match(skill, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/jev-cli\.js" tiebreak-status`/);
  assert.match(skill, /jev-cli\.js" decide --auto/);
  assert.match(skill, /jev-cli\.js" compare --auto/);
});

// The CLI as the skill runs it, fetch stubbed and counted.
test('jev-cli decide --auto honours the gate; plain decide does not', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-tiebreak-'));
  const dataDir = path.join(tmp, 'claude', 'mynameisjev');
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, 'state.json');
  const calls = path.join(tmp, 'calls');
  const stub = path.join(tmp, 'stub-fetch.js');
  fs.writeFileSync(stub, `global.fetch = async () => { require('fs').appendFileSync(${JSON.stringify(calls)}, 'x'); return { ok: true, json: async () => ({ answers: { pick: { choice: 'o1', probabilities: { o1: 0.8, o2: 0.2 } } }, usage: { cost: 0 } }) }; };`);
  const cli = path.join(__dirname, '..', 'plugin', 'scripts', 'jev-cli.js');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), HOME: tmp, USERPROFILE: tmp, OPENROUTER_API_KEY: 'sk-test' };
  const input = JSON.stringify({ options: ['alpha', 'beta'] });
  const run = (...args) => spawnSync(process.execPath, ['--require', stub, cli, 'decide', ...args], { input, env, encoding: 'utf8' });
  const count = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').length : 0);

  fs.writeFileSync(statePath, JSON.stringify({ enabled: true, tiebreak: false, promptAt: 't1' }));
  const off = run('--auto');
  assert.strictEqual(off.status, 0);
  assert.match(off.stdout, /decide yourself/i);
  assert.strictEqual(count(), 0);

  fs.writeFileSync(statePath, JSON.stringify({ enabled: true, tiebreak: true, promptAt: 't1' }));
  for (let i = 0; i < tb.MAX_PER_TURN; i++) assert.match(run('--auto').stdout, /Pick: alpha/);
  assert.match(run('--auto').stdout, /limit/i);
  assert.strictEqual(count(), tb.MAX_PER_TURN);
  assert.match(run().stdout, /Pick: alpha/);
  assert.strictEqual(count(), tb.MAX_PER_TURN + 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).stats.tiebreaks, tb.MAX_PER_TURN);

  const status = spawnSync(process.execPath, [cli, 'tiebreak-status'], { env, encoding: 'utf8' });
  assert.match(status.stdout, /^Tiebreak: on, 0 calls left this turn/);
});
