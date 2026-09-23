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
  },
  cost: 0,
  lastSilent: null,
  // Outcome of the most recent Jev API call, shown by the status line:
  // { at, ok, error? }.
  lastCall: null,
  // Previous prompt of the current session, for topic-shift detection.
  lastPrompt: null,
  // Last Claude usage notice shown, so each threshold crossing shows once.
  limitNotice: null,
  // Per-tier Codex model overrides (`/mynameisjev:codex set`).
  codexTiers: {},
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
    };
  } catch (e) {
    return { ...DEFAULT_STATE, stats: { ...DEFAULT_STATE.stats }, codexTiers: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(dataFile('state.json'), JSON.stringify(state, null, 2));
}

module.exports = { PLUGIN_ID, claudeDir, codexHome, dataDir, dataFile, DEFAULT_STATE, readState, writeState };
