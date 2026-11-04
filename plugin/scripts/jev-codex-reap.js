#!/usr/bin/env node
// jev-codex-reap — SessionEnd hook: stops the codex plugin's shared
// app-server brokers that were left behind by a Claude process that has
// exited and that nobody is using.
//
// The companion starts one detached broker per workspace (the git root of the
// directory a task runs in) and has no idle timeout. Its own SessionEnd hook
// stops only the broker of the session's last directory, so a session that
// ran Codex tasks after `cd` into other repos, subdirectories or worktrees
// leaves those brokers (and their `codex app-server` trees) running for days.
//
// A broker is stopped only when both hold:
// - The Claude process that started it (CLAUDE_PID in its environment) has
//   exited: no process has that PID, or the one that has it started after
//   the broker did. A live starter, or one that cannot be read, keeps it.
// - Its listening socket has no connected client on two samples
//   SAMPLE_GAP_MS apart. The companion hands a ready broker to any later
//   session in the same workspace, and a task holds its connection for as
//   long as it runs, so a client means some session is using it.
// An idle broker is safe to stop: the companion's next task in that
// workspace finds it gone and starts a new one. A task that connects in the
// moment between the second sample and the signal is not detected.
//
// The ending session's own brokers are stopped at a later session end, once
// its Claude process has exited. Reads /proc, so Linux only. Anything it
// cannot read stops nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const COMPANION_ROOT = path.join(claudeDir, 'plugins', 'cache', 'openai-codex', 'codex');
// The hook's timeout is 5 s. Node start and the /proc scan take well under
// a second, so a 2 s gap between the two client samples leaves over 2 s of
// margin. A longer gap catches more connections but risks the timeout.
const SAMPLE_GAP_MS = 2000;
const UNIX_CONNECTED = '03';
const LISTENING = '00010000'; // __SO_ACCEPTCON: a listening socket

function readProc(procRoot, pid, file) {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), file), 'utf8');
  } catch (e) {
    return null;
  }
}

// Session ID and start time from /proc/<pid>/stat, plus the command line:
// together they identify one process even after its PID is reused.
function identity(procRoot, pid) {
  const stat = readProc(procRoot, pid, 'stat');
  const cmdline = readProc(procRoot, pid, 'cmdline');
  if (!stat || cmdline === null) return null;
  // Fields after the parenthesised command: state ppid pgrp session ... with
  // the start time 20th.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const sid = Number(fields[3]);
  if (!Number.isInteger(sid) || !fields[19]) return null;
  return { sid, start: Number(fields[19]), cmdline };
}

const sameProcess = (a, b) => !!a && !!b && a.start === b.start && a.cmdline === b.cmdline;

// args[1] is <companion root>/<version>/scripts/app-server-broker.mjs.
function isBrokerScript(script, companionRoot) {
  if (!script || !path.isAbsolute(script)) return false;
  const parts = path.relative(companionRoot, path.normalize(script)).split(path.sep);
  return parts.length === 3 && parts[0] !== '..' && parts[0] !== '' &&
    parts[1] === 'scripts' && parts[2] === 'app-server-broker.mjs';
}

// Connected clients of a broker's listening socket, or null when that
// cannot be read. The listening socket is found among the broker's open
// files by inode, so its path is taken as /proc/net/unix shows it (the
// kernel cuts long paths short). Each accepted client socket is listed
// connected (St 03) with the same path; the broker's own stdio sockets to
// `codex app-server` are connected too, but have no path.
function brokerClients(procRoot, pid) {
  let text;
  let inodes;
  try {
    text = fs.readFileSync(path.join(procRoot, 'net', 'unix'), 'utf8');
    const fdDir = path.join(procRoot, String(pid), 'fd');
    inodes = new Set(fs.readdirSync(fdDir).map((fd) => {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(path.join(fdDir, fd)));
        return m ? m[1] : null;
      } catch (e) {
        return null; // Closed meanwhile.
      }
    }).filter(Boolean));
  } catch (e) {
    return null;
  }
  const entries = text.split('\n').slice(1).map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 7)
    .map((f) => ({ flags: f[3], st: f[5], inode: f[6], path: f.slice(7).join(' ') }));
  const listening = entries.find((e) => inodes.has(e.inode) && e.flags === LISTENING && e.path);
  if (!listening) return null;
  return entries.filter((e) => e.st === UNIX_CONNECTED && e.path === listening.path).length;
}

