---
description: Ask Jev to score 2 to 4 code variants (files, line ranges, or versions from the conversation)
argument-hint: [file[:start-end] file[:start-end] ... -- criteria]
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Arguments: $ARGUMENTS

Build one JSON object for Jev, then run it through the command below.

- **If the arguments above are not empty**, the object is `{"raw": "<the arguments, verbatim>"}`. Do not split, reword, or add context; the script reads the files itself.
- **If they are empty**, take the code variants the conversation is currently weighing (for example, two versions of a function you proposed). Build `{"variants": [{"label": "...", "text": "..."}, ...], "criteria": ["...", "..."], "context": "..."}`. Use 2 to 4 variants with short distinct labels and the full code of each (at most 6,000 characters each). `criteria` (up to 4) and `context` (the goal and constraints, up to about 300 words) are optional. If the conversation has no clear set of variants, ask the user what to compare instead of inventing code, and stop.

Run, with the JSON on its own line between the markers:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" compare <<'JEV_COMPARE_EOF'
{...}
JEV_COMPARE_EOF
```

Show the output to the user exactly as printed. Then add one line starting with **Claude's take:** with a short reason for or against Jev's best pick, in your own words. Jev returns no reasons and runs no code, so this line is your opinion, not Jev's. If the command printed an `Error:` line, show it and stop.
