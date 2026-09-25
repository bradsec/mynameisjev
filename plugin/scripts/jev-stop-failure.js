#!/usr/bin/env node
// jev-stop-failure — StopFailure hook for `rate_limit`: the turn ended
// because Claude hit its usage limit. The usage thresholds in jev-router.js
// act earlier, but one long turn can jump past all of them.
//
// Claude Code ignores this hook's output except `terminalSequence`, so the
// user hears about it through a desktop notification. With auto-transfer on
// (and Codex available) the session is copied into Codex first and the
// notification carries the `codex resume` command, which the status line's
// Codex line also keeps in view (state.lastTransfer).

const st = require('./jev-state');

// A retry right after a transfer reuses it instead of making another thread.
const REUSE_TRANSFER_MS = 5 * 60 * 1000;

// Terminal escape sequence for a desktop notification, picked for the
// terminal Claude Code runs in. Claude Code only passes OSC 9 (iTerm2,
// WezTerm, Windows Terminal, ConEmu), OSC 99 (Kitty) and OSC 777 (Ghostty,
// Warp, urxvt, the default here). Control characters are stripped so the
// text can't end the sequence early.
function notification(title, body, env = process.env) {
  const clean = (t) => String(t).replace(/[\x00-\x1f\x7f]/g, ' ');
  if (env.KITTY_WINDOW_ID) return `\x1b]99;;${clean(body)}\x1b\\`;
  if (env.WT_SESSION || env.ConEmuPID || /^(iTerm\.app|WezTerm)$/.test(env.TERM_PROGRAM || '')) {
    return `\x1b]9;${clean(`${title}: ${body}`)}\x07`;
  }
  return `\x1b]777;notify;${clean(title).replace(/;/g, ',')};${clean(body)}\x07`;
}

async function handle(hookInput) {
  if (hookInput.error !== 'rate_limit') return null;
  const state = st.readState();
  if (!state.enabled) return null;
  const r = require('./jev-router');
  const codex = require('./jev-codex');
  const claude = r.claudePeak();
  const resets = claude ? ` (resets ${r.fmtReset(claude.resetsAt, claude.window === '7d')})` : '';
  const codexNow = r.codexStatus(codex.readCache());
  state.stats.limitHits = (state.stats.limitHits || 0) + 1;

  let body;
  if (state.autoTransfer && codexNow.available && hookInput.transcript_path) {
    const last = state.lastTransfer;
    const recent = last && last.session === hookInput.session_id && Date.now() - Date.parse(last.at) < REUSE_TRANSFER_MS;
    const t = recent
      ? { threadId: last.threadId, resumeCommand: `codex resume ${last.threadId}` }
      : await r.autoTransfer(hookInput.transcript_path, hookInput.session_id, hookInput.cwd);
    if (!recent) r.recordTransfer(state, t, hookInput.session_id);
    body = t.threadId
      ? `Claude hit its usage limit${resets}. Continue in Codex: ${t.resumeCommand}`
      : `Claude hit its usage limit${resets}. Codex transfer failed (${t.error}); run /codex:transfer.`;
  } else if (codexNow.available) {
    body = `Claude hit its usage limit${resets}. Run /codex:transfer to continue in Codex.`;
  } else {
    body = `Claude hit its usage limit${resets}.`;
  }
  st.writeState(state);
  return { terminalSequence: notification('Claude Code', body) };
}

module.exports = { handle, notification };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const out = await handle(JSON.parse(input || '{}'));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (e) {
      // Nothing to disturb: the turn has already ended.
    }
  });
}
