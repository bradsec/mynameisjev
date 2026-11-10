// jev-tiebreak — the gate for the jev-tiebreak skill, which lets Claude ask
// Jev (decide or compare with --auto) at a fork mid-task. Opt-in with
// `/mynameisjev:tiebreak on`, and capped per turn so a skill that triggers
// too eagerly cannot turn into a stream of calls. A turn belongs to one
// session: on every prompt the router stamps sessions[id].promptAt and calls
// startTurn, and state.tiebreakTurn holds { [session]: { turn, count } }, so
// a prompt in another session neither resets this turn's count nor uses it up.

const MAX_PER_TURN = 2;
// Sessions whose count is kept, newest first; matches the sessions the state
// keeps settings for.
const MAX_SESSIONS = 20;

// Claude Code sets this for commands run in a session; the hooks get the
// same ID as session_id.
const currentSession = () => process.env.CLAUDE_CODE_SESSION_ID || null;

// With no session ID, or no prompt seen in it yet, the turn is the last
// prompt in any session (state.promptAt).
const turnOf = (state, session) => (session && state.sessions && state.sessions[session] && state.sessions[session].promptAt) || state.promptAt || null;

// The per-session counts; '' is for callers with no session ID. The
// single-turn { turn, count } of 0.3.28 and earlier reads as that entry.
function turns(state) {
  const t = state.tiebreakTurn;
  if (!t || typeof t !== 'object') return {};
  return typeof t.count === 'number' ? { '': { turn: t.turn, count: t.count } } : t;
}

// A session with no count of its own falls back to the sessionless one.
function used(state, session) {
  const all = turns(state);
  const t = all[session || ''] || all[''];
  return t && t.turn === turnOf(state, session) ? t.count : 0;
}

// Re-inserted last, so the trim drops the sessions idle longest.
function put(state, session, count) {
  const { [session || '']: _own, ...others } = turns(state);
  const kept = Object.entries(others).slice(-(MAX_SESSIONS - 1));
  state.tiebreakTurn = { ...Object.fromEntries(kept), [session || '']: { turn: turnOf(state, session), count } };
}

// Called by the router on each prompt, after it stamps the turn. The count
// starts at 0 here, not at the first claim: the state merge adds each
// process's difference to the number on disk, which needs a shared base.
function startTurn(state, session) {
  put(state, session, 0);
}

function offReason(state) {
  if (!state.enabled) return 'router off';
  if (!state.tiebreak) return 'off';
  return null;
}

// One line for the skill's header, run before Claude reads the skill.
function statusLine(state, session = currentSession()) {
  const off = offReason(state);
  if (off === 'router off') return 'Tiebreak: off (router off). Decide yourself; do not run the commands below.';
  if (off) return 'Tiebreak: off. Decide yourself; do not run the commands below.';
  const left = Math.max(0, MAX_PER_TURN - used(state, session));
  return `Tiebreak: on, ${left} call${left === 1 ? '' : 's'} left this turn.`;
}

// Counts one call against the turn. The caller writes state when ok.
function claim(state, session = currentSession()) {
  const off = offReason(state);
  if (off) return { ok: false, message: `Jev tiebreak is ${off === 'off' ? 'off' : 'unavailable (router off)'}: decide yourself.` };
  const count = used(state, session);
  if (count >= MAX_PER_TURN) return { ok: false, message: `Jev tiebreak limit reached (${MAX_PER_TURN} per turn): decide yourself.` };
  put(state, session, count + 1);
  state.stats = state.stats || {};
  state.stats.tiebreaks = (state.stats.tiebreaks || 0) + 1;
  return { ok: true };
}

module.exports = { claim, statusLine, startTurn, MAX_PER_TURN };
