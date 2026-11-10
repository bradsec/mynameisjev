#!/usr/bin/env node
// Local token accounting for Codex hand-offs. Other tools' files are read only.
const fs = require('fs');
const path = require('path');
const st = require('./jev-state');
const jobs = require('./jev-codex-jobs');
const { tokenUse } = require('./jev-subagent-stop');

const TAIL_BYTES = 8 * 1024 * 1024;
const KEEP_SESSIONS = 50;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function tail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const data = Buffer.alloc(length);
    fs.readSync(fd, data, 0, length, size - length);
    return { buf: data, text: data.toString('utf8'), start: size - length, size };
  } finally { fs.closeSync(fd); }
}

function claudeUsage(text) {
  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const use of Object.values(tokenUse(text))) {
    for (const key of Object.keys(totals)) totals[key] += use[key];
  }
  return totals;
}

function codexUsage(threadId) {
  if (!UUID.test(threadId || '')) return null;
  const root = path.join(st.codexHome, 'sessions');
  let years;
  try { years = fs.readdirSync(root).reverse(); } catch (_) { return null; }
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    let months;
    try { months = fs.readdirSync(path.join(root, year)).reverse(); } catch (_) { continue; }
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue;
      let days;
      try { days = fs.readdirSync(path.join(root, year, month)).reverse(); } catch (_) { continue; }
      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue;
        const dir = path.join(root, year, month, day);
        let names;
        try { names = fs.readdirSync(dir).filter((name) => name.endsWith(`-${threadId}.jsonl`)); } catch (_) { continue; }
        for (const name of names) {
          let data;
          try {
            const file = fs.realpathSync(path.join(dir, name));
            if (!file.startsWith(fs.realpathSync(root) + path.sep)) continue;
            data = tail(file);
          } catch (_) { continue; }
          let usage = null;
          let model = null;
          for (const line of data.text.split('\n')) {
            if (!line.startsWith('{')) continue;
            let event;
            try { event = JSON.parse(line); } catch (_) { continue; }
            if (event.type === 'turn_context' && typeof event.payload?.model === 'string') model = event.payload.model;
            if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
              const u = event.payload.info?.total_token_usage;
              usage = u && ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'].every((key) => Number.isFinite(u[key]) && u[key] >= 0)
                ? { input: u.input_tokens, cacheRead: u.cached_input_tokens, output: u.output_tokens, reasoningOutput: u.reasoning_output_tokens } : null;
            }
          }
          if (usage) return { model: model || 'unknown', ...usage };
        }
      }
    }
  }
  return null;
}

const USAGE_KEYS = ['input', 'cacheRead', 'output', 'reasoningOutput'];

// Codex reports a thread's running total, and --resume-last adds a task to the same thread.
// Each task keeps the total it read (codexTotal); its own share (codex) is that total less the
// total of the task read before it. Two hooks that register from the same stale state cannot
// see each other's task, so the shares are worked out again on every ledger write.
function settle(ledger, threadId) {
  if (!threadId) return;
  const tasks = Object.values(ledger).flatMap((session) => session.tasks || []).filter((task) => task.threadId === threadId);
  const size = (task) => USAGE_KEYS.reduce((sum, key) => sum + task.codexTotal[key], 0);
  const read = tasks.filter((task) => task.codexTotal).sort((a, b) => size(a) - size(b));
  read.forEach((task, i) => {
    // The first task keeps its share: the tasks before it may have been trimmed from the ledger.
    if (i === 0 && task.codex) return;
    // Tasks stored without a total (0.3.28 and earlier) each hold the thread's running total as
    // their share, so the first task read since starts from the largest of them.
    const earlier = i ? [read[i - 1].codexTotal] : tasks.filter((other) => !other.codexTotal && other.codex).map((other) => other.codex);
    task.codex = { ...task.codexTotal };
    for (const key of USAGE_KEYS) task.codex[key] = Math.max(0, task.codex[key] - Math.max(0, ...earlier.map((before) => before[key])));
  });
}

// A task registered while its turn is still running reads the thread too early, so register
// reads it again when the result returns; the share grows by what the thread gained since.
function readUsage(ledger, task) {
  if (task.codex && !task.codexTotal) return;
  const total = codexUsage(task.threadId);
  if (!total) return;
  if (task.codex) {
    for (const key of USAGE_KEYS) task.codex[key] += Math.max(0, total[key] - task.codexTotal[key]);
    task.codex.model = total.model;
  }
  task.codexTotal = total;
  settle(ledger, task.threadId);
}

function matchingJob(sessionId, jobId, threadId, window, claimed) {
  if (!sessionId) return null;
  const matches = [];
  for (const root of jobs.stateRoots()) {
    let dirs;
    try { dirs = fs.readdirSync(root); } catch (_) { continue; }
    for (const dir of dirs) {
      let all;
      try { all = JSON.parse(fs.readFileSync(path.join(root, dir, 'state.json'), 'utf8')).jobs; } catch (_) { continue; }
      if (!Array.isArray(all)) continue;
      for (const job of all) {
        if (job?.sessionId !== sessionId || claimed.has(job.id)) continue;
        if (jobId ? job.id !== jobId : threadId ? job.threadId !== threadId : !window || !Number.isFinite(window.from) || !Number.isFinite(window.to) ||
            !Number.isFinite(Date.parse(job.createdAt)) ||
            Date.parse(job.createdAt) < window.from || Date.parse(job.createdAt) > window.to) continue;
        matches.push(job);
      }
    }
  }
  if (threadId && !jobId) return matches.reduce((newest, job) =>
    !newest || Date.parse(job.createdAt) > Date.parse(newest.createdAt) ? job : newest, null);
  return matches.length === 1 ? matches[0] : null;
}

