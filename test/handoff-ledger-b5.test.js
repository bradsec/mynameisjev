const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ledger-b5-'));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.CODEX_HOME = path.join(home, '.codex');
const ledger = require('../plugin/scripts/jev-handoff-ledger');
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

const sessionId = '11111111-2222-3333-4444-555555555555';
const jobsDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'data', 'codex-openai-codex', 'state', 'workspace');
const rolloutDir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '10');
const transcript = path.join(home, 'transcript.jsonl');
fs.mkdirSync(jobsDir, { recursive: true });
fs.mkdirSync(rolloutDir, { recursive: true });
fs.writeFileSync(transcript, '');

// Codex writes total_token_usage as the running total for the whole thread.
const count = (input, output) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
  input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0,
} } } }) + '\n';
const writeJobs = (threadId, ids) => fs.writeFileSync(path.join(jobsDir, 'state.json'), JSON.stringify({ jobs: ids.map((id, i) => (
  { id, sessionId, threadId, createdAt: `2026-11-10T01:0${i}:00Z` })) }));
const hook = (threadId) => ({ session_id: sessionId, transcript_path: transcript,
  tool_response: { stdout: `Done.\n[codex] Thread ready (${threadId}).\n` } });
const sums = (tasks) => tasks.reduce((sum, task) => (
  { input: sum.input + task.codex.input, output: sum.output + task.codex.output }), { input: 0, output: 0 });

test('a resumed Codex thread counts each turn once across its tasks', () => {
  const threadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const rollout = path.join(rolloutDir, `rollout-2026-11-10T01-00-00-${threadId}.jsonl`);
  const state = {};

  writeJobs(threadId, ['task-1']);
  fs.writeFileSync(rollout, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }) + '\n' + count(1000, 100));
  ledger.register(state, hook(threadId));
  // --resume-last: a second job on the same thread, whose turn used 500 input and 50 output.
  writeJobs(threadId, ['task-1', 'task-2']);
  fs.appendFileSync(rollout, count(1500, 150));
  ledger.register(state, hook(threadId));
  ledger.finish(state, { session_id: sessionId, transcript_path: transcript });

  const session = state.handoffLedger[sessionId];
  assert.deepEqual(session.tasks.map((task) => task.jobId), ['task-1', 'task-2']);
  const totals = session.totals.models['gpt-6.1-sol'];
  assert.deepEqual({ runs: totals.runs, input: totals.input, output: totals.output }, { runs: 2, input: 1500, output: 150 });
  // The report command sums the stored per-task usage, so that must also add up to the thread total.
  assert.deepEqual(session.tasks.map((task) => [task.codex.input, task.codex.output]), [[1000, 100], [500, 50]]);
});

test('a resumed thread whose first task was read late still totals the thread once', () => {
  const threadId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const rollout = path.join(rolloutDir, `rollout-2026-11-10T02-00-00-${threadId}.jsonl`);
  const state = {};

  // The rollout does not exist yet when the first task is registered, so its usage is read at Stop.
  writeJobs(threadId, ['task-3']);
  ledger.register(state, hook(threadId));
  writeJobs(threadId, ['task-3', 'task-4']);
  fs.writeFileSync(rollout, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }) + '\n' + count(1000, 100) + count(1500, 150));
  ledger.register(state, hook(threadId));
  ledger.finish(state, { session_id: sessionId, transcript_path: transcript });

  const session = state.handoffLedger[sessionId];
  assert.deepEqual(sums(session.tasks), { input: 1500, output: 150 });
  const totals = session.totals.models['gpt-6.1-sol'];
  assert.deepEqual({ runs: totals.runs, input: totals.input, output: totals.output }, { runs: 2, input: 1500, output: 150 });
});

// The tests below go through the state file, as the hooks do.
const st = require('../plugin/scripts/jev-state');
const statePath = path.join(st.dataDir, 'state.json');
fs.mkdirSync(st.dataDir, { recursive: true });
const jobHook = (id) => ({ session_id: sessionId, transcript_path: transcript, tool_response: { stdout: `Job: ${id}\nDone.\n` } });
const newThread = (threadId, ...counts) => {
  const rollout = path.join(rolloutDir, `rollout-2026-11-10T03-00-00-${threadId}.jsonl`);
  fs.writeFileSync(rollout, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }) + '\n' + counts.join(''));
  fs.writeFileSync(statePath, JSON.stringify({ enabled: true }));
  return rollout;
};
const inputs = (tasks) => tasks.map((task) => task.codex && task.codex.input);
const onDisk = () => JSON.parse(fs.readFileSync(statePath, 'utf8')).handoffLedger[sessionId];

