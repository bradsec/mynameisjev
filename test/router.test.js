const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point every path at a throwaway config before loading the scripts.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-router-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
// Codex routing needs the codex plugin's companion script to exist.
const companionDir = path.join(tmp, 'claude', 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts');
fs.mkdirSync(companionDir, { recursive: true });
fs.writeFileSync(path.join(companionDir, 'codex-companion.mjs'), '');

const router = require('../plugin/scripts/jev-router');

// A classifier result as the router receives it from Jev.
const result = (over = {}) => ({ size: 'everyday', confidence: 0.9, contained: 0.9, heavy: 0.1, coding: 0.1, shift: null, ...over });
const codexOk = { ok: true, available: true, text: 'Codex 5h 0%, weekly 36%' };
const codexBusy = { ok: false, available: true, text: 'Codex 5h 90%, weekly 36%, Codex near its limit' };
const noCodex = { ok: false, available: false, text: '' };
const ctx = (over = {}) => ({ sessionFamily: 'opus', claude: null, claudeLow: false, codexNow: noCodex, codexCache: null, overrides: {}, ...over });

test('skips slash commands, short messages and bare confirmations', () => {
  assert.ok(router.looksSkippable('/mynameisjev:status'));
  assert.ok(router.looksSkippable('short one'));
  assert.ok(router.looksSkippable('yes do that please'));
  assert.ok(!router.looksSkippable('Write a short email to my landlord about the faucet.'));
});

test('delegation: suppressed when the task needs the conversation', () => {
  const a = router.delegationAdvice('large', result({ size: 'large', contained: 0.2 }), 'opus');
  assert.match(a.suppress, /not self-contained/);
});

test('delegation: tiny tasks with little output stay inline', () => {
  assert.match(router.delegationAdvice('tiny', result(), 'opus').suppress, /start-up costs more/);
});

test('delegation: cheaper helper than the session model', () => {
  assert.match(router.delegationAdvice('everyday', result(), 'opus'), /cheaper than this session's opus/);
});

test('delegation: same model only for bulky output', () => {
  assert.match(router.delegationAdvice('large', result({ size: 'large' }), 'opus').suppress, /same model/);
  assert.match(router.delegationAdvice('large', result({ size: 'large', heavy: 0.9 }), 'opus'), /bulky intermediate output/);
});

test('delegation: stronger helper than the session model', () => {
  assert.match(router.delegationAdvice('hardest', result({ size: 'hardest' }), 'sonnet'), /stronger than this session's sonnet/);
});

test('delegation: names the plugin agents', () => {
  assert.match(router.delegationAdvice('everyday', result(), 'opus'), /"mynameisjev:everyday"/);
});

test('route: without Codex, coding work gets Claude advice', () => {
  const r = router.routeAdvice('everyday', result({ coding: 0.9 }), ctx());
  assert.strictEqual(r.codex, false);
  assert.match(r.note, /mynameisjev:everyday/);
});

test('route: with Codex, self-contained coding goes to Codex', () => {
  const r = router.routeAdvice('everyday', result({ coding: 0.9 }), ctx({ codexNow: codexOk }));
  assert.strictEqual(r.codex, true);
  assert.match(r.note, /Route it to Codex/);
  assert.match(r.note, /codex-companion\.mjs" task --model gpt-6-sol --effort medium/);
});

test('route: busy Codex falls back to Claude', () => {
  const r = router.routeAdvice('everyday', result({ coding: 0.9 }), ctx({ codexNow: codexBusy }));
  assert.strictEqual(r.codex, false);
});

test('route: low Claude usage sends non-coding work to Codex', () => {
  const claude = { pct: 87, window: '5h', resetsAt: 0 };
  const r = router.routeAdvice('everyday', result(), ctx({ codexNow: codexOk, claude, claudeLow: true }));
  assert.strictEqual(r.codex, true);
  assert.match(r.note, /Claude 5h usage at 87%/);
});

test('thresholds: route at 80%, warn at 85%, auto-transfer at 90%', () => {
  assert.deepStrictEqual(router.THRESHOLDS, { route: 80, transfer: 85, auto: 90, codexMax: 85 });
  assert.strictEqual(router.limitNoticeFor({ pct: 81, window: '5h', resetsAt: 0 }, codexOk, false).key, '5h:0:route');
});

test('route: with Claude low, work that needs the conversation gets a sub-step note', () => {
  const claude = { pct: 82, window: '5h', resetsAt: 0 };
  const r = router.routeAdvice('large', result({ size: 'large', contained: 0.1 }), ctx({ codexNow: codexOk, claude, claudeLow: true }));
  assert.strictEqual(r.codex, true);
  assert.match(r.note, /hand each self-contained step/);
});

test('route: with Claude fine, work that needs the conversation stays quiet', () => {
  const r = router.routeAdvice('large', result({ size: 'large', contained: 0.1 }), ctx({ codexNow: codexOk }));
  assert.match(r.suppress, /not self-contained/);
});

test('limit notice: none below 80%', () => {
  assert.strictEqual(router.limitNoticeFor({ pct: 60, window: '5h', resetsAt: 0 }, codexOk, false), null);
});

test('limit notice: leaves Codex out entirely when unavailable', () => {
  const n = router.limitNoticeFor({ pct: 87, window: '5h', resetsAt: 0 }, noCodex, true);
  assert.match(n.text, /Close to the limit\.$/);
  assert.doesNotMatch(n.text, /Codex|transfer/);
});

test('limit notice: suggests /codex:transfer when Codex is available', () => {
  const n = router.limitNoticeFor({ pct: 87, window: '5h', resetsAt: 0 }, codexOk, false);
  assert.match(n.text, /run \/codex:transfer/);
});

test('limit notice: auto-transfer takes over from 90%', () => {
  const claude = { pct: 91, window: '5h', resetsAt: 0 };
  assert.strictEqual(router.limitNoticeFor(claude, codexOk, true), null);
  assert.ok(router.limitNoticeFor(claude, codexOk, false), 'still notified when auto-transfer is off');
});

test('transcript: newest main-thread reply wins, subagent and synthetic entries skipped', () => {
  const file = path.join(tmp, 't.jsonl');
  const line = (o) => JSON.stringify(o);
  fs.writeFileSync(file, [
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { model: 'claude-sonnet-5' } }),
    line({ type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: { model: 'claude-opus-5-5' } }),
    line({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5' } }),
    line({ type: 'assistant', message: { model: '<synthetic>' } }),
    line({ type: 'user', message: {} }),
  ].join('\n'));
  assert.strictEqual(router.transcriptModel(file).family, 'opus');
  assert.strictEqual(router.transcriptModel(path.join(tmp, 'missing.jsonl')), null);
});

test('prefer codex: self-contained work goes to Codex at low Claude usage', () => {
  const r = router.routeAdvice('everyday', result(), ctx({ codexNow: codexOk, preferCodex: true }));
  assert.strictEqual(r.codex, true);
  assert.match(r.note, /prefer-Codex mode is on/);
});

test('prefer codex: work that needs the conversation gets the sub-step note', () => {
  const r = router.routeAdvice('large', result({ size: 'large', contained: 0.1 }), ctx({ codexNow: codexOk, preferCodex: true }));
  assert.strictEqual(r.model, 'steps');
  assert.match(r.note, /^Jev: prefer-Codex mode is on\. Keep coordination/);
});

test('prefer codex: tiny jobs stay on Claude, and a busy Codex falls back', () => {
  assert.match(router.routeAdvice('tiny', result({ size: 'tiny' }), ctx({ codexNow: codexOk, preferCodex: true })).suppress, /hand-off costs more/);
  assert.strictEqual(router.routeAdvice('everyday', result(), ctx({ codexNow: codexBusy, preferCodex: true })).codex, false);
});

test('override: parses "+" prefixes, not look-alikes', () => {
  assert.deepStrictEqual(router.parseOverride('+large build the parser'), { target: 'tier', tier: 'large', token: '+large' });
  assert.deepStrictEqual(router.parseOverride('+codex fix it'), { target: 'codex', tier: 'everyday', token: '+codex' });
  assert.deepStrictEqual(router.parseOverride('+CODEX:hardest redesign'), { target: 'codex', tier: 'hardest', token: '+CODEX:hardest' });
  assert.deepStrictEqual(router.parseOverride('+claude'), { target: 'claude', tier: null, token: '+claude' });
  assert.strictEqual(router.parseOverride('+larger plan'), null);
  assert.strictEqual(router.parseOverride('!codex fix it'), null);
  assert.strictEqual(router.parseOverride('use +codex here'), null);
});

test('override: tier and claude notes', () => {
  const tier = router.overrideAdvice(router.parseOverride('+tiny rename x'), ctx());
  assert.match(tier.note, /"mynameisjev:tiny" subagent \(haiku\)\. Delegate it without asking/);
  assert.deepStrictEqual(tier.route, ['claude', 'haiku', 'suggested']);
  const here = router.overrideAdvice(router.parseOverride('+claude do it'), ctx());
  assert.match(here.note, /Handle this message here/);
  assert.deepStrictEqual(here.route, ['claude', 'opus', 'session']);
});

test('override: codex routes with the asked size, even when Codex looks busy', () => {
  const r = router.overrideAdvice(router.parseOverride('+codex:tiny x'), ctx({ codexNow: codexOk }));
  assert.match(r.note, /task --model gpt-6-luna --effort low/);
  assert.deepStrictEqual(r.route, ['codex', 'gpt-6-luna', 'suggested']);
  assert.strictEqual(r.notice, null);
  const busy = router.overrideAdvice(router.parseOverride('+codex x'), ctx({ codexNow: codexBusy }));
  assert.match(busy.note, /Route it to Codex/);
  assert.match(busy.notice, /near its limit/);
});

test('override: codex falls back to Claude when unavailable', () => {
  const r = router.overrideAdvice(router.parseOverride('+codex x'), ctx());
  assert.match(r.note, /Codex is not available, so handle it here/);
  assert.match(r.notice, /"\+codex" ignored/);
  assert.strictEqual(r.route[0], 'claude');
});
