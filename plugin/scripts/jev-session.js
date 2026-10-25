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
// directory within CARRY_MAX_AGE_MS. A compaction drops the full Codex brief
// text from context, so the next Codex note gives it in full again.

const st = require('./jev-state');

const CARRY_MAX_AGE_MS = 60 * 1000;
const CARRIED = ['prefer', 'review'];

// Applies the hook to state; returns true when state changed.
function handle(mode, hookInput, state, nowMs) {
  const session = hookInput.session_id;
  if (!session) return false;
  if (mode === 'end') {
    if (hookInput.reason !== 'clear') return false;
    state.clearCarry = { from: session, cwd: hookInput.cwd || null, at: new Date(nowMs).toISOString() };
    return true;
  }
  if (mode !== 'start') return false;
  if (hookInput.source === 'compact') {
    if (!st.guidedFor(state, session, true) && !st.guidedFor(state, session, false)) return false;
    st.putSessionSetting(state, session, 'guided', null);
    return true;
  }
  if (hookInput.source !== 'clear') return false;
  const carry = state.clearCarry;
  if (!carry) return false;
  state.clearCarry = null;
  const fresh = nowMs - Date.parse(carry.at) <= CARRY_MAX_AGE_MS && (carry.cwd || null) === (hookInput.cwd || null);
  const old = fresh && state.sessions && state.sessions[carry.from];
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
