#!/usr/bin/env node
// jev-session — keeps per-session settings (`/mynameisjev:prefer`,
// `/mynameisjev:review`) meaningful across /clear and compaction.
//
//   jev-session.js end     SessionEnd hook (reason "clear"): notes the
//                          session being cleared
//   jev-session.js start   SessionStart hook (source "clear" or "compact")
//
// /clear starts a new session ID, so without this its settings would fall
// back to the defaults. SessionStart gives no link to the old session, so
// SessionEnd leaves one (state.clearCarry) for the next start in the same
// directory within CARRY_MAX_AGE_MS. When two sessions in one directory are
// cleared within that window, neither new session can be matched to its old
// one, so both start with the defaults. A compaction drops the full Codex brief
// text from context, so the next Codex note gives it in full again.

const st = require('./jev-state');

const CARRY_MAX_AGE_MS = 60 * 1000;
const CARRIED = ['prefer', 'review'];

// Applies the hook to state; returns true when state changed.
function handle(mode, hookInput, state, nowMs) {
  const session = hookInput.session_id;
  if (!session) return false;
  const pending = state.clearCarry || {};
  for (const [from, c] of Object.entries(pending)) {
    if (!(nowMs - Date.parse(c.at) <= CARRY_MAX_AGE_MS)) delete pending[from];
  }
  state.clearCarry = pending;
  if (mode === 'end') {
    if (hookInput.reason !== 'clear') return false;
    pending[session] = { cwd: hookInput.cwd || null, at: new Date(nowMs).toISOString() };
    return true;
  }
  if (mode !== 'start') return false;
  if (hookInput.source === 'compact') {
    if (!st.guidedFor(state, session, true) && !st.guidedFor(state, session, false)) return false;
    st.putSessionSetting(state, session, 'guided', null);
    return true;
  }
  if (hookInput.source !== 'clear') return false;
  const matches = Object.keys(pending).filter((from) => (pending[from].cwd || null) === (hookInput.cwd || null));
  if (matches.length !== 1) return true;
  delete pending[matches[0]];
  const old = state.sessions && state.sessions[matches[0]];
  if (old) {
    for (const key of CARRIED) {
      if (old[key] !== undefined) st.putSessionSetting(state, session, key, old[key]);
    }
  }
  return true;
}

module.exports = { handle, CARRY_MAX_AGE_MS };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const state = st.readState();
      if (handle(process.argv[2], JSON.parse(input || '{}'), state, Date.now())) st.writeState(state);
    } catch (e) {
      // Settings fall back to the defaults; never fail the session over it.
    }
  });
}
