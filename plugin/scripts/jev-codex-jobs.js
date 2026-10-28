#!/usr/bin/env node
// jev-codex-jobs — progress of Codex companion tasks while they run.
//
// The companion records every task, foreground or --background, under
// <root>/<workspace>-<hash>/: state.json lists the jobs (status, phase, pid,
// sessionId, logFile) and jobs/<id>.log gets one line per step. <root> is
// the codex plugin's data dir when the companion ran with its
// CLAUDE_PLUGIN_DATA, otherwise <tmpdir>/codex-companion (lib/state.mjs in
// the codex plugin). Callers here (the status line, the router's Bash calls)
// do not share that environment, so both roots are scanned.
//
// `node jev-codex-jobs.js watch <job-id>` prints the job's progress lines as
// they arrive and exits when the job ends: run it with Claude Code's Monitor
// tool to get updates during a long --background task.

const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ACTIVE = new Set(['queued', 'running']);
// A finished job stays on the status line this long, so its end is not missed.
const FINISHED_SHOW_MS = 5 * 60 * 1000;
const WATCH_POLL_MS = 2000;
// Log lines worth waking Claude for. Command and file-change lines repeat
// dozens of times per task; Codex's own messages summarise them.
const WATCH_LINE = /^(Assistant message captured|Applying \d+ file change|Command failed|Turn (completed|failed)|Reviewer (started|finished))/;

function stateRoots() {
  return [
    path.join(claudeDir, 'plugins', 'data', 'codex-openai-codex', 'state'),
    path.join(os.tmpdir(), 'codex-companion'),
  ];
}

// Every workspace state dir with its job list: [{ dir, jobs }].
function workspaces() {
  const out = [];
  for (const root of stateRoots()) {
    let names;
    try { names = fs.readdirSync(root); } catch (e) { continue; }
    for (const name of names) {
      const dir = path.join(root, name);
      try {
        const jobs = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).jobs;
        if (Array.isArray(jobs)) out.push({ dir, jobs });
      } catch (e) {
        // Not a workspace dir, or a write in progress: skip it this time.
      }
    }
  }
  return out;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// The log path the job names, only when it lies inside its workspace dir:
// state.json is another plugin's file, so it does not pick what gets read.
function logFileOf(dir, job) {
  if (typeof job.logFile !== 'string') return null;
  try {
    const file = fs.realpathSync(job.logFile);
    return file.startsWith(fs.realpathSync(dir) + path.sep) ? file : null;
  } catch (e) {
    return null;
  }
}

// "[2026-10-25T02:11:45.226Z] Running command: ..." -> "Running command: ...".
function stripStamp(line) {
  return line.replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
}

// Last progress line of a log, read from its tail only.
function lastLogLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => /^\[[^\]]*\]\s*\S/.test(l));
    return lines.length ? stripStamp(lines[lines.length - 1]) : null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// This session's running Codex job, else the one that finished last within
// FINISHED_SHOW_MS, or null. A running job whose process is gone crashed
// without updating its record, so it does not count.
function sessionJob(sessionId, now = Date.now()) {
  if (!sessionId) return null;
  let best = null;
  for (const { dir, jobs } of workspaces()) {
    for (const job of jobs) {
      if (!job || job.sessionId !== sessionId) continue;
      const active = ACTIVE.has(job.status) && alive(job.pid);
      const ended = Date.parse(job.completedAt);
      if (!active && !(now - ended < FINISHED_SHOW_MS)) continue;
      const at = Date.parse(job.updatedAt || job.startedAt || job.createdAt) || 0;
      if (best && (best.active && !active || (best.active === active && best.at >= at))) continue;
      best = { dir, job, active, at };
    }
  }
  if (!best) return null;
  const { job } = best;
  return {
    id: job.id,
    status: job.status,
    phase: job.phase || null,
    startedAt: Date.parse(job.startedAt || job.createdAt) || null,
    completedAt: Date.parse(job.completedAt) || null,
    last: best.active ? lastLogLine(logFileOf(best.dir, job)) : null,
  };
}

function findJob(id) {
  for (const { dir, jobs } of workspaces()) {
    const job = jobs.find((j) => j && j.id === id);
    if (job) return { dir, job };
  }
  return null;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

// Prints the job's progress lines (WATCH_LINE) from the start of its log,
// then a last line once it ends. Resolves to the exit code.
async function watch(id, { pollMs = WATCH_POLL_MS, write = (l) => process.stdout.write(`${l}\n`) } = {}) {
  let found = findJob(id);
  if (!found) {
    write(`Codex job ${id} not found.`);
    return 1;
  }
  const file = logFileOf(found.dir, found.job);
  let offset = 0;
  let partial = '';
  const drain = () => {
    if (!file) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const lines = (partial + buf.toString('utf8')).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const text = stripStamp(line);
        if (/^\[[^\]]*\]/.test(line) && WATCH_LINE.test(text)) write(text.length > 200 ? `${text.slice(0, 199)}…` : text);
      }
    } catch (e) {
      // The log may not exist yet for a queued job.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  for (;;) {
    drain();
    const { job } = found;
    if (!ACTIVE.has(job.status) || !alive(job.pid)) {
      const status = ACTIVE.has(job.status) ? 'stopped (its process exited)' : job.status;
      const took = Date.parse(job.completedAt) - Date.parse(job.startedAt || job.createdAt);
      write(`Codex job ${id} ${status}${Number.isFinite(took) ? ` after ${fmtElapsed(took)}` : ''}. Read the result with the companion's result ${id} command.`);
      return job.status === 'completed' ? 0 : 1;
    }
    await new Promise((r) => setTimeout(r, pollMs));
    found = findJob(id) || found;
  }
}

module.exports = { stateRoots, sessionJob, watch, fmtElapsed, FINISHED_SHOW_MS };

if (require.main === module) {
  const [cmd, id] = process.argv.slice(2);
  if (cmd !== 'watch' || !id) {
    process.stderr.write('usage: jev-codex-jobs.js watch <job-id>\n');
    process.exit(2);
  }
  watch(id).then((code) => { process.exitCode = code; });
}
