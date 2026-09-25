---
description: Make general-purpose subagents run on the Claude helper model Jev suggested
argument-hint: [on | off]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" enforce $ARGUMENTS`

Show the output above to the user exactly as printed. Do not summarize it or add commentary.
