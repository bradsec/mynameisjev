#!/usr/bin/env node
// jev-router — UserPromptSubmit hook. Asks Jev (typesafe/jev-1.13 via OpenRouter)
// how big each message is, and leaves a note for Claude when a pinned helper
// agent (mynameisjev:tiny/everyday/large) would help: a cheaper model than the
// session's, a stronger one, or the same model keeping bulky output out of the
// main context. In the same call it asks whether the message starts a new task
// unrelated to the previous prompt in this session, and if so tells the user
// /clear would help.
//
// Codex (via the codex plugin) is a second route: self-contained coding work,
// or any self-contained work once Claude's plan usage passes CLAUDE_ROUTE_PCT,
// goes to a Codex model picked by size (jev-codex.js), while Codex has
// headroom. Near Claude's limit the user is told about /codex:transfer, and
// from AUTO_TRANSFER_PCT the router runs the transfer itself on every prompt.
//
// A leading "+tiny", "+everyday", "+large", "+hardest", "+codex[:<size>]" or
// "+claude" on a message routes it without a Jev call (see parseOverride).
// A project's .claude/mynameisjev.json can turn sizing off or set the
// Codex preference for that project (jev-state.js readProjectConfig).
//
// Contract: never blocks, never slows the prompt down noticeably, and stays
// silent on any error (missing key, network failure, bad response, timeout).
// Silent outcomes are recorded in state.lastSilent so `/mynameisjev:status` can tell
// an error apart from a low-confidence result. Reasons never include prompt
// text; the only prompt text stored is state.lastPrompt (see PREVIOUS_CHARS).
// Likely secrets are stripped (jev-redact.js) from everything sent or stored.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const st = require('./jev-state');
const codex = require('./jev-codex');
const caveman = require('./jev-caveman');
const sync = require('./jev-sync');
const updates = require('./jev-updates');
const { redact } = require('./jev-redact');

// Written by the jev-model-switch PostModelSwitch hook.
const modelsPath = path.join(st.dataDir, 'session-models.json');
// Written by the status line (cc-statusline.js): Claude's 5h/7d plan usage.
const claudeLimitsPath = path.join(st.dataDir, 'claude-limits.json');
// Claude plan usage at which work moves to Codex, and at which the user is
// told to hand the whole session over with /codex:transfer. Set well below
// 100%: one long Claude turn can use 10% or more of a 5-hour window, and at
// 100% Claude can't act at all, not even to hand work over.
const CLAUDE_ROUTE_PCT = 80;
const CLAUDE_TRANSFER_PCT = 85;
// From here the router copies the session into Codex on every prompt (and
// the usage watch once mid-turn), so an up-to-date `codex resume` target
// exists when Claude stops answering.
const AUTO_TRANSFER_PCT = 90;
// Runs alongside the Jev call inside the 5s hook timeout; a 2.3MB transcript
// transfers in about 0.4s.
const TRANSFER_TIMEOUT_MS = 4000;
// Codex usage above which Codex stops taking routed work.
const CODEX_MAX_PCT = 85;
// Older Codex caches are not trusted for routing (background refresh runs
// every CACHE_MAX_AGE_MS while prompts arrive).
const CODEX_CACHE_USABLE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 3000;
// A shift notice interrupts the user, so only fire when Jev is confident.
const SHIFT_THRESHOLD = 0.8;
// The previous prompt is kept in the local state file (and sent to Jev with
// the next prompt), so store only enough to judge topic.
const PREVIOUS_CHARS = 1000;
// Yes/no answers at or above this count as yes for the delegation checks.
const NOUL_THRESHOLD = 0.5;
// Enough transcript tail to hold the last assistant entry; entries carrying
// large tool results can run to tens of KB.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

const readState = st.readState;

// The hook never fails a prompt over a state write.
function writeState(state) {
  try {
    st.writeState(state);
  } catch (e) {
    // best-effort only
  }
}

function recordSilent(state, counter, reason) {
  state.stats[counter] += 1;
  state.lastSilent = { at: new Date().toISOString(), reason };
  writeState(state);
}

