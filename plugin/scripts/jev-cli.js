#!/usr/bin/env node
// jev-cli — backs the /mynameisjev:* commands: on/off/status, Claude and Codex
// usage limits, the Codex model per size tier, and the opt-in features
// (caveman, sync, updates, auto-transfer, status line).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const st = require('./jev-state');
const codex = require('./jev-codex');
const caveman = require('./jev-caveman');
const sync = require('./jev-sync');
const plugins = require('./jev-plugins');
const updates = require('./jev-updates');

const state = st.readState();
const [cmd = 'status', ...args] = process.argv.slice(2).map((a) => a.toLowerCase());
const print = (lines) => lines.forEach((l) => console.log(l));
const onOff = (b) => (b ? 'on' : 'off');

const COMMANDS = {
  on, off, status, limits, codex: codexCommand, sync: syncCommand, caveman: cavemanCommand,
  update: updateCommand, transfer: transferCommand, statusline: statuslineCommand, prefer: preferCommand,
  report, coldguard: coldguardCommand, handoff: handoffPath, enforce: enforceCommand,
};

(async () => {
  const run = COMMANDS[cmd];
  if (!run) {
    console.log(`Unknown command "${cmd}". Commands: ${Object.keys(COMMANDS).join(', ')}.`);
    return;
  }
  try {
    await run(args);
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
})();

// Flip a boolean feature flag from an "on"/"off" argument. Returns true when
// the argument was handled.
function toggle(key, label, arg) {
  if (arg !== 'on' && arg !== 'off') return false;
  state[key] = arg === 'on';
  st.writeState(state);
  console.log(`${label}: ${arg}.`);
  return true;
}

async function on() {
  state.enabled = true;
  st.writeState(state);
  console.log('Jev router: ON');
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('WARNING: OPENROUTER_API_KEY is not set in this shell, so the router stays silent. Add it to your shell profile and restart Claude Code.');
  }
  console.log('While on, your message text is sent to OpenRouter/TypeSafe for sizing. Turn it off for private work: /mynameisjev:off');
  if (state.sync) print(await sync.ensureAll({ withCaveman: state.caveman }));
}

async function off() {
  state.enabled = false;
  st.writeState(state);
  console.log('Jev router: OFF');
}

async function status() {
  const s = state.stats;
  const total = s.tiny + s.everyday + s.large + s.hardest + s.unsure + s.skipped + s.failed;
  const available = codex.codexAvailable();
  print([
    `Jev router: ${state.enabled ? 'ON' : 'OFF'}`,
    'Messages sized:',
    `  tiny (haiku):     ${s.tiny}`,
    `  everyday (sonnet):${s.everyday}`,
    `  large (opus):     ${s.large}`,
    `  hardest (opus):   ${s.hardest}`,
    `  unsure (<60%):    ${s.unsure}`,
    `  skipped (short):  ${s.skipped}`,
    `  failed (error):   ${s.failed}`,
    `  total seen:       ${total}`,
    // These overlap the size counts above, so they stay out of the total.
    `Topic shifts flagged: ${s.shift}`,
    `Delegation notes suppressed (no gain): ${s.suppressed}`,
    `Jev cost so far: $${state.cost.toFixed(6)}`,
  ]);
  if (state.lastSilent) console.log(`Last silent: ${state.lastSilent.reason} (${state.lastSilent.at})`);
  const project = st.readProjectConfig(st.projectDir(process.cwd()));
  if (project) {
    console.log(project.error
      ? `Project config: ${project.path} is not usable (${project.error}); sizing is off here until it is fixed.`
      : `Project config: ${project.path}: sizing ${project.router ? 'on' : 'off'}${project.prefer ? `, prefer ${project.prefer}` : ''}`);
  }

  console.log(`Codex: ${available ? 'available' : 'not available (needs the codex plugin enabled and the codex CLI on PATH)'}`);
  if (available) {
    console.log(`Prefer: ${state.prefer} (/mynameisjev:prefer codex | claude)`);
    console.log(`Routed to Codex: ${s.codex}`);
    console.log(`Auto-transfer: ${onOff(state.autoTransfer)}, transfers so far: ${s.transfers}` +
      (state.lastTransfer ? ` (latest: codex resume ${state.lastTransfer.threadId})` : ''));
  }

  console.log(`Features: caveman ${onOff(state.caveman)}, sync ${onOff(state.sync)}, daily update check ${onOff(state.updates)}, cold-cache guard ${onOff(state.coldGuard)}, enforce hand-offs ${onOff(state.enforce)}`);
  if (state.caveman) console.log(`Caveman: Claude ${caveman.claudeStatus()}${available ? `, Codex ${caveman.codexStatus()}` : ''}`);
  if (state.sync) {
    const rtk = sync.rtkStatus();
    const yn = (b) => (b ? 'active' : 'missing');
    console.log(`RTK: binary ${rtk.binary ? 'found' : 'missing'}, Claude hook ${yn(rtk.claudeHook)}${available ? `, Codex rules ${yn(rtk.codexRules)}` : ''}`);
    if (available) console.log(`Codex AGENTS.md: ${sync.agentsStatus({ withCaveman: state.caveman })}`);
    for (const p of await plugins.requiredStatus()) {
      const name = `${p.name[0].toUpperCase()}${p.name.slice(1)}`;
      const claudeSide = `Claude ${p.claude}${p.claudeVersion ? ` ${p.claudeVersion}` : ''}`;
      console.log(`${name}: ${claudeSide}${available ? `, Codex ${p.codex}${p.codexVersion ? ` ${p.codexVersion}` : ''}` : ''}`);
    }
  }
  statusLineOverrideWarnings().forEach((w) => console.log(w));
  if (state.updates) {
    const found = updates.readCache();
    console.log(`Updates: ${found ? `${found.updates.length} available, checked ${new Date(found.checkedAt).toLocaleString()}` : 'not checked yet'}`);
  }
}

