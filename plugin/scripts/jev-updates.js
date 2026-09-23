#!/usr/bin/env node
// jev-updates — daily check for updates to what the Jev setup depends on:
// Claude plugins from third-party marketplaces, the Codex CLI, and RTK.
// Notify-only: the router reports what is out of date and `/mynameisjev:update`
// applies it, so no new third-party code runs without the user choosing to.
//
// Scope:
// - Claude plugins: only marketplaces without Claude Code's own background
//   auto-update (claude-plugins-official has it on by default; third-party
//   marketplaces default to off). Versions resolve the way Claude Code does:
//   plugin.json version, then the marketplace entry's version, then the git
//   commit of the plugin's source.
// - Codex CLI (only when Codex is available): installed version vs the
//   latest openai/codex GitHub release.
// - RTK: version check only; it has no self-update command, so the notice
//   points to its releases page.
// - Required plugins (jev-plugins.js) on Codex: `codex plugin list` shows no
//   "latest" version, so a Codex copy counts as behind when it is older than
//   the Claude copy of the same plugin (which Claude Code auto-updates).
//   The check also records a required plugin missing on either side.
// Other Codex plugins are left out: there is no documented way to tell
// whether an installed Codex plugin is behind.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const exec = require('./jev-exec');
const plugins = require('./jev-plugins');
const codex = require('./jev-codex');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const pluginsDir = path.join(claudeDir, 'plugins');
const st = require('./jev-state');
const cachePath = path.join(st.dataDir, 'updates.json');
const lockPath = path.join(st.dataDir, 'updates.lock');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A check still running after this long is treated as dead.
const LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const CMD_TIMEOUT_MS = 120000;
const OFFICIAL_AUTO_UPDATE = new Set(['claude-plugins-official']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

const run = (cmd, args, opts = {}) => exec.run(cmd, args, { timeout: CMD_TIMEOUT_MS, ...opts }).then((out) => out.trim());

async function githubLatestTag(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'jev-updates' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub ${repo}: HTTP ${res.status}`);
  return (await res.json()).tag_name;
}

// Numeric compare of dotted versions; true when b is newer than a.
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return y > x;
  }
  return false;
}

const short = (sha) => String(sha).slice(0, 12);
const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

// Latest version for an installed plugin from its (already refreshed)
// marketplace clone. Returns { latest, compare: 'version' | 'sha' } or null.
async function latestPluginVersion(marketplace, name, install) {
  const known = readJson(path.join(pluginsDir, 'known_marketplaces.json')) || {};
  const mdir = (known[marketplace] && known[marketplace].installLocation) || path.join(pluginsDir, 'marketplaces', marketplace);
  const catalog = readJson(path.join(mdir, '.claude-plugin', 'marketplace.json'));
  const entry = catalog && (catalog.plugins || []).find((p) => p.name === name);
  if (!entry) return null;
  const src = entry.source;

  if (typeof src === 'string') {
    const manifest = readJson(path.join(mdir, src, '.claude-plugin', 'plugin.json'));
    if (manifest && manifest.version) return { latest: manifest.version, compare: 'version' };
    if (entry.version) return { latest: entry.version, compare: 'version' };
    return { latest: short(await run('git', ['-C', mdir, 'rev-parse', 'HEAD'])), compare: 'sha' };
  }
  // Remote sources: plugin.json lives in the remote repo, so compare the
  // commit the marketplace pins (or the remote HEAD) with the installed one.
  if (src && (src.url || src.repo)) {
    if (!install.gitCommitSha) return entry.version ? { latest: entry.version, compare: 'version' } : null;
    if (src.sha) return { latest: short(src.sha), compare: 'sha' };
    const url = src.url || `https://github.com/${src.repo}.git`;
    const head = (await run('git', ['ls-remote', url, src.ref || 'HEAD'])).split(/\s/)[0];
    return head ? { latest: short(head), compare: 'sha' } : null;
  }
  return null;
}

async function checkClaudePlugins() {
  const updates = [];
  const errors = [];
  const installed = (readJson(path.join(pluginsDir, 'installed_plugins.json')) || {}).plugins || {};
  const known = readJson(path.join(pluginsDir, 'known_marketplaces.json')) || {};
  const byMarketplace = {};
  for (const [id, entries] of Object.entries(installed)) {
    const marketplace = id.split('@')[1];
    if (!marketplace || OFFICIAL_AUTO_UPDATE.has(marketplace) || (known[marketplace] && known[marketplace].autoUpdate === true)) continue;
    (byMarketplace[marketplace] = byMarketplace[marketplace] || []).push([id, entries[0]]);
  }
  for (const [marketplace, members] of Object.entries(byMarketplace)) {
    try {
      await run('claude', ['plugin', 'marketplace', 'update', marketplace]);
    } catch (e) {
      errors.push(`marketplace ${marketplace}: ${e.message}`);
      continue;
    }
    for (const [id, install] of members) {
      try {
        const found = await latestPluginVersion(marketplace, id.split('@')[0], install);
        if (!found) continue;
        const current = found.compare === 'sha' ? (install.gitCommitSha || install.version) : install.version;
        // Claude Code updates whenever the resolved version differs from the
        // installed one (not only when it is higher), so mirror that. A
        // plugin can also switch schemes, e.g. from a commit SHA to "2.7.0".
        const behind = found.compare === 'sha' ? !sameSha(current, found.latest) : String(current) !== String(found.latest);
        if (behind) {
          updates.push({ kind: 'plugin', name: id, current: found.compare === 'sha' ? short(current) : current, latest: found.latest, apply: ['claude', ['plugin', 'update', id]] });
        }
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
      }
    }
  }
  return { updates, errors };
}

