#!/usr/bin/env node
// jev-usage-watch — PostToolUse hook. Claude's plan usage can climb past
// every threshold inside one long turn, where the prompt hook (jev-router)
// never runs. After each tool call this checks the usage the status line
// last recorded and, once per threshold crossing (shared with the router's
// notices), tells Claude to move remaining work to Codex or wrap up, tells
// the user, and at the auto-transfer level copies the session into Codex.
//
// Runs after every tool call, so the common case (router off, or usage
// below the first threshold) reads two small files and exits before loading
// the router.

const fs = require('fs');
const path = require('path');
const st = require('./jev-state');

// Mirrors CLAUDE_ROUTE_PCT in jev-router.js for the fast path; the router's
// THRESHOLDS decide everything past it.
const FAST_PATH_PCT = 80;

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

async function watch(hookInput) {
  if (!st.readState().enabled || peakPct() < FAST_PATH_PCT) return null;

  const r = require('./jev-router');
  const codex = require('./jev-codex');
  const TH = r.THRESHOLDS;
  const state = r.readState();
  const claude = r.claudePeak();
  if (!claude || claude.pct < TH.route) return null;
  const cache = codex.readCache();
  codex.refreshInBackgroundIfStale(cache);
  const codexNow = r.codexStatus(cache);
  const companion = codex.companionPath();

  const auto = state.autoTransfer && codexNow.available && claude.pct >= TH.auto;
  const level = auto ? 'auto' : claude.pct >= TH.transfer ? 'transfer' : 'route';
  const key = `${claude.window}:${claude.resetsAt}:${level}`;
  if (state.limitNotice === key) return null;
  state.limitNotice = key;
  r.writeState(state);

  const pct = Math.round(claude.pct);
  const when = r.fmtReset(claude.resetsAt, claude.window === '7d');
  const head = `Jev: Claude ${claude.window} usage reached ${pct}% during this turn (resets ${when}).`;
  const codexHead = codexNow.available ? `${head} ${codexNow.text}.` : head;
  const handOff = codexNow.ok && companion;

  let notice;
  let context;
  if (level === 'auto') {
    const t = await r.autoTransfer(hookInput.transcript_path, hookInput.session_id, hookInput.cwd);
    r.recordTransfer(state, t);
    notice = r.transferNotice(claude, codexNow, t);
    context = `${head} Claude is close to its limit and this session is copied into Codex. Stop after the current step and give a short summary of what is left.`;
  } else if (level === 'transfer') {
    notice = `${codexHead} Close to the limit.` + (!codexNow.available ? ''
      : state.autoTransfer ? ` Jev copies this session into Codex at ${TH.auto}%.`
        : ' Run /codex:transfer to continue this session in Codex.');
    context = `${head} Near the limit: finish the current step, then stop and give a short summary of what is left.` +
      (handOff ? ` Hand any remaining self-contained step to Codex: ${r.subStepAdvice(claude, companion)}` : '');
  } else {
    notice = `${codexHead}${handOff ? ' Claude now hands self-contained steps to Codex.' : ''}`;
    context = handOff ? r.subStepAdvice(claude, companion) : `${head} Keep the rest of this turn short.`;
  }
  return {
    systemMessage: notice,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  };
}

module.exports = { watch, FAST_PATH_PCT };

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