// What the router did and what it saved: notes given vs hand-offs that ran,
// and the tokens the helper subagents used per model.
async function report() {
  const s = state.stats;
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const calls = s.tiny + s.everyday + s.large + s.hardest + s.unsure;
  print([
    `Jev calls: ${calls}, cost $${state.cost.toFixed(6)}${calls > 0 ? ` ($${(state.cost / calls).toFixed(6)} each)` : ''}`,
    'Hand-offs (notes given / runs):',
    `  Claude helpers:   ${s.helper} / ${s.helperRuns}`,
    `  Codex:            ${s.codex} / ${s.codexRuns}`,
    `  "+" overrides:    ${s.forced}`,
    `  subagent models set by enforce: ${s.enforced}`,
    `  turns ended at the usage limit: ${s.limitHits}`,
    `  notes suppressed (no gain): ${s.suppressed}`,
    `Topic shifts flagged: ${s.shift}`,
  ]);
  const families = Object.keys(state.helperTokens);
  if (families.length === 0) {
    console.log('Helper subagent tokens: none recorded yet.');
  } else {
    console.log('Helper subagent tokens (from their transcripts):');
    for (const f of families) {
      const t = state.helperTokens[f];
      console.log(`  ${f.padEnd(7)} ${String(t.runs).padStart(4)} runs   input ${fmt(t.input)}, cache write ${fmt(t.cacheWrite)}, cache read ${fmt(t.cacheRead)}, output ${fmt(t.output)}`);
    }
  }
  print([
    'Runs count every mynameisjev:* subagent and Codex task, including ones started without a Jev note.',
    'Codex tasks bill your ChatGPT plan, so their tokens are not counted here.',
  ]);
}

function fmtWindow(label, pct, resetsAt) {
  const when = Number.isFinite(resetsAt) ? new Date(resetsAt * 1000).toLocaleString() : 'unknown';
  return `  ${label.padEnd(8)}${String(Math.round(pct)).padStart(3)}%   resets ${when}`;
}

