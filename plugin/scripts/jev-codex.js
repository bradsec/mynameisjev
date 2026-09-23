#!/usr/bin/env node
// jev-codex — Codex side of the Jev router. Reads Codex's model list and
// ChatGPT-plan usage limits from `codex app-server`, caches them, and maps Jev
// size tiers to a Codex model + effort.
//
// Starting app-server takes about a second, too slow for every prompt, so the
// router reads the cache and triggers `jev-codex.js refresh` in the background
// when it is stale. `/mynameisjev:limits` refreshes in the foreground.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const st = require('./jev-state');
const exec = require('./jev-exec');
const cachePath = path.join(st.dataDir, 'codex-cache.json');
const lockPath = path.join(st.dataDir, 'codex-refresh.lock');
const REFRESH_TIMEOUT_MS = 10000;
// Usage moves slowly relative to prompts; five minutes keeps routing current
// without starting app-server on every prompt.
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
// A refresh that has not finished in this long is treated as dead.
const LOCK_MAX_AGE_MS = 30 * 1000;

// Mirrors the Claude tiers: fast model for lookups, balanced for everyday
// work, frontier model for large and hardest. Efforts stay within what the
// companion's `task --effort` accepts (none..xhigh).
const DEFAULT_TIERS = {
  tiny: { model: 'gpt-5.6-luna', effort: 'low' },
  everyday: { model: 'gpt-5.6-terra', effort: 'medium' },
  large: { model: 'gpt-6-astra', effort: 'medium' },
  hardest: { model: 'gpt-6-astra', effort: 'high' },
};
const TASK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Newest installed codex plugin's companion script, or null when the plugin
// is not installed. Resolved at call time so plugin updates are picked up.
function companionPath() {
  const base = path.join(claudeDir, 'plugins', 'cache', 'openai-codex', 'codex');
  try {
    const versions = fs.readdirSync(base)
      .filter((v) => fs.existsSync(path.join(base, v, 'scripts', 'codex-companion.mjs')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length === 0) return null;
    return path.join(base, versions[versions.length - 1], 'scripts', 'codex-companion.mjs');
  } catch (e) {
    return null;
  }
}

// One app-server session: initialize, then model/list and
// account/rateLimits/read. Resolves to the cache record or rejects.
function queryAppServer() {
  return new Promise((resolve, reject) => {
    const proc = exec.spawnCli('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map();
    let nextId = 0;
    const finish = (err, value) => {
      clearTimeout(timer);
      proc.kill();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`codex app-server timed out after ${REFRESH_TIMEOUT_MS}ms`)), REFRESH_TIMEOUT_MS);
    proc.on('error', (e) => finish(new Error(`cannot start codex: ${e.message}`)));
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      const handler = msg.id != null && pending.get(msg.id);
      if (!handler) return;
      pending.delete(msg.id);
      if (msg.error) handler.reject(new Error(msg.error.message || 'app-server error'));
      else handler.resolve(msg.result);
    });
    const request = (method, params) => new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { resolve: res, reject: rej });
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

    (async () => {
      await request('initialize', {
        clientInfo: { name: 'jev-router', title: 'Jev router', version: '1' },
        capabilities: { experimentalApi: false },
      });
      proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      const [models, limits] = await Promise.all([
        request('model/list', {}),
        request('account/rateLimits/read', {}),
      ]);
      const rl = limits && limits.rateLimits;
      const win = (w) => (w && Number.isFinite(w.usedPercent)
        ? { usedPercent: w.usedPercent, windowMins: w.windowDurationMins, resetsAt: w.resetsAt }
        : null);
      finish(null, {
        at: Date.now(),
        models: ((models && models.data) || []).filter((m) => !m.hidden).map((m) => ({
          id: m.id,
          description: m.description || '',
          isDefault: !!m.isDefault,
        })),
        limits: {
          ordinaryUsageAllowed: limits ? limits.ordinaryUsageAllowed !== false : false,
          reachedType: (rl && rl.rateLimitReachedType) || null,
          planType: (rl && rl.planType) || null,
          primary: win(rl && rl.primary),
          secondary: win(rl && rl.secondary),
        },
      });
    })().catch((e) => finish(e));
  });
}

// Codex features need the codex Claude Code plugin (installed and enabled)
// and the codex CLI on PATH; without them every Codex feature stays off.
// Checked with file lookups only, since the router calls it on every prompt.
function codexAvailable() {
  if (!companionPath()) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    if (!settings.enabledPlugins || settings.enabledPlugins['codex@openai-codex'] !== true) return false;
  } catch (e) {
    return false;
  }
  return exec.findOnPath('codex') !== null;
}

async function refreshCache() {
  const record = await queryAppServer();
  fs.writeFileSync(cachePath, JSON.stringify(record, null, 2));
  return record;
}

function readCache() {
  return readJson(cachePath);
}

// Start a background refresh when the cache is stale, unless one is already
// running. Never waits: the caller uses whatever cache exists now.
function refreshInBackgroundIfStale(cache) {
  if (!codexAvailable()) return;
  if (cache && Date.now() - cache.at < CACHE_MAX_AGE_MS) return;
  try {
    const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (lockAge < LOCK_MAX_AGE_MS) return;
  } catch (e) {
    // No lock: no refresh running.
  }
  try {
    fs.writeFileSync(lockPath, String(process.pid));
    spawn(process.execPath, [__filename, 'refresh'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    // Best-effort: the next prompt tries again.
  }
}

// Highest usage across Codex's windows (5h and weekly), with the window it
// came from, or null when unknown.
function codexPeak(cache) {
  const l = cache && cache.limits;
  if (!l) return null;
  const nowSec = Date.now() / 1000;
  let peak = null;
  for (const [name, w] of [['5h', l.primary], ['weekly', l.secondary]]) {
    if (!w) continue;
    // A window whose reset time has passed has started over.
    const pct = Number.isFinite(w.resetsAt) && w.resetsAt < nowSec ? 0 : w.usedPercent;
    if (!peak || pct > peak.pct) peak = { pct, window: name, resetsAt: w.resetsAt };
  }
  return peak;
}

// Model + effort for a tier: user override (state.codexTiers) first, then the
// defaults. A model missing from Codex's current list is dropped so Codex
// uses its own default instead of failing on an unknown model.
function tierChoice(tier, overrides, cache) {
  const choice = { ...DEFAULT_TIERS[tier], ...((overrides && overrides[tier]) || {}) };
  const listed = cache && Array.isArray(cache.models) ? cache.models.map((m) => m.id) : null;
  if (listed && listed.length > 0 && !listed.includes(choice.model)) choice.model = null;
  if (!TASK_EFFORTS.includes(choice.effort)) choice.effort = null;
  return choice;
}

module.exports = {
  codexAvailable,
  DEFAULT_TIERS,
  TASK_EFFORTS,
  CACHE_MAX_AGE_MS,
  companionPath,
  readCache,
  refreshCache,
  refreshInBackgroundIfStale,
  codexPeak,
  tierChoice,
};

if (require.main === module && process.argv[2] === 'refresh') {
  refreshCache()
    .catch((e) => {
      // Record the failure (e.g. Codex not logged in) so readers can say why
      // there is no usage data; it is retried once the record goes stale.
      try { fs.writeFileSync(cachePath, JSON.stringify({ at: Date.now(), error: e.message })); } catch (err) { /* ignore */ }
    })
    .finally(() => {
      try { fs.unlinkSync(lockPath); } catch (e) { /* already gone */ }
      process.exit(0);
    });
}
