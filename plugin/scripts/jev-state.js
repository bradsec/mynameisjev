// jev-state — shared paths and the router's settings/stats file.
//
// Jev's own files live in ~/.claude/mynameisjev/ (under CLAUDE_CONFIG_DIR
// when set). Not the plugin data directory Claude Code offers: that path is
// named after plugin and marketplace, and commands Claude runs through Bash
// don't receive it. Uninstalling the plugin leaves this folder behind.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ID = 'mynameisjev@mynameisjev';
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const dataDir = path.join(claudeDir, 'mynameisjev');
const statePath = path.join(dataDir, 'state.json');

// Path of a file in the data directory, creating the directory on first use.
function dataFile(name) {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, name);
}

// Everything beyond sizing and routing is opt-in: several features change
// files outside Jev (Codex's AGENTS.md, plugin installs, Codex threads).
const DEFAULT_STATE = {
  enabled: false,
  stats: {
    tiny: 0, everyday: 0, large: 0, hardest: 0, unsure: 0, skipped: 0, failed: 0,
    shift: 0, suppressed: 0, codex: 0, transfers: 0,
    // Claude helper notes given, "+" overrides used, and hand-offs that ran
    // (counted by jev-usage-watch.js) per target.
    helper: 0, forced: 0, helperRuns: 0, codexRuns: 0,
  },
  // Token use of mynameisjev:* subagents per model, from their transcripts
  // (jev-subagent-stop.js): { haiku: { runs, input, cacheWrite, cacheRead, output } }.
  helperTokens: {},
  cost: 0,
  lastSilent: null,
  // Outcome of the most recent Jev API call, shown by the status line:
  // { at, ok, error? }.
  lastCall: null,
  // Previous prompt of the current session, for topic-shift detection.
  lastPrompt: null,
  // Session and path of the last unusable project config announced.
  projectNotice: null,
  // Messages in a row sized off the session's model (jev-router modelStreak).
  modelStreak: null,
  // Block the first message after the prompt cache went cold on a large
  // context (`/mynameisjev:coldguard on`), once per expiry (coldGuardKey).
  coldGuard: false,
  coldGuardKey: null,
  // Last Claude usage notice shown, so each threshold crossing shows once.
  limitNotice: null,
  // Per-tier Codex model overrides (`/mynameisjev:codex set`).
  codexTiers: {},
  // 'codex' routes work to Codex first at any Claude usage (`/mynameisjev:prefer`).
  prefer: 'claude',
  // Copy the session into Codex from 90% Claude usage (`/mynameisjev:transfer on`).
  autoTransfer: false,
  lastTransfer: null,
  // Keep caveman active on Claude and Codex (`/mynameisjev:caveman on`).
  caveman: false,
  // Generate ~/.codex/AGENTS.md from CLAUDE.md, keep RTK and required
  // plugins active on both sides (`/mynameisjev:sync on`).
  sync: false,
  setupNoticeSession: null,
  // Daily update check (`/mynameisjev:update on`).
  updates: false,
  updatesNoticeAt: null,
  // statusLine setting replaced by `/mynameisjev:statusline install`.
  previousStatusLine: null,
  // 'wrap': the status line records Jev's data but prints previousStatusLine's
  // output (`/mynameisjev:statusline wrap`); 'full' or null: Jev's own.
  statusLineMode: null,
  // Wrap mode also prints the JEV segment (`/mynameisjev:statusline wrap --with-jev`).
  statusLineJev: false,
};

// Settings files written by earlier, non-plugin versions of Jev.
const LEGACY_STATE = path.join(claudeDir, '.jev-router-state.json');

function readState() {
  let raw = null;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    try { raw = fs.readFileSync(LEGACY_STATE, 'utf8'); } catch (e2) { /* fresh install */ }
  }
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      ...DEFAULT_STATE,
      ...parsed,
      stats: { ...DEFAULT_STATE.stats, ...(parsed.stats || {}) },
      codexTiers: { ...(parsed.codexTiers || {}) },
      helperTokens: { ...(parsed.helperTokens || {}) },
    };
  } catch (e) {
    return { ...DEFAULT_STATE, stats: { ...DEFAULT_STATE.stats }, codexTiers: {}, helperTokens: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(dataFile('state.json'), JSON.stringify(state, null, 2));
}

// Per-project overrides in <project>/.claude/mynameisjev.json:
//   { "router": false }     never send this project's messages to Jev
//   { "prefer": "codex" }   or "claude": overrides /mynameisjev:prefer here
// Returns null when the file is absent, else { path, router, prefer, error }.
// A file that can't be read or parsed sets `error` and router: false, so a
// broken privacy opt-out fails closed instead of sending text.
const PROJECT_CONFIG = path.join('.claude', 'mynameisjev.json');

function readProjectConfig(dir) {
  if (!dir) return null;
  const file = path.join(dir, PROJECT_CONFIG);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    return { path: file, router: false, prefer: null, error: e.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { path: file, router: false, prefer: null, error: `invalid JSON: ${e.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path: file, router: false, prefer: null, error: 'expected a JSON object' };
  }
  const problems = [];
  if (parsed.router !== undefined && typeof parsed.router !== 'boolean') problems.push('"router" must be true or false');
  if (parsed.prefer !== undefined && parsed.prefer !== 'codex' && parsed.prefer !== 'claude') problems.push('"prefer" must be "codex" or "claude"');
  if (problems.length > 0) return { path: file, router: false, prefer: null, error: problems.join('; ') };
  return { path: file, router: parsed.router !== false, prefer: parsed.prefer || null, error: null };
}

// Re-cache size from which the cold-cache guard blocks a message (router)
// and the status line shows it armed.
const COLD_GUARD_TOKENS = 100000;

// The project directory a hook or command runs for.
function projectDir(fallback) {
  return process.env.CLAUDE_PROJECT_DIR || fallback || null;
}

module.exports = {
  PLUGIN_ID, claudeDir, codexHome, dataDir, dataFile, DEFAULT_STATE, readState, writeState,
  PROJECT_CONFIG, readProjectConfig, projectDir, COLD_GUARD_TOKENS,
};