// Tier -> the plugin's pinned helper agent (agents/*.md, namespaced by the
// plugin as mynameisjev:<name>) and its model. Hardest shares the opus helper.
const TIER_INFO = {
  tiny: { agent: 'mynameisjev:tiny', model: 'haiku' },
  everyday: { agent: 'mynameisjev:everyday', model: 'sonnet' },
  large: { agent: 'mynameisjev:large', model: 'opus' },
  hardest: { agent: 'mynameisjev:large', model: 'opus' },
};

// Cost/capability order of model families.
const MODEL_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

function modelFamily(model) {
  if (typeof model !== 'string') return null;
  return Object.keys(MODEL_RANK).find((f) => model.includes(f)) || null;
}

// UserPromptSubmit input carries no model field, so read it from the newest
// main-thread assistant entry in the transcript. Returns { family, at } with
// family a MODEL_RANK key and at the entry's epoch ms, or null when unknown
// (new session, unreadable transcript).
function transcriptModel(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // The first line may be cut mid-entry; its JSON.parse fails and is skipped.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
      if (entry.type !== 'assistant' || entry.isSidechain) continue;
      const family = modelFamily(entry.message && entry.message.model);
      if (family) return { family, at: Date.parse(entry.timestamp) || 0 };
      // e.g. "<synthetic>" error entries: keep looking further back.
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The session's current model family. A /model switch recorded by the
// jev-model-switch hook wins when it is newer than the transcript's last
// reply, which covers the prompt right after a switch, before the new model
// has replied.
function sessionModelFamily(sessionId, transcriptPath) {
  const fromTranscript = transcriptModel(transcriptPath);
  let switched = null;
  try {
    const record = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))[sessionId];
    const family = record && modelFamily(record.model);
    if (family) switched = { family, at: Date.parse(record.at) || 0 };
  } catch (e) {
    // No switch recorded yet.
  }
  if (switched && (!fromTranscript || switched.at > fromTranscript.at)) return switched.family;
  return fromTranscript ? fromTranscript.family : null;
}

// Decide whether a delegation note is worth adding. Returns the note text, or
// { suppress: reason } when handing off would not pay for itself.
function delegationAdvice(tier, result, sessionFamily) {
  const info = TIER_INFO[tier];
  const head = `Jev sized this message as ${tier.toUpperCase()} (confidence ${result.confidence.toFixed(2)}).`;
  const contained = result.contained === null || result.contained >= NOUL_THRESHOLD;
  const heavy = result.heavy !== null && result.heavy >= NOUL_THRESHOLD;

  if (!contained) return { suppress: `${tier}: needs the conversation's context, not self-contained` };
  // A subagent starts with an empty cache and re-derives context, which costs
  // more than a one-line job saves.
  if (tier === 'tiny' && !heavy) return { suppress: 'tiny: subagent start-up costs more than it saves' };

  if (!sessionFamily) {
    return `${head} Session model unknown. If this is self-contained work, consider delegating it to the "${info.agent}" subagent (${info.model}).`;
  }
  const agentRank = MODEL_RANK[info.model];
  const sessionRank = MODEL_RANK[sessionFamily];
  if (agentRank < sessionRank) {
    return `${head} The "${info.agent}" subagent (${info.model}) is cheaper than this session's ${sessionFamily} and fits the job; consider delegating it.`;
  }
  if (agentRank > sessionRank) {
    return `${head} The "${info.agent}" subagent (${info.model}) is stronger than this session's ${sessionFamily}; delegate it if quality matters more than cost.`;
  }
  if (heavy) {
    return `${head} "${info.agent}" runs the same model as this session (${sessionFamily}), so it saves no cost, but delegating keeps this task's bulky intermediate output out of the main context.`;
  }
  return { suppress: `${tier}: same model as session (${sessionFamily}), little output to isolate` };
}

// Highest Claude plan usage across the 5h and 7d windows, as saved by the
// status line, or null when unknown (API-key sessions have no plan limits).
function claudePeak() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(claudeLimitsPath, 'utf8'));
  } catch (e) {
    return null;
  }
  const nowSec = Date.now() / 1000;
  let peak = null;
  for (const [name, w] of [['5h', saved.five_hour], ['7d', saved.seven_day]]) {
    if (!w || !Number.isFinite(w.used_percentage)) continue;
    // A window whose reset time has passed has started over.
    const pct = Number.isFinite(w.resets_at) && w.resets_at < nowSec ? 0 : w.used_percentage;
    if (!peak || pct > peak.pct) peak = { pct, window: name, resetsAt: w.resets_at };
  }
  return peak;
}

