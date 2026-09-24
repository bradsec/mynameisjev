#!/usr/bin/env node
// Claude Code Statusline - Enhanced Edition
// Shows pretty bars for: context usage, session (5h) usage, weekly (7d) usage,
// plus the Jev router state (on/off, OpenRouter access)
// Line 2: git status + token counts
// Line 3: Codex plan usage, while the codex plugin is enabled

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ── Visual helpers ────────────────────────────────────────────────────────────

// ANSI helpers — reset is explicit so colors never bleed across segments
const R = '\x1b[0m';

function color(ansi, text) { return `${ansi}${text}${R}`; }

// Named palette — every color defined once, used by name throughout
function bold(t)       { return color('\x1b[1m',           t); }
function white(t)      { return color('\x1b[97m',          t); }   // bright white — primary info
function softBlue(t)   { return color('\x1b[38;5;111m',    t); }   // #87afff — model name
function cyan(t)       { return color('\x1b[38;5;87m',     t); }   // bright cyan — metric labels
function yellow(t)     { return color('\x1b[38;5;220m',    t); }   // amber — active task / warnings
function green(t)      { return color('\x1b[38;5;120m',    t); }   // soft green — healthy
function amber(t)      { return color('\x1b[38;5;214m',    t); }   // orange-amber — moderate
function orange(t)     { return color('\x1b[38;5;208m',    t); }   // deep orange — elevated
function red(t)        { return color('\x1b[38;5;203m',    t); }   // soft red — high
function blink_red(t)  { return color('\x1b[5;38;5;196m',  t); }   // blinking bright red — critical
function mutedGray(t)  { return color('\x1b[38;5;244m',    t); }   // separator / secondary

// Color ramp for usage bars — green → amber → orange → red → blink
function usageColor(pct, text) {
  if (pct <  50) return green(text);
  if (pct <  65) return amber(text);
  if (pct <  80) return orange(text);
  if (pct <  92) return red(text);
  return blink_red(text);
}

// Build a labelled metric block with distinct label styling:
//   LABEL ████░░░░  nn%
//
// - Label: bright cyan, bold — immediately identifiable
// - Filled bar + percentage: usage-colored — state at a glance
// - Empty bar: muted gray — low visual weight
function metricBar(label, pct, segments) {
  if (!Number.isFinite(pct)) return '';
  pct = Math.max(0, Math.min(100, pct));
  const filled = Math.round((pct / 100) * segments);
  const empty  = segments - filled;
  const filledBar = usageColor(pct, '█'.repeat(filled));
  const emptyBar  = mutedGray('░'.repeat(empty));
  const pctStr    = bold(usageColor(pct, String(Math.round(pct)) + '%'));
  return `${cyan(bold(label))} ${filledBar}${emptyBar} ${pctStr}`;
}

// Cache hit-rate bar: like metricBar but the color ramp is inverted because a
// HIGH hit rate is healthy (cheap, fast) while a low one is not. Coloring by
// (100 - pct) reuses the usageColor ramp so 90% hit reads green, 10% reads red.
function cacheBar(label, pct, segments) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled  = Math.round((clamped / 100) * segments);
  const empty   = segments - filled;
  const inv      = 100 - clamped;
  const filledBar = usageColor(inv, '█'.repeat(filled));
  const emptyBar  = mutedGray('░'.repeat(empty));
  const pctStr    = bold(usageColor(inv, String(Math.round(clamped)) + '%'));
  return `${cyan(bold(label))} ${filledBar}${emptyBar} ${pctStr}`;
}

// Per-turn cache hit rate: fraction of input tokens served from the prompt
// cache for the last API call. Denominator is all input tokens (fresh + cache
// read + cache write). This is a fallback; it reflects one turn, not the
// session. Returns null when the fields are absent or no input yet.
function turnCacheHitRate(currentUsage) {
  if (!currentUsage || currentUsage.cache_read_input_tokens == null) return null;
  const fresh = currentUsage.input_tokens ?? 0;
  const read  = currentUsage.cache_read_input_tokens ?? 0;
  const write = currentUsage.cache_creation_input_tokens ?? 0;
  if (![fresh, read, write].every(n => Number.isFinite(n) && n >= 0)) return null;
  const total = fresh + read + write;
  if (!Number.isFinite(total) || total <= 0) return null;
  return (read / total) * 100;
}

