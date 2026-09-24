---
description: Save a short note of the current task, to /clear now and pick it up later
argument-hint: [what to focus on]
allowed-tools: Bash(node:*), Write
disable-model-invocation: true
---

Handoff file: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" handoff`

Write a handoff note for the task this conversation has been working on to the handoff file above, with the Write tool. The note is for a fresh session with none of this conversation, so it must stand on its own. Use these sections, and keep the whole note under 400 words:

- **Goal**: what the user wants, in their terms
- **Done so far**: what is finished and verified, with file paths
- **Decisions**: choices made and why, including approaches ruled out
- **Open**: what is left, the next step, and anything blocked or uncertain
- **Key files**: paths a new session should read first

Focus: $ARGUMENTS

Write only facts from this conversation; mark guesses as guesses. Then reply with one line: the file path, and that the user can run /clear and later start again with `@<path>`.
