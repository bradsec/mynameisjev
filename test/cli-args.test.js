const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cli-args-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME);
const st = require('../plugin/scripts/jev-state');
const cli = require.resolve('../plugin/scripts/jev-cli');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('CLI rejects stray arguments and reuses no handoff path', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  async function run(...args) {
    const argv = process.argv;
    lines.length = 0;
    try {
      process.argv = [process.execPath, cli, ...args];
      delete require.cache[cli];
      require(cli);
      await new Promise(setImmediate);
      return lines.join('\n');
    } finally {
      process.argv = argv;
    }
  }
  const before = st.readState().completeCheck;
  assert.match(await run('check', 'on', 'extra'), /^Error: /);
  assert.equal(st.readState().completeCheck, before);
  assert.match(await run('status', 'bad'), /^Error: /);
  assert.match(await run('report', 'bad'), /^Error: /);
  assert.match(await run('transfer', 'invalid'), /^Error: usage: \/mynameisjev:transfer/);

  const first = (await run('handoff')).trim();
  fs.writeFileSync(first, 'note');
  const second = (await run('handoff')).trim();
  assert.notEqual(second, first);
  assert.ok(!fs.existsSync(second));
});
