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

// Hooks and the status line read these files while others write them, so a
// write goes to a temp file and is renamed into place: readers see the old
// file or the new one, never half of one. Windows refuses the rename while
// another process has the file open; then it falls back to a direct write.
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
    if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e;
    fs.writeFileSync(file, text);
  }
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
    // Turns that ended because Claude hit its usage limit (jev-stop-failure.js).
    limitHits: 0,
    // Subagent calls whose model jev-agent-model.js set.
    enforced: 0,
    // Claude file edits jev-codex-steps.js denied while routed to Codex.
    editsBlocked: 0,
    // Completeness checks run and stops they blocked (jev-check.js).
    // checkScope: blocks that flagged edits beyond the request.
    checks: 0, checkBlocks: 0, checkScope: 0,
    // Jev calls Claude made through the jev-tiebreak skill.
    tiebreaks: 0,
    // /effort suggestions shown (jev-router.js effortStreak).
    effortNotices: 0,
  },
  // Token use of mynameisjev:* subagents per model, from their transcripts
  // (jev-subagent-stop.js): { haiku: { runs, input, cacheWrite, cacheRead, output } }.
  helperTokens: {},
  // Total Jev cost in USD, and per feature (addCost): { sizing: { calls, cost } }.
  cost: 0,
  costs: {},
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
  // Messages in a row scored off the session's effort (jev-router effortStreak).
  effortStreak: null,
  // Block the first message after the prompt cache went cold on a large
  // context (`/mynameisjev:coldguard on`), once per expiry (coldGuardKey).
  coldGuard: false,
  coldGuardKey: null,
  // Check at each stop that the reply covers every part of the request,
  // and continue once if not (`/mynameisjev:check on`, jev-check.js).
  completeCheck: false,
  // Let Claude ask Jev at a fork mid-task (`/mynameisjev:tiebreak on`,
  // jev-tiebreak.js); tiebreakTurn counts calls in the current turn,
  // promptAt (set by the router on every prompt) marks the turn.
  tiebreak: false,
  tiebreakTurn: null,
  promptAt: null,
  // Where each session's latest message went (putRoute, routeFor), newest
  // MAX_ROUTE_SESSIONS kept; route is the latest of them, for readers with no
  // session.
  route: null,
  routes: {},
  // Set the model of general-purpose subagents to the Claude helper Jev
  // suggested for the message (`/mynameisjev:enforce on`).
  enforce: false,
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

// The state as read, kept on the object for writeState's merge. A symbol, so
// JSON.stringify and object spreads leave it out.
const BASE = Symbol('jev-state-base');
const clone = (v) => JSON.parse(JSON.stringify(v));

function normalize(parsed) {
  return {
    ...DEFAULT_STATE,
    ...parsed,
    stats: { ...DEFAULT_STATE.stats, ...(parsed.stats || {}) },
    codexTiers: { ...(parsed.codexTiers || {}) },
    helperTokens: { ...(parsed.helperTokens || {}) },
    costs: { ...(parsed.costs || {}) },
    routes: { ...(parsed.routes || {}) },
  };
}

function readState() {
  const state = readStateFile();
  Object.defineProperty(state, BASE, { value: clone(state), writable: true });
  return state;
}

function readStateFile() {
  let raw = null;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    try { raw = fs.readFileSync(LEGACY_STATE, 'utf8'); } catch (e2) { /* fresh install */ }
  }
  try {
    return normalize(raw ? JSON.parse(raw) : {});
  } catch (e) {
    return normalize({});
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Maps (stats, costs, routes, ...) hold only numbers and objects; records
// (a route, lastCall, a streak) also hold strings and are replaced whole.
const isMap = (v) => isPlainObject(v) && Object.values(v).every((x) => typeof x === 'number' || isPlainObject(x));

// Three-way merge of this process's changes (ours vs base, the state it read)
// onto what is on disk now, which another hook may have written meanwhile.
// Values this process left alone keep the disk's; changed counters add their
// difference; maps merge per key; other changes overwrite.
function merge(base, ours, disk, top = false) {
  if (JSON.stringify(ours) === JSON.stringify(base)) return disk;
  if (typeof ours === 'number' && typeof base === 'number' && typeof disk === 'number') return disk + (ours - base);
  if ((top || (isMap(ours) && isMap(disk))) && isPlainObject(ours) && isPlainObject(base) && isPlainObject(disk)) {
    const out = {};
    for (const k of new Set([...Object.keys(disk), ...Object.keys(ours)])) {
      // A key this process deleted stays deleted.
      if (!(k in ours) && k in base) continue;
      const v = merge(base[k], ours[k], disk[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return ours;
}

// Make target equal to src, reusing target's nested objects so references a
// caller holds (state.stats) stay live.
function assignInPlace(target, src) {
  for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
  for (const [k, v] of Object.entries(src)) {
    if (isPlainObject(v) && isPlainObject(target[k])) assignInPlace(target[k], v);
    else target[k] = v;
  }
}

// A state from readState is merged with the file's current contents (see
// merge) and then updated to the result, so writing it again later counts
// only what changed since. A state built by hand is written as given.
function writeState(state) {
  const file = dataFile('state.json');
  let out = state;
  if (state[BASE] && fs.existsSync(file)) {
    out = merge(state[BASE], clone(state), readStateFile(), true);
    assignInPlace(state, out);
  }
  writeFileAtomic(file, JSON.stringify(out, null, 2));
  if (state[BASE]) state[BASE] = clone(out);
}

// Route bookkeeping. Sessions run side by side, so each keeps its own route;
// a single shared one let one session's prompt lift another's enforcement.
const MAX_ROUTE_SESSIONS = 20;

function putRoute(state, route) {
  state.route = route;
  if (!route.session) return;
  const routes = { ...(state.routes || {}), [route.session]: route };
  state.routes = Object.fromEntries(Object.entries(routes)
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
    .slice(0, MAX_ROUTE_SESSIONS));
}

// The session's route, or the latest one when no session is given; null
// when the session has none. Falls back to state.route for state written
// before per-session routes.
function routeFor(state, session) {
  if (!state) return null;
  if (!session) return state.route || null;
  const own = state.routes && state.routes[session];
  if (own) return own;
  return state.route && state.route.session === session ? state.route : null;
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
// Counts one Jev call for a feature (sizing, check, decide, compare,
// tiebreak) and adds its cost to the feature and to the total.
function addCost(state, feature, amount) {
  const cost = Number.isFinite(amount) ? amount : 0;
  const prev = state.costs[feature] || { calls: 0, cost: 0 };
  state.costs[feature] = { calls: prev.calls + 1, cost: prev.cost + cost };
  state.cost += cost;
}

function projectDir(fallback) {
  return process.env.CLAUDE_PROJECT_DIR || fallback || null;
}

module.exports = {
  PLUGIN_ID, claudeDir, codexHome, dataDir, dataFile, writeFileAtomic, DEFAULT_STATE, readState, writeState,
  putRoute, routeFor,
  PROJECT_CONFIG, readProjectConfig, projectDir, COLD_GUARD_TOKENS, addCost,
};
