const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway home, so no real Claude or Codex state is read or written.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-watch-b6-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.USERPROFILE = home;
const claudeDir = path.join(home, '.claude');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = path.join(home, '.codex');
const dataDir = path.join(claudeDir, 'mynameisjev');
fs.mkdirSync(dataDir, { recursive: true });

const watcher = require('../plugin/scripts/jev-usage-watch');
const st = require('../plugin/scripts/jev-state');
const guard = require('../plugin/scripts/jev-codex-steps').guard;

const companion = 'node "/home/u/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs"';
const bash = (command) => ({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '{}\n' } });

// What a tool call left behind that only a Codex task should leave.
async function effects(command) {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true, enforce: true, review: false }));
  fs.writeFileSync(path.join(dataDir, 'claude-limits.json'), JSON.stringify({ five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 } }));
  await watcher.watch(bash(command));
  const state = st.readState();
  return {
    handOff: watcher.handOff(bash(command))?.target || null,
    codexRuns: state.stats.codexRuns,
    route: state.route ? `${state.route.target}/${state.route.how}` : null,
    ledgerTasks: (state.handoffLedger?.s1?.tasks || []).length,
    editDenied: !!guard({ session_id: 's1', tool_name: 'Edit' }, state, Date.now(), '/x/codex-companion.mjs'),
  };
}

const NOT_A_TASK = { handOff: null, codexRuns: 0, route: null, ledgerTasks: 0, editDenied: false };

test('B6: the task-resume-candidate probe is not a Codex task', async () => {
  // Verbatim from the codex plugin 1.0.6 commands/rescue.md:26.
  assert.deepStrictEqual(await effects(`${companion} task-resume-candidate --json`), NOT_A_TASK);
});

test('B6: the task-worker subcommand is not a Codex task', async () => {
  assert.deepStrictEqual(await effects(`${companion} task-worker --cwd /x --job-id j1`), NOT_A_TASK);
});

test('B6: a real task still counts, with arguments or alone', async () => {
  const ran = await effects(`${companion} task --write "fix it"`);
  assert.deepStrictEqual({ handOff: ran.handOff, codexRuns: ran.codexRuns, route: ran.route }, { handOff: 'codex', codexRuns: 1, route: 'codex/ran' });
  assert.strictEqual(watcher.handOff(bash(`${companion} task`))?.target, 'codex');
  assert.strictEqual(watcher.handOff(bash(`${companion} task\n--write "x"`))?.target, 'codex');
});

// B7: Claude's mid-turn threshold note is per session; the user notice is
// once per crossing. From here on Codex is available: enabled plugin, a
// companion that answers `transfer`, and a codex executable on PATH (with
// the .cmd form Windows looks for).
const { execFileSync } = require('child_process');
const routerScript = path.join(__dirname, '..', 'plugin', 'scripts', 'jev-router.js');
const stub = path.join(home, 'stub-fetch.js');
const transcript = path.join(claudeDir, 'projects', 'p', 's.jsonl');

function withCodex(pct, state = {}) {
  const scripts = path.join(claudeDir, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts');
  if (!fs.existsSync(scripts)) {
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'codex-companion.mjs'),
      'process.stdout.write(JSON.stringify({ threadId: "t-1", resumeCommand: "codex resume t-1" }));\n');
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'codex@openai-codex': true } }));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['codex', 'codex.cmd']) fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    fs.writeFileSync(stub, 'global.fetch = async () => { throw new Error("no network in tests"); };\n');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"user"}\n');
  }
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true, enforce: true, ...state }));
  fs.writeFileSync(path.join(dataDir, 'claude-limits.json'), JSON.stringify({ five_hour: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 3600 } }));
  fs.writeFileSync(path.join(dataDir, 'codex-cache.json'), JSON.stringify({ at: Date.now(), limits: { ordinaryUsageAllowed: true, primary: { usedPercent: 10 }, secondary: { usedPercent: 10 } } }));
}

const toolCall = (session) => watcher.watch({ session_id: session, cwd: home, transcript_path: transcript, tool_name: 'Read', tool_input: {}, tool_response: {} });

// The router's prompt hook, run as Claude Code does, with fetch stubbed.
function prompt(session, text) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: home };
  delete env.OPENROUTER_API_KEY;
  const out = execFileSync(process.execPath, ['--require', stub, routerScript],
    { input: JSON.stringify({ prompt: text, session_id: session, cwd: home, transcript_path: transcript }), env }).toString();
  return out ? JSON.parse(out) : {};
}

test('B7: a second session past the same crossing gets the hand-off note and route; the user notice shows once', async () => {
  withCodex(82);
  const a = await toolCall('session-a');
  assert.match(a.systemMessage, /reached 82% during this turn/);
  assert.match(a.hookSpecificOutput.additionalContext, /Delegate without asking/);
  const b = await toolCall('session-b');
  const route = st.routeFor(st.readState(), 'session-b');
  assert.ok(b && route, `session-b output: ${JSON.stringify(b)}, session-b route: ${JSON.stringify(route)}`);
  assert.match(b.hookSpecificOutput.additionalContext, /codex-companion\.mjs" task/);
  assert.deepStrictEqual([route.target, route.model, route.how], ['codex', 'steps', 'suggested']);
  assert.strictEqual(b.systemMessage, undefined, 'the user already saw this crossing');
  assert.strictEqual(await toolCall('session-a'), null, 'session-a is not told twice');
  assert.strictEqual(await toolCall('session-b'), null, 'session-b is not told twice');
});

// The prompt hook announces the crossing and routes that prompt itself; the
// watch must then stay quiet in that session and leave its route alone.
test('B7: a session whose own prompt announced the crossing gets no mid-turn note', async () => {
  withCodex(82);
  assert.match(prompt('session-a', '+claude rename the helper in src/a.js').systemMessage, /usage at 82%/);
  assert.strictEqual(st.routeFor(st.readState(), 'session-a').target, 'claude');
  assert.strictEqual(await toolCall('session-a'), null);
  assert.strictEqual(st.routeFor(st.readState(), 'session-a').target, 'claude', 'the prompt route stands');
});

test('B7: a session that prompts after another session crossed mid-turn gets no mid-turn note', async () => {
  withCodex(82);
  assert.ok(await toolCall('session-a'));
  prompt('session-b', '+claude rename the helper in src/a.js');
  assert.strictEqual(await toolCall('session-b'), null);
  assert.strictEqual(st.routeFor(st.readState(), 'session-b').target, 'claude', 'the prompt route stands');
});

test('B7: a session mid-turn when another session\'s prompt announced the crossing still gets the note', async () => {
  withCodex(82);
  prompt('session-a', '+claude rename the helper in src/a.js');
  const b = await toolCall('session-b');
  assert.ok(b && st.routeFor(st.readState(), 'session-b'), `session-b output: ${JSON.stringify(b)}`);
  assert.strictEqual(b.systemMessage, undefined, 'the user already saw this crossing');
});

test('B7: a prompt-time auto-transfer is not repeated on the session\'s first tool call', async () => {
  withCodex(91, { autoTransfer: true });
  assert.match(prompt('session-a', '+claude rename the helper in src/a.js').systemMessage, /codex resume t-1/);
  assert.strictEqual(st.readState().stats.transfers, 1);
  const again = await toolCall('session-a');
  assert.deepStrictEqual({ output: again, transfers: st.readState().stats.transfers }, { output: null, transfers: 1 });
  // Another session, mid-turn at the same level, is still copied.
  const b = await toolCall('session-b');
  assert.match(b.systemMessage, /codex resume t-1/);
  assert.strictEqual(st.readState().stats.transfers, 2);
});
