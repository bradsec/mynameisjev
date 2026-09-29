const test = require('node:test');
const assert = require('node:assert');
const { guard } = require('../plugin/scripts/jev-codex-steps');

const now = Date.now();
const companion = '/p/codex-companion.mjs';
const route = (over = {}) => ({ at: new Date(now - 60000).toISOString(), target: 'codex', model: 'steps', how: 'suggested', session: 's1', ...over });
const state = (over = {}) => ({ enabled: true, enforce: true, route: route(), ...over });
const call = (over = {}) => ({ tool_name: 'Edit', session_id: 's1', tool_input: { file_path: 'a.js' }, ...over });

test('blocks Claude\'s own file edits while the message is routed to Codex', () => {
  for (const tool_name of ['Edit', 'Write', 'NotebookEdit']) {
    const out = guard(call({ tool_name }), state(), now, companion);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /codex-companion\.mjs" task/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /--write/);
  }
  const ran = guard(call(), state({ route: route({ model: 'gpt-6-sol', how: 'ran' }) }), now, companion);
  assert.strictEqual(ran.hookSpecificOutput.permissionDecision, 'deny', 'still Codex after one step ran');
});

test('leaves the edit alone otherwise', () => {
  assert.strictEqual(guard(call(), state({ enforce: false }), now, companion), null, 'enforce off');
  assert.strictEqual(guard(call(), state({ enabled: false }), now, companion), null, 'router off');
  assert.strictEqual(guard(call(), state(), now, null), null, 'no Codex companion');
  assert.strictEqual(guard(call(), state({ route: route({ target: 'claude', model: 'opus', how: 'session' }) }), now, companion), null, 'Claude route');
  assert.strictEqual(guard(call({ session_id: 's2' }), state(), now, companion), null, 'other session');
  assert.strictEqual(guard(call(), state({ route: route({ at: new Date(now - 2 * 3600000).toISOString() }) }), now, companion), null, 'stale');
  assert.strictEqual(guard(call({ tool_name: 'Bash' }), state(), now, companion), null, 'not an edit tool');
});
