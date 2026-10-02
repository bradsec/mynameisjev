---
description: Ask Jev to pick between options, typed here or taken from the conversation
argument-hint: [option A | option B ... -- criteria]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Arguments: $ARGUMENTS

Build one JSON object for Jev, then run it through the command below.

- **If the arguments above are not empty**, the object is `{"raw": "<the arguments, verbatim>"}`. Do not split, reword, or add context; the script parses them.
- **If they are empty**, take the options the conversation is currently choosing between (for example, approaches or fixes you proposed). Build `{"question": "...", "options": ["...", "..."], "criteria": "...", "context": "..."}`. Use 2 to 8 options of at most 200 characters each, named so they stand on their own. Context is up to about 300 words: the goal, the constraints, and what each option involves. `criteria` is optional. If the conversation has no clear choice between options, ask the user what to decide instead of inventing options, and stop.

Run, with the JSON on its own line between the markers:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" decide <<'JEV_DECIDE_EOF'
{...}
JEV_DECIDE_EOF
```

Show the output to the user exactly as printed. Then add one line starting with **Claude's take:** giving a short reason for or against the pick in your own words. Jev returns no reasons, so this line is your opinion, not Jev's. If the command printed an `Error:` line, show it and stop.