function toolWindow(data, toolUseId) {
  if (!toolUseId) return null;
  let from = null;
  // Offsets come from the bytes, not the decoded text: a tail that starts inside a multibyte
  // character decodes to replacement characters of a different length.
  for (let at = 0, next; at <= data.buf.length; at = next + 1) {
    next = data.buf.indexOf(10, at);
    if (next < 0) next = data.buf.length;
    const offset = data.start + at;
    try {
      const entry = JSON.parse(data.buf.toString('utf8', at, next));
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        if (entry.type === 'assistant' && content.some((part) => part.type === 'tool_use' && part.id === toolUseId)) {
          from = { offset, at: Date.parse(entry.timestamp) };
        }
        if (from && entry.type === 'user' && content.some((part) => part.type === 'tool_result' && part.tool_use_id === toolUseId)) {
          const to = Date.parse(entry.timestamp);
          return { start: from.offset, from: from.at, to };
        }
      }
    } catch (_) {}
  }
  return from && { start: from.offset, from: from.at, to: NaN };
}

function register(state, hookInput, jobId, returned = true) {
  const sessionId = hookInput.session_id;
  if (!sessionId) return;
  const ledger = state.handoffLedger || (state.handoffLedger = {});
  const session = ledger[sessionId] || (ledger[sessionId] = { at: Date.now(), tasks: [] });
  let data;
  try { data = tail(hookInput.transcript_path); } catch (_) {}
  const window = data && toolWindow(data, hookInput.tool_use_id);
  const response = typeof hookInput.tool_response === 'string' ? hookInput.tool_response
    : hookInput.tool_response?.stdout || '';
  let parsedResponse;
  try { parsedResponse = JSON.parse(response); } catch (_) {}
  const responseId = parsedResponse?.jobId || response.match(/(?:^|\n)Job: ([\w-]+)/)?.[1] ||
    response.match(/started in the background as (task-[\w-]+)\./)?.[1] || null;
  const responseThread = response.match(/(?:^|\n)\[codex\] Thread ready \(([0-9a-f-]{36})\)\.(?:\n|$)/i)?.[1];
  const claimed = new Set(session.tasks.map((task) => task.jobId).filter(Boolean));
  const exactId = jobId || responseId;
  const job = matchingJob(sessionId, exactId, UUID.test(responseThread || '') ? responseThread : null, window, exactId ? new Set() : claimed);
  const existing = job?.id && session.tasks.find((task) => task.jobId === job.id);
  if (existing) {
    existing.returned = returned || existing.returned;
    existing.threadId = existing.threadId || (UUID.test(job.threadId || '') ? job.threadId : null);
    if (!existing.done) readUsage(ledger, existing);
    return;
  }
  const start = window?.start ?? null;
  const threadId = UUID.test(job?.threadId || '') ? job.threadId : null;
  const task = { jobId: job?.id || null, threadId, codex: null, start, claude: null, returned, done: false };
  session.tasks.push(task);
  readUsage(ledger, task);
  if (session.tasks.length > 100) session.tasks.splice(0, session.tasks.length - 100);
  session.at = Date.now();
  for (const id of Object.keys(ledger).sort((a, b) => ledger[b].at - ledger[a].at).slice(KEEP_SESSIONS)) delete ledger[id];
}

function finish(state, hookInput) {
  const session = state.handoffLedger?.[hookInput.session_id];
  if (!session) return;
  let data;
  try { data = tail(hookInput.transcript_path); } catch (_) { return; }
  const starts = session.tasks.map((task) => task.start).filter((start) => start !== null).sort((a, b) => a - b);
  for (const task of session.tasks) {
    if (!task.returned || task.done) continue;
    const end = starts.find((start) => start > task.start) ?? data.size;
    if (!task.codex) readUsage(state.handoffLedger, task);
    task.claude = task.start !== null && task.start >= data.start && end <= data.size
      ? claudeUsage(data.buf.subarray(task.start - data.start, end - data.start).toString('utf8')) : null;
    task.done = true;
  }
  for (const threadId of new Set(session.tasks.map((task) => task.threadId))) settle(state.handoffLedger, threadId);
  const models = {};
  let claude = 0;
  let measured = 0;
  let unknown = 0;
  for (const task of session.tasks) {
    if (task.codex) {
      const total = models[task.codex.model] || (models[task.codex.model] = { runs: 0, input: 0, cacheRead: 0, output: 0, reasoningOutput: 0 });
      total.runs++;
      for (const key of ['input', 'cacheRead', 'output', 'reasoningOutput']) total[key] += task.codex[key];
    } else unknown++;
    if (task.claude) {
      measured++;
      for (const value of Object.values(task.claude)) claude += value;
    }
  }
  session.totals = { models, claude, measured, unknown };
}

module.exports = { codexUsage, claudeUsage, register, finish, settle };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const state = st.readState();
      if (!state.enabled) return;
      finish(state, JSON.parse(input || '{}'));
      st.writeState(state);
    } catch (_) { /* Accounting never interrupts a session. */ }
  });
}
