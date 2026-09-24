# Changelog

## 0.3.3

- Likely secrets (API keys, tokens, private keys, `password=...`-style
  values, credentials in URLs) are replaced with `[REDACTED]` before a
  message is sent to Jev or stored as the previous prompt.
- Per-project settings in `<project>/.claude/mynameisjev.json`:
  `"router": false` stops sizing (nothing is sent) in that project, and
  `"prefer"` overrides `/mynameisjev:prefer` there. A file that can't be read
  turns sizing off until fixed. The status line and `/mynameisjev:status`
  show it.
- Routing overrides: start a message with `+tiny`, `+everyday`, `+large`,
  `+hardest`, `+codex` (or `+codex:<size>`) or `+claude` to route it without
  a Jev call. They work without an API key and in projects with sizing off.
- New `/mynameisjev:report`: notes given vs hand-offs that ran, per Claude
  helper and Codex, and the tokens `mynameisjev:*` subagents used per model
  (read from their transcripts by a new `SubagentStop` hook).

## 0.3.2

- New `/mynameisjev:prefer codex`: routes work to Codex first at any Claude
  usage (whole self-contained tasks, and the self-contained steps of work
  that needs the conversation). Tiny jobs stay on Claude and a busy Codex
  falls back to Claude. `/mynameisjev:prefer claude` restores the default.
  The status line shows `codex-first` while it's on.

## 0.3.1

- Default Codex models now use the GPT-6 line: `gpt-6-luna` for tiny tasks
  (was `gpt-5.6-luna`) and `gpt-6-sol` for everyday tasks (was
  `gpt-5.6-terra`). Large and hardest stay on `gpt-6-astra`. Custom models set
  with `/mynameisjev:codex set` are unchanged.

## 0.3.0

- The status line shows where the latest message went, after the JEV state:
  `→ opus` (the session's own model), `→ sonnet?` or `→ codex gpt-6-sol?`
  (suggested), and `→ sonnet ✓` or `→ codex gpt-6-sol ✓` once the hand-off
  actually ran. The usage watch hook detects Codex companion tasks and
  `mynameisjev:*` subagents as they run.

## 0.2.0

Claude usage limits are handled well before 100%:

- Thresholds lowered: work moves to Codex from 80% Claude plan usage (was
  85%), the warning and `/codex:transfer` suggestion come at 85% (was 90%),
  and auto-transfer starts at 90% (was 95%).
- New mid-turn usage watch (PostToolUse hook): usage is checked after every
  tool call, so a long Claude turn that crosses a threshold is caught before
  it runs out, not at the next message.
- Messages that need the conversation can't go to Codex whole; above 80%
  Claude is now told to hand their self-contained steps to Codex instead of
  getting no note.
- The `codex resume` command from an automatic transfer gets its own line in
  the notice and stays on the status line's Codex line for 5 hours.

## 0.1.2

Security fixes:

- The update check validates git remotes and refs taken from third-party
  marketplace files before passing them to `git ls-remote`, so a value like
  `--upload-pack=...` can't run a command.
- On Windows, only `.cmd`/`.bat` shims run through the shell, and only with
  arguments free of shell metacharacters; real executables run directly.
- The `/mynameisjev:*` commands can only be run by you, not invoked by
  Claude, since they pass their arguments to a shell.

## 0.1.1

- Status line shows the router state and whether OpenRouter access works
  (`JEV ✓`, `JEV no key`, `JEV HTTP 401`, `JEV off`), based on the router's
  last Jev call.

## 0.1.0

First release as a Claude Code plugin.

- Jev sizing on every prompt, with model-aware delegation notes for the
  `mynameisjev:tiny`, `:everyday` and `:large` helper agents.
- Topic-shift notices.
- Codex routing, usage limits and model choice per size, active only when the
  Codex plugin and CLI are present.
- Claude and Codex plan usage notices; optional auto-transfer into Codex.
- Status line with Claude usage and an optional Codex line, installed with
  `/mynameisjev:statusline install`.
- Opt-in sync (Codex AGENTS.md from CLAUDE.md), caveman, and daily update
  checks.
- Linux, macOS and Windows support.
