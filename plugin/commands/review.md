---
description: Turn Claude's review of Codex work on or off for this session; --default sets new sessions
argument-hint: [--default] [on | off]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" review $ARGUMENTS`

Show the output above to the user exactly as printed, including any WARNING line. Do not summarize it or add commentary.
