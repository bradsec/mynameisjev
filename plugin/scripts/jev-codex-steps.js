#!/usr/bin/env node
// jev-codex-steps — PreToolUse hook for Claude's own file edits. With
// enforcement on (`/mynameisjev:enforce on`) and the current message routed
// to Codex (state.route target 'codex', whole task or its steps), Edit,
// Write and NotebookEdit are denied with the Codex companion command, so the
// edits go to Codex's quota instead of depending on Claude following the note.
//
// The route stays 'codex' after a Codex task ran (jev-usage-watch.js), so the
// guard holds for the rest of the turn. A "+claude" message, another
// session, or a route older than ROUTE_MAX_AGE_MS lifts it. Edits made
// through Bash are not caught here; the router note asks Claude not to.

const st = require('./jev-state');
const codex = require('./jev-codex');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
// Same bound as jev-agent-model.js: a route belongs to the message it was
// made for.
const ROUTE_MAX_AGE_MS = 60 * 60 * 1000;

// The hook output for an edit call, or null to leave it alone.
function guard(hookInput, state, nowMs, companion) {
  if (!state.enabled || !state.enforce || !companion || !EDIT_TOOLS.has(hookInput.tool_name)) return null;
  const route = state.route;
  if (!route || route.target !== 'codex') return null;
  if (!hookInput.session_id || route.session !== hookInput.session_id) return null;
  if (!(nowMs - Date.parse(route.at) <= ROUTE_MAX_AGE_MS)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Jev: this message is routed to Codex, so file edits go to Codex, not Claude (/mynameisjev:enforce off stops this). ' +
        `Send the edit with one Bash call: node "${companion.replace(/\\/g, '/')}" task --write "<the change, with the file paths and context it needs>". ` +
        'Do not make the edit through Bash commands instead.',
    },
  };
}

module.exports = { guard };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const state = st.readState();
      const out = guard(JSON.parse(input || '{}'), state, Date.now(), codex.companionPath());
      if (!out) return;
      state.stats.editsBlocked = (state.stats.editsBlocked || 0) + 1;
      try { st.writeState(state); } catch (e) { /* the count misses one */ }
      process.stdout.write(JSON.stringify(out));
    } catch (e) {
      // Never block a tool call over a failure in the guard itself.
    }
  });
}
