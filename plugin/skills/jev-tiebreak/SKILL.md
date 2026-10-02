---
name: jev-tiebreak
description: Use mid-task when you are choosing between 2 to 4 concrete, viable approaches, the user has stated no preference, and the choice is cheap to reverse (an implementation detail, a library within the existing stack, naming or structure, which of several fixes). Asks Jev for a fast, cheap pick. Not for product, security, data, destructive, cost or public API decisions; ask the user about those.
user-invocable: false
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" tiebreak-status`

If the line above says the tiebreak is off or has 0 calls left, make the choice yourself and stop reading this skill.

## When to use it

All of these hold:

- You are about to pick one of 2 to 4 concrete options, each of which would work.
- The user has not stated or implied a preference, and the repo's conventions do not settle it.
- Choosing wrong is cheap: the choice is local and easy to change later.

Ask the user instead, and do not run Jev, when the choice affects product behavior, security, data loss or anything destructive, cost, a public API or config format, or anything else the user should own. When one option is clearly better, take it; Jev is for real ties.

## How

To pick between options, send the same JSON `/mynameisjev:decide` uses, with a short question, the options named so they stand on their own, optional criteria, and up to about 300 words of context (the goal, the constraints, what each option involves):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" decide --auto <<'JEV_DECIDE_EOF'
{"question": "...", "options": ["...", "..."], "criteria": "...", "context": "..."}
JEV_DECIDE_EOF
```

To pick between code variants, send the JSON `/mynameisjev:compare` uses (2 to 4 variants, at most 6,000 characters each):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-cli.js" compare --auto <<'JEV_COMPARE_EOF'
{"variants": [{"label": "...", "text": "..."}, {"label": "...", "text": "..."}], "criteria": ["..."], "context": "..."}
JEV_COMPARE_EOF
```

## After

- Follow Jev's pick, unless the output has a `Toss-up` line. On a toss-up, use your own judgment and say so.
- Tell the user in one line what Jev picked and its probability, for example `Jev tiebreak: picked the shared helper (0.78)`, so they can override it. Then carry on with the task.
- If the command says the tiebreak is off, unavailable or at its limit, or prints an `Error:` line, make the choice yourself and carry on.