async function limits() {
  console.log('Claude (from the status line):');
  let claude = null;
  try { claude = JSON.parse(fs.readFileSync(path.join(st.dataDir, 'claude-limits.json'), 'utf8')); } catch (e) { /* none yet */ }
  if (!claude) {
    console.log('  not recorded yet (needs a Claude subscription and the mynameisjev status line; see /mynameisjev:statusline)');
  } else {
    if (claude.five_hour) console.log(fmtWindow('5h', claude.five_hour.used_percentage, claude.five_hour.resets_at));
    if (claude.seven_day) console.log(fmtWindow('7d', claude.seven_day.used_percentage, claude.seven_day.resets_at));
  }

  if (!codex.codexAvailable()) {
    console.log('Codex: not available (needs the codex plugin enabled and the codex CLI on PATH).');
    return;
  }
  console.log('Codex (live):');
  const cache = await codex.refreshCache();
  const l = cache.limits;
  if (l.primary) console.log(fmtWindow('5h', l.primary.usedPercent, l.primary.resetsAt));
  if (l.secondary) console.log(fmtWindow('weekly', l.secondary.usedPercent, l.secondary.resetsAt));
  console.log(`  plan: ${l.planType || 'unknown'}${l.reachedType ? `, limit reached (${l.reachedType})` : ''}`);
  const TH = require('./jev-router').THRESHOLDS;
  print([
    `Routing: self-contained coding work goes to Codex while Codex is under ${TH.codexMax}%.`,
    `From ${TH.route}% Claude usage, work moves to Codex (whole tasks, or their self-contained steps);`,
    `at ${TH.transfer}% Jev warns and suggests /codex:transfer` +
      (state.autoTransfer ? `; from ${TH.auto}% it copies the session into Codex.` : '.'),
    'Usage is also checked after each tool call, so a long turn crossing a threshold is caught mid-turn.',
  ]);
}

async function codexCommand([sub = 'show', tier, model, effort]) {
  if (!codex.codexAvailable()) throw new Error('Codex is not available (needs the codex plugin enabled and the codex CLI on PATH).');
  const cache = await codex.refreshCache();
  if (sub === 'reset') {
    state.codexTiers = {};
    st.writeState(state);
    console.log('Codex tier models reset to defaults.');
  } else if (sub === 'set') {
    if (!codex.DEFAULT_TIERS[tier]) throw new Error(`tier must be one of: ${Object.keys(codex.DEFAULT_TIERS).join(', ')}`);
    if (!model) throw new Error('usage: /mynameisjev:codex set <tier> <model> [effort]');
    const ids = cache.models.map((m) => m.id);
    if (!ids.includes(model)) throw new Error(`unknown model "${model}". Available: ${ids.join(', ')}`);
    if (effort && !codex.TASK_EFFORTS.includes(effort)) throw new Error(`effort must be one of: ${codex.TASK_EFFORTS.join(', ')}`);
    state.codexTiers = { ...state.codexTiers, [tier]: effort ? { model, effort } : { model } };
    st.writeState(state);
    console.log(`Codex ${tier} -> ${model}${effort ? ` (${effort})` : ''}`);
  } else if (sub !== 'show') {
    throw new Error('usage: /mynameisjev:codex [show | set <tier> <model> [effort] | reset]');
  }
  console.log('Codex model per Jev size:');
  for (const t of Object.keys(codex.DEFAULT_TIERS)) {
    const c = codex.tierChoice(t, state.codexTiers, cache);
    console.log(`  ${t.padEnd(9)}${c.model || 'Codex default'}, effort ${c.effort || 'default'}${state.codexTiers[t] ? ' (custom)' : ''}`);
  }
  console.log('Available Codex models:');
  for (const m of cache.models) console.log(`  ${m.id}${m.isDefault ? ' (default)' : ''}: ${m.description}`);
}

async function syncCommand([arg]) {
  if (toggle('sync', 'Sync', arg) && !state.sync) return;
  if (arg && arg !== 'on') throw new Error('usage: /mynameisjev:sync [on | off]');
  if (!state.sync) {
    console.log('Sync is off; turn it on with /mynameisjev:sync on. It generates ~/.codex/AGENTS.md from ~/.claude/CLAUDE.md (replacing the current file, with one backup) and installs missing caveman, superpowers and RTK setup.');
    return;
  }
  print(await sync.ensureAll({ withCaveman: state.caveman }));
}

