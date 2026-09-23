---
description: Opt-in: keep caveman (terse output) active on Claude and Codex
argument-hint: [on | off]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" caveman $ARGUMENTS`

Show the output above to the user exactly as printed, including any WARNING line. Do not summarize it or add commentary.
