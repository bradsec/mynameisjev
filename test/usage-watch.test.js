const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway home: auto-transfer writes its transcript copy under
// ~/.claude/projects, and Codex detection reads settings and PATH.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-watch-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const claudeDir = path.join(home, '.claude');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = path.join(home, '.codex');
const dataDir = path.join(claudeDir, 'mynameisjev');
fs.mkdirSync(dataDir, { recursive: true });

const watcher = require('../plugin/scripts/jev-usage-watch');
const router = require('../plugin/scripts/jev-router');

const setState = (over) => fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true, ...over }));
const setUsage = (pct) => fs.writeFileSync(path.join(dataDir, 'claude-limits.json'),
  JSON.stringify({ at: Date.now(), five_hour: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 3600 } }));
const hookInput = { session_id: 's', cwd: home, transcript_path: path.join(claudeDir, 'projects', 'p', 's.jsonl') };

test('records hand-offs that ran, even below the usage thresholds', async () => {
  setState({});
  setUsage(10);
  await watcher.watch({ tool_name: 'Bash', tool_input: { command: 'node "/p/codex-companion.mjs" task --model gpt-6-sol --effort medium "x"' } });
  let route = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).route;
  assert.deepStrictEqual({ target: route.target, model: route.model, how: route.how }, { target: 'codex', model: 'gpt-6-sol', how: 'ran' });
  await watcher.watch({ tool_name: 'Agent', tool_input: { subagent_type: 'mynameisjev:tiny', prompt: 'x' } });
  route = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).route;
  assert.strictEqual(route.model, 'haiku');
  assert.strictEqual(watcher.handOff({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } }), null);
  assert.deepStrictEqual(watcher.handOff({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', model: 'sonnet' } }), { target: 'claude', model: 'sonnet' });
  assert.strictEqual(watcher.handOff({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } }), null);
  assert.deepStrictEqual(watcher.handOff({ tool_name: 'Agent', tool_input: { subagent_type: 'mynameisjev:hardest' } }), { target: 'claude', model: 'opus' });
  assert.strictEqual(watcher.handOff({ tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
});

test('fast path exits only below every threshold, including the pace', () => {
  assert.strictEqual(watcher.FAST_PATH_PCT, require('../plugin/scripts/jev-pace').PACE_ROUTE_MIN_PCT);
  assert.ok(watcher.FAST_PATH_PCT <= router.THRESHOLDS.route);
});

test('a fast pace moves work to Codex mid-turn below 80%', async () => {
  setState({});
  const now = Date.now();
  const reset = Math.floor(now / 1000) + 3 * 3600;
  // 50% to 70% in the last 30 minutes: 100% in ~45 minutes, well before the reset.
  fs.writeFileSync(path.join(dataDir, 'claude-limits.json'), JSON.stringify({
    at: now,
    five_hour: { used_percentage: 70, resets_at: reset },
    history: [
      { at: now - 30 * 60000, pct: 50, reset },
      { at: now - 1000, pct: 70, reset },
    ],
  }));
  const out = await watcher.watch(hookInput);
  assert.match(out.systemMessage, /usage reached 70% during this turn .*At this pace the 5h limit is reached in ~4\dm, before the reset\./);
});

test('quiet below 80% and when the router is off', async () => {
  setState({});
  setUsage(79);
  assert.strictEqual(await watcher.watch(hookInput), null);
  setState({ enabled: false });
  setUsage(95);
  assert.strictEqual(await watcher.watch(hookInput), null);
});

test('without Codex: one wrap-up notice per crossing, no Codex mentioned', async () => {
  setState({});
  setUsage(82);
  const first = await watcher.watch(hookInput);
  assert.match(first.systemMessage, /reached 82% during this turn/);
  assert.doesNotMatch(first.systemMessage, /Codex/);
  assert.match(first.hookSpecificOutput.additionalContext, /Keep the rest of this turn short/);
  assert.strictEqual(await watcher.watch(hookInput), null, 'same crossing is not repeated');
  setUsage(86);
  const second = await watcher.watch(hookInput);
  assert.match(second.hookSpecificOutput.additionalContext, /finish the current step/);
});

test('with Codex: hands off steps at 80%, auto-transfers at 90%', async () => {
  // Fake Codex: enabled plugin, a companion that answers `transfer`, and a
  // codex executable on PATH (with the .cmd form Windows looks for).
  const scripts = path.join(claudeDir, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'codex-companion.mjs'),
    'process.stdout.write(JSON.stringify({ threadId: "t-1", resumeCommand: "codex resume t-1" }));\n');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'codex@openai-codex': true } }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['codex', 'codex.cmd']) fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  fs.writeFileSync(path.join(dataDir, 'codex-cache.json'), JSON.stringify({
    at: Date.now(),
    limits: { ordinaryUsageAllowed: true, primary: { usedPercent: 5 }, secondary: { usedPercent: 10 } },
  }));
  fs.mkdirSync(path.dirname(hookInput.transcript_path), { recursive: true });
  fs.writeFileSync(hookInput.transcript_path, '{"type":"user"}\n');

  setState({ autoTransfer: true });
  setUsage(81);
  const route = await watcher.watch(hookInput);
  assert.match(route.systemMessage, /hands self-contained steps to Codex/);
  assert.match(route.hookSpecificOutput.additionalContext, /codex-companion\.mjs" task/);

  setUsage(91);
  const auto = await watcher.watch(hookInput);
  assert.match(auto.systemMessage, /continue in a terminal: codex resume t-1/);
  assert.match(auto.hookSpecificOutput.additionalContext, /copied into Codex/);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.strictEqual(state.lastTransfer.threadId, 't-1');
  assert.deepStrictEqual(fs.readdirSync(path.join(claudeDir, 'projects', 'jev-transfers')), [], 'transcript copy removed');
});

test('counts hand-off runs per target', async () => {
  setState({});
  setUsage(10);
  await watcher.watch({ tool_name: 'Bash', tool_input: { command: 'node "/p/codex-companion.mjs" task "x"' } });
  await watcher.watch({ tool_name: 'Agent', tool_input: { subagent_type: 'mynameisjev:large', prompt: 'x' } });
  await watcher.watch({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'x' } });
  const stats = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).stats;
  assert.deepStrictEqual([stats.codexRuns, stats.helperRuns], [1, 1]);
});
