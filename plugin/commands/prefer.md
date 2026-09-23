---
description: Route work to Codex first at any Claude usage, or back to the default
argument-hint: [codex | claude]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" prefer $ARGUMENTS`

Show the output above to the user exactly as printed, including any WARNING line. Do not summarize it or add commentary.
