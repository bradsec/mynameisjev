const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { reap, SAMPLE_GAP_MS } = require('../plugin/scripts/jev-codex-reap');

const COMPANION_ROOT = '/home/u/.claude/plugins/cache/openai-codex/codex';
const BROKER = `${COMPANION_ROOT}/1.0.6/scripts/app-server-broker.mjs`;
const sock = (pid) => `/tmp/cxc-${pid}/broker.sock`;

// /proc/<pid>/stat with the fields reap reads: session (4th after the
// command) and start time (20th after the command).
const statLine = (p) => {
  const after = ['S', p.ppid || 1, p.pgrp || p.pid, p.sid || p.pid, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, p.start || 1000];
  return `${p.pid} (${path.basename(p.args[0])}) ${after.join(' ')} 0 0`;
};

// /proc/net/unix: per broker a listening line, a pathless connected stdio
// socket, and one connected (St 03) server-side line per client.
const netUnix = (procs, clients = {}) => [
  'Num       RefCount Protocol Flags    Type St Inode Path',
  ...procs.filter((p) => p.listen).flatMap((p) => [
    `0000000000000001: 00000002 00000000 00010000 0001 01 ${p.pid}1 ${sock(p.pid)}`,
    `0000000000000003: 00000003 00000000 00000000 0001 03 ${p.pid}9`,
    ...Array.from({ length: clients[p.pid] ?? p.clients ?? 0 }, (_, i) => `0000000000000002: 00000003 00000000 00000000 0001 03 ${p.pid}2${i} ${sock(p.pid)}`),
  ]),
].join('\n');

