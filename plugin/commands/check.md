---
description: Check at each stop that Claude's reply covers every part of your request
argument-hint: [on | off]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" check $ARGUMENTS`

Show the output above to the user exactly as printed. Do not summarize it or add commentary.
