const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-stopfail-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const claudeDir = path.join(home, '.claude');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = path.join(home, '.codex');
const dataDir = path.join(claudeDir, 'mynameisjev');
fs.mkdirSync(dataDir, { recursive: true });
const stop = require('../plugin/scripts/jev-stop-failure');

const setState = (over) => fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ enabled: true, ...over }));
const readState = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
const transcript = path.join(claudeDir, 'projects', 'p', 's1.jsonl');
const input = { error: 'rate_limit', session_id: 's1', cwd: home, transcript_path: transcript };

test('notification sequence per terminal, with control characters stripped', () => {
  assert.strictEqual(stop.notification('T;x', 'a\x07b', {}), '\x1b]777;notify;T,x;a b\x07');
  assert.strictEqual(stop.notification('T', 'body', { TERM_PROGRAM: 'iTerm.app' }), '\x1b]9;T: body\x07');
  assert.strictEqual(stop.notification('T', 'body', { WT_SESSION: '1' }), '\x1b]9;T: body\x07');
  assert.strictEqual(stop.notification('T', 'body', { KITTY_WINDOW_ID: '1' }), '\x1b]99;;body\x1b\\');
});

test('only rate limits, only with the router on', async () => {
  setState({});
  assert.strictEqual(await stop.handle({ ...input, error: 'overloaded' }), null);
  setState({ enabled: false });
  assert.strictEqual(await stop.handle(input), null);
});

test('without Codex: a notification with the reset time, and the hit counted', async () => {
  setState({});
  fs.writeFileSync(path.join(dataDir, 'claude-limits.json'), JSON.stringify({ five_hour: { used_percentage: 100, resets_at: 1799999999 } }));
  const out = await stop.handle(input);
  assert.match(out.terminalSequence, /Claude hit its usage limit \(resets \d\d:\d\d\)\.\x07$/);
  assert.strictEqual(readState().stats.limitHits, 1);
});

test('with Codex and auto-transfer: copies the session once and names the resume command', async () => {
  const scripts = path.join(claudeDir, 'plugins', 'cache', 'openai-codex', 'codex', '1.0.0', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'codex-companion.mjs'),
    'process.stdout.write(JSON.stringify({ threadId: "t-9", resumeCommand: "codex resume t-9" }));\n');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'codex@openai-codex': true } }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['codex', 'codex.cmd']) fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"user"}\n');

  setState({ autoTransfer: false });
  assert.match((await stop.handle(input)).terminalSequence, /Run \/codex:transfer to continue in Codex/);
  assert.ok(!readState().lastTransfer, 'no transfer with auto-transfer off');

  setState({ autoTransfer: true });
  const out = await stop.handle(input);
  assert.match(out.terminalSequence, /Continue in Codex: codex resume t-9/);
  const state = readState();
  assert.deepStrictEqual([state.lastTransfer.threadId, state.lastTransfer.session, state.stats.transfers], ['t-9', 's1', 1]);

  // A retry within minutes reuses that thread.
  await stop.handle(input);
  assert.strictEqual(readState().stats.transfers, 1);
});
