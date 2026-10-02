// jev-tiebreak — the gate for the jev-tiebreak skill, which lets Claude ask
// Jev (decide or compare with --auto) at a fork mid-task. Opt-in with
// `/mynameisjev:tiebreak on`, and capped per turn so a skill that triggers
// too eagerly cannot turn into a stream of calls. The turn is the router's
// state.promptAt, set on every prompt.

const MAX_PER_TURN = 2;

function used(state) {
  const t = state.tiebreakTurn;
  return t && t.turn === (state.promptAt || null) ? t.count : 0;
}

function offReason(state) {
  if (!state.enabled) return 'router off';
  if (!state.tiebreak) return 'off';
  return null;
}

// One line for the skill's header, run before Claude reads the skill.
function statusLine(state) {
  const off = offReason(state);
  if (off === 'router off') return 'Tiebreak: off (router off). Decide yourself; do not run the commands below.';
  if (off) return 'Tiebreak: off. Decide yourself; do not run the commands below.';
  const left = Math.max(0, MAX_PER_TURN - used(state));
  return `Tiebreak: on, ${left} call${left === 1 ? '' : 's'} left this turn.`;
}

// Counts one call against the turn. The caller writes state when ok.
function claim(state) {
  const off = offReason(state);
  if (off) return { ok: false, message: `Jev tiebreak is ${off === 'off' ? 'off' : 'unavailable (router off)'}: decide yourself.` };
  const count = used(state);
  if (count >= MAX_PER_TURN) return { ok: false, message: `Jev tiebreak limit reached (${MAX_PER_TURN} per turn): decide yourself.` };
  state.tiebreakTurn = { turn: state.promptAt || null, count: count + 1 };
  state.stats = state.stats || {};
  state.stats.tiebreaks = (state.stats.tiebreaks || 0) + 1;
  return { ok: true };
}

module.exports = { claim, statusLine, MAX_PER_TURN };
