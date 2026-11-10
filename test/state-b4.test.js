// B4: two hook processes read state.json before either writes it. The
// interleaving is made deterministic by holding two reads in one process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-state-b4-'));
test.after(() => fs.rmSync(claudeDir, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const st = require('../plugin/scripts/jev-state');
const statePath = path.join(st.dataDir, 'state.json');
const onDisk = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const seed = (state) => {
  fs.mkdirSync(st.dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ enabled: true, ...state }));
};

// A ledger task as jev-handoff-ledger.js register() records it.
const task = (jobId, start = null) => ({ jobId, threadId: null, codex: null, start, claude: null, returned: true, done: false });
// What register() does to the state for a new task.
function addTask(state, session, t, at) {
  const ledger = state.handoffLedger || (state.handoffLedger = {});
  const own = ledger[session] || (ledger[session] = { at, tasks: [] });
  own.tasks.push(t);
  own.at = at;
}
const jobIds = (session) => onDisk().handoffLedger[session].tasks.map((t) => t.jobId);

test('B4: two hooks that each add a ledger task to a new session both keep it', () => {
  seed({});
  const a = st.readState();
  const b = st.readState();
  addTask(a, 's1', task('task-aaa', 10), 1000);
  addTask(b, 's1', task('task-bbb', 20), 2000);
  st.writeState(a);
  st.writeState(b);
  assert.deepStrictEqual(jobIds('s1'), ['task-aaa', 'task-bbb']);
  assert.strictEqual(onDisk().handoffLedger.s1.at, 2000, 'a time is stored, not summed');
});

test('B4: a ledger task added on an older read keeps the tasks written meanwhile', () => {
  seed({ handoffLedger: { s1: { at: 1, tasks: [{ ...task('task-1'), done: true }] } } });
  const a = st.readState();
  const b = st.readState();
  // No job id and no transcript offset: nothing tells these two apart.
  addTask(a, 's1', task(null), 1000);
  st.writeState(a);
  addTask(b, 's1', task(null), 2000);
  st.writeState(b);
  assert.deepStrictEqual(jobIds('s1'), ['task-1', null, null]);
  assert.strictEqual(onDisk().handoffLedger.s1.at, 2000, 'a time is stored, not summed');
});

test('B4: a change to one ledger task keeps a task another hook added', () => {
  seed({ handoffLedger: { s1: { at: 1, tasks: [task('task-1', 10)] } } });
  const a = st.readState();
  const b = st.readState();
  addTask(a, 's1', task('task-2', 20), 1000);
  st.writeState(a);
  // The Stop hook finishes the task it read.
  Object.assign(b.handoffLedger.s1.tasks[0], { done: true, claude: { input: 5, cacheWrite: 0, cacheRead: 0, output: 7 } });
  st.writeState(b);
  const tasks = onDisk().handoffLedger.s1.tasks;
  assert.deepStrictEqual(tasks.map((t) => [t.jobId, t.done]), [['task-1', true], ['task-2', false]]);
  assert.deepStrictEqual(tasks[0].claude, { input: 5, cacheWrite: 0, cacheRead: 0, output: 7 });
});

test('B4: ledger tasks a hook trimmed stay removed, and the same job is not listed twice', () => {
  seed({ handoffLedger: { s1: { at: 1, tasks: [task('task-1', 10), task('task-2', 20)] } } });
  const a = st.readState();
  const b = st.readState();
  addTask(a, 's1', task('task-3', 30), 1000);
  st.writeState(a);
  b.handoffLedger.s1.tasks.shift();
  addTask(b, 's1', task('task-3', 30), 2000);
  st.writeState(b);
  assert.deepStrictEqual(jobIds('s1'), ['task-2', 'task-3']);
});

test('B4: two sessions recording the same update-check time store that time', () => {
  seed({ updatesNoticeAt: 1762700000000 });
  const a = st.readState();
  const b = st.readState();
  a.updatesNoticeAt = 1762786400000;
  b.updatesNoticeAt = 1762786400000;
  st.writeState(a);
  st.writeState(b);
  assert.strictEqual(onDisk().updatesNoticeAt, 1762786400000);
});

test('B4: counters still add up across concurrent writers', () => {
  seed({ cost: 0.25, costs: { sizing: { calls: 1, cost: 0.25 } }, tiebreakTurn: { turn: 't1', count: 0 }, helperTokens: { haiku: { runs: 1, input: 10, cacheWrite: 0, cacheRead: 0, output: 5 } } });
  const a = st.readState();
  const b = st.readState();
  for (const s of [a, b]) {
    s.stats.codexRuns += 1;
    st.addCost(s, 'sizing', 0.25);
    s.helperTokens.haiku = { runs: s.helperTokens.haiku.runs + 1, input: s.helperTokens.haiku.input + 10, cacheWrite: 0, cacheRead: 0, output: s.helperTokens.haiku.output + 5 };
    s.tiebreakTurn = { turn: 't1', count: s.tiebreakTurn.count + 1 };
    st.writeState(s);
  }
  const s = onDisk();
  assert.strictEqual(s.stats.codexRuns, 2);
  assert.strictEqual(s.cost, 0.75);
  assert.deepStrictEqual(s.costs.sizing, { calls: 3, cost: 0.75 });
  assert.deepStrictEqual(s.helperTokens.haiku, { runs: 3, input: 30, cacheWrite: 0, cacheRead: 0, output: 15 });
  assert.strictEqual(s.tiebreakTurn.count, 2);
});