test('R1: two overlapping hooks on one thread total the thread once after Stop', () => {
  const threadId = 'cccccccc-dddd-eeee-ffff-000000000001';
  const rollout = newThread(threadId, count(1000, 100));
  writeJobs(threadId, ['task-1']);
  let state = st.readState();
  ledger.register(state, jobHook('task-1'));
  st.writeState(state);
  // Both hooks read the state before either writes it.
  writeJobs(threadId, ['task-1', 'task-2', 'task-3']);
  const a = st.readState();
  const b = st.readState();
  fs.appendFileSync(rollout, count(1500, 150));
  ledger.register(a, jobHook('task-2'));
  fs.appendFileSync(rollout, count(1800, 180));
  ledger.register(b, jobHook('task-3'));
  st.writeState(a);
  st.writeState(b);
  state = st.readState();
  ledger.finish(state, { session_id: sessionId, transcript_path: transcript });
  st.writeState(state);

  const session = onDisk();
  assert.deepEqual(session.tasks.map((task) => task.jobId), ['task-1', 'task-2', 'task-3']);
  assert.deepEqual(inputs(session.tasks), [1000, 500, 300]);
  assert.equal(session.totals.models['gpt-6.1-sol'].input, 1800);
  assert.equal(session.totals.models['gpt-6.1-sol'].output, 180);
});

test('R2: a resumed task registered before its turn wrote tokens is read again when its result returns', () => {
  const threadId = 'cccccccc-dddd-eeee-ffff-000000000002';
  const rollout = newThread(threadId, count(1000, 100));
  writeJobs(threadId, ['task-1']);
  const state = {};
  ledger.register(state, jobHook('task-1'));
  // Background launch: the job already carries the thread, which still stands at the first turn.
  writeJobs(threadId, ['task-1', 'task-2']);
  ledger.register(state, jobHook('task-2'), null, false);
  assert.deepEqual(inputs(state.handoffLedger[sessionId].tasks), [1000, 0]);
  fs.appendFileSync(rollout, count(1500, 150));
  ledger.register(state, jobHook('task-2'), 'task-2', true);
  ledger.finish(state, { session_id: sessionId, transcript_path: transcript });

  assert.deepEqual(inputs(state.handoffLedger[sessionId].tasks), [1000, 500]);
  assert.equal(state.handoffLedger[sessionId].totals.models['gpt-6.1-sol'].input, 1500);
});

test('R5: trimming a session to 100 tasks leaves later tasks on the thread with their own turn', () => {
  const threadId = 'cccccccc-dddd-eeee-ffff-000000000003';
  const rollout = newThread(threadId);
  const ids = Array.from({ length: 102 }, (_, i) => `task-${i}`);
  fs.writeFileSync(path.join(jobsDir, 'state.json'), JSON.stringify({ jobs: ids.map((id) => (
    { id, sessionId, threadId, createdAt: '2026-11-10T01:00:00Z' })) }));
  const state = {};
  ids.forEach((id, i) => {
    fs.appendFileSync(rollout, count(1000 * (i + 1), 0));
    ledger.register(state, jobHook(id));
  });
  ledger.finish(state, { session_id: sessionId, transcript_path: transcript });

  const tasks = state.handoffLedger[sessionId].tasks;
  assert.equal(tasks.length, 100);
  assert.deepEqual([...new Set(inputs(tasks))], [1000]);
});