function fmtReset(epochSec, withDay) {
  if (!Number.isFinite(epochSec)) return 'unknown';
  const d = new Date(epochSec * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return withDay ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}` : hm;
}

// Whether Codex can take work now, with a short status for notices. An old
// or missing cache counts as unavailable: routing to a Codex that turns out
// to be at its limit wastes the hand-off.
// available is false when Codex isn't set up (see codex.codexAvailable); then
// notices leave Codex out entirely instead of reporting it missing.
function codexStatus(cache) {
  if (!codex.codexAvailable()) return { ok: false, available: false, text: '' };
  const unknown = (why) => ({ ok: false, available: true, text: why });
  if (!cache || Date.now() - cache.at > CODEX_CACHE_USABLE_MS) return unknown('Codex usage not known yet');
  if (cache.error) return unknown(`Codex usage unavailable (${cache.error})`);
  const l = cache.limits || {};
  const five = l.primary ? `${Math.round(l.primary.usedPercent)}%` : '?';
  const week = l.secondary ? `${Math.round(l.secondary.usedPercent)}%` : '?';
  const text = `Codex 5h ${five}, weekly ${week}`;
  if (!l.ordinaryUsageAllowed || l.reachedType) return { ok: false, available: true, text: `${text}, Codex limit reached` };
  const peak = codex.codexPeak(cache);
  if (peak && peak.pct >= CODEX_MAX_PCT) return { ok: false, available: true, text: `${text}, Codex near its limit` };
  return { ok: true, available: true, text };
}

// Where the current message is headed, for the status line: the session's
// own Claude model, or a suggested Claude helper / Codex model.
// jev-usage-watch.js upgrades a suggestion to how: 'ran' when it runs.
function setRoute(state, target, model, how) {
  state.route = { at: new Date().toISOString(), target, model: model || 'claude', how };
}

// Choose between Codex, a Claude helper, and no note. Codex takes
// self-contained work when it has headroom and either Claude is running low
// or the task is coding (Codex bills a separate ChatGPT-plan quota). Returns
// { note, codex } or { suppress: reason }.
function routeAdvice(tier, result, ctx) {
  const contained = result.contained === null || result.contained >= NOUL_THRESHOLD;
  const heavy = result.heavy !== null && result.heavy >= NOUL_THRESHOLD;
  const coding = result.coding !== null && result.coding >= NOUL_THRESHOLD;

  const companion = codex.companionPath();
  // Codex first: Claude's usage is past the routing threshold, or the user
  // turned prefer-Codex mode on.
  const codexFirst = ctx.claudeLow || ctx.preferCodex;
  // Work that needs this conversation can't move to Codex whole, but its
  // self-contained steps can: with Codex first, that is the note to give.
  if (!contained && codexFirst && ctx.codexNow.ok && companion) {
    return { note: subStepAdvice(ctx.claudeLow ? ctx.claude : null, companion), codex: true, model: 'steps' };
  }
  if (contained && ctx.codexNow.ok && companion && (codexFirst || coding)) {
    // Same start-up argument as for Claude helpers: a one-line job is
    // cheaper done in place than handed off.
    if (tier === 'tiny' && !heavy) return { suppress: 'tiny: hand-off costs more than it saves' };
    const reason = ctx.claudeLow
      ? `Claude ${ctx.claude.window} usage at ${Math.round(ctx.claude.pct)}%`
      : ctx.preferCodex ? 'prefer-Codex mode is on'
        : 'self-contained coding task; Codex uses a separate quota';
    const choice = codex.tierChoice(tier, ctx.overrides, ctx.codexCache);
    return { note: codexAdvice(tier, result, reason, choice, companion), codex: true, model: choice.model || 'default' };
  }

  const advice = delegationAdvice(tier, result, ctx.sessionFamily);
  return typeof advice === 'string' ? { note: advice, codex: false, model: TIER_INFO[tier].model } : advice;
}

// Note for Claude when its plan usage is high but the message can't go to
// Codex whole: keep coordinating here, send the self-contained steps there.
// `claude` is the usage peak when that is the reason, or null in prefer-Codex
// mode.
function subStepAdvice(claude, companion) {
  const why = claude
    ? `Jev: Claude ${claude.window} usage is at ${Math.round(claude.pct)}% (resets ${fmtReset(claude.resetsAt, claude.window === '7d')}). `
    : 'Jev: prefer-Codex mode is on. ';
  return why +
    'Keep coordination and decisions here, but hand each self-contained step (tests, file edits, searches, reviews, research) to Codex ' +
    `with one Bash call: node "${companion.replace(/\\/g, '/')}" task "<the step, with the context it needs>" (add --write if it should edit files). ` +
    'Keep your own replies short.';
}

// User notice once Claude usage crosses a threshold, or null below it. The
// key identifies window, reset and level so each crossing is announced once.
function limitNoticeFor(claude, codexNow, autoTransferOn) {
  if (!claude || claude.pct < CLAUDE_ROUTE_PCT) return null;
  // With auto-transfer on, the per-prompt transfer notice takes over here.
  if (autoTransferOn && codexNow.available && claude.pct >= AUTO_TRANSFER_PCT) return null;
  const level = claude.pct >= CLAUDE_TRANSFER_PCT ? 'transfer' : 'route';
  const head = `Jev: Claude ${claude.window} usage at ${Math.round(claude.pct)}% ` +
    `(resets ${fmtReset(claude.resetsAt, claude.window === '7d')}).` +
    (codexNow.available ? ` ${codexNow.text}.` : '');
  let text = head;
  if (level === 'transfer') {
    if (!codexNow.available) text = `${head} Close to the limit.`;
    else if (autoTransferOn) text = `${head} Close to the limit. From ${AUTO_TRANSFER_PCT}% Jev copies this session into Codex on every prompt and shows the \`codex resume\` command; run /codex:transfer to do it now.`;
    else text = `${head} Close to the limit: run /codex:transfer to continue this session in Codex.`;
  } else if (codexNow.available) {
    text = codexNow.ok ? `${head} Routing self-contained work to Codex until the reset.` : `${head} Codex can't take work, so it stays on Claude.`;
  }
  return { key: `${claude.window}:${claude.resetsAt}:${level}`, text };
}

