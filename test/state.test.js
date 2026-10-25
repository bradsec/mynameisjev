const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-state-'));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const st = require('../plugin/scripts/jev-state');
const statePath = path.join(st.dataDir, 'state.json');
const onDisk = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

const route = (session, at, model = 'opus') => ({ at: new Date(at).toISOString(), target: 'claude', model, how: 'session', session });

test('concurrent writers keep each other\'s counters, settings and routes', () => {
  st.writeState({ ...st.readState(), enabled: true });
  // Two hooks read the same state, then write in turn.
  const a = st.readState();
  const b = st.readState();
  a.stats.helper += 1;
  a.enforce = true;
  st.putRoute(a, route('s1', 1000));
  st.writeState(a);
  b.stats.codexRuns += 2;
  st.addCost(b, 'sizing', 0.5);
  st.putRoute(b, route('s2', 2000, 'sonnet'));
  st.writeState(b);

  const s = onDisk();
  assert.strictEqual(s.stats.helper, 1);
  assert.strictEqual(s.stats.codexRuns, 2);
  assert.strictEqual(s.enforce, true, 'b left enforce alone, so a\'s change stands');
  assert.strictEqual(s.cost, 0.5);
  assert.deepStrictEqual(Object.keys(s.routes).sort(), ['s1', 's2']);
  assert.strictEqual(s.route.session, 's2', 'latest writer\'s route is the latest');
});

test('writing the same state twice does not count its changes twice', () => {
  st.writeState({ ...st.readState(), stats: { ...st.DEFAULT_STATE.stats } });
  const a = st.readState();
  const statsRef = a.stats;
  a.stats.helper += 1;
  st.writeState(a);
  // Another hook adds one in between.
  const other = st.readState();
  other.stats.helper += 1;
  st.writeState(other);
  a.stats.shift += 1;
  st.writeState(a);
  assert.strictEqual(a.stats, statsRef, 'nested objects keep their identity');
  assert.strictEqual(onDisk().stats.helper, 2);
  assert.strictEqual(onDisk().stats.shift, 1);
  assert.strictEqual(a.stats.helper, 2, 'the writer sees the merged values');
});

test('records such as routes are replaced whole, never spliced', () => {
  st.writeState({ ...st.readState(), route: null, routes: {} });
  const a = st.readState();
  const b = st.readState();
  st.putRoute(a, { ...route('s1', 1000), how: 'suggested', target: 'codex', model: 'gpt-6.1-sol' });
  a.lastCall = { at: 'a', ok: false, error: 'timeout' };
  st.writeState(a);
  const theirs = route('s1', 2000, 'sonnet');
  st.putRoute(b, theirs);
  b.lastCall = { at: 'b', ok: true };
  st.writeState(b);
  assert.deepStrictEqual(onDisk().routes.s1, theirs);
  assert.deepStrictEqual(onDisk().route, theirs);
  assert.deepStrictEqual(onDisk().lastCall, { at: 'b', ok: true });
});

test('a hand-built state is written as given', () => {
  st.writeState({ enabled: false, stats: {} });
  assert.deepStrictEqual(onDisk(), { enabled: false, stats: {} });
});

test('writes leave no temp files behind', () => {
  st.writeState(st.readState());
  st.writeFileAtomic(path.join(st.dataDir, 'x.json'), '{}');
  assert.deepStrictEqual(fs.readdirSync(st.dataDir).filter((f) => f.endsWith('.tmp')), []);
  assert.strictEqual(fs.readFileSync(path.join(st.dataDir, 'x.json'), 'utf8'), '{}');
});

test('routeFor picks the session\'s own route', () => {
  const s = { route: route('s2', 2000), routes: { s1: route('s1', 1000), s2: route('s2', 2000) } };
  assert.strictEqual(st.routeFor(s, 's1').session, 's1');
  assert.strictEqual(st.routeFor(s, 's3'), null);
  assert.strictEqual(st.routeFor(s, null).session, 's2', 'no session: the latest route');
  // States written before per-session routes.
  assert.strictEqual(st.routeFor({ route: route('s1', 1000) }, 's1').session, 's1');
  assert.strictEqual(st.routeFor({ route: route('s1', 1000) }, 's2'), null);
});

test('putRoute keeps the newest sessions only', () => {
  const s = { routes: {} };
  for (let i = 0; i < 25; i++) st.putRoute(s, route(`s${i}`, 1000 + i));
  assert.strictEqual(Object.keys(s.routes).length, 20);
  assert.ok(!s.routes.s0 && s.routes.s24);
  assert.strictEqual(s.route.session, 's24');
});

test('per-session prefer and review: session, then project, then default', () => {
  const s = { ...st.DEFAULT_STATE, sessions: {} };
  assert.strictEqual(st.preferFor(s, 's1', null), 'claude');
  assert.strictEqual(st.reviewFor(s, 's1'), true, 'review is on by default');
  assert.strictEqual(st.preferFor(s, 's1', { prefer: 'codex' }), 'codex', 'project over default');
  st.putSessionSetting(s, 's1', 'prefer', 'claude');
  st.putSessionSetting(s, 's1', 'review', false);
  assert.strictEqual(st.preferFor(s, 's1', { prefer: 'codex' }), 'claude', 'session over project');
  assert.strictEqual(st.reviewFor(s, 's1'), false);
  assert.strictEqual(s.sessions.s1.prefer, 'claude', 'a second setting keeps the first');
  assert.strictEqual(st.preferFor(s, 's2', null), 'claude', 'other sessions keep the default');
  assert.strictEqual(st.reviewFor(s, 's2'), true);
  assert.strictEqual(st.reviewFor({ ...s, review: false }, 's2'), false, 'default off');
  assert.strictEqual(st.preferFor(s, null, null), 'claude', 'no session');
});

test('per-session settings survive a concurrent write and are capped', () => {
  const a = st.readState();
  const b = st.readState();
  st.putSessionSetting(a, 'sa', 'prefer', 'codex');
  st.writeState(a);
  st.putSessionSetting(b, 'sb', 'review', false);
  st.writeState(b);
  assert.strictEqual(st.preferFor(onDisk(), 'sa', null), 'codex');
  assert.strictEqual(st.reviewFor(onDisk(), 'sb'), false);
  const c = st.readState();
  for (let i = 0; i < 30; i += 1) st.putSessionSetting(c, `x${i}`, 'review', true);
  assert.ok(Object.keys(c.sessions).length <= 20);
});

test('guided: per session and per review setting', () => {
  const s = { ...st.DEFAULT_STATE, sessions: {} };
  assert.strictEqual(st.guidedFor(s, 's1', true), false);
  st.markGuided(s, 's1', true);
  assert.strictEqual(st.guidedFor(s, 's1', true), true);
  assert.strictEqual(st.guidedFor(s, 's1', false), false, 'review turned off: the plain text is new');
  assert.strictEqual(st.guidedFor(s, 's2', true), false);
  assert.strictEqual(st.guidedFor(s, null, true), false);
});