async function checkCodexCli() {
  const current = (await run('codex', ['--version'])).split(/\s+/).pop();
  const latest = (await githubLatestTag('openai/codex')).replace(/^rust-v/, '');
  return newer(current, latest)
    ? [{ kind: 'cli', name: 'Codex CLI', current, latest, apply: ['codex', ['update']] }]
    : [];
}

async function checkRtk() {
  // RTK is optional; no binary means nothing to check.
  try { await run('rtk', ['--version']); } catch (e) { return []; }
  const current = (await run('rtk', ['--version'])).split(/\s+/).pop();
  const latest = (await githubLatestTag('rtk-ai/rtk')).replace(/^v/, '');
  return newer(current, latest)
    ? [{ kind: 'cli', name: 'RTK', current, latest, apply: null, manual: 'https://github.com/rtk-ai/rtk/releases/latest' }]
    : [];
}

async function checkRequiredPlugins() {
  const updates = [];
  const missing = [];
  for (const s of await plugins.requiredStatus()) {
    const p = plugins.REQUIRED.find((r) => r.name === s.name);
    if (s.claude !== 'active') missing.push(`${s.name} (Claude: ${s.claude})`);
    if (s.codex !== 'active' && s.codex !== 'n/a') missing.push(`${s.name} (Codex: ${s.codex})`);
    if (s.codex === 'active' && s.claudeVersion && s.codexVersion && newer(s.codexVersion, s.claudeVersion)) {
      updates.push({ kind: 'plugin', name: `${p.codex} (Codex)`, current: s.codexVersion, latest: s.claudeVersion, apply: ['codex', ['plugin', 'add', p.codex]] });
    }
  }
  return { updates, missing };
}

// Run every check and save the result. Individual failures are recorded,
// not thrown, so one unreachable source does not hide the others.
async function runCheck() {
  const result = { checkedAt: Date.now(), updates: [], missing: [], errors: [] };
  const plugins = await checkClaudePlugins();
  result.updates.push(...plugins.updates);
  result.errors.push(...plugins.errors);
  try {
    const required = await checkRequiredPlugins();
    result.updates.push(...required.updates);
    result.missing = required.missing;
  } catch (e) {
    result.errors.push(`required plugins: ${e.message}`);
  }
  const cliChecks = [['RTK', checkRtk]];
  if (codex.codexAvailable()) cliChecks.unshift(['Codex CLI', checkCodexCli]);
  for (const [label, check] of cliChecks) {
    try {
      result.updates.push(...(await check()));
    } catch (e) {
      result.errors.push(`${label}: ${e.message}`);
    }
  }
  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  return result;
}

function readCache() {
  return readJson(cachePath);
}

// Start a background check when the last one is over a day old, unless one
// is already running. Never waits.
function refreshInBackgroundIfStale() {
  const cache = readCache();
  if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) return;
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_MAX_AGE_MS) return;
  } catch (e) {
    // No lock: no check running.
  }
  try {
    fs.writeFileSync(lockPath, String(process.pid));
    spawn(process.execPath, [__filename, 'check'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    // Best-effort: the next prompt tries again.
  }
}

// One line per update, for notices and /mynameisjev:update --check.
function describe(u) {
  return `${u.name} ${u.current} -> ${u.latest}${u.manual ? ` (update by hand: ${u.manual})` : ''}`;
}

// Apply every update that has a command, then re-check. Returns report lines.
async function applyUpdates() {
  const cache = readCache() || (await runCheck());
  const lines = [];
  for (const u of cache.updates) {
    if (!u.apply) {
      lines.push(`skipped ${describe(u)}`);
      continue;
    }
    try {
      await run(u.apply[0], u.apply[1]);
      lines.push(`updated ${u.name} ${u.current} -> ${u.latest}`);
    } catch (e) {
      lines.push(`failed ${u.name}: ${e.message}`);
    }
  }
  if (lines.length === 0) lines.push('Everything is up to date.');
  // Codex's shared app-server loads plugins and runs the binary it started
  // with, so restart it after any Codex plugin or CLI update.
  if (lines.some((l) => l.startsWith('updated')) && cache.updates.some((u) => u.apply && u.apply[0] === 'codex')) {
    lines.push(await plugins.restartCodexRuntime());
  }
  await runCheck();
  return lines;
}

module.exports = { runCheck, readCache, refreshInBackgroundIfStale, applyUpdates, describe };

if (require.main === module && process.argv[2] === 'check') {
  runCheck()
    .catch(() => {
      // Silent: the stale cache triggers another attempt later.
    })
    .finally(() => {
      try { fs.unlinkSync(lockPath); } catch (e) { /* already gone */ }
      process.exit(0);
    });
}
