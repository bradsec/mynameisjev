const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-watch-f4-'));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.CODEX_HOME = path.join(home, '.codex');
const dataDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'mynameisjev');
const companionDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(companionDir, { recursive: true });
fs.writeFileSync(path.join(companionDir, 'codex-companion.mjs'), '');
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ enabledPlugins: { 'codex@openai-codex': true } }));
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { watch } = require('../plugin/scripts/jev-usage-watch');
const st = require('../plugin/scripts/jev-state');

test('a subagent threshold crossing leaves the main session notice for its next tool call', async () => {
  const now = Date.now();
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(dataDir, 'claude-limits.json'), JSON.stringify({
    five_hour: { used_percentage: 82, resets_at: now / 1000 + 3600 },
  }));
  fs.writeFileSync(path.join(dataDir, 'codex-cache.json'), JSON.stringify({
    at: now,
    limits: { ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: { usedPercent: 10 } },
  }));
  const input = { session_id: 'main', tool_name: 'Read', tool_input: {}, tool_response: {} };

  assert.strictEqual(await watch({ ...input, agent_id: 'child', agent_type: 'Explore' }), null);
  const afterChild = st.readState();
  assert.strictEqual(afterChild.limitNotice, null);
  assert.strictEqual(st.routeFor(afterChild, 'main'), null);
  assert.strictEqual(st.guidedFor(afterChild, 'main', true), false);

  const main = await watch(input);
  assert.match(main.hookSpecificOutput.additionalContext, /Tasks without --write are read-only/);
  assert.doesNotMatch(main.hookSpecificOutput.additionalContext, /Same Codex rules as earlier this session/);
  assert.strictEqual(st.routeFor(st.readState(), 'main').target, 'codex');
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
