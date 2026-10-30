#!/usr/bin/env node
// jev-usage-watch — PostToolUse hook. Claude's plan usage can climb past
// every threshold inside one long turn, where the prompt hook (jev-router)
// never runs. After each tool call this checks the usage the status line
// last recorded and, once per threshold crossing (shared with the router's
// notices), tells Claude to move remaining work to Codex or wrap up, tells
// the user, and at the auto-transfer level copies the session into Codex.
//
// It also records hand-offs that actually ran (a Codex companion task, or a
// mynameisjev:* subagent) as state.route, for the status line.
//
// Runs after every tool call, so the common case (router off, or usage
// below the first threshold) reads two small files and exits before loading
// the router.

const fs = require('fs');
const path = require('path');
const st = require('./jev-state');

// Below this no threshold or pace can apply (jev-pace.js PACE_ROUTE_MIN_PCT),
// so the fast path exits before loading the router, which decides the rest.
const FAST_PATH_PCT = require('./jev-pace').PACE_ROUTE_MIN_PCT;

function peakPct() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(st.dataDir, 'claude-limits.json'), 'utf8'));
    const nowSec = Date.now() / 1000;
    return Math.max(0, ...[saved.five_hour, saved.seven_day]
      .filter((w) => w && Number.isFinite(w.used_percentage) && !(Number.isFinite(w.resets_at) && w.resets_at < nowSec))
      .map((w) => w.used_percentage));
  } catch (e) {
    return 0;
  }
}

// Helper agents and the Claude model each is pinned to (plugin/agents/*.md).
const HELPER_MODELS = { 'mynameisjev:tiny': 'haiku', 'mynameisjev:everyday': 'sonnet', 'mynameisjev:large': 'opus', 'mynameisjev:hardest': 'opus' };

// Subagent types that run on the session's model unless given one.
const GENERAL_TYPES = new Set([undefined, null, '', 'general-purpose', 'claude']);

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// The companion's result command fails with one of these while the job runs
// (codex plugin lib/job-control.mjs); a failed Bash call may not reach this
// hook at all, but when it does its output says so.
const UNFINISHED = /is still (queued|running)|No finished (Codex )?jobs? found/;
const resultFinished = (hookInput) => !UNFINISHED.test(JSON.stringify(hookInput.tool_response || ''));

const shellCommand = (hookInput) => {
  const input = hookInput.tool_input || {};
  const shell = hookInput.tool_name === 'Bash' || hookInput.tool_name === 'PowerShell';
  return shell && typeof input.command === 'string' ? input.command : '';
};