// True only when the broker's starting Claude process is known to be gone:
// its PID is free, or reused by a process that started after the broker.
function starterExited(procRoot, ids, broker) {
  const starter = ids.get(broker.claudePid);
  if (starter) return starter.start > ids.get(broker.pid).start;
  return !fs.existsSync(path.join(procRoot, String(broker.claudePid)));
}

// One pass over /proc: every process's identity, grouped by session ID, and
// the companion's brokers with their markers.
function scan(procRoot, companionRoot) {
  let pids;
  try {
    pids = fs.readdirSync(procRoot).filter((d) => /^\d+$/.test(d)).map(Number);
  } catch (e) {
    return { ids: new Map(), bySession: new Map(), brokers: [] };
  }
  const ids = new Map();
  const bySession = new Map();
  const brokers = [];
  for (const pid of pids) {
    const id = identity(procRoot, pid);
    if (!id) continue;
    ids.set(pid, id);
    if (!bySession.has(id.sid)) bySession.set(id.sid, []);
    bySession.get(id.sid).push(pid);
    const args = id.cmdline.split('\0');
    if (args[2] !== 'serve' || !isBrokerScript(args[1], companionRoot)) continue;
    const env = {};
    for (const entry of (readProc(procRoot, pid, 'environ') || '').split('\0')) {
      const eq = entry.indexOf('=');
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const claudePid = Number(env.CLAUDE_PID);
    if (Number.isInteger(claudePid) && claudePid > 0) brokers.push({ pid, claudePid });
  }
  return { ids, bySession, brokers };
}

// Stops the brokers to reap and returns their PIDs. A broker is started
// detached, so it leads its own session: its `codex app-server` and that
// server's helpers (some in their own process group) share the session ID.
async function reap({
  procRoot = '/proc',
  companionRoot = COMPANION_ROOT,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  kill = (pid) => process.kill(pid, 'SIGTERM'),
} = {}) {
  const { ids, bySession, brokers } = scan(procRoot, companionRoot);
  let candidates = brokers.filter((b) => starterExited(procRoot, ids, b) && brokerClients(procRoot, b.pid) === 0);
  if (candidates.length === 0) return [];
  await sleep(SAMPLE_GAP_MS);
  candidates = candidates.filter((b) => brokerClients(procRoot, b.pid) === 0);
  const reaped = [];
  for (const b of candidates) {
    const scanned = ids.get(b.pid);
    if (!sameProcess(scanned, identity(procRoot, b.pid))) continue;
    const tree = scanned.sid === b.pid ? [b.pid, ...bySession.get(b.pid).filter((p) => p !== b.pid)] : [b.pid];
    for (const pid of tree) {
      // Each PID is checked right before its own signal, since it may have
      // exited and been reused.
      if (pid !== b.pid && !sameProcess(ids.get(pid), identity(procRoot, pid))) continue;
      try {
        kill(pid);
      } catch (e) {
        // Exited meanwhile.
      }
    }
    reaped.push(b.pid);
  }
  return reaped;
}

module.exports = { reap, SAMPLE_GAP_MS };

if (require.main === module) {
  // The hook input is not needed: which session ended does not matter.
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (process.platform !== 'linux') return;
    // Report, but never fail the session end over cleanup.
    reap().catch((e) => process.stderr.write(`jev-codex-reap: ${e.message}\n`));
  });
}
