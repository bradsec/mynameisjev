const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-style-cli-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'Brief'), { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME);
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), '# CLAUDE.md\nShared rules.');
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'Brief', 'SKILL.md'),
  '---\nname: Brief\ndescription: Concise output. Stays on until stopped.\n---\nKeep facts.');
const st = require('../plugin/scripts/jev-state');
const cli = require.resolve('../plugin/scripts/jev-cli');
const agentsPath = path.join(process.env.CODEX_HOME, 'AGENTS.md');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('style CLI saves exact ids, reports candidates, and mirrors only with sync on', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  async function run(...args) {
    const argv = process.argv;
    lines.length = 0;
    try {
      process.argv = [process.execPath, cli, 'style', ...args];
      delete require.cache[cli];
      require(cli);
      await new Promise(setImmediate);
      return lines.join('\n');
    } finally {
      process.argv = argv;
    }
  }
  assert.match(await run(), /Output style: off[\s\S]*Candidates: Brief[\s\S]*Codex block: missing/);
  assert.match(await run('Brief'), /Chosen skill: Brief[\s\S]*Turn on \/mynameisjev:sync/);
  assert.equal(st.readState().outputStyle, 'Brief');
  assert.ok(!fs.existsSync(agentsPath));
  const state = st.readState();
  state.sync = true;
  st.writeState(state);
  assert.match(await run('auto'), /Codex AGENTS.md: updated[\s\S]*Codex block: active/);
  assert.match(fs.readFileSync(agentsPath, 'utf8'), /from the Brief skill/);
  assert.match(await run('off'), /Chosen skill: off[\s\S]*Codex block: missing/);
  assert.equal(st.readState().outputStyle, null);
  assert.doesNotMatch(fs.readFileSync(agentsPath, 'utf8'), /jev-style:start/);
  assert.match(await run('absent'), /absent not found or its plugin is disabled/);
});