// The hand-off this tool call performed, or null: { target, model, reviewing? }.
// reviewing: Codex's result is back in this conversation (a foreground task),
// so Claude may make small review fixes (jev-codex-steps.js).
function handOff(hookInput) {
  const input = hookInput.tool_input || {};
  const command = shellCommand(hookInput);
  if (/codex-companion\.mjs"?\s+task\b/.test(command)) {
    // Flags sit before the heredoc; the brief after it may mention them.
    const line = command.split('<<')[0];
    const model = line.match(/--model\s+"?([\w.-]+)/);
    return { target: 'codex', model: model ? model[1] : 'default', reviewing: !/\s--background\b/.test(line) };
  }
  if (hookInput.tool_name === 'Agent' && HELPER_MODELS[input.subagent_type]) {
    return { target: 'claude', model: HELPER_MODELS[input.subagent_type] };
  }
  // A general-purpose subagent on a helper model, as /mynameisjev:enforce sets.
  if (hookInput.tool_name === 'Agent' && GENERAL_TYPES.has(input.subagent_type) && ['haiku', 'sonnet', 'opus'].includes(input.model)) {
    return { target: 'claude', model: input.model };
  }
  return null;
}

async function watch(hookInput) {
  if (hookInput.session_id && !hookInput.agent_id && typeof hookInput.effort?.level === 'string') {
    st.shareEffort(hookInput.session_id, hookInput.effort.level);
  }
  const current = st.readState();
  if (!current.enabled) return null;
  const ran = handOff(hookInput);
  if (ran?.target === 'codex' || /codex-companion\.mjs"?\s+result\b/.test(shellCommand(hookInput))) {
    const output = JSON.stringify(hookInput.tool_response || '');
    // Denial wording only: bare EPERM/EACCES also show up in code Codex reports on.
    const readonly = /EROFS|read-only file ?system|(?:sandbox|workspace|filesystem) is (?:still )?read-only/i.test(output);
    const network = /network unreachable|ENETUNREACH|EHOSTUNREACH/i.test(output);
    if (readonly) current.codexLimits.readonly = new Date().toISOString();
    if (network) current.codexLimits.network = new Date().toISOString();
    if (readonly || network) {
      try { st.writeState(current); } catch (e) { /* the next result may record it */ }
    }
  }
  const before = st.routeFor(current, hookInput.session_id);
  const reviewOn = st.reviewFor(current, hookInput.session_id);
  const reviewing = !!(reviewOn && before && before.target === 'codex' && before.reviewing);
  if (ran) {
    // A new Codex task while Claude reviews the last result: sent back.
    if (ran.target === 'codex' && reviewing) current.stats.reviewSendBacks = (current.stats.reviewSendBacks || 0) + 1;
    if (reviewOn && ran.target === 'codex' && ran.reviewing) current.stats.codexReturns = (current.stats.codexReturns || 0) + 1;
    // session keeps the Codex edit guard (jev-codex-steps.js) on for this turn.
    st.putRoute(current, { at: new Date().toISOString(), ...ran, how: 'ran', session: hookInput.session_id || null });
    current.stats[ran.target === 'codex' ? 'codexRuns' : 'helperRuns'] += 1;
    try { st.writeState(current); } catch (e) { /* the status line just misses one update */ }
    // A Codex task just spent Codex usage: refresh the cached limits now
    // rather than up to five minutes later.
    if (ran.target === 'codex') {
      const codex = require('./jev-codex');
      codex.refreshInBackgroundIfStale(codex.readCache(), 0);
    }
  }
  // A background task's result read back: review fixes may start.
  const route = before;
  if (!ran && route && route.target === 'codex' && route.session && !route.reviewing &&
      /codex-companion\.mjs"?\s+result\b/.test(shellCommand(hookInput)) && resultFinished(hookInput)) {
    st.putRoute(current, { ...route, reviewing: true });
    if (reviewOn) current.stats.codexReturns = (current.stats.codexReturns || 0) + 1;
    try { st.writeState(current); } catch (e) { /* the edit guard stays on for this one */ }
  }
  // Claude's first own edit while reviewing a Codex result: fixed in place.
  if (reviewing && !before.fixed && EDIT_TOOLS.has(hookInput.tool_name)) {
    st.putRoute(current, { ...before, fixed: true });
    current.stats.reviewFixes = (current.stats.reviewFixes || 0) + 1;
    try { st.writeState(current); } catch (e) { /* the report misses one */ }
  }
  if (peakPct() < FAST_PATH_PCT) return null;

  const r = require('./jev-router');
  const codex = require('./jev-codex');
  const TH = r.THRESHOLDS;
  const state = r.readState();
  const claude = r.claudePeak();
  if (!r.claudeLow(claude)) return null;
  const cache = codex.readCache();
  codex.refreshInBackgroundIfStale(cache);
  const codexNow = r.codexStatus(cache);
  const companion = codex.companionPath();

  const auto = state.autoTransfer && codexNow.available && claude.pct >= TH.auto;
  const level = auto ? 'auto' : claude.pct >= TH.transfer ? 'transfer' : 'route';
  const key = `${claude.window}:${claude.resetsAt}:${level}`;
  if (state.limitNotice === key) return null;
  state.limitNotice = key;
  // Past a threshold mid-turn the rest of the turn is Codex steps, as the
  // router would have routed it; this also arms the edit guard.
  if (level !== 'auto' && codexNow.ok && companion) r.setRoute(state, 'codex', 'steps', 'suggested', hookInput.session_id);
  r.writeState(state);

  const pct = Math.round(claude.pct);
  const when = r.fmtReset(claude.resetsAt, claude.window === '7d');
  const head = `Jev: Claude ${claude.window} usage reached ${pct}% during this turn (resets ${when}).${r.paceText(claude)}`;
  const codexHead = codexNow.available ? `${head} ${codexNow.text}.` : head;
  const canHandOff = codexNow.ok && companion;
  // The sub-step note, full or short (st.guidedFor), marking the session
  // guided; state is written again after the notes are built.
  const steps = () => {
    const review = st.reviewFor(state, hookInput.session_id);
    const note = r.subStepAdvice(claude, companion, { review, guided: st.guidedFor(state, hookInput.session_id, review), codexLimits: state.codexLimits });
    st.markGuided(state, hookInput.session_id, review);
    return note;
  };

  let notice;
  let context;
  if (level === 'auto') {
    const t = await r.autoTransfer(hookInput.transcript_path, hookInput.session_id, hookInput.cwd);
    r.recordTransfer(state, t, hookInput.session_id);
    notice = r.transferNotice(claude, codexNow, t);
    context = `${head} Claude is close to its limit and this session is copied into Codex. Stop after the current step and give a short summary of what is left.`;
  } else if (level === 'transfer') {
    notice = `${codexHead} Close to the limit.` + (!codexNow.available ? ''
      : state.autoTransfer ? ` Jev copies this session into Codex at ${TH.auto}%.`
        : ' Run /codex:transfer to continue this session in Codex.');
    context = `${head} Near the limit: finish the current step, then stop and give a short summary of what is left.` +
      (canHandOff ? ` Hand any remaining self-contained step to Codex: ${steps()}` : '');
  } else {
    notice = `${codexHead}${canHandOff ? ' Claude now hands self-contained steps to Codex.' : ''}`;
    context = canHandOff ? steps() : `${head} Keep the rest of this turn short.`;
  }
  if (canHandOff && level !== 'auto') {
    try { r.writeState(state); } catch (e) { /* the next Codex note is the full one again */ }
  }
  return {
    systemMessage: notice,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  };
}

module.exports = { watch, handOff, FAST_PATH_PCT };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const out = await watch(JSON.parse(input || '{}'));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (e) {
      // Never disturb a tool call over a usage notice.
    }
  });
}