async function cavemanCommand([arg]) {
  if (!toggle('caveman', 'Caveman', arg)) {
    console.log(`Caveman: ${onOff(state.caveman)}. Claude plugin ${caveman.claudeStatus()}${codex.codexAvailable() ? `, Codex ${caveman.codexStatus()}` : ''}. usage: /mynameisjev:caveman [on | off]`);
    return;
  }
  if (!state.caveman) {
    const result = state.sync ? sync.syncAgents({ withCaveman: false }) : 'sync off, AGENTS.md unchanged';
    console.log(`Codex caveman block removed (${result}). The Claude plugin stays installed; disable it with /plugin if wanted.`);
    return;
  }
  console.log(`Claude ${await caveman.installClaude()}`);
  if (state.sync) console.log(`Codex AGENTS.md: ${sync.syncAgents({ withCaveman: true })}`);
  else console.log('Codex: turn on /mynameisjev:sync to add caveman to ~/.codex/AGENTS.md.');
}

async function preferCommand([arg]) {
  if (arg === 'codex' || arg === 'claude') {
    state.prefer = arg;
    st.writeState(state);
  } else if (arg) {
    throw new Error('usage: /mynameisjev:prefer [codex | claude]');
  }
  if (state.prefer === 'codex') {
    console.log('Prefer: codex. Self-contained work goes to Codex at any Claude usage, and Claude hands the self-contained steps of other work to Codex while it coordinates.');
    console.log('Tiny one-line jobs stay on Claude, and work falls back to Claude while Codex is near its limit.');
    if (!codex.codexAvailable()) console.log('WARNING: Codex is not available (needs the codex plugin enabled and the codex CLI on PATH), so work stays on Claude until it is.');
  } else {
    console.log('Prefer: claude. Work goes to Codex only for self-contained coding tasks, or once Claude usage passes the routing threshold.');
  }
}

async function enforceCommand([arg]) {
  if (toggle('enforce', 'Enforce hand-offs', arg)) return;
  if (arg) throw new Error('usage: /mynameisjev:enforce [on | off]');
  console.log(`Enforce hand-offs: ${onOff(state.enforce)}. When on and Jev suggested a Claude helper for the message, a general-purpose subagent Claude starts without choosing a model runs on that helper's model. usage: /mynameisjev:enforce [on | off]`);
}

async function coldguardCommand([arg]) {
  if (toggle('coldGuard', 'Cold-cache guard', arg)) return;
  if (arg) throw new Error('usage: /mynameisjev:coldguard [on | off]');
  console.log(`Cold-cache guard: ${onOff(state.coldGuard)}. When on, the first message after the prompt cache expired on a context of 100k tokens or more is blocked once, so you can /compact or /clear first; sending it again goes through. Needs the mynameisjev status line. usage: /mynameisjev:coldguard [on | off]`);
}

// A new file for /mynameisjev:handoff to write, outside the project so it is
// never committed: <data dir>/handoffs/<project>-<YYYYMMDD-HHMMSS>.md.
async function handoffPath() {
  const dir = st.projectDir(process.cwd());
  const name = path.basename(dir || 'session').replace(/[^A-Za-z0-9._-]/g, '-') || 'session';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const folder = path.join(st.dataDir, 'handoffs');
  fs.mkdirSync(folder, { recursive: true });
  console.log(path.join(folder, `${name}-${stamp}.md`));
}

async function transferCommand([arg]) {
  if (toggle('autoTransfer', 'Auto-transfer', arg)) {
    if (state.autoTransfer && !codex.codexAvailable()) console.log('Note: Codex is not available, so nothing is transferred until it is.');
    return;
  }
  console.log(`Auto-transfer: ${onOff(state.autoTransfer)}. From 90% Claude usage, copies the session into a new Codex thread on every prompt and shows the codex resume command. usage: /mynameisjev:transfer [on | off]`);
}

