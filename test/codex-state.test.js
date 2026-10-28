const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-codex-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');

const st = require('../plugin/scripts/jev-state');
const codex = require('../plugin/scripts/jev-codex');

test('task command hides progress, prints fatal stderr, and keeps its exit code', () => {
  const script = path.join(tmp, 'companion.mjs');
  fs.writeFileSync(script, 'process.stderr.write("progress\\n"); process.exit(Number(process.env.FAIL || 0));');
  const command = codex.taskCommand(script, '', 'brief');
  const delimiter = command.match(/<<'([^']+)'/)[1];
  assert.match(delimiter, /^JEV_BRIEF_[a-f0-9]+$/);
  assert.match(command, new RegExp(`\\n${delimiter}\\n`));
  assert.notStrictEqual(delimiter, codex.taskCommand(script, '', 'brief').match(/<<'([^']+)'/)[1]);
  const run = (fail) => spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, FAIL: String(fail) } });
  assert.deepStrictEqual([run(0).status, run(0).stderr], [0, '']);
  const failed = run(7);
  assert.deepStrictEqual([failed.status, failed.stderr], [7, 'progress\n']);
});

test('defaults: router only, every optional feature off', () => {
  const s = st.readState();
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.outputStyle, null);
  for (const flag of ['sync', 'updates', 'autoTransfer']) assert.strictEqual(s[flag], false, flag);
});

test('state lives in ~/.claude/mynameisjev', () => {
  assert.strictEqual(st.dataDir, path.join(tmp, 'claude', 'mynameisjev'));
  const s = st.readState();
  s.enabled = true;
  st.writeState(s);
  assert.strictEqual(st.readState().enabled, true);
});

test('Codex limits older than seven days expire on read', () => {
  const state = st.readState();
  state.codexLimits = { readonly: new Date(Date.now() - 8 * 86400000).toISOString(), network: new Date().toISOString() };
  st.writeState(state);
  assert.deepStrictEqual(Object.keys(st.readState().codexLimits), ['network']);
});

test('Codex is unavailable without the codex plugin', () => {
  assert.strictEqual(codex.codexAvailable(), false);
});

test('tier choice: defaults, overrides, unknown models dropped', () => {
  const cache = { models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-luna' }] };
  assert.deepStrictEqual(codex.tierChoice('tiny', {}, cache), { model: 'gpt-6-luna', effort: 'low' });
  assert.deepStrictEqual(codex.tierChoice('large', { large: { effort: 'high' } }, cache, true), { model: 'gpt-6-astra', effort: 'high' });
  assert.strictEqual(codex.tierChoice('everyday', {}, cache).model, null, 'gpt-6.1-sol is not in this list');
  assert.strictEqual(codex.DEFAULT_TIERS.everyday.model, 'gpt-6.1-sol');
  assert.strictEqual(codex.tierChoice('tiny', { tiny: { effort: 'max' } }, cache).effort, null, 'task effort must be none..xhigh');
});

test('tier choice: unasked routing stays off gpt-6-astra unless the user picked it', () => {
  const cache = { models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] };
  assert.deepStrictEqual(codex.tierChoice('large', {}, cache), { model: 'gpt-6.1-sol', effort: 'medium' });
  assert.deepStrictEqual(codex.tierChoice('hardest', {}, cache), { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepStrictEqual(codex.tierChoice('hardest', {}, cache, true), { model: 'gpt-6-astra', effort: 'high' });
  assert.strictEqual(codex.tierChoice('large', { large: { model: 'gpt-6-astra' } }, cache).model, 'gpt-6-astra', 'set with /mynameisjev:codex set');
  assert.strictEqual(codex.tierChoice('large', { everyday: { model: 'gpt-6-luna' } }, cache).model, null, 'falls back to the everyday choice, here unlisted');
});

// Codex's model/list as of 0.164.0, in its own order (newest first).
const LIVE = [
  { id: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.', isDefault: true },
  { id: 'gpt-6-astra', description: 'Frontier intelligence for the most demanding work.' },
  { id: 'gpt-6-sol', description: 'Previous generation workhorse model.' },
  { id: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.' },
  { id: 'gpt-5.6-sol', description: 'Older generation workhorse model.' },
  { id: 'gpt-5.6-luna', description: 'Older fast and efficient model.' },
];

test('auto tiers: today\'s Codex list gives the built-in table', () => {
  const tiers = codex.autoTiers({ models: LIVE });
  for (const t of Object.keys(codex.DEFAULT_TIERS)) assert.deepStrictEqual(tiers[t], codex.DEFAULT_TIERS[t], t);
});

test('auto tiers: a new generation is picked up from the descriptions, older ones skipped', () => {
  const cache = { models: [
    { id: 'gpt-7-sol', description: 'Latest workhorse model.', isDefault: true },
    { id: 'gpt-7-astra', description: 'Frontier intelligence for the most demanding work.' },
    { id: 'gpt-7-luna', description: 'Fast, cheap model for easy tasks.' },
    ...LIVE.map((m) => ({ ...m, isDefault: false, description: `Previous generation. ${m.description}` })),
  ] };
  assert.deepStrictEqual(codex.tierChoice('tiny', {}, cache), { model: 'gpt-7-luna', effort: 'low' });
  assert.deepStrictEqual(codex.tierChoice('everyday', {}, cache), { model: 'gpt-7-sol', effort: 'medium' });
  assert.strictEqual(codex.tierChoice('hardest', {}, cache, true).model, 'gpt-7-astra');
  assert.strictEqual(codex.tierChoice('hardest', {}, cache).model, 'gpt-7-sol', 'the new frontier model counts as premium');
  assert.strictEqual(codex.tierChoice('tiny', { tiny: { model: 'gpt-6-luna' } }, cache).model, 'gpt-6-luna', 'a user override still wins');
});

test('auto tiers: follows a model\'s upgrade when no description matches', () => {
  const cache = { models: [{ id: 'gpt-6-luna', upgrade: 'gpt-6.5-luna' }, { id: 'gpt-6.5-luna', upgrade: null }] };
  assert.strictEqual(codex.tierChoice('tiny', {}, cache).model, 'gpt-6.5-luna');
  const loop = { models: [{ id: 'gpt-6-luna', upgrade: 'b' }, { id: 'b', upgrade: 'gpt-6-luna' }] };
  assert.ok(['gpt-6-luna', 'b'].includes(codex.tierChoice('tiny', {}, loop).model), 'an upgrade loop ends');
});

test('auto tiers: an effort the model does not support is dropped', () => {
  const cache = { models: [{ ...LIVE[3], efforts: ['minimal', 'medium'] }] };
  assert.deepStrictEqual(codex.tierChoice('tiny', {}, cache), { model: 'gpt-6-luna', effort: null });
});

test('codex peak: highest window, reset windows count as 0', () => {
  const now = Date.now() / 1000;
  const cache = { limits: { primary: { usedPercent: 60, resetsAt: now - 10 }, secondary: { usedPercent: 40, resetsAt: now + 1000 } } };
  assert.deepStrictEqual(codex.codexPeak(cache), { pct: 40, window: 'weekly', resetsAt: now + 1000 });
});

test('migrates legacy output style only when the new setting is absent', () => {
  for (const [legacy, setting, expected] of [[true, undefined, 'auto'], [false, undefined, null], [true, null, null], [true, 'user', 'user']]) {
    fs.writeFileSync(path.join(st.dataDir, 'state.json'), JSON.stringify({ caveman: legacy, outputStyle: setting }));
    assert.strictEqual(st.readState().outputStyle, expected);
  }
});
