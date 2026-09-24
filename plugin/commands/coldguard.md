---
description: Block the first message after the prompt cache goes cold on a large context
argument-hint: [on | off]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" coldguard $ARGUMENTS`

Show the output above to the user exactly as printed. Do not summarize it or add commentary.