async function updateCommand([arg]) {
  if (toggle('updates', 'Daily update check', arg)) return;
  if (arg === '--check') {
    console.log('Checking (refreshes third-party marketplaces, may take a minute)...');
    const r = await updates.runCheck();
    if (r.updates.length === 0) console.log('Everything checked is up to date.');
    r.updates.forEach((u) => console.log(`  ${updates.describe(u)}`));
    (r.missing || []).forEach((m) => console.log(`  not active: ${m} (run /mynameisjev:sync)`));
    r.errors.forEach((e) => console.log(`  check failed: ${e}`));
    return;
  }
  if (arg) throw new Error('usage: /mynameisjev:update [--check | on | off]');
  const lines = await updates.applyUpdates();
  print(lines);
  if (lines.some((l) => l.startsWith('updated'))) {
    // A caveman update changes the rules Codex's AGENTS.md is built from.
    if (state.sync) console.log(`Codex AGENTS.md: ${sync.syncAgents({ withCaveman: state.caveman })}`);
    // Claude Code offers no way for a script or hook to trigger a plugin
    // reload, so this step stays with the user.
    console.log('Claude Code: run /reload-plugins (or restart) to load updated plugins; new sessions load them automatically.');
    if (codex.codexAvailable()) console.log('Codex: open interactive codex sessions keep the old versions until restarted.');
  }
}

// Plugins cannot set the main status line, so `install` writes a small
// launcher into the data directory (its path survives plugin updates, unlike
// the plugin's versioned install path) and points settings.json at it. The
// previous statusLine setting is kept in state and restored by `uninstall`.
// `wrap` installs the same launcher but has it print the previous status
// line's output, so Jev still gets the usage and cache data it records.
// The previous setting is also kept in a file next to settings.json, so
// `uninstall` can restore it after the data directory is gone.
async function statuslineCommand([arg, flag]) {
  // Seconds between timed re-renders of Jev's own status line.
  const refreshInterval = 60;
  const settingsPath = path.join(st.claudeDir, 'settings.json');
  const backupPath = path.join(st.claudeDir, 'statusline.jev-backup.json');
  const settings = readSettings(settingsPath);
  const launcher = st.dataFile('statusline.js');
  // Windows runs status line commands through Git Bash or PowerShell; Git Bash
  // strips unquoted backslashes, so give it a forward-slash absolute path.
  const home = os.homedir();
  const command = process.platform === 'win32'
    ? `node "${launcher.replace(/\\/g, '/')}"`
    : `node "${launcher.startsWith(home) ? `$HOME${launcher.slice(home.length)}` : launcher}"`;
  const current = settings.statusLine || null;
  const installed = !!current && current.command === command;
  // The user's own status line: the saved one while ours is installed.
  const previous = installed ? savedPrevious(backupPath) : current;

  if (flag && !(arg === 'wrap' && flag === '--with-jev')) {
    throw new Error('usage: /mynameisjev:statusline [install | wrap [--with-jev] | uninstall]');
  }
  if (arg === 'install' || arg === 'wrap') {
    if (arg === 'wrap' && !(previous && typeof previous.command === 'string' && previous.command.trim())) {
      throw new Error('there is no status line of your own to wrap. Set one in settings.json first, or use /mynameisjev:statusline install for the Jev status line.');
    }
    writeLauncher(launcher);
    writeJsonAtomic(backupPath, { note: 'Your statusLine setting before /mynameisjev:statusline install; uninstall restores it.', statusLine: previous || null });
    state.previousStatusLine = previous || null;
    state.statusLineMode = arg === 'wrap' ? 'wrap' : 'full';
    state.statusLineJev = arg === 'wrap' && flag === '--with-jev';
    st.writeState(state);
    // Wrap keeps the wrapped setting's other fields (padding, refreshInterval).
    // Jev's own refreshes on a timer too, so the Codex line and the cache
    // countdown stay current while the session is idle.
    settings.statusLine = arg === 'wrap'
      ? { ...previous, type: 'command', command }
      : { type: 'command', command, refreshInterval };
    writeJsonAtomic(settingsPath, settings);
    if (arg === 'wrap') {
      console.log(`Status line: wrapping your own (${previous.command})${state.statusLineJev ? ', with the JEV segment on its own line' : ''}. Jev records usage and cache data from it; /mynameisjev:statusline uninstall restores it unwrapped.`);
    } else {
      console.log(installed
        ? 'Status line: Jev status line installed (launcher refreshed).'
        : `Status line installed.${previous ? ' Your previous status line is saved; /mynameisjev:statusline uninstall restores it, and /mynameisjev:statusline wrap keeps it with Jev\'s data recording.' : ''}`);
    }
    const problem = checkLauncher(launcher);
    if (problem) console.log(`WARNING: the status line did not render (${problem}). Run /reload-plugins or reinstall the plugin, then /mynameisjev:statusline ${arg} again.`);
  } else if (arg === 'uninstall') {
    if (!installed) {
      console.log('The mynameisjev status line is not the active one; nothing changed.');
    } else {
      const restore = savedPrevious(backupPath);
      if (restore) settings.statusLine = restore;
      else delete settings.statusLine;
      writeJsonAtomic(settingsPath, settings);
      fs.rmSync(backupPath, { force: true });
      state.previousStatusLine = null;
      state.statusLineMode = null;
      state.statusLineJev = false;
      st.writeState(state);
      console.log('Status line removed; the previous one is restored.');
    }
  } else if (arg) {
    throw new Error('usage: /mynameisjev:statusline [install | wrap [--with-jev] | uninstall]');
  } else {
    const mode = !installed ? 'not installed'
      : state.statusLineMode === 'wrap' ? `installed, wrapping your own (${(previous || {}).command})${state.statusLineJev ? ' with the JEV segment' : ''}`
        : 'installed';
    console.log(`Status line: ${mode}. usage: /mynameisjev:statusline [install | wrap [--with-jev] | uninstall]`);
  }
  statusLineOverrideWarnings().forEach((w) => console.log(w));
}