test('S3: a transcript tail that starts inside a multibyte character keeps the hand-off boundary', () => {
  const threadId = 'cccccccc-dddd-eeee-ffff-000000000004';
  newThread(threadId, count(10, 1));
  writeJobs(threadId, ['task-s3']);
  const lines = [
    { type: 'assistant', timestamp: '2026-11-10T01:00:00Z', message: { id: 'brief', model: 'claude-sonnet-4-5',
      usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: 'tool_use', id: 'tu-s3', name: 'Bash' }] } },
    { type: 'assistant', message: { id: 'review', model: 'claude-sonnet-4-5', usage: { input_tokens: 7, output_tokens: 3 } } },
  ].map(JSON.stringify).join('\n') + '\n';
  // One long first line of two-byte characters, sized so the 8 MB tail starts on a second byte.
  const filler = 'é'.repeat(4200000);
  const cut = Buffer.byteLength(filler) + 1 + Buffer.byteLength(lines) - 8 * 1024 * 1024;
  const big = path.join(home, 'big-transcript.jsonl');
  fs.writeFileSync(big, filler + (cut % 2 ? '' : 'x') + '\n' + lines);
  try {
    const hookInput = { session_id: sessionId, transcript_path: big, tool_use_id: 'tu-s3', tool_response: { stdout: 'Job: task-s3\nDone.\n' } };
    const state = {};
    ledger.register(state, hookInput);
    ledger.finish(state, hookInput);
    const task = state.handoffLedger[sessionId].tasks[0];
    assert.equal(task.start, fs.statSync(big).size - Buffer.byteLength(lines));
    assert.deepEqual(task.claude, { input: 12, cacheWrite: 0, cacheRead: 0, output: 5 });
  } finally { fs.rmSync(big); }
});

test('R1: the report totals a thread once when read between two overlapping hooks and Stop', () => {
  const { execFileSync } = require('child_process');
  const threadId = 'cccccccc-dddd-eeee-ffff-000000000005';
  const rollout = newThread(threadId, count(1000, 100));
  writeJobs(threadId, ['task-1']);
  const state = st.readState();
  ledger.register(state, jobHook('task-1'));
  st.writeState(state);
  writeJobs(threadId, ['task-1', 'task-2', 'task-3']);
  const a = st.readState();
  const b = st.readState();
  fs.appendFileSync(rollout, count(1500, 150));
  ledger.register(a, jobHook('task-2'));
  fs.appendFileSync(rollout, count(1800, 180));
  ledger.register(b, jobHook('task-3'));
  st.writeState(a);
  st.writeState(b);

  const before = fs.readFileSync(statePath, 'utf8');
  for (const args of [['report'], ['report', '--session']]) {
    const output = execFileSync(process.execPath, [path.join(__dirname, '../plugin/scripts/jev-cli.js'), ...args],
      { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } });
    assert.match(output, /gpt-6\.1-sol: 3 tasks, input 1\.8k, cached input 0, output 180, /);
  }
  // Reading the report leaves the ledger as the hooks wrote it.
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).handoffLedger, JSON.parse(before).handoffLedger);
});

test('P2: a new task on a thread with tasks stored by 0.3.28 gets its own turn', () => {
  const threadId = 'cccccccc-dddd-eeee-ffff-000000000006';
  const rollout = newThread(threadId, count(1000, 100), count(1500, 150));
  // 0.3.28 stored the thread's running total on each task and no codexTotal.
  const old = (jobId, input, output) => ({ jobId, threadId, start: null, claude: null, returned: true, done: true,
    codex: { model: 'gpt-6.1-sol', input, cacheRead: 0, output, reasoningOutput: 0 } });
  const state = { handoffLedger: { [sessionId]: { at: 1, tasks: [old('task-1', 1000, 100), old('task-2', 1500, 150)] } } };
  writeJobs(threadId, ['task-1', 'task-2', 'task-3', 'task-4']);
  fs.appendFileSync(rollout, count(1800, 180));
  ledger.register(state, jobHook('task-3'));
  fs.appendFileSync(rollout, count(2000, 200));
  ledger.register(state, jobHook('task-4'));
  ledger.finish(state, { session_id: sessionId, transcript_path: transcript });

  const tasks = state.handoffLedger[sessionId].tasks;
  // The old tasks keep what 0.3.28 stored; the new ones hold 300 and 200.
  assert.deepEqual(tasks.map((task) => [task.codex.input, task.codex.output]), [[1000, 100], [1500, 150], [300, 30], [200, 20]]);
});
