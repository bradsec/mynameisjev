#!/usr/bin/env node
// jev-plugins — plugins the Jev setup keeps installed and enabled on both
// sides. Claude Code plugins are checked from its plugin records (fast);
// Codex plugins through `codex plugin list` (about half a second, so callers
// avoid it on every prompt).

const fs = require('fs');
const path = require('path');
const os = require('os');
const exec = require('./jev-exec');
const codex = require('./jev-codex');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CMD_TIMEOUT_MS = 120000;

// Plugins required on both sides. `claudeMarketplace` is the source to add
// when the marketplace is missing. Caveman is also listed in jev-caveman.js
// for its Codex side, which is an AGENTS.md block rather than a plugin.
const REQUIRED = [
  {
    name: 'superpowers',
    claude: 'superpowers@claude-plugins-official',
    claudeMarketplace: 'anthropics/claude-plugins-official',
    codex: 'superpowers@openai-curated-remote',
  },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

const run = (cmd, args, opts = {}) => exec.run(cmd, args, { timeout: CMD_TIMEOUT_MS, ...opts });

function claudeInstall(id) {
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const entries = installed && installed.plugins && installed.plugins[id];
  return Array.isArray(entries) && entries.length > 0 ? entries[0] : null;
}

// 'active' | 'disabled' | 'missing'
function claudePluginStatus(id) {
  if (!claudeInstall(id)) return 'missing';
  const settings = readJson(path.join(claudeDir, 'settings.json')) || {};
  return settings.enabledPlugins && settings.enabledPlugins[id] === true ? 'active' : 'disabled';
}

// Install or enable a Claude plugin. Returns a line describing what was done.
async function ensureClaudePlugin(id, marketplaceSource) {
  const status = claudePluginStatus(id);
  if (status === 'active') return `${id}: active`;
  if (status === 'disabled') {
    await run('claude', ['plugin', 'enable', id]);
    return `${id}: enabled (run /reload-plugins in open sessions)`;
  }
  const marketplace = id.split('@')[1];
  const known = readJson(path.join(claudeDir, 'plugins', 'known_marketplaces.json')) || {};
  if (!known[marketplace] && marketplaceSource) await run('claude', ['plugin', 'marketplace', 'add', marketplaceSource]);
  await run('claude', ['plugin', 'install', id]);
  return `${id}: installed (run /reload-plugins in open sessions)`;
}

// Map of Codex plugin id -> { status, version } from `codex plugin list`.
async function codexPlugins() {
  const out = await run('codex', ['plugin', 'list']);
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+@\S+)\s+(installed, enabled|installed, disabled|not installed)\s+(\S+)?/);
    if (m) map[m[1]] = { status: m[2], version: m[3] || null };
  }
  return map;
}

// 'active' | 'disabled' | 'missing' | 'unknown' (not in any marketplace)
function codexStatusFrom(map, id) {
  const p = map[id];
  if (!p) return 'unknown';
  if (p.status === 'installed, enabled') return 'active';
  return p.status === 'installed, disabled' ? 'disabled' : 'missing';
}

async function ensureCodexPlugin(id, map) {
  const status = codexStatusFrom(map, id);
  if (status === 'active') return `${id}: active`;
  if (status === 'unknown') return `${id}: not found in any Codex marketplace`;
  // `codex plugin add` installs, and re-enables a disabled plugin.
  await run('codex', ['plugin', 'add', id]);
  return `${id}: ${status === 'disabled' ? 'enabled' : 'installed'} in Codex`;
}

// The codex plugin keeps a shared app-server running per workspace, and it
// only loads Codex plugins at start: after a Codex plugin install or update,
// companion tasks keep the old set until it restarts. Stop each shared server
// whose workspace has no running Codex job; the companion starts a fresh one
// on the next task. Reads process arguments from /proc (Linux).
async function restartCodexRuntime() {
  if (process.platform !== 'linux') return 'Codex runtime: automatic restart is Linux-only; restart Claude Code to load the change';
  const companion = codex.companionPath();
  let candidates = [];
  try {
    candidates = (await run('pgrep', ['-f', 'app-server-broker.mjs serve'])).split('\n').filter(Boolean);
  } catch (e) {
    // pgrep exits 1 when nothing matches.
  }
  // pgrep -f also matches any process whose command line merely contains the
  // pattern (a shell running a command that mentions it, for one), so keep
  // only processes actually executing the broker script.
  const brokers = [];
  for (const pid of candidates) {
    if (Number(pid) === process.pid) continue;
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (args[1] && args[1].endsWith('/app-server-broker.mjs') && args[2] === 'serve') brokers.push({ pid, args });
    } catch (e) {
      // Process exited meanwhile.
    }
  }
  if (brokers.length === 0) return 'Codex runtime: not running; the next Codex task loads the change';
  const results = [];
  for (const { pid, args } of brokers) {
    try {
      const cwd = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : '/';
      const status = JSON.parse(await run(process.execPath, [companion, 'status', '--json'], { cwd }));
      if ((status.running || []).length > 0) {
        results.push(`kept (${status.running.length} job running in ${cwd}; restart after it finishes)`);
        continue;
      }
      let children = [];
      try { children = (await run('pgrep', ['-P', pid])).split('\n').filter(Boolean); } catch (e) { /* none */ }
      for (const child of children) process.kill(Number(child));
      process.kill(Number(pid));
      results.push(`restarted (${cwd})`);
    } catch (e) {
      results.push(`could not restart pid ${pid} (${e.message})`);
    }
  }
  return `Codex runtime: ${results.join('; ')}`;
}

// Status of every required plugin on both sides:
// [{ name, claude, codex, claudeVersion, codexVersion }]. The Codex side is
// 'n/a' when Codex is not available.
async function requiredStatus() {
  let map = null;
  const available = codex.codexAvailable();
  if (available) {
    try { map = await codexPlugins(); } catch (e) { /* Codex failing */ }
  }
  return REQUIRED.map((p) => {
    const install = claudeInstall(p.claude);
    return {
      name: p.name,
      claude: claudePluginStatus(p.claude),
      codex: !available ? 'n/a' : map ? codexStatusFrom(map, p.codex) : 'unknown',
      claudeVersion: install ? install.version : null,
      codexVersion: map && map[p.codex] ? map[p.codex].version : null,
    };
  });
}

// Install or enable every required plugin wherever it is missing.
async function ensureRequired() {
  const lines = [];
  let map = null;
  if (codex.codexAvailable()) {
    try { map = await codexPlugins(); } catch (e) { lines.push(`Codex plugins: could not list (${e.message})`); }
  }
  let codexChanged = false;
  for (const p of REQUIRED) {
    try { lines.push(`Claude ${await ensureClaudePlugin(p.claude, p.claudeMarketplace)}`); } catch (e) { lines.push(`Claude ${p.claude}: ${e.message}`); }
    if (map) {
      try {
        const line = await ensureCodexPlugin(p.codex, map);
        if (!line.endsWith(': active')) codexChanged = true;
        lines.push(`Codex ${line}`);
      } catch (e) { lines.push(`Codex ${p.codex}: ${e.message}`); }
    }
  }
  if (codexChanged) lines.push(await restartCodexRuntime());
  return lines;
}

module.exports = {
  REQUIRED,
  claudeInstall,
  claudePluginStatus,
  ensureClaudePlugin,
  codexPlugins,
  requiredStatus,
  ensureRequired,
  restartCodexRuntime,
};
