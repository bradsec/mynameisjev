# Changelog

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