// Copy the session into a new Codex thread with the plugin's transfer command
// (the same one /codex:transfer runs). Resolves { threadId, resumeCommand }
// or { error }; never rejects. Earlier auto-transfer threads are left alone:
// the user may have resumed one and kept working in it.
//
// Codex imports a given source file only once: importing it again after it
// grows fails. So each transfer imports a fresh copy under its own name,
// which gives an up-to-date thread every time and leaves the real transcript
// unimported for a manual /codex:transfer. The copy must sit under
// ~/.claude/projects (the plugin rejects other paths) and is deleted once
// imported; the Codex thread does not need it.
function autoTransfer(transcriptPath, sessionId, cwd) {
  const companion = codex.companionPath();
  if (!companion) return Promise.resolve({ error: 'Codex plugin not installed' });
  const copyDir = path.join(os.homedir(), '.claude', 'projects', 'jev-transfers');
  const copyPath = path.join(copyDir, `${sessionId || 'session'}-${Date.now()}.jsonl`);
  try {
    fs.mkdirSync(copyDir, { recursive: true });
    fs.copyFileSync(transcriptPath, copyPath);
  } catch (e) {
    return Promise.resolve({ error: `could not copy the transcript: ${e.message}` });
  }
  return new Promise((resolve) => {
    execFile(process.execPath, [companion, 'transfer', '--json', '--source', copyPath],
      { cwd: cwd || process.cwd(), timeout: TRANSFER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(copyPath); } catch (e) { /* already gone */ }
        if (err) {
          const detail = (stderr || '').trim().split('\n').pop() || err.message.split('\n')[0];
          resolve({ error: err.killed ? `timed out after ${TRANSFER_TIMEOUT_MS}ms` : detail });
          return;
        }
        try {
          const payload = JSON.parse(stdout.slice(stdout.indexOf('{')));
          if (!payload.threadId) throw new Error('no thread id');
          resolve({ threadId: payload.threadId, resumeCommand: payload.resumeCommand || `codex resume ${payload.threadId}` });
        } catch (e) {
          resolve({ error: 'unexpected transfer output' });
        }
      });
  });
}