test('R4: two hooks that each create the same session entry keep both settings', () => {
  seed({});
  const a = st.readState();
  const b = st.readState();
  st.putSessionSetting(a, 'new', 'guided', 'review');
  st.writeState(a);
  st.putSessionSetting(b, 'new', 'limitNote', 'five_hour:1:90');
  st.writeState(b);
  const own = onDisk().sessions.new;
  assert.strictEqual(own.guided, 'review');
  assert.strictEqual(own.limitNote, 'five_hour:1:90');
});

test('R4: the first calls two hooks record for a feature or helper model both count', () => {
  seed({});
  const a = st.readState();
  const b = st.readState();
  for (const s of [a, b]) {
    st.addCost(s, 'sizing', 0.25);
    s.helperTokens.haiku = { runs: 1, input: 10, cacheWrite: 0, cacheRead: 0, output: 5 };
    s.stats.custom = (s.stats.custom || 0) + 1;
    st.writeState(s);
  }
  const s = onDisk();
  assert.strictEqual(s.cost, 0.5);
  assert.deepStrictEqual(s.costs.sizing, { calls: 2, cost: 0.5 });
  assert.deepStrictEqual(s.helperTokens.haiku, { runs: 2, input: 20, cacheWrite: 0, cacheRead: 0, output: 10 });
  assert.strictEqual(s.stats.custom, 2);
});

test('R4: a route or Codex tier new to both hooks is still replaced whole', () => {
  seed({});
  const a = st.readState();
  const b = st.readState();
  st.putRoute(a, { at: '2026-11-10T00:00:01.000Z', target: 'codex', model: 'default', how: 'suggested', session: 's1', reviewing: true });
  a.codexTiers = { large: { model: 'm1', effort: 'high' } };
  st.writeState(a);
  const theirs = { at: '2026-11-10T00:00:02.000Z', target: 'claude', model: 'opus', how: 'session', session: 's1' };
  st.putRoute(b, theirs);
  b.codexTiers = { large: { model: 'm2' } };
  st.writeState(b);
  assert.deepStrictEqual(onDisk().routes.s1, theirs);
  assert.deepStrictEqual(onDisk().codexTiers.large, { model: 'm2' });
});

// state.tiebreakTurn is { [session]: { turn, count } } (jev-tiebreak.js);
// '' is the entry of callers with no session ID.
test('G1: two sessions that start their first turn at once both keep their count', () => {
  seed({});
  const a = st.readState();
  const b = st.readState();
  a.tiebreakTurn = { A: { turn: 'tA', count: 0 } };
  b.tiebreakTurn = { B: { turn: 'tB', count: 0 } };
  st.writeState(a);
  st.writeState(b);
  assert.deepStrictEqual(onDisk().tiebreakTurn, { A: { turn: 'tA', count: 0 }, B: { turn: 'tB', count: 0 } });
});

test('G2: two first claims with no session entry yet both count', () => {
  seed({ promptAt: 't1' });
  const a = st.readState();
  const b = st.readState();
  a.tiebreakTurn = { '': { turn: 't1', count: 1 } };
  b.tiebreakTurn = { '': { turn: 't1', count: 1 } };
  st.writeState(a);
  st.writeState(b);
  assert.deepStrictEqual(onDisk().tiebreakTurn, { '': { turn: 't1', count: 2 } });
});

test('G2: claims in a new turn do not carry the old turn\'s count', () => {
  seed({ tiebreakTurn: { '': { turn: 't1', count: 2 }, A: { turn: 't1', count: 2 } } });
  const a = st.readState();
  const b = st.readState();
  // Two first claims of turn t2 with no session ID.
  a.tiebreakTurn = { ...a.tiebreakTurn, '': { turn: 't2', count: 1 } };
  b.tiebreakTurn = { ...b.tiebreakTurn, '': { turn: 't2', count: 1 } };
  st.writeState(a);
  // Session A's router starts turn t2 while a claim of t1 lands late.
  const late = st.readState();
  late.tiebreakTurn.A = { turn: 't1', count: 3 };
  st.writeState(late);
  b.tiebreakTurn.A = { turn: 't2', count: 0 };
  st.writeState(b);
  assert.deepStrictEqual(onDisk().tiebreakTurn, { '': { turn: 't2', count: 2 }, A: { turn: 't2', count: 0 } });
});

test('G1: claims in one turn still add up, and a dropped session stays dropped', () => {
  seed({ tiebreakTurn: { old: { turn: 't0', count: 1 }, A: { turn: 'tA', count: 0 } } });
  const a = st.readState();
  const b = st.readState();
  a.tiebreakTurn = { A: { turn: 'tA', count: 1 } };
  b.tiebreakTurn.A = { turn: 'tA', count: 1 };
  st.writeState(a);
  st.writeState(b);
  assert.deepStrictEqual(onDisk().tiebreakTurn, { A: { turn: 'tA', count: 2 } });
});
