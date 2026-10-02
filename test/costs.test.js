const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-costs-'));
const claudeDir = path.join(tmp, 'claude');
const dataDir = path.join(claudeDir, 'mynameisjev');
fs.mkdirSync(dataDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const st = require('../plugin/scripts/jev-state');

const statePath = path.join(dataDir, 'state.json');
const cli = path.join(__dirname, '..', 'plugin', 'scripts', 'jev-cli.js');
const stub = path.join(tmp, 'stub-fetch.js');
fs.writeFileSync(stub, `global.fetch = async (url, opts) => {
  const q = JSON.parse(opts.body).questions;
  const answers = q.pick ? { pick: { choice: 'o1', probabilities: { o1: 0.8, o2: 0.2 } } } : { best: { choice: 'v1', probabilities: { v1: 0.8, v2: 0.2 } } };
  return { ok: true, json: async () => ({ answers, usage: { cost: 0.00002 } }) };
};`);
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_PROJECT_DIR: tmp, HOME: tmp, USERPROFILE: tmp, OPENROUTER_API_KEY: 'sk-test' };
const run = (args, input = '') => spawnSync(process.execPath, ['--require', stub, cli, ...args], { input, env, cwd: tmp, encoding: 'utf8' });
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

test('addCost updates the feature entry and the total', () => {
  const state = st.readState();
  st.addCost(state, 'decide', 0.00002);
  st.addCost(state, 'decide', 0.00003);
  st.addCost(state, 'check', undefined);
  assert.deepStrictEqual(state.costs.decide, { calls: 2, cost: 0.00005 });
  assert.deepStrictEqual(state.costs.check, { calls: 1, cost: 0 });
  assert.ok(Math.abs(state.cost - 0.00005) < 1e-12);
});

test('a fresh state does not share its costs object', () => {
  const a = st.readState();
  st.addCost(a, 'sizing', 1);
  assert.deepStrictEqual(st.readState().costs, {});
});

test('decide, compare and --auto calls record their cost by feature', () => {
  fs.writeFileSync(statePath, JSON.stringify({ enabled: true, tiebreak: true, promptAt: 't1' }));
  const decide = JSON.stringify({ options: ['alpha', 'beta'] });
  assert.strictEqual(run(['decide'], decide).status, 0);
  assert.strictEqual(run(['decide', '--auto'], decide).status, 0);
  fs.writeFileSync(path.join(tmp, 'a.js'), 'a');
  fs.writeFileSync(path.join(tmp, 'b.js'), 'b');
  const out = run(['compare'], JSON.stringify({ raw: 'a.js b.js' }));
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
  const s = readState();
  assert.deepStrictEqual(s.costs.decide, { calls: 1, cost: 0.00002 });
  assert.deepStrictEqual(s.costs.tiebreak, { calls: 1, cost: 0.00002 });
  assert.deepStrictEqual(s.costs.compare, { calls: 1, cost: 0.00002 });
  assert.ok(Math.abs(s.cost - 0.00006) < 1e-12);
  assert.strictEqual(s.stats.tiebreaks, 1, 'the tiebreak cap still counts');
});

test('report lists cost by feature, skips unused ones, and keeps earlier cost', () => {
  fs.writeFileSync(statePath, JSON.stringify({
    enabled: true,
    cost: 0.001,
    stats: { tiny: 2, everyday: 1 },
    costs: { sizing: { calls: 3, cost: 0.0006 }, decide: { calls: 1, cost: 0.0001 } },
  }));
  const out = run(['report']).stdout.split('\n');
  assert.match(out[0], /^Jev calls: 4, cost \$0\.001000$/);
  assert.match(out[1], /^\s+sizing\s+3\s+\$0\.000600$/);
  assert.match(out[2], /^\s+decide\s+1\s+\$0\.000100$/);
  assert.match(out[3], /^\s+earlier\s+\$0\.000300\s+\(before per-feature tracking\)$/);
  assert.ok(!out.some((l) => /^\s+(check|compare|tiebreak)\b/.test(l)));
});

test('report without per-feature data shows the old totals line', () => {
  fs.writeFileSync(statePath, JSON.stringify({ enabled: true, cost: 0.0003, stats: { tiny: 3 } }));
  const out = run(['report']).stdout.split('\n');
  assert.match(out[0], /^Jev calls: 3, cost \$0\.000300$/);
  assert.match(out[1], /^\s+earlier\s+3\s+\$0\.000300/);
});