function writeProc(root, p) {
  const dir = path.join(root, String(p.pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cmdline'), `${p.args.join('\0')}\0`);
  fs.writeFileSync(path.join(dir, 'environ'), Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}\0`).join(''));
  fs.writeFileSync(path.join(dir, 'stat'), statLine(p));
  if (p.listen) {
    fs.rmSync(path.join(dir, 'fd'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'fd'));
    // stdio socket to app-server, then the listening socket.
    fs.symlinkSync(`socket:[${p.pid}9]`, path.join(dir, 'fd', '3'));
    fs.symlinkSync(`socket:[${p.pid}1]`, path.join(dir, 'fd', '4'));
  }
}

const setClients = (root, procs, clients) => fs.writeFileSync(path.join(root, 'net', 'unix'), netUnix(procs, clients));

function fakeProc(procs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-reap-'));
  for (const p of procs) writeProc(root, p);
  fs.mkdirSync(path.join(root, 'net'));
  setClients(root, procs, {});
  return root;
}

// Brokers start at time 1000; a starter Claude process at 500.
const broker = (pid, cwd, env, extra = {}) => ({
  pid, listen: true, env, start: 1000, ...extra,
  args: ['node', extra.script || BROKER, 'serve', '--endpoint', `unix:${sock(pid)}`, '--cwd', cwd, '--pid-file', `/tmp/cxc-${pid}/broker.pid`],
});
const claude = (pid, start = 500) => ({ pid, start, args: ['claude'] });
const appServer = (pid, broker) => ({ pid, ppid: broker, pgrp: broker, sid: broker, start: 1001, args: ['codex', 'app-server'] });
const modeHost = (pid, server, broker) => ({ pid, ppid: server, pgrp: pid, sid: broker, start: 1002, args: ['codex-code-mode-host'] });
const startedBy = (claudePid) => ({ CLAUDE_CODE_SESSION_ID: `s${claudePid}`, CLAUDE_PID: String(claudePid) });

// Runs reap on a fake /proc. between(root) runs in place of the wait
// between the two client samples.
async function run(procs, { between, onKill, root } = {}) {
  const procRoot = root || fakeProc(procs);
  const killed = [];
  const waits = [];
  const reaped = await reap({
    procRoot,
    companionRoot: COMPANION_ROOT,
    sleep: async (ms) => { waits.push(ms); if (between) between(procRoot); },
    kill: (pid) => { killed.push(pid); if (onKill) onKill(pid, procRoot); },
  });
  return { reaped: reaped.sort((a, b) => a - b), killed: killed.sort((a, b) => a - b), waits };
}

test('idle brokers whose starting Claude process has exited are stopped, with their trees', async () => {
  // Claude pid 50 ran tasks in /repo, a worktree and a sibling repo, then exited.
  const { reaped, killed, waits } = await run([
    broker(100, '/repo', startedBy(50)), appServer(101, 100), modeHost(102, 101, 100),
    broker(200, '/tmp/scratchpad/worktree', startedBy(50)), appServer(201, 200), modeHost(202, 201, 200),
    broker(300, '/other-repo', startedBy(50)), appServer(301, 300),
  ]);
  assert.deepEqual(reaped, [100, 200, 300]);
  assert.deepEqual(killed, [100, 101, 102, 200, 201, 202, 300, 301]);
  assert.deepEqual(waits, [SAMPLE_GAP_MS], 'one wait between the two samples');
});

test('a broker whose starter is alive is kept, even when idle', async () => {
  const { reaped, killed, waits } = await run([claude(50), broker(100, '/repo', startedBy(50)), appServer(101, 100)]);
  assert.deepEqual(reaped, []);
  assert.deepEqual(killed, []);
  assert.deepEqual(waits, [], 'no candidates, no wait');
});

test('a starter PID reused by a process started after the broker counts as exited', async () => {
  const { reaped } = await run([claude(50, 2000), broker(100, '/repo', startedBy(50)), appServer(101, 100)]);
  assert.deepEqual(reaped, [100]);
});

test('a starter whose identity cannot be read counts as alive', async () => {
  const procs = [broker(100, '/repo', startedBy(50)), appServer(101, 100)];
  const root = fakeProc(procs);
  fs.mkdirSync(path.join(root, '50')); // exists, but no stat
  const { reaped, killed } = await run(procs, { root });
  assert.deepEqual(reaped, []);
  assert.deepEqual(killed, []);
});

test('a broker that gains a client between the samples is kept', async () => {
  const procs = [broker(100, '/repo', startedBy(50)), appServer(101, 100), broker(200, '/repo2', startedBy(50)), appServer(201, 200)];
  const { reaped, killed } = await run(procs, { between: (root) => setClients(root, procs, { 100: 1 }) });
  assert.deepEqual(reaped, [200]);
  assert.deepEqual(killed, [200, 201]);
});

test('a broker with a client on the first sample is kept, even if idle on the second', async () => {
  const procs = [broker(100, '/repo', startedBy(50), { clients: 1 }), appServer(101, 100)];
  const { reaped, killed } = await run(procs, { between: (root) => setClients(root, procs, { 100: 0 }) });
  assert.deepEqual(reaped, []);
  assert.deepEqual(killed, []);
});

test('brokers not started from Claude Code, or shells naming the script, are kept', async () => {
  const { reaped, killed } = await run([
    broker(200, '/repo2', {}), appServer(201, 200),
    { pid: 300, args: ['bash', '-c', `pgrep -f ${BROKER} serve`], env: startedBy(50) },
  ]);
  assert.deepEqual(reaped, []);
  assert.deepEqual(killed, []);
});

test('a broker that does not lead its own session is stopped alone', async () => {
  const b = { ...broker(100, '/repo', startedBy(50)), sid: 10 };
  const { killed } = await run([b, { pid: 101, ppid: 100, sid: 10, args: ['codex', 'app-server'] }, { pid: 102, sid: 10, args: ['zsh'] }]);
  assert.deepEqual(killed, [100]);
});

test('a broker whose listening socket cannot be found is kept', async () => {
  const { reaped, killed } = await run([{ ...broker(100, '/repo', startedBy(50)), listen: false }, appServer(101, 100)]);
  assert.deepEqual(reaped, []);
  assert.deepEqual(killed, []);
});

// The kernel cuts socket paths longer than 107 bytes, so /proc/net/unix may
// not show the --endpoint path as given.
test('clients count against the listening socket path as the kernel lists it', async () => {
  const b = broker(100, '/repo', startedBy(50), { clients: 1 });
  b.args[b.args.indexOf('--endpoint') + 1] = `unix:/tmp/${'x'.repeat(120)}/broker.sock`;
  const { killed } = await run([b, appServer(101, 100)]);
  assert.deepEqual(killed, []);
});

test('nothing is stopped when socket use cannot be read', async () => {
  const procs = [broker(100, '/repo', startedBy(50)), appServer(101, 100)];
  const { killed } = await run(procs, { between: (root) => fs.unlinkSync(path.join(root, 'net', 'unix')) });
  assert.deepEqual(killed, []);
});

// A process that exits after the scan can have its PID reused.
test('a PID whose process changed since the scan is not signalled', async () => {
  const { killed } = await run([
    broker(100, '/repo', startedBy(50)), appServer(101, 100), modeHost(102, 101, 100),
  ], {
    onKill: (pid, root) => {
      if (pid !== 100) return;
      // 101 exits and its PID goes to an unrelated process; 102 is replaced
      // by a process with the same command but a later start time.
      writeProc(root, { pid: 101, sid: 100, start: 1001, args: ['vim'] });
      writeProc(root, { pid: 102, ppid: 101, pgrp: 102, sid: 100, start: 9999, args: ['codex-code-mode-host'] });
    },
  });
  assert.deepEqual(killed, [100]);
});

test('a broker replaced during the wait is not signalled, nor its tree', async () => {
  const procs = [broker(100, '/repo', startedBy(50)), appServer(101, 100)];
  const { killed } = await run(procs, { between: (root) => writeProc(root, { ...procs[0], start: 5000 }) });
  assert.deepEqual(killed, []);
});

// Only the installed companion's broker script counts.
test('a same-named script outside the installed companion is not a broker', async () => {
  const env = startedBy(50);
  const { reaped, killed } = await run([
    broker(100, '/repo', env, { script: '/home/u/other-pkg/scripts/app-server-broker.mjs' }),
    broker(200, '/repo', env, { script: `${COMPANION_ROOT}/1.0.6/lib/app-server-broker.mjs` }),
    broker(300, '/repo', env, { script: `${COMPANION_ROOT}/../evil/1.0.6/scripts/app-server-broker.mjs` }),
    broker(400, '/repo', env, { script: `${COMPANION_ROOT}/1.0.5/scripts/app-server-broker.mjs` }),
  ]);
  assert.deepEqual(reaped, [400], 'an older installed version still counts');
  assert.deepEqual(killed, [400]);
});

// The hook has a 5 s budget; reading every process once per broker is
// brokers x processes file reads.
test('a large process table is scanned once', async () => {
  const procs = [];
  for (let i = 0; i < 6000; i++) procs.push({ pid: 10000 + i, args: ['bash'] });
  for (let b = 0; b < 60; b++) {
    const pid = 100000 + b * 10;
    procs.push(broker(pid, `/repo${b}`, startedBy(50)), appServer(pid + 1, pid), modeHost(pid + 2, pid + 1, pid));
  }
  const procRoot = fakeProc(procs);
  let statReads = 0;
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).endsWith('/stat')) statReads++;
    return readFileSync.call(this, file, ...rest);
  };
  const started = process.hrtime.bigint();
  let result;
  try {
    result = await run(procs, { root: procRoot });
  } finally {
    fs.readFileSync = readFileSync;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.reaped.length, 60);
  assert.equal(result.killed.length, 180);
  // One read per process in the scan, one more per signalled process.
  assert.ok(statReads <= procs.length + result.killed.length, `${statReads} stat reads for ${procs.length} processes`);
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

test('the sample gap leaves the hook margin within its timeout', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.SessionEnd.find((e) => e.hooks.some((h) => (h.args || []).some((a) => a.endsWith('/jev-codex-reap.js'))));
  assert.ok(entry, 'SessionEnd runs jev-codex-reap.js');
  assert.equal(entry.matcher, undefined, 'not limited to one end reason');
  const hook = entry.hooks.find((h) => h.args.some((a) => a.endsWith('/jev-codex-reap.js')));
  assert.ok(SAMPLE_GAP_MS >= 1000 && SAMPLE_GAP_MS <= hook.timeout * 1000 / 2, `gap ${SAMPLE_GAP_MS} ms, timeout ${hook.timeout} s`);
});
