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
// While a Codex task runs, its usage climbs by the minute. The refresh only
// reads rate limits, so it costs no Codex usage itself.
const ACTIVE_MAX_AGE_MS = 60 * 1000;
// A refresh that has not finished in this long is treated as dead.
const LOCK_MAX_AGE_MS = 30 * 1000;

// Mirrors the Claude tiers: fast model for lookups, balanced for everyday
// work, frontier model for large and hardest. Efforts stay within what the
// companion's `task --effort` accepts (none..xhigh). The models here are a
// seed: autoTiers picks the current ones from Codex's own model list, so a
// new Codex model needs no Jev release.
const DEFAULT_TIERS = {
  tiny: { model: 'gpt-6-luna', effort: 'low' },
  everyday: { model: 'gpt-6.1-sol', effort: 'medium' },
  large: { model: 'gpt-6-astra', effort: 'medium' },
  hardest: { model: 'gpt-6-astra', effort: 'high' },
};
const TASK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
// Models that draw down Codex usage fastest. Jev routes to them only when the
// user asks: a +codex prefix, or a tier set with /mynameisjev:codex set.
// Seed only: with a model list, the frontier models found there count.
const PREMIUM_MODELS = new Set(['gpt-6-astra']);

// How autoTiers reads Codex's model descriptions ("Fast and affordable model
// for easier tasks.", "Frontier intelligence for the most demanding work.").
// Codex lists the newest models first, so the first match is the newest.
const OLD_MODEL = /\b(older|previous|legacy|deprecated)\b/i;
const FAST_MODEL = /\b(fast|affordable|cheap|efficient|lightweight)\b/i;
const FRONTIER_MODEL = /\b(frontier|most capable|most intelligent|most demanding|flagship)\b/i;
const MAX_UPGRADE_HOPS = 5;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// The companion task command with its prompt on stdin through a quoted
// heredoc: as a quoted argument, quotes, backticks and $ in a multi-paragraph
// brief break the command or get expanded by the shell. The companion reads
// stdin before it starts a --background job. Forward slashes work in Git Bash
// on Windows too.
const HEREDOC = 'JEV_BRIEF';
function taskCommand(companion, flags, placeholder) {
  return `node "${companion.replace(/\\/g, '/')}" task ${flags ? `${flags} ` : ''}<<'${HEREDOC}'\n${placeholder}\n${HEREDOC}`;
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
          // The model Codex suggests in its place, when it has one.
          upgrade: (m.upgrade && (m.upgrade.id || m.upgrade.model || m.upgrade)) || null,
          efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).filter(Boolean),
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
  st.writeFileAtomic(cachePath, JSON.stringify(record, null, 2));
  return record;
}

function readCache() {
  return readJson(cachePath);
}

// Start a background refresh when the cache is older than maxAgeMs, unless
// one is already running. Never waits: the caller uses whatever cache exists
// now.
function refreshInBackgroundIfStale(cache, maxAgeMs = CACHE_MAX_AGE_MS) {
  if (!codexAvailable()) return;
  if (cache && Date.now() - cache.at < maxAgeMs) return;
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

const listedModels = (cache) => (cache && Array.isArray(cache.models) ? cache.models : []);

// The newest current model whose description matches, or null.
function newest(models, pattern) {
  const m = models.find((x) => !OLD_MODEL.test(x.description || '') && pattern.test(x.description || ''));
  return m ? m.id : null;
}

// A seed model, moved along Codex's upgrade pointers to a listed model.
function upgraded(id, models) {
  const byId = new Map(models.map((m) => [m.id, m]));
  for (let hops = 0; hops < MAX_UPGRADE_HOPS && byId.get(id) && byId.get(id).upgrade && byId.has(byId.get(id).upgrade); hops++) {
    id = byId.get(id).upgrade;
  }
  return id;
}

// Each tier's model and effort for Codex's current model list, before user
// overrides: tiny takes the newest fast model, everyday Codex's default,
// large and hardest the newest frontier model. A tier no description fits
// keeps its seed model, following any upgrade Codex lists for it. With no
// list this is DEFAULT_TIERS.
function autoTiers(cache) {
  const models = listedModels(cache);
  const def = models.find((m) => m.isDefault);
  const frontier = newest(models, FRONTIER_MODEL);
  const found = {
    tiny: newest(models, FAST_MODEL),
    everyday: def ? def.id : null,
    large: frontier,
    hardest: frontier,
  };
  const out = {};
  for (const [tier, seed] of Object.entries(DEFAULT_TIERS)) {
    out[tier] = { ...seed, model: found[tier] || upgraded(seed.model, models) };
  }
  return out;
}

// Premium models: the frontier models in Codex's list, or the seed set when
// the list has no descriptions to judge by.
function premiumModels(cache) {
  const models = listedModels(cache);
  const frontier = models.filter((m) => !OLD_MODEL.test(m.description || '') && FRONTIER_MODEL.test(m.description || ''));
  return frontier.length > 0 ? new Set(frontier.map((m) => m.id)) : PREMIUM_MODELS;
}

// Model + effort for a tier: user override (state.codexTiers) first, then
// autoTiers. A model missing from Codex's current list is dropped so Codex
// uses its own default instead of failing on an unknown model, and so is an
// effort the model does not list as supported.
// explicit: the user asked for this tier, so its premium model stands.
// Otherwise a premium model gives way to the everyday tier's model,
// keeping this tier's effort.
function tierChoice(tier, overrides, cache, explicit = false) {
  const auto = autoTiers(cache);
  const override = (overrides && overrides[tier]) || {};
  const choice = { ...auto[tier], ...override };
  if (!explicit && !override.model && premiumModels(cache).has(choice.model) && tier !== 'everyday') {
    choice.model = { ...auto.everyday, ...((overrides && overrides.everyday) || {}) }.model;
  }
  const models = listedModels(cache);
  if (models.length > 0 && !models.some((m) => m.id === choice.model)) choice.model = null;
  if (!TASK_EFFORTS.includes(choice.effort)) choice.effort = null;
  const listed = models.find((m) => m.id === choice.model);
  if (listed && Array.isArray(listed.efforts) && listed.efforts.length > 0 && !listed.efforts.includes(choice.effort)) choice.effort = null;
  return choice;
}

module.exports = {
  HEREDOC,
  taskCommand,
  codexAvailable,
  DEFAULT_TIERS,
  TASK_EFFORTS,
  PREMIUM_MODELS,
  autoTiers,
  CACHE_MAX_AGE_MS,
  ACTIVE_MAX_AGE_MS,
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
      try { st.writeFileAtomic(cachePath, JSON.stringify({ at: Date.now(), error: e.message })); } catch (err) { /* ignore */ }
    })
    .finally(() => {
      try { fs.unlinkSync(lockPath); } catch (e) { /* already gone */ }
      process.exit(0);
    });
}
