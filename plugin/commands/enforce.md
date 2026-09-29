---
description: Make Jev's hand-offs happen - helper models for subagents, Codex for edits on Codex routes
argument-hint: [on | off]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" enforce $ARGUMENTS`

Show the output above to the user exactly as printed. Do not summarize it or add commentary.
