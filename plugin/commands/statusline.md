---
description: Install or remove the Jev status line (Claude usage, plus a Codex line when available)
argument-hint: [install | uninstall]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" statusline $ARGUMENTS`

Show the output above to the user exactly as printed, including any WARNING line. Do not summarize it or add commentary.