// Session cache hit rate. Claude Code v2.1.251+ sends a `prompt_cache` object
// whose `hit_ratio` (0..1) is cache-read tokens over all input tokens for the
// whole main conversation. Prefer it; fall back to the per-turn estimate on
// older clients or before the first response.
function cacheHitRate(data) {
  const ratio = data.prompt_cache?.hit_ratio;
  if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) return ratio * 100;
  return turnCacheHitRate(data.context_window?.current_usage);
}

// " ↺ HH:MM" (or " ↺ Day HH:MM") for a reset time in epoch seconds, or ''
// when the value is missing or implausible.
function resetSuffix(epochSec, withDay) {
  if (!Number.isFinite(epochSec) || Math.abs(epochSec) > 8.64e12) return '';
  const d = new Date(epochSec * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = withDay ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ` : '';
  return mutedGray(` ↺ ${day}${hm}`);
}

// Hooks never receive prompt_cache, so share when each session's cache goes
// cold and what re-caching would cost with the Jev router's cold-cache guard
// (jev-router.js). Keyed by session; a reply with no cache tokens has a null
// expires_at, so the last known expiry is kept. Written only on change.
const PROMPT_CACHE_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

function sharePromptCache(session, pc) {
  let file;
  let all = {};
  try {
    file = require('./jev-state').dataFile('prompt-cache.json');
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    if (!file) return;
  }
  const prev = all[session] || {};
  const next = {
    expires_at: Number.isFinite(pc.expires_at) ? pc.expires_at : (prev.expires_at ?? null),
    ttl: pc.ttl || prev.ttl || null,
    // null right after a compaction, until the next reply: the old size no
    // longer applies, so don't keep it.
    recache: Number.isFinite(pc.recache_tokens_if_cold) ? pc.recache_tokens_if_cold : null,
  };
  if (JSON.stringify([prev.expires_at, prev.ttl, prev.recache]) === JSON.stringify([next.expires_at, next.ttl, next.recache])) return;
  const now = Date.now();
  for (const [id, v] of Object.entries(all)) {
    if (!v || !(now - v.at < PROMPT_CACHE_KEEP_MS)) delete all[id];
  }
  all[session] = { ...next, at: now };
  try { fs.writeFileSync(file, JSON.stringify(all)); } catch (_) {}
}

// ── Jev router state (line 1) ─────────────────────────────────────────────────
// Whether the router is on and its OpenRouter access works. "Works" comes from
// the outcome of the router's last Jev call (state.lastCall), so rendering
// never calls the API. Returns '' when the Jev state can't be read.
// projectDir is checked for a .claude/mynameisjev.json override.
function jevSegment(projectDir) {
  let state;
  let project;
  try {
    const st = require('./jev-state');
    state = st.readState();
    project = st.readProjectConfig(projectDir);
  } catch (_) {
    return '';
  }
  const label = cyan(bold('JEV'));
  if (!state.enabled) return `${label} ${mutedGray('off')}`;
  if (project && project.error) return `${label} ${red('project config error')}`;
  const prefer = (project && project.prefer) || state.prefer;
  // Prefer-Codex mode is a standing choice, so it stays visible.
  const route = (prefer === 'codex' ? ` ${cyan('codex-first')}` : '') + routeSuffix(state.route);
  if (project && !project.router) return `${label} ${mutedGray('off in project')}${route}`;
  if (!process.env.OPENROUTER_API_KEY) return `${label} ${red('no key')}`;
  const last = state.lastCall;
  if (!last) return `${label} ${amber('on')}${route}`;
  if (!last.ok) return `${label} ${red(String(last.error || 'error').slice(0, 24))}${route}`;
  return `${label} ${green('✓')}${route}`;
}

// Where Jev sent the latest message: " → opus" (grey, the session's own
// model), " → codex gpt-6-sol?" (amber, suggested) or " → sonnet ✓" (green,
// the hand-off ran). Hidden once older than 30 minutes.
function routeSuffix(route) {
  if (!route || Date.now() - Date.parse(route.at) > 30 * 60 * 1000) return '';
  const where = route.target === 'codex'
    ? `codex${route.model && route.model !== 'default' ? ` ${route.model}` : ''}`
    : route.model;
  if (route.how === 'ran') return ` ${green(`→ ${where} ✓`)}`;
  if (route.how === 'suggested') return ` ${amber(`→ ${where}?`)}`;
  return ` ${mutedGray(`→ ${where}`)}`;
}

// ── Codex usage (third line) ──────────────────────────────────────────────────
// Shown only while Codex is available (codex plugin enabled, codex CLI on
// PATH; see jev-codex.js codexAvailable). Reads the usage cache the Jev
// router keeps (jev-codex.js) so the status line never waits on Codex;
// a stale cache triggers that module's background refresh (lock-guarded, so
// frequent status line runs start at most one). Returns '' when unavailable.
function codexLine() {
  let codex;
  try {
    codex = require('./jev-codex');
  } catch (_) {
    return '';
  }
  if (!codex.codexAvailable()) return '';
  const cache = codex.readCache();
  codex.refreshInBackgroundIfStale(cache);
  const label = cyan(bold('CODEX'));
  if (cache?.error) return `${label} ${mutedGray(`usage unavailable: ${cache.error}`)}`;
  if (!cache?.limits) return `${label} ${mutedGray('usage loading…')}`;

  const l = cache.limits;
  const nowSec = Date.now() / 1000;
  // A window whose reset time has passed has started over.
  const pctOf = w => (Number.isFinite(w.resetsAt) && w.resetsAt < nowSec ? 0 : Math.round(w.usedPercent));
  const parts = [l.planType ? `${label} ${green(l.planType)}` : label];
  if (l.primary) parts.push(metricBar('5H', pctOf(l.primary), 6) + resetSuffix(l.primary.resetsAt, false));
  if (l.secondary) parts.push(metricBar('7D', pctOf(l.secondary), 6) + resetSuffix(l.secondary.resetsAt, true));
  if (l.reachedType || l.ordinaryUsageAllowed === false) parts.push(red('LIMIT REACHED'));
  const ageMin = Math.floor((Date.now() - cache.at) / 60000);
  if (ageMin >= 15) parts.push(mutedGray(`${ageMin}m old`));
  // A recent automatic transfer means Claude is near its limit: keep the
  // command to continue in Codex in view (it is easy to miss as a notice).
  try {
    const last = require('./jev-state').readState().lastTransfer;
    if (last && Date.now() - Date.parse(last.at) < 5 * 60 * 60 * 1000) {
      parts.push(red(`→ codex resume ${last.threadId}`));
    }
  } catch (_) {}
  return parts.join(mutedGray(' · '));
}

// ── Git status ────────────────────────────────────────────────────────────────
// Returns null when cwd is not inside a git repo (or git is not available).
// execFileSync with argument arrays: no shell involved, fixed arguments only.
// --no-optional-locks is a global git flag, so it goes before the subcommand.
// Pass { skipRemote: true } to skip the remote-URL lookup when the caller
// already has repo identity from the statusline payload.
function getGitInfo(cwd, { skipRemote = false } = {}) {
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 };

  const run = args => {
    try { return execFileSync('git', args, opts).trim(); } catch (_) { return null; }
  };

  // Confirm we're in a git repo (also fails when git is not installed)
  if (run(['rev-parse', '--git-dir']) === null) return null;

  // Branch name (or short SHA when detached HEAD)
  const branch = run(['symbolic-ref', '--short', 'HEAD']) ||
                 run(['rev-parse', '--short', 'HEAD']) ||
                 '?';

  // Dirty file count: modified + added + deleted (tracked changes only + untracked)
  const statusLines = run(['--no-optional-locks', 'status', '--porcelain']) || '';
  const dirtyCount  = statusLines ? statusLines.split('\n').filter(Boolean).length : 0;

  // Commits ahead of / behind @{upstream}
  let unpushed = 0;
  let behind   = 0;
  if (run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])) {
    unpushed = parseInt(run(['--no-optional-locks', 'rev-list', '--count', '@{u}..HEAD']), 10) || 0;
    behind   = parseInt(run(['--no-optional-locks', 'rev-list', '--count', 'HEAD..@{u}']), 10) || 0;
  }

  // Remote URL for origin (or first remote if origin absent)
  let remote = null;
  if (!skipRemote) {
    const remoteUrl = run(['remote', 'get-url', 'origin']) ||
                      (() => {
                        const remotes = run(['remote']);
                        if (!remotes) return null;
                        const first = remotes.split('\n').find(Boolean);
                        return first ? run(['remote', 'get-url', first]) : null;
                      })();
    if (remoteUrl) {
      // Display repository identity without URL credentials, query, or fragment.
      if (remoteUrl.includes('://')) {
        try {
          const url = new URL(remoteUrl);
          remote = `${url.host}${url.pathname.replace(/\.git$/, '')}`;
        } catch (_) {
          remote = null;
        }
      } else {
        remote = remoteUrl.replace(/^[^@/]+@([^:]+):/, '$1/').replace(/\.git$/, '');
      }
    }
  }

  return { branch, dirtyCount, unpushed, behind, remote };
}

// ── Account / plan ──────────────────────────────────────────────────────────
// Account name and subscription plan are NOT in the statusLine JSON payload
// (open feature requests anthropics/claude-code#24679, #26219). They live in
// the global config file ~/.claude.json under `oauthAccount`. Read it directly:
// docs warn that shelling out to `claude auth whoami` from hooks hangs.
// Honors CLAUDE_CONFIG_DIR. The field is internal/undocumented, so every access
// is guarded and a missing file or shape is treated as "no account info".
function getAccountInfo() {
  // Single config root, mirroring the todos lookup: an explicit CLAUDE_CONFIG_DIR
  // wins outright so a different account root never leaks the home account.
  const configFile = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');

  try {
    const acct = JSON.parse(fs.readFileSync(configFile, 'utf8')).oauthAccount;
    if (!acct) return null;

    const name = acct.displayName || null;

    // organizationType is e.g. "claude_max" / "claude_pro" -> "Max" / "Pro"
    let plan = null;
    const t = acct.organizationType;
    if (typeof t === 'string' && t.startsWith('claude_')) {
      const word = t.slice('claude_'.length);
      plan = word.charAt(0).toUpperCase() + word.slice(1);
    }

    return name || plan ? { name, plan } : null;
  } catch (_) {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);

    const model    = data.model?.display_name || 'Claude';
    const effort   = data.effort?.level ? mutedGray(` [${data.effort.level}]`) : '';
    const dir      = data.workspace?.current_dir || data.cwd || process.cwd();
    const session  = data.session_id || '';
    const dirname  = path.basename(dir);
    const cw       = data.context_window || {};

    const homeDir   = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');

    function fmtTokens(n) {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000)     return (n / 1_000).toFixed(1)     + 'k';
      return String(n);
    }

    // ── Context bar ────────────────────────────────────────────────────────
    // Prefer used_percentage; otherwise use the complement of
    // remaining_percentage on older clients that do not send it.
    let ctxPart = '';
    if (Number.isFinite(cw.used_percentage)) {
      ctxPart = metricBar('CTX', Math.round(cw.used_percentage), 8);
    } else if (Number.isFinite(cw.remaining_percentage)) {
      ctxPart = metricBar('CTX', 100 - cw.remaining_percentage, 8);
    }

    // ── Context occupancy tokens ────────────────────────────────────────────
    // context_window.total_* are the tokens currently in the window (from the
    // most recent API response), not session cumulative. Pair with the window
    // size so the ratio is meaningful.
    let tokenPart = '';
    const totalIn  = cw.total_input_tokens;
    const totalOut = cw.total_output_tokens;
    const winSize  = cw.context_window_size;
    if (totalIn != null) {
      tokenPart = `${cyan(bold('TOK'))} ${cyan(bold('IN'))} ${white(fmtTokens(totalIn))}`;
      if (winSize) tokenPart += ` ${mutedGray('/')} ${white(fmtTokens(winSize))}`;
      if (totalOut != null) {
        tokenPart += ` ${mutedGray('·')} ${cyan(bold('OUT'))} ${white(fmtTokens(totalOut))}`;
      }
    }

    // ── Cost (session) ─────────────────────────────────────────────────────
    let costPart = '';
    const costUsd = data.cost?.total_cost_usd;
    if (typeof costUsd === 'number' && costUsd > 0) {
      costPart = `${cyan(bold('$'))} ${white(costUsd.toFixed(2))}`;
    }

    // ── Cache hit rate ─────────────────────────────────────────────────────
    // Session-wide when prompt_cache is present, else the per-turn estimate.
    let cachePart = '';
    const hitRate = cacheHitRate(data);
    if (hitRate != null) {
      cachePart = cacheBar('CACHE', hitRate, 6);
    }

    // Cache state: minutes until a warm cache expires, or the re-cache bill a
    // cold cache will charge on the next turn, plus unexplained misses and the
    // likely cause of the last one. Claude Code re-runs the status line when
    // expires_at passes, so the warm/cold flip shows up without a new turn.
    const pc = data.prompt_cache;
    if (pc?.caching_observed) {
      const nowSec = Date.now() / 1000;
      if (pc.warm && Number.isFinite(pc.expires_at)) {
        const mins = Math.max(0, Math.ceil((pc.expires_at - nowSec) / 60));
        cachePart += ` ${mutedGray(`warm ${mins}m`)}`;
      } else {
        const recache = Number.isFinite(pc.recache_tokens_if_cold)
          ? ` re-cache ${fmtTokens(pc.recache_tokens_if_cold)}`
          : '';
        cachePart += ` ${orange(`cold${recache}`)}`;
      }
      if (pc.misses > 0) {
        const cause = pc.last_miss_cause?.causes?.[0];
        cachePart += ` ${red(`miss ${pc.misses}${cause ? ` (${cause})` : ''}`)}`;
      }
      if (session) sharePromptCache(session, pc);
    }

    // ── Rate limit bars (claude.ai subscription only) ──────────────────────
    let fiveHourPart = '';
    let sevenDayPart = '';

    const fiveHour  = data.rate_limits?.five_hour;
    const sevenDay  = data.rate_limits?.seven_day;

    // Hooks never receive rate_limits, so share them with the Jev router
    // (jev-router.js) through a file. Written only when the numbers change,
    // since the status line re-runs on every update.
    if (fiveHour || sevenDay) {
      const pick = w => (Number.isFinite(w?.used_percentage)
        ? { used_percentage: w.used_percentage, resets_at: w.resets_at ?? null }
        : null);
      const limits = { five_hour: pick(fiveHour), seven_day: pick(sevenDay) };
      const limitsPath = require('./jev-state').dataFile('claude-limits.json');
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(limitsPath, 'utf8')); } catch (_) {}
      const unchanged = prev &&
        JSON.stringify([prev.five_hour, prev.seven_day]) === JSON.stringify([limits.five_hour, limits.seven_day]);
      if (!unchanged) {
        try { fs.writeFileSync(limitsPath, JSON.stringify({ at: Date.now(), ...limits })); } catch (_) {}
      }
    }

    if (Number.isFinite(fiveHour?.used_percentage)) {
      fiveHourPart = metricBar('5H', Math.round(fiveHour.used_percentage), 6) + resetSuffix(fiveHour.resets_at, false);
    }

    if (Number.isFinite(sevenDay?.used_percentage)) {
      sevenDayPart = metricBar('7D', Math.round(sevenDay.used_percentage), 6) + resetSuffix(sevenDay.resets_at, true);
    }

    // ── Current task from todos ────────────────────────────────────────────
    let task = '';
    const todosDir = path.join(claudeDir, 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        const files = fs.readdirSync(todosDir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
          const inProgress = todos.find(t => t.status === 'in_progress');
          if (inProgress) task = inProgress.activeForm || '';
        }
      } catch (_) {}
    }

    // ── Git info ───────────────────────────────────────────────────────────
    // repo identity comes from the payload when available, so skip the extra
    // `git remote` calls in that case.
    let gitPart = '';
    const gitCwd = data.cwd || dir;
    const repo   = data.workspace?.repo;
    const git    = getGitInfo(gitCwd, { skipRemote: !!repo });
    let remoteLabel = null;
    if (repo && (repo.owner || repo.name)) {
      remoteLabel = [repo.host, repo.owner, repo.name].filter(Boolean).join('/');
    } else if (git?.remote) {
      remoteLabel = git.remote;
    }
    if (git) {
      // Branch: always shown
      gitPart = `${cyan(bold('GIT'))} ${white(git.branch)}`;

      // Dirty indicator: show count when there are changes, "clean" when not
      if (git.dirtyCount > 0) {
        gitPart += ` ${mutedGray('·')} ${cyan(bold('~'))}${white(String(git.dirtyCount))}`;
      } else {
        gitPart += ` ${mutedGray('·')} ${mutedGray('clean')}`;
      }

      // Unpushed / behind commits
      if (git.unpushed > 0) {
        gitPart += ` ${mutedGray('·')} ${cyan(bold('↑'))}${white(String(git.unpushed))}`;
      }
      if (git.behind > 0) {
        gitPart += ` ${mutedGray('·')} ${cyan(bold('↓'))}${white(String(git.behind))}`;
      }
    }

    // ── Assemble output ────────────────────────────────────────────────────
    // Line 1: Name · Plan │ ModelName [effort] │ JEV ✓ │ active task │ CTX ████░░░░ nn% · 5H ████░░ nn% ↺HH:MM · 7D ████░░ nn%
    // Line 2: dirname · remote · GIT branch · ~n · ↑n · ↓n · TOK IN nn.nk / nnnk · OUT nn.nk · $ n.nn · CACHE ████░░ nn%
    // Line 3: CODEX plan · 5H ████░░ nn% ↺HH:MM · 7D ████░░ nn% ↺Day HH:MM · LIMIT REACHED (codex plugin enabled only)
    //
    // Visual hierarchy:
    //   - Model: soft blue (ambient context)
    //   - Task: bold amber (most important left-side info when present)
    //   - Dir: bright white (primary navigation anchor)
    //   - Separators: muted gray (structural, low weight)
    //   - Metric labels: bold cyan (scannable right-side anchors)
    //   - Bars + percentages: usage-colored (state at a glance)
    //   - Git branch/counts: bright white values, cyan labels

    const sep    = mutedGray(' │ ');
    const dotSep = mutedGray(' · ');

    // Account segment: "Alex · Max" (name white, plan soft green). Leading
    // position so identity/plan is the first thing read on line 1.
    const acct = getAccountInfo();
    const acctPart = acct
      ? [acct.name ? white(acct.name) : null, acct.plan ? green(acct.plan) : null]
          .filter(Boolean)
          .join(dotSep)
      : null;

    const leftParts = [
      acctPart,
      softBlue(model) + effort,
      jevSegment(data.workspace?.project_dir || dir) || null,
      task ? bold(yellow(task)) : null,
    ].filter(Boolean).join(sep);

    const rightParts = [ctxPart, fiveHourPart, sevenDayPart]
      .filter(Boolean)
      .join(dotSep);

    const line1 = rightParts
      ? leftParts + sep + rightParts
      : leftParts;

    // Line 2: dir (+ remote) · git · tokens · cost · cache
    let dirPart = white(dirname);
    if (remoteLabel) {
      dirPart += dotSep + mutedGray(remoteLabel);
    }

    const line2Parts = [dirPart, gitPart, tokenPart, costPart, cachePart].filter(Boolean).join(dotSep);
    const line3      = codexLine();
    const output     = [line1, line2Parts, line3].filter(Boolean).join('\n');

    process.stdout.write(output);
  } catch (_) {
    // Silent fail — never break the statusline
  }
});
