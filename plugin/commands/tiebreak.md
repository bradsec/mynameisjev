---
description: Let Claude ask Jev to pick at a reversible fork mid-task
argument-hint: [on | off]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" tiebreak $ARGUMENTS`

Show the output above to the user exactly as printed. Do not summarize it or add commentary.
