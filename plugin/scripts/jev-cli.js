#!/usr/bin/env node
// jev-cli — backs the /mynameisjev:* commands: on/off/status, Claude and Codex
// usage limits, the Codex model per size tier, and the opt-in features
// (caveman, sync, updates, auto-transfer, status line).

const fs = require('fs');
const path = require('path');
const os = require('os');
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
  update: updateCommand, transfer: transferCommand, statusline: statuslineCommand,
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

  console.log(`Codex: ${available ? 'available' : 'not available (needs the codex plugin enabled and the codex CLI on PATH)'}`);
  if (available) {
    console.log(`Routed to Codex: ${s.codex}`);
    console.log(`Auto-transfer: ${onOff(state.autoTransfer)}, transfers so far: ${s.transfers}` +
      (state.lastTransfer ? ` (latest: codex resume ${state.lastTransfer.threadId})` : ''));
  }

  console.log(`Features: caveman ${onOff(state.caveman)}, sync ${onOff(state.sync)}, daily update check ${onOff(state.updates)}`);
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
  if (state.updates) {
    const found = updates.readCache();
    console.log(`Updates: ${found ? `${found.updates.length} available, checked ${new Date(found.checkedAt).toLocaleString()}` : 'not checked yet'}`);
  }
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
async function statuslineCommand([arg]) {
  const settingsPath = path.join(st.claudeDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const launcher = st.dataFile('statusline.js');
  // Windows runs status line commands through Git Bash or PowerShell; Git Bash
  // strips unquoted backslashes, so give it a forward-slash absolute path.
  const home = os.homedir();
  const command = process.platform === 'win32'
    ? `node "${launcher.replace(/\\/g, '/')}"`
    : `node "${launcher.startsWith(home) ? `$HOME${launcher.slice(home.length)}` : launcher}"`;
  const installed = settings.statusLine && settings.statusLine.command === command;

  if (arg === 'install') {
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
    if (!installed) {
      state.previousStatusLine = settings.statusLine || null;
      st.writeState(state);
      settings.statusLine = { type: 'command', command };
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
    console.log(installed ? 'Status line already installed (launcher refreshed).' : 'Status line installed. Your previous status line is saved; /mynameisjev:statusline uninstall restores it.');
  } else if (arg === 'uninstall') {
    if (!installed) {
      console.log('The mynameisjev status line is not the active one; nothing changed.');
      return;
    }
    if (state.previousStatusLine) settings.statusLine = state.previousStatusLine;
    else delete settings.statusLine;
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    state.previousStatusLine = null;
    st.writeState(state);
    console.log('Status line removed; the previous one is restored.');
  } else {
    console.log(`Status line: ${installed ? 'installed' : 'not installed'}. usage: /mynameisjev:statusline [install | uninstall]`);
  }
}
