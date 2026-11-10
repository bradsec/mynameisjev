// P-F5: the tiebreak cap is per turn of one session. A prompt in another
// session must not hand this session's turn more calls.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Point every path at a throwaway config before loading the scripts.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-pf5-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
const dataDir = path.join(tmp, 'claude', 'mynameisjev');
fs.mkdirSync(dataDir, { recursive: true });
const statePath = path.join(dataDir, 'state.json');

const tb = require('../plugin/scripts/jev-tiebreak');
const st = require('../plugin/scripts/jev-state');

// What the router does on a prompt in `session`.
const prompt = (state, session, turn) => {
  state.promptAt = turn;
  st.putSessionSetting(state, session, 'promptAt', turn);
  tb.startTurn(state, session);
};
const claims = (state, session, n) => Array.from({ length: n }, () => tb.claim(state, session).ok);

test('a prompt in another session neither resets nor uses up this session\'s turn', () => {
  const state = { enabled: true, tiebreak: true, stats: {} };
  prompt(state, 'A', 'A-turn-1');
  assert.deepStrictEqual(claims(state, 'A', 3), [true, true, false]);
  prompt(state, 'B', 'B-turn-1');
  assert.deepStrictEqual(claims(state, 'A', 2), [false, false]);
  assert.match(tb.statusLine(state, 'A'), /0 calls left/);
  assert.match(tb.statusLine(state, 'B'), new RegExp(`${tb.MAX_PER_TURN} calls left`));
  assert.deepStrictEqual(claims(state, 'B', 3), [true, true, false]);
  assert.deepStrictEqual(claims(state, 'A', 1), [false]);
  prompt(state, 'A', 'A-turn-2');
  assert.deepStrictEqual(claims(state, 'A', 3), [true, true, false]);
  assert.deepStrictEqual(claims(state, 'B', 1), [false]);
  assert.strictEqual(state.stats.tiebreaks, 6);
});

test('a count saved in the earlier single-turn shape still counts for its turn, and old sessions are trimmed', () => {
  const state = { enabled: true, tiebreak: true, stats: {}, tiebreakTurn: { turn: 'A-turn-1', count: 2 } };
  state.promptAt = 'A-turn-1';
  assert.strictEqual(tb.claim(state, 'A').ok, false);
  assert.strictEqual(tb.claim(state, null).ok, false);
  prompt(state, 'A', 'A-turn-2');
  assert.strictEqual(tb.claim(state, 'A').ok, true);
  assert.deepStrictEqual(state.tiebreakTurn.A, { turn: 'A-turn-2', count: 1 });
  for (let i = 0; i < 30; i++) {
    prompt(state, `s${i}`, `t${i}`);
    tb.claim(state, `s${i}`);
  }
  assert.ok(Object.keys(state.tiebreakTurn).length <= 20);
  assert.ok(state.tiebreakTurn.s29);
});

test('two processes claiming in one session add up; claims in two sessions stay apart', () => {
  fs.writeFileSync(statePath, JSON.stringify({ enabled: true, tiebreak: true }));
  const first = st.readState();
  prompt(first, 'A', 'A-turn-1');
  prompt(first, 'B', 'B-turn-1');
  tb.claim(first, 'A');
  st.writeState(first);
  const a = st.readState();
  const b = st.readState();
  const c = st.readState();
  tb.claim(a, 'A');
  tb.claim(b, 'B');
  tb.claim(c, 'B');
  for (const s of [a, b, c]) st.writeState(s);
  const disk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepStrictEqual(disk.tiebreakTurn, { A: { turn: 'A-turn-1', count: 2 }, B: { turn: 'B-turn-1', count: 2 } });
  assert.strictEqual(disk.stats.tiebreaks, 4);
});

// End to end: the CLI as the skill runs it in session A, and the router hook
// for a prompt in session B, on one state file.
test('router prompt in session B leaves session A\'s cap in place (CLI and hook)', () => {
  const calls = path.join(tmp, 'calls');
  const stub = path.join(tmp, 'stub-fetch.js');
  fs.writeFileSync(stub, `global.fetch = async () => { require('fs').appendFileSync(${JSON.stringify(calls)}, 'x'); return { ok: true, json: async () => ({ answers: { pick: { choice: 'o1', probabilities: { o1: 0.8, o2: 0.2 } } }, usage: { cost: 0 } }) }; };`);
  const scripts = path.join(__dirname, '..', 'plugin', 'scripts');
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, OPENROUTER_API_KEY: 'sk-test' };
  const decide = (session) => spawnSync(process.execPath, ['--require', stub, path.join(scripts, 'jev-cli.js'), 'decide', '--auto'],
    { input: JSON.stringify({ options: ['alpha', 'beta'] }), env: { ...env, CLAUDE_CODE_SESSION_ID: session }, encoding: 'utf8' }).stdout;
  // "ok" is skipped by the router, so the hook makes no Jev call.
  const hook = (session) => spawnSync(process.execPath, ['--require', stub, path.join(scripts, 'jev-router.js')],
    { input: JSON.stringify({ prompt: 'ok', session_id: session, cwd: tmp }), env, encoding: 'utf8' });

  fs.writeFileSync(statePath, JSON.stringify({ enabled: true, tiebreak: true }));
  hook('A');
  for (let i = 0; i < tb.MAX_PER_TURN; i++) assert.match(decide('A'), /Pick: alpha/);
  assert.match(decide('A'), /limit/i);
  hook('B');
  assert.match(decide('A'), /limit/i);
  assert.match(decide('B'), /Pick: alpha/);
  hook('A');
  assert.match(decide('A'), /Pick: alpha/);
  assert.strictEqual(fs.readFileSync(calls, 'utf8').length, tb.MAX_PER_TURN + 2);
});