// settings.json as an object; {} when it doesn't exist yet. Any other read
// or parse error stops the command, so a file we can't read is never replaced.
function readSettings(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`cannot read ${settingsPath}: ${e.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) {
    throw new Error(`${settingsPath} is not valid JSON (${e.message}); fix it, then run this again`);
  }
  throw new Error(`${settingsPath} does not hold a JSON object; fix it, then run this again`);
}

// The status line setting saved at install: the backup file when it exists
// (it survives the data directory being deleted), else the copy in state.
function savedPrevious(backupPath) {
  try {
    return JSON.parse(fs.readFileSync(backupPath, 'utf8')).statusLine || null;
  } catch (e) {
    return state.previousStatusLine || null;
  }
}

// Replace a JSON file in one step (write a temp file, then rename), so a
// concurrent reader never sees half a file and a failed write leaves the old
// one. Writes through a symlink to its target, keeping dotfile setups intact.
function writeJsonAtomic(file, value) {
  let target = file;
  try { target = fs.realpathSync(file); } catch (e) { /* new file */ }
  const tmp = `${target}.jev-tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Renders the status line once with sample input. Returns why it failed, or
// null when it printed something other than the launcher's error.
function checkLauncher(launcher) {
  const sample = JSON.stringify({ model: { display_name: 'Claude' }, workspace: { current_dir: process.cwd() }, cwd: process.cwd() });
  try {
    const out = execFileSync(process.execPath, [launcher], { input: sample, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] });
    if (!out.trim()) return 'it printed nothing';
    if (out.includes('mynameisjev status line: plugin not found')) return 'the installed mynameisjev plugin was not found';
    return null;
  } catch (e) {
    return e.killed ? 'it timed out' : `exit ${e.status}`;
  }
}

function writeLauncher(launcher) {
  fs.writeFileSync(launcher, `// Written by /mynameisjev:statusline install. Loads the status line from the
// currently installed mynameisjev plugin version.
const fs = require('fs');
const path = require('path');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
try {
  const plugins = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins;
  require(path.join(plugins['${st.PLUGIN_ID}'][0].installPath, 'scripts', 'cc-statusline.js'));
} catch (e) {
  process.stdout.write('mynameisjev status line: plugin not found');
}
`);
}

// Project settings take precedence over ~/.claude/settings.json, so a
// statusLine set there hides Jev's and the data it records for the router.
function statusLineOverrideWarnings() {
  const dir = st.projectDir(process.cwd());
  if (!dir) return [];
  const warnings = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(dir, '.claude', name);
    if (path.resolve(file) === path.resolve(st.claudeDir, 'settings.json')) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
    if (parsed && parsed.statusLine) {
      warnings.push(`WARNING: ${file} sets its own statusLine, which takes precedence in this project, so Jev's status line and the usage data the router needs are not recorded here. Remove it there to use Jev's.`);
    }
  }
  return warnings;
}
