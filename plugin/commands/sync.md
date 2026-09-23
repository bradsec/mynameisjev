---
description: Opt-in: generate ~/.codex/AGENTS.md from CLAUDE.md and keep caveman, superpowers and RTK active on both sides
argument-hint: [on | off]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" sync $ARGUMENTS`

Show the output above to the user exactly as printed, including any WARNING line. Do not summarize it or add commentary.
