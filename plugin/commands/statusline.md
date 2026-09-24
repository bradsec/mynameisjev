---
description: Install, wrap your own, or remove the Jev status line
argument-hint: [install | wrap [--with-jev] | uninstall]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" statusline $ARGUMENTS`

Show the output above to the user exactly as printed, including any WARNING line. Do not summarize it or add commentary.
