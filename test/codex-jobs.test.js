const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-codex-jobs-'));
const claudeDir = path.join(tmp, 'claude');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = path.join(tmp, 'codex');

const jobs = require('../plugin/scripts/jev-codex-jobs');

const workspace = path.join(claudeDir, 'plugins', 'data', 'codex-openai-codex', 'state', 'proj-0123456789abcdef');
fs.mkdirSync(path.join(workspace, 'jobs'), { recursive: true });

// Writes the companion's job list and returns each job's log path.
function writeJobs(list) {
  fs.writeFileSync(path.join(workspace, 'state.json'), JSON.stringify({ version: 1, jobs: list }));
}
function logPath(id) {
  return path.join(workspace, 'jobs', `${id}.log`);
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('running job of this session, with the latest log step', () => {
  fs.writeFileSync(logPath('t1'), [
    `[${ago(60000)}] Starting Codex Task.`,
    `[${ago(30000)}] Running command: rg -n foo`,
    `[${ago(1000)}] Applying 2 file change(s).`,
    '',
  ].join('\n'));
  writeJobs([
    { id: 't1', sessionId: 's1', status: 'running', phase: 'editing', pid: process.pid, startedAt: ago(90000), updatedAt: ago(1000), logFile: logPath('t1') },
    { id: 't0', sessionId: 's2', status: 'running', phase: 'running', pid: process.pid, startedAt: ago(1000), logFile: logPath('t0') },
  ]);
  const job = jobs.sessionJob('s1');
  assert.strictEqual(job.id, 't1');
  assert.strictEqual(job.status, 'running');
  assert.strictEqual(job.phase, 'editing');
  assert.strictEqual(job.last, 'Applying 2 file change(s).');
  assert.strictEqual(jobs.sessionJob('s3'), null, 'another session sees nothing');
  assert.strictEqual(jobs.sessionJob(''), null);
});

test('a running record whose process is gone does not count', () => {
  writeJobs([{ id: 't2', sessionId: 's1', status: 'running', pid: 2 ** 30, startedAt: ago(1000) }]);
  assert.strictEqual(jobs.sessionJob('s1'), null);
});

test('a finished job shows for a few minutes, then drops off', () => {
  writeJobs([{ id: 't3', sessionId: 's1', status: 'completed', startedAt: ago(200000), completedAt: ago(60000) }]);
  assert.deepStrictEqual(
    (({ id, status, last }) => ({ id, status, last }))(jobs.sessionJob('s1')),
    { id: 't3', status: 'completed', last: null });
  writeJobs([{ id: 't3', sessionId: 's1', status: 'completed', startedAt: ago(900000), completedAt: ago(jobs.FINISHED_SHOW_MS + 1000) }]);
  assert.strictEqual(jobs.sessionJob('s1'), null);
});

test('a running job wins over a newer finished one', () => {
  writeJobs([
    { id: 'run', sessionId: 's1', status: 'running', pid: process.pid, startedAt: ago(500000), updatedAt: ago(500000) },
    { id: 'done', sessionId: 's1', status: 'completed', startedAt: ago(5000), completedAt: ago(1000), updatedAt: ago(1000) },
  ]);
  assert.strictEqual(jobs.sessionJob('s1').id, 'run');
});

test('a log path outside the workspace dir is not read', () => {
  const outside = path.join(tmp, 'secret.log');
  fs.writeFileSync(outside, `[${ago(0)}] secret\n`);
  writeJobs([{ id: 't4', sessionId: 's1', status: 'running', pid: process.pid, startedAt: ago(1000), logFile: outside }]);
  assert.strictEqual(jobs.sessionJob('s1').last, null);
});

test('watch prints progress lines only, then the outcome, and exits', async () => {
  fs.writeFileSync(logPath('w1'), [
    `[${ago(9000)}] Starting Codex Task.`,
    `[${ago(8000)}] Running command: rg -n foo`,
    `[${ago(7000)}] Command completed: rg -n foo (exit 0)`,
    `[${ago(6000)}] Assistant message captured: Reading the parser first.`,
    '',
  ].join('\n'));
  writeJobs([{ id: 'w1', sessionId: 's1', status: 'running', pid: process.pid, startedAt: ago(10000), logFile: logPath('w1') }]);
  const out = [];
  let ended = false;
  const done = jobs.watch('w1', { pollMs: 20, write: (l) => out.push(l) }).then((code) => { ended = true; return code; });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(ended, false, 'keeps watching while the job runs');
  fs.appendFileSync(logPath('w1'), `[${ago(0)}] Applying 1 file change(s).\n[${ago(0)}] File changes completed.\n[${ago(0)}] Turn completed.\n`);
  writeJobs([{ id: 'w1', sessionId: 's1', status: 'completed', pid: null, startedAt: ago(10000), completedAt: ago(0), logFile: logPath('w1') }]);
  assert.strictEqual(await done, 0);
  assert.deepStrictEqual(out.slice(0, 3), [
    'Assistant message captured: Reading the parser first.',
    'Applying 1 file change(s).',
    'Turn completed.',
  ]);
  assert.match(out[3], /^Codex job w1 completed after 10s\. Read the result with the companion's result w1 command\.$/);
  assert.strictEqual(out.length, 4);
});

test('watch: unknown job and a crashed job exit non-zero', async () => {
  writeJobs([{ id: 'c1', sessionId: 's1', status: 'running', pid: 2 ** 30, startedAt: ago(1000) }]);
  const out = [];
  assert.strictEqual(await jobs.watch('nope', { write: (l) => out.push(l) }), 1);
  assert.strictEqual(await jobs.watch('c1', { write: (l) => out.push(l) }), 1);
  assert.deepStrictEqual(out.map((l) => l.split(' after')[0].split('.')[0]), ['Codex job nope not found', 'Codex job c1 stopped (its process exited)']);
});

test('status line shows this session\'s running task on its own line', () => {
  fs.writeFileSync(logPath('s1'), `[${ago(1000)}] Running command: npm test\n`);
  writeJobs([{ id: 's1', sessionId: 'sess', status: 'running', phase: 'verifying', pid: process.pid, startedAt: ago(125000), logFile: logPath('s1') }]);
  const script = path.join(__dirname, '..', 'plugin', 'scripts', 'cc-statusline.js');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(tmp, 'codex'), NO_COLOR: '1' };
  const render = (session) => execFileSync(process.execPath, [script], {
    input: JSON.stringify({ model: { display_name: 'Opus 5.5' }, session_id: session }), env, cwd: tmp,
  }).toString();
  const lines = render('sess').split('\n');
  assert.match(lines[lines.length - 1], /^CODEX TASK running 2m0[45]s · verifying · Running command: npm test$/);
  assert.doesNotMatch(render('other'), /CODEX TASK/);

  writeJobs([{ id: 's1', sessionId: 'sess', status: 'failed', startedAt: ago(70000), completedAt: ago(10000) }]);
  const after = render('sess').split('\n');
  assert.strictEqual(after[after.length - 1], 'CODEX TASK failed after 1m00s · /codex:result s1');
});