// Count a finished transfer and remember its thread for the status line.
function recordTransfer(state, t) {
  if (!t.threadId) return;
  state.stats.transfers += 1;
  state.lastTransfer = { at: new Date().toISOString(), threadId: t.threadId };
  writeState(state);
}

// User notice for an automatic transfer. The resume command gets its own
// line: it is the one thing the user needs once Claude stops answering.
function transferNotice(claude, codexNow, t) {
  const head = `Jev: Claude ${claude.window} usage at ${Math.round(claude.pct)}% ` +
    `(resets ${fmtReset(claude.resetsAt, claude.window === '7d')}). ${codexNow.text}.`;
  if (!t.threadId) return `${head} Automatic Codex transfer failed (${t.error}); run /codex:transfer.`;
  return `${head} This session is copied into Codex up to now (older copies stay; codex delete --force <id> removes one).\n` +
    `>>> If Claude stops answering, continue in a terminal: ${t.resumeCommand}`;
}

// Note telling Claude to hand the task to Codex. Calls the companion script
// directly: the plugin's codex:codex-rescue agent is itself a Claude Sonnet
// subagent, which would spend the Claude usage this route is meant to save.
function codexAdvice(tier, result, reason, choice, companion) {
  return `Jev sized this message as ${tier.toUpperCase()} (confidence ${result.confidence.toFixed(2)}). ` +
    `Route it to Codex (${reason}) ${codexCall(choice, companion)}`;
}

function codexCall(choice, companion) {
  const flags = [
    choice.model ? `--model ${choice.model}` : null,
    choice.effort ? `--effort ${choice.effort}` : null,
  ].filter(Boolean).join(' ');
  return 'with one Bash call from this conversation, not the codex:codex-rescue agent (that agent runs on Claude):\n' +
    // Forward slashes work in Git Bash and PowerShell on Windows too.
    `node "${companion.replace(/\\/g, '/')}" task ${flags} "<the task, self-contained>"\n` +
    'Add --write if Codex should edit files. For long multi-step work add --background and check it later with the companion\'s status/result commands.';
}

// A routing override at the start of a message: "+large fix the parser".
// Not "!": a leading "!" puts Claude Code's prompt into bash mode. Returns
// { target: 'tier' | 'codex' | 'claude', tier, token } or null.
const OVERRIDE = /^\+(tiny|everyday|large|hardest|claude|codex(?::(tiny|everyday|large|hardest))?)(?=\s|$)/i;

