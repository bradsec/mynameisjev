#!/usr/bin/env node
// jev-plugins — what is installed on each side, found at run time rather
// than from a list of plugin names, so renamed, added or removed plugins
// need no code change. Claude Code plugins are read from its plugin records
// (fast); Codex plugins through `codex plugin list` (about half a second, so
// callers avoid it on every prompt). Jev reports what it finds and never
// installs or enables a plugin.

const fs = require('fs');
const path = require('path');
const os = require('os');
const exec = require('./jev-exec');
const codex = require('./jev-codex');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CMD_TIMEOUT_MS = 120000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

const run = (cmd, args, opts = {}) => exec.run(cmd, args, { timeout: CMD_TIMEOUT_MS, ...opts });

// Every installed Claude plugin: [{ id, name, version, installPath, enabled }].
function claudePlugins() {
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const enabled = (readJson(path.join(claudeDir, 'settings.json')) || {}).enabledPlugins || {};
  return Object.entries((installed && installed.plugins) || {})
    .filter(([, entries]) => Array.isArray(entries) && entries.length > 0)
    .map(([id, entries]) => ({
      id,
      name: id.split('@')[0],
      version: entries[0].version || null,
      installPath: entries[0].installPath || null,
      enabled: enabled[id] === true,
    }));
}

// Map of Codex plugin id -> { status, version } from `codex plugin list`.
async function codexPlugins() {
  const out = await run('codex', ['plugin', 'list']);
  const map = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+@\S+)\s+(installed, enabled|installed, disabled|not installed)(?:\s+(\S+))?(?:\s|$)/);
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

// Plugins enabled in Claude Code whose name also exists in a Codex
// marketplace, matched by name (the part before @):
// [{ name, claude: { id, version }, codex: { id, status, version } }], with
// codex.status 'active' | 'disabled' | 'missing'. A Claude plugin with no
// Codex counterpart is left out. [] when Codex is not available.
async function pluginPairs() {
  if (!codex.codexAvailable()) return [];
  const map = await codexPlugins();
  const byName = {};
  for (const id of Object.keys(map)) {
    const name = id.split('@')[0];
    // Several marketplaces may list one name; an installed copy wins.
    if (!byName[name] || codexStatusFrom(map, id) !== 'missing') byName[name] = id;
  }
  return claudePlugins()
    .filter((p) => p.enabled && byName[p.name])
    .map((p) => {
      const id = byName[p.name];
      return {
        name: p.name,
        claude: { id: p.id, version: p.version },
        codex: { id, status: codexStatusFrom(map, id), version: map[id].version },
      };
    });
}

// One line per plugin pair for /mynameisjev:status and /mynameisjev:sync.
// Jev does not install: a plugin Codex lacks gets the command to add it.
function describePair(p) {
  if (p.codex.status === 'active') return `${p.name}: Claude ${p.claude.version || '?'}, Codex ${p.codex.version || '?'}`;
  const fix = p.codex.status === 'disabled' ? 'enable it in Codex' : `install with: codex plugin add ${p.codex.id}`;
  return `${p.name}: Claude ${p.claude.version || '?'}, Codex ${p.codex.status} (${fix})`;
}

module.exports = {
  claudePlugins,
  codexPlugins,
  pluginPairs,
  describePair,
  restartCodexRuntime,
};
