---
description: Show or change the Codex model and effort Jev picks per task size
argument-hint: [show | set <tier> <model> [effort] | reset]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" codex $ARGUMENTS`

Show the output above to the user exactly as printed, including any WARNING line. Do not summarize it or add commentary.