function parseOverride(prompt) {
  const m = OVERRIDE.exec(prompt.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (word === 'claude') return { target: 'claude', tier: null, token: m[0] };
  if (word.startsWith('codex')) return { target: 'codex', tier: (m[2] || 'everyday').toLowerCase(), token: m[0] };
  return { target: 'tier', tier: word, token: m[0] };
}

// Note and route for an override. Returns { note, route: [target, model, how],
// notice? } (route as in setRoute); notice goes to the user when Codex was
// asked for but may not run.
function overrideAdvice(o, ctx) {
  const prefix = `The "${o.token}" prefix on this message is a Jev routing override from the user, not part of the task. `;
  if (o.target === 'claude') {
    return { note: `${prefix}Handle this message here in this session, without delegating it.`, route: ['claude', ctx.sessionFamily, 'session'] };
  }
  if (o.target === 'tier') {
    const info = TIER_INFO[o.tier];
    return {
      note: `${prefix}The user wants it done by the "${info.agent}" subagent (${info.model}). Delegate it without asking, ` +
        'with a self-contained prompt that carries any context it needs from this conversation.',
      route: ['claude', info.model, 'suggested'],
    };
  }
  const companion = codex.companionPath();
  if (!ctx.codexNow.available || !companion) {
    return {
      note: `${prefix}The user asked for Codex, but Codex is not available, so handle it here.`,
      route: ['claude', ctx.sessionFamily, 'session'],
      notice: 'Jev: "+codex" ignored: Codex is not available (needs the codex plugin enabled and the codex CLI on PATH).',
    };
  }
  const choice = codex.tierChoice(o.tier, ctx.overrides, ctx.codexCache);
  return {
    note: `${prefix}Route it to Codex ${codexCall(choice, companion)}`,
    route: ['codex', choice.model || 'default', 'suggested'],
    // Asked for explicitly, so it goes even when usage looks high; the user
    // hears why it may fail.
    notice: ctx.codexNow.ok ? null : `Jev: sending to Codex as asked, but ${ctx.codexNow.text}.`,
  };
}

// Asked in the same call as size when a previous prompt from this session is
// known. Output tokens are free, so the extra question costs only the
// previous prompt's input tokens.
const SHIFT_QUESTION = {
  type: 'noul',
  instructions: 'Does the message start a new task unrelated to the previous message, so earlier conversation context is no longer needed?',
  criteria: {
    true: 'a different topic or task; the earlier work is not needed to answer it',
    false: 'continues, follows up on, or depends on the previous task',
  },
};

async function classify(prompt, previous, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const state = { message: redact(prompt).slice(0, 4000) };
  const questions = {
    size: {
      type: 'choice',
      instructions: "What's the smallest job size the message needs?",
      criteria: {
        tiny: 'a lookup, a rename, a one-line answer',
        everyday: 'a normal email, post, or short document',
        large: 'a multi-step build, research, or a full report',
        hardest: 'strategy, or anything where a wrong call is expensive',
      },
    },
    contained: {
      type: 'noul',
      instructions: 'Could a helper with no access to the earlier conversation do this task from the message alone, plus any files or links it names?',
      criteria: {
        true: 'the message states the whole task; nothing said earlier is needed',
        false: 'it refers to or builds on earlier work, decisions, or answers ("that", "now do the next one", "yes")',
      },
    },
    heavy: {
      type: 'noul',
      instructions: 'Will doing this task produce a lot of intermediate output the final answer does not need, such as reading many files, long logs, test runs, or web research?',
      criteria: {
        true: 'many reads, searches, or long command output along the way',
        false: 'a direct answer or a small, targeted change',
      },
    },
    coding: {
      type: 'noul',
      instructions: 'Is this a software engineering task on code or a repository: writing, changing, debugging, testing, or reviewing code?',
      criteria: {
        true: 'the work is on code, scripts, config, or a repository',
        false: 'prose, a lookup, planning, or a question not about code',
      },
    },
  };
  if (previous) {
    state.previous_message = previous;
    questions.shift = SHIFT_QUESTION;
  }
  try {
    const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'typesafe/jev-1.13', state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const answer = data.answers && data.answers.size;
    if (!answer) throw new Error('response had no size answer');
    const noul = (key) => {
      const value = data.answers[key] && data.answers[key].noul;
      return Number.isFinite(value) ? value : null;
    };
    return {
      size: answer.choice,
      confidence: answer.confidence,
      shift: noul('shift'),
      contained: noul('contained'),
      heavy: noul('heavy'),
      coding: noul('coding'),
      cost: (data.usage && data.usage.cost) || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

function looksSkippable(prompt) {
  const trimmed = prompt.trim();
  if (trimmed.startsWith('/')) return true;
  if (trimmed.length < 20) return true;
  if (/^(yes|no|ok|okay|sure|do that|go ahead|continue|thanks|please)\b/i.test(trimmed) && trimmed.length < 40) return true;
  return false;
}

// Pure decision helpers (exported for the tests in test/) and the usage
// helpers shared with the mid-turn usage watch (jev-usage-watch.js).
module.exports = {
  TIER_INFO, MODEL_RANK, modelFamily, transcriptModel, delegationAdvice,
  routeAdvice, limitNoticeFor, looksSkippable, subStepAdvice, parseOverride, overrideAdvice,
  claudePeak, codexStatus, autoTransfer, fmtReset, recordTransfer, transferNotice, readState, writeState, setRoute,
  THRESHOLDS: { route: CLAUDE_ROUTE_PCT, transfer: CLAUDE_TRANSFER_PCT, auto: AUTO_TRANSFER_PCT, codexMax: CODEX_MAX_PCT },
};

if (require.main === module) main();

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    const state = readState();
    if (!state.enabled) return;
    // Notices go to the user (systemMessage), context notes to Claude. Written
    // in `finally` so a limit notice still shows when sizing is skipped or fails.
    const output = {};
    const notices = [];
    let transfer = null;
    let claude = null;
    let codexNow = null;
    try {
      let prompt;
      let sessionId;
      let transcriptPath;
      let cwd;
      try {
        const hookInput = JSON.parse(input);
        prompt = (hookInput.prompt || '').trim();
        sessionId = hookInput.session_id || null;
        transcriptPath = hookInput.transcript_path || null;
        cwd = hookInput.cwd || null;
      } catch (e) {
        recordSilent(state, 'failed', 'hook input was not valid JSON');
        return;
      }
      if (!prompt) return;

      claude = claudePeak();
      const codexCache = codex.readCache();
      codex.refreshInBackgroundIfStale(codexCache);
      codexNow = codexStatus(codexCache);
      // Started now so it runs alongside the Jev call; awaited in `finally`.
      if (state.autoTransfer && codexNow.available && claude && claude.pct >= AUTO_TRANSFER_PCT && transcriptPath) {
        transfer = autoTransfer(transcriptPath, sessionId, cwd);
      }
      const claudeLow = !!claude && claude.pct >= CLAUDE_ROUTE_PCT;
      const limitNotice = limitNoticeFor(claude, codexNow, state.autoTransfer);
      // Once per window, reset and level, so the notice doesn't repeat on every prompt.
      if (limitNotice && state.limitNotice !== limitNotice.key) {
        state.limitNotice = limitNotice.key;
        notices.push(limitNotice.text);
        writeState(state);
      }

      // Codex's AGENTS.md is generated locally, cheap enough to keep in sync on
      // every prompt. Claude-side installs (caveman plugin, RTK hook) are too
      // slow for this hook, so they only get a once-per-session pointer.
      if (state.sync) {
        try {
          if (sync.syncAgents({ withCaveman: state.caveman }) === 'updated') {
            notices.push('Jev: regenerated ~/.codex/AGENTS.md to match CLAUDE.md, RTK and caveman. Stop this with /mynameisjev:sync off.');
          }
        } catch (e) {
          notices.push(`Jev: could not regenerate ~/.codex/AGENTS.md (${e.message}).`);
        }
      }
      // Daily update check runs in the background (jev-updates.js); its result
      // is announced once, on the first prompt after it lands.
      if (state.updates) {
        updates.refreshInBackgroundIfStale();
        const found = updates.readCache();
        if (found && found.checkedAt !== state.updatesNoticeAt) {
          const parts = [];
          if (found.updates.length > 0) {
            parts.push(`${found.updates.length} update${found.updates.length > 1 ? 's' : ''} available: ` +
              `${found.updates.map(updates.describe).join('; ')}. Run /mynameisjev:update to apply.`);
          }
          if (found.missing && found.missing.length > 0) {
            parts.push(`Not active: ${found.missing.join(', ')}. Run /mynameisjev:sync to install.`);
          }
          state.updatesNoticeAt = found.checkedAt;
          writeState(state);
          if (parts.length > 0) notices.push(`Jev: ${parts.join(' ')}`);
        }
      }
      if (sessionId && state.setupNoticeSession !== sessionId) {
        const missing = [];
        if (state.caveman && caveman.claudeStatus() !== 'active') missing.push('the caveman plugin');
        if (state.sync && !sync.rtkClaudeHook()) missing.push("RTK's Claude hook");
        if (missing.length > 0) {
          state.setupNoticeSession = sessionId;
          writeState(state);
          notices.push(`Jev: ${missing.join(' and ')} not active in Claude Code; run /mynameisjev:sync to install.`);
        }
      }

      // Every message runs on the session model unless a note below says
      // otherwise.
      const sessionFamily = sessionModelFamily(sessionId, transcriptPath);
      setRoute(state, 'claude', sessionFamily, 'session');

      const project = st.readProjectConfig(st.projectDir(cwd));
      if (project && project.error && state.projectNotice !== `${sessionId}:${project.path}`) {
        state.projectNotice = `${sessionId}:${project.path}`;
        notices.push(`Jev: ${project.path} is not usable (${project.error}), so Jev does not size messages in this project until it is fixed.`);
      }
      const prefer = (project && project.prefer) || state.prefer;

      // Overrides need no Jev call, so they work without a key and in
      // projects that turn sizing off.
      const override = parseOverride(prompt);
      if (override) {
        const o = overrideAdvice(override, { sessionFamily, codexNow, codexCache, overrides: state.codexTiers });
        state.stats.forced += 1;
        setRoute(state, ...o.route);
        state.lastSilent = null;
        writeState(state);
        if (o.notice) notices.push(o.notice);
        output.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: o.note };
        return;
      }

      if (project && !project.router) {
        recordSilent(state, 'skipped', project.error ? 'project config unusable' : 'sizing off for this project');
        return;
      }

      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        recordSilent(state, 'failed', 'OPENROUTER_API_KEY not set');
        return;
      }

      if (looksSkippable(prompt)) {
        recordSilent(state, 'skipped', 'short or slash-command message');
        return;
      }

      // Only compare prompts from the same session: a new session already has a
      // fresh context, so a topic change there needs no /clear. Updated before
      // the request so a failed call still leaves the right baseline.
      const last = state.lastPrompt;
      const previous = sessionId && last && last.session === sessionId ? last.text : null;
      state.lastPrompt = sessionId ? { session: sessionId, text: redact(prompt).slice(0, PREVIOUS_CHARS) } : null;

      let result;
      try {
        result = await classify(prompt, previous, apiKey);
      } catch (e) {
        const timedOut = e.name === 'AbortError';
        // Short form for the status line's JEV segment.
        state.lastCall = { at: new Date().toISOString(), ok: false, error: timedOut ? 'timeout' : e.message };
        recordSilent(state, 'failed', timedOut ? `timeout after ${TIMEOUT_MS}ms` : `request failed: ${e.message}`);
        return;
      }

      state.lastCall = { at: new Date().toISOString(), ok: true };
      state.cost += result.cost || 0;

      // Topic-shift notice goes to the user, not Claude: only the user can run
      // /clear or /compact, and a systemMessage adds nothing to Claude's context.
      if (result.shift !== null && result.shift >= SHIFT_THRESHOLD) {
        state.stats.shift += 1;
        notices.push(`Jev: this looks like a new task (p ${result.shift.toFixed(2)}). ` +
          'Run /clear to drop the old context for free, or /compact to keep a summary.');
      }

      const tier = TIER_INFO[result.size] ? result.size : null;
      if (!tier || result.confidence < 0.6) {
        recordSilent(state, 'unsure', !tier
          ? `unknown size "${result.size}"`
          : `${tier} at confidence ${Number(result.confidence).toFixed(2)} (< 0.60)`);
        // Unsized work still runs on Claude; with Claude low, point its
        // self-contained steps at Codex anyway.
        const companion = codex.companionPath();
        if ((claudeLow || prefer === 'codex') && codexNow.ok && companion) {
          setRoute(state, 'codex', 'steps', 'suggested');
          writeState(state);
          output.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: subStepAdvice(claudeLow ? claude : null, companion) };
        }
      } else {
        // Tier counts record sizing; `suppressed` (outside the total) counts
        // sized messages that got no note because delegating would not pay off.
        state.stats[tier] += 1;
        const advice = routeAdvice(tier, result, {
          sessionFamily,
          claude,
          claudeLow,
          preferCodex: prefer === 'codex',
          codexNow,
          codexCache,
          overrides: state.codexTiers,
        });
        if (advice.note) {
          if (advice.codex) state.stats.codex += 1;
          else state.stats.helper += 1;
          setRoute(state, advice.codex ? 'codex' : 'claude', advice.model, 'suggested');
          writeState(state);
          output.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: advice.note };
        } else {
          recordSilent(state, 'suppressed', advice.suppress);
        }
      }
    } catch (e) {
      // Silent fail — router must never block a prompt.
      recordSilent(state, 'failed', `unexpected error: ${e.message}`);
    } finally {
      if (transfer) {
        const t = await transfer;
        recordTransfer(state, t);
        notices.unshift(transferNotice(claude, codexNow, t));
      }
      if (notices.length > 0) output.systemMessage = notices.join('\n');
      if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
    }
  });
}
