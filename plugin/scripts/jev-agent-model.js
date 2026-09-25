#!/usr/bin/env node
// jev-agent-model — PreToolUse hook for Agent calls. With enforcement on
// (`/mynameisjev:enforce on`), a general-purpose subagent that Claude starts
// without choosing a model runs on the Claude helper model Jev suggested for
// the current message (state.route), so the saving no longer depends on
// Claude following the note.
//
// Left alone: calls that name a model, named agents (they carry their own
// model, including the pinned mynameisjev:* helpers), messages Jev gave no
// Claude helper note (or routed to Codex), other sessions, and suggestions
// older than ROUTE_MAX_AGE_MS. Only the input changes: the permission
// decision stays with Claude Code's normal rules.

const st = require('./jev-state');

// Subagent types that take the session's model unless told otherwise.
const GENERAL_TYPES = new Set([undefined, null, '', 'general-purpose', 'claude']);
const HELPER_MODELS = new Set(['haiku', 'sonnet', 'opus']);
// A suggestion applies to the message it was made for; this bounds how long
// a long turn keeps using it.
const ROUTE_MAX_AGE_MS = 60 * 60 * 1000;

// The hook output for an Agent call, or null to leave it unchanged.
function enforce(hookInput, state, nowMs) {
  if (!state.enabled || !state.enforce || hookInput.tool_name !== 'Agent') return null;
  const input = hookInput.tool_input || {};
  if (input.model || !GENERAL_TYPES.has(input.subagent_type)) return null;
  const route = state.route;
  if (!route || route.target !== 'claude' || route.how !== 'suggested' || !HELPER_MODELS.has(route.model)) return null;
  if (!hookInput.session_id || route.session !== hookInput.session_id) return null;
  if (!(nowMs - Date.parse(route.at) <= ROUTE_MAX_AGE_MS)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...input, model: route.model },
      additionalContext: `Jev ran this subagent on ${route.model}, the Claude helper model it suggested for this message (/mynameisjev:enforce off stops this).`,
    },
  };
}

module.exports = { enforce };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const state = st.readState();
      const out = enforce(JSON.parse(input || '{}'), state, Date.now());
      if (!out) return;
      state.stats.enforced += 1;
      try { st.writeState(state); } catch (e) { /* the count misses one */ }
      process.stdout.write(JSON.stringify(out));
    } catch (e) {
      // Never block a tool call over enforcement.
    }
  });
}
