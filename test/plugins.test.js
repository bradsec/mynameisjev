const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-plugins-'));
process.env.CLAUDE_CONFIG_DIR = tmp;
process.env.CODEX_HOME = path.join(tmp, 'codex');
fs.mkdirSync(path.join(tmp, 'plugins'));
const names = ['older', 'equal', 'ahead', 'missing', 'disabled', 'unmatched', 'off'];
fs.writeFileSync(path.join(tmp, 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: Object.fromEntries(names.map((name) => [`${name}@local`, [{ version: '2.0.0' }]])),
}));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
  enabledPlugins: Object.fromEntries(names.filter((name) => name !== 'off').map((name) => [`${name}@local`, true])),
}));
fs.writeFileSync(path.join(tmp, 'plugins', 'known_marketplaces.json'), JSON.stringify({ local: { autoUpdate: true } }));
const exec = require('../plugin/scripts/jev-exec');
const codex = require('../plugin/scripts/jev-codex');
const plugins = require('../plugin/scripts/jev-plugins');
const updates = require('../plugin/scripts/jev-updates');
fs.mkdirSync(require('../plugin/scripts/jev-state').dataDir, { recursive: true });
const listing = [
  'older@remote installed, enabled 1.0.0',
  'equal@remote installed, enabled 2.0.0',
  'ahead@remote installed, enabled 3.0.0',
  'missing@remote not installed',
  'disabled@remote installed, disabled 1.0.0',
  'off@remote installed, enabled 1.0.0',
].join('\n');

function mockCommands(t) {
  t.mock.method(codex, 'codexAvailable', () => true);
  t.mock.method(exec, 'run', async (cmd, args) => {
    if (cmd === 'codex' && args.join(' ') === 'plugin list') return listing;
    if (cmd === 'codex' && args.join(' ') === '--version') return 'codex 1.0.0';
    if (cmd === 'rtk' && args.join(' ') === '--version') throw new Error('not installed');
    assert.fail(`Unexpected command: ${cmd} ${args.join(' ')}`);
  });
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('plugin pairs match enabled Claude names to Codex marketplaces without installing', async (t) => {
  mockCommands(t);
  const pairs = await plugins.pluginPairs();
  assert.deepEqual(pairs.map((p) => [p.name, p.codex.status]), [
    ['older', 'active'], ['equal', 'active'], ['ahead', 'active'], ['missing', 'missing'], ['disabled', 'disabled'],
  ]);
  assert.deepEqual(pairs[0], {
    name: 'older', claude: { id: 'older@local', version: '2.0.0' },
    codex: { id: 'older@remote', status: 'active', version: '1.0.0' },
  });
  assert.match(plugins.describePair(pairs[3]), /codex plugin add missing@remote/);
  assert.match(plugins.describePair(pairs[4]), /enable it in Codex/);
});

test('plugin pairs are empty without Codex and never invoke it', async (t) => {
  t.mock.method(codex, 'codexAvailable', () => false);
  t.mock.method(exec, 'run', () => assert.fail('Codex must not run'));
  assert.deepEqual(await plugins.pluginPairs(), []);
});

test('update checks report inactive counterparts and update only older active copies', async (t) => {
  mockCommands(t);
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ tag_name: 'rust-v1.0.0' }) }));
  const found = await updates.runCheck();
  assert.deepEqual(found.errors, []);
  assert.deepEqual(found.missing, [
    'missing (Codex: missing, codex plugin add missing@remote)',
    'disabled (Codex: disabled, codex plugin add disabled@remote)',
  ]);
  assert.deepEqual(found.updates, [{
    kind: 'plugin', name: 'older@remote (Codex)', current: '1.0.0', latest: '2.0.0',
    apply: ['codex', ['plugin', 'add', 'older@remote']],
  }]);
});
