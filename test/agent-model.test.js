const test = require('node:test');
const assert = require('node:assert');
const { enforce } = require('../plugin/scripts/jev-agent-model');

const now = Date.now();
const route = (over = {}) => ({ at: new Date(now - 60000).toISOString(), target: 'claude', model: 'sonnet', how: 'suggested', session: 's1', ...over });
const state = (over = {}) => ({ enabled: true, enforce: true, route: route(), ...over });
const call = (input = {}, over = {}) => ({ tool_name: 'Agent', session_id: 's1', tool_input: { description: 'd', prompt: 'p', ...input }, ...over });

test('sets the suggested model on a general-purpose subagent, keeping the rest of the input', () => {
  for (const subagent_type of [undefined, 'general-purpose', 'claude']) {
    const out = enforce(call({ subagent_type }), state(), now);
    assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, { description: 'd', prompt: 'p', subagent_type, model: 'sonnet' });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, undefined, 'permission stays with Claude Code');
    assert.match(out.hookSpecificOutput.additionalContext, /ran this subagent on sonnet/);
  }
});

test('sets the suggested effort too, unless Claude chose one', () => {
  const out = enforce(call(), state({ route: route({ model: 'opus', effort: 'xhigh' }) }), now);
  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, { description: 'd', prompt: 'p', model: 'opus', effort: 'xhigh' });
  assert.match(out.hookSpecificOutput.additionalContext, /on opus, xhigh effort/);
  const own = enforce(call({ effort: 'low' }), state({ route: route({ model: 'opus', effort: 'xhigh' }) }), now);
  assert.strictEqual(own.hookSpecificOutput.updatedInput.effort, 'low');
});

test('leaves the call alone otherwise', () => {
  assert.strictEqual(enforce(call(), state({ enforce: false }), now), null, 'off');
  assert.strictEqual(enforce(call(), state({ enabled: false }), now), null, 'router off');
  assert.strictEqual(enforce(call({ model: 'opus' }), state(), now), null, 'Claude chose a model');
  assert.strictEqual(enforce(call({ subagent_type: 'Explore' }), state(), now), null, 'named agent');
  assert.strictEqual(enforce(call({ subagent_type: 'mynameisjev:tiny' }), state(), now), null, 'pinned helper');
  assert.strictEqual(enforce(call(), state({ route: route({ target: 'codex', model: 'gpt-6-sol' }) }), now), null, 'Codex route');
  assert.strictEqual(enforce(call(), state({ route: route({ how: 'session', model: 'opus' }) }), now), null, 'no suggestion');
  assert.strictEqual(enforce(call({}, { session_id: 's2' }), state(), now), null, 'other session');
  assert.strictEqual(enforce(call(), state({ route: route({ at: new Date(now - 2 * 3600000).toISOString() }) }), now), null, 'stale');
  assert.strictEqual(enforce(call(), state({ route: route({ at: new Date(now + 24 * 3600000).toISOString() }) }), now), null, 'future route');
  assert.strictEqual(enforce(call({}, { tool_name: 'Bash' }), state(), now), null, 'not Agent');
});

test('another session\'s newer route does not lift this session\'s suggestion', () => {
  const mine = route();
  const theirs = route({ session: 's2', how: 'session', model: 'opus' });
  const out = enforce(call(), state({ route: theirs, routes: { s1: mine, s2: theirs } }), now);
  assert.strictEqual(out.hookSpecificOutput.updatedInput.model, 'sonnet');
});
