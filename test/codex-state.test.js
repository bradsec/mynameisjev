const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-codex-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');

const st = require('../plugin/scripts/jev-state');
const codex = require('../plugin/scripts/jev-codex');

test('defaults: router only, every optional feature off', () => {
  const s = st.readState();
  assert.strictEqual(s.enabled, false);
  for (const flag of ['caveman', 'sync', 'updates', 'autoTransfer']) assert.strictEqual(s[flag], false, flag);
});

test('state lives in ~/.claude/mynameisjev', () => {
  assert.strictEqual(st.dataDir, path.join(tmp, 'claude', 'mynameisjev'));
  const s = st.readState();
  s.enabled = true;
  st.writeState(s);
  assert.strictEqual(st.readState().enabled, true);
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

test('codex peak: highest window, reset windows count as 0', () => {
  const now = Date.now() / 1000;
  const cache = { limits: { primary: { usedPercent: 60, resetsAt: now - 10 }, secondary: { usedPercent: 40, resetsAt: now + 1000 } } };
  assert.deepStrictEqual(codex.codexPeak(cache), { pct: 40, window: 'weekly', resetsAt: now + 1000 });
});
