# mynameisjev

[![CI](https://github.com/bradsec/mynameisjev/actions/workflows/ci.yml/badge.svg)](https://github.com/bradsec/mynameisjev/actions/workflows/ci.yml)

<p align="center">
  <img src="mynameisjev.png" alt="My Name is JEV" />
</p>

A Claude Code plugin that sizes every message you send and tells Claude when
a cheaper model, a stronger one, or Codex would handle it better.

It asks [Jev](https://openrouter.ai/docs/guides/community/jev), TypeSafe's
structured decision model on OpenRouter, a few typed questions about your
message (how big is the job, does it need the earlier conversation, will it
produce bulky output, is it coding, is it a new topic) and turns the answers
into a short routing note for Claude. One Jev call costs about $0.00002.

- **Model-aware delegation.** Knows which Claude model the session runs and
  only suggests a helper (`mynameisjev:tiny` on Haiku, `:everyday` on Sonnet
  at medium effort, `:large` on Opus at high effort, `:hardest` on Opus at
  extra-high effort) when it is cheaper, stronger, or keeps bulky output out
  of your main context. Tiny jobs and jobs that need the conversation stay
  put. `/mynameisjev:enforce on` makes general-purpose subagents use the
  suggested model.
- **Topic-shift notices.** Tells you when a message starts an unrelated task,
  so you can `/clear` instead of paying for stale context.
  `/mynameisjev:handoff` saves a note of the old task first.
- **Session model advice.** After several messages in a row sized for a
  cheaper (or stronger) model than the session's, suggests `/model` for the
  whole session.
- **Compaction digest.** After a compaction, gives Claude your latest
  requests, the files it edited and how its last reply ended, in case the
  summary dropped them.
- **Codex routing (only if you use Codex).** With the Codex plugin installed,
  self-contained coding work goes to a Codex model picked by size, and all
  self-contained work moves to Codex when your Claude plan runs low.
- **Status line (optional).** Router state and OpenRouter access, context,
  Claude 5-hour and 7-day usage, cache health, git, cost, plus a Codex usage
  line when Codex is available.
- **Quick decisions.** `/mynameisjev:decide` asks Jev to pick between
  options you type, or the ones the conversation is weighing, and shows the
  probability of each. `/mynameisjev:compare` scores 2 to 4 code variants
  on a few criteria. See [Decide](#decide) and [Compare](#compare).

Everything else is opt-in (see [Optional features](#optional-features)).

## Requirements

- [Claude Code](https://code.claude.com/docs) on Linux, macOS or Windows
- Node.js 18 or later on your `PATH`
- An [OpenRouter API key](https://openrouter.ai/keys) in `OPENROUTER_API_KEY`
- Optional: the [Codex CLI](https://github.com/openai/codex) and the
  [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc),
  logged in to a ChatGPT plan

## Install

### 1. Node.js

Check with `node --version`. If it is missing or older than 18:

| OS | Install |
| --- | --- |
| Linux | Your package manager, or [nvm](https://github.com/nvm-sh/nvm): `nvm install --lts` |
| macOS | `brew install node`, or nvm as above |
| Windows | `winget install OpenJS.NodeJS.LTS`, then open a new terminal |

### 2. OpenRouter API key

Create a key at [openrouter.ai/keys](https://openrouter.ai/keys) and make it
available to Claude Code. Claude Code passes its environment to hooks, so set
the variable where the shell that starts Claude Code will see it.

**Linux** (bash: `~/.bashrc`, zsh: `~/.zshrc`):

```bash
echo 'export OPENROUTER_API_KEY="sk-or-..."' >> ~/.bashrc
source ~/.bashrc
```

**macOS** (zsh is the default shell):

```bash
echo 'export OPENROUTER_API_KEY="sk-or-..."' >> ~/.zshrc
source ~/.zshrc
```

**Windows** (PowerShell, stored for your user account):

```powershell
[Environment]::SetEnvironmentVariable('OPENROUTER_API_KEY', 'sk-or-...', 'User')
```

Then close and reopen your terminal so it picks the variable up.

Restart Claude Code after setting the key.

### 3. The plugin

In Claude Code:

```text
/plugin marketplace add bradsec/mynameisjev
/plugin install mynameisjev@mynameisjev
/reload-plugins
/mynameisjev:on
```

`/mynameisjev:on` warns if it can't see `OPENROUTER_API_KEY`.

This marketplace is third-party, so Claude Code doesn't update the plugin in
the background. Update with `/plugin update mynameisjev@mynameisjev`, or turn
the update check on (`/mynameisjev:update on`) to be told when a release is
out.

### 4. Status line (optional)

Plugins can't set Claude Code's main status line, so this is a separate step:

```text
/mynameisjev:statusline install
```

It saves your current status line (in Jev's state and in
`~/.claude/statusline.jev-backup.json`, so it survives deleting
`~/.claude/mynameisjev`) and `/mynameisjev:statusline uninstall` puts it
back. Install renders the status line once and warns if that fails. It sets
`refreshInterval` to 60 seconds, so the Codex line and the cache countdown
stay current while the session is idle. The status line also records your Claude plan usage and prompt
cache state, which the router needs for its limit-aware features and the
cold-cache guard; without it those stay quiet.

To keep a status line of your own, wrap it instead:

```text
/mynameisjev:statusline wrap
```

Jev's launcher then records the same data but prints your status line's
output, unchanged. Your command gets the usual JSON on stdin and runs
through a shell, as Claude Code runs it (`cmd.exe` on Windows). Its other
settings, such as `padding` and `refreshInterval`, are kept. `install` and
`wrap` switch between the two; `uninstall` restores yours unwrapped.
`/mynameisjev:statusline wrap --with-jev` adds the JEV segment (router state
and where the latest message went) on its own line after yours.

A `statusLine` in a project's `.claude/settings.json` or
`settings.local.json` takes precedence over yours in `~/.claude`, and then
neither Jev's status line nor its data recording runs in that project.
`/mynameisjev:statusline` and `/mynameisjev:status` warn when they see one.

The rest of this section describes Jev's own status line. It follows
[`NO_COLOR`](https://no-color.org), and on narrow terminals it drops the
account name first, then shortens the usage bars, then the reset times.

Line 1 shows the router's state next to the model:

| Shows | Meaning |
| --- | --- |
| `JEV ✓` | On, and the last Jev call succeeded |
| `JEV on` | On, key present, no call made yet |
| `JEV no key` | On, but `OPENROUTER_API_KEY` isn't set |
| `JEV HTTP 401`, `JEV timeout`, … | On, and the last Jev call failed with this error |
| `JEV off` | Router off |

The check reuses the outcome of the router's last call, so the status line
never calls the API itself.

After it, an arrow shows where the latest message went (hidden after 30
minutes):

| Shows | Meaning |
| --- | --- |
| `→ opus` (grey) | Handled on the session's own Claude model |
| `→ sonnet?`, `→ codex gpt-6-sol?` (amber) | Jev suggested handing it to that Claude helper or Codex model |
| `→ sonnet ✓`, `→ codex gpt-6-sol ✓` (green) | The hand-off ran: a `mynameisjev:*` subagent started, or a Codex task ran |
| `codex-first` (cyan, before the arrow) | Prefer-Codex mode is on |
| `off in project`, `project config error` | See [Per-project settings](#per-project-settings) |

### 5. Codex (optional)

Skip this if you don't use Codex; nothing Codex-related runs without it.

```bash
npm install -g @openai/codex
codex login
```

Then in Claude Code:

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
```

mynameisjev detects Codex automatically (the plugin enabled and `codex` on
your `PATH`) and turns on Codex routing, the Codex status line and
`/mynameisjev:codex`.

## Commands

| Command | What it does |
| --- | --- |
| `/mynameisjev:on` / `off` | Turn the router on or off |
| `/mynameisjev:status` | Stats, and the state of each feature |
| `/mynameisjev:decide [A \| B -- criteria]` | Jev picks between options; see [Decide](#decide) |
| `/mynameisjev:compare [a.js b.js -- criteria]` | Jev scores code variants; see [Compare](#compare) |
| `/mynameisjev:handoff [focus]` | Claude writes a note of the current task, to `/clear` now and pick it up later |
| `/mynameisjev:check` | Opt-in, see below |
| `/mynameisjev:coldguard` | Opt-in, see below |
| `/mynameisjev:tiebreak` | Opt-in, see below |
| `/mynameisjev:enforce` | Opt-in, see below |
| `/mynameisjev:report` | Notes given vs hand-offs that ran, and helper subagent token use per model |
| `/mynameisjev:limits` | Claude and Codex plan usage and reset times |
| `/mynameisjev:codex` | Show or set the Codex model per task size: `set <tier> <model> [effort]`, `reset` |
| `/mynameisjev:prefer` | `codex` routes work to Codex first at any Claude usage; `claude` (default) goes back |
| `/mynameisjev:statusline` | `install` Jev's status line, `wrap [--with-jev]` your own, or `uninstall` |
| `/mynameisjev:sync` | Opt-in, see below |
| `/mynameisjev:caveman` | Opt-in, see below |
| `/mynameisjev:transfer` | Opt-in, see below |
| `/mynameisjev:update` | Opt-in, see below |

## Decide

`/mynameisjev:decide` asks Jev to pick one of 2 to 8 options:

```text
/mynameisjev:decide zod | valibot -- bundle size, DX
/mynameisjev:decide
```

With arguments, options are split on `|` and anything after ` -- ` is the
criteria. Jev sees only what you typed. With no arguments, Claude takes the
options the conversation is choosing between (for example, fixes it
proposed) and sends them with a short summary of the goal and constraints.

```text
Pick: valibot  0.71
      zod      0.29
Cost: $0.00002
```

The numbers are Jev's probability for each option. When the top two are
within 0.15, a `Toss-up` line says either is defensible. Jev gives no
reasons, so Claude adds one line marked **Claude's take**, its own opinion.
Jev cannot run code or see files Claude does not send, so treat the pick as
a cheap second opinion, not a verdict. Text only: Jev takes no images.

## Compare

`/mynameisjev:compare` asks Jev to score 2 to 4 code variants on up to 4
criteria and pick the best overall:

```text
/mynameisjev:compare src/a.js src/b.js -- correctness risk, readability
/mynameisjev:compare lib/x.js:10-40 lib/y.js:5-30
/mynameisjev:compare
```

With arguments, each is a file, optionally with a `:start-end` line range,
and anything after ` -- ` is a comma-separated list of criteria (default:
correctness risk, readability, simplicity). Files must be inside the project,
after following symlinks, and at most 6,000 characters each; use a line
range for bigger files. With no arguments, Claude takes the variants the
conversation is weighing, such as two versions of a function it proposed.

```text
                  a.js  b.js
correctness risk   2.8   2.0
readability        2.1   3.1
handles backoff    3.8   0.4
Best: a.js 0.93, b.js 0.07
Scores: 0 = very poor, 4 = very good
Cost: $0.00004
```

Scores are Jev's expected score per criterion, higher is better. The best
pick and the `Toss-up` line work as in [Decide](#decide), and Claude adds
its own one-line take. Jev reads the code but does not run it, so a high
score is a second opinion, not a test result.

## How routing works

Each message gets one Jev call with up to five questions. The router then
adds a note to Claude's context, or stays silent:

| Situation | Note |
| --- | --- |
| Not self-contained (needs the earlier conversation) | none |
| Tiny job, little output | none (a subagent's start-up costs more) |
| Helper model cheaper than the session's | "cheaper, consider delegating" |
| Helper model stronger than the session's | "stronger, delegate if quality matters" |
| Same model, lots of intermediate output | "keeps bulky output out of your context" |
| Self-contained coding, Codex under 85% | route to Codex |
| Claude plan at 80% or more, Codex has headroom | route self-contained work to Codex; for work that needs the conversation, hand its self-contained steps to Codex |

### Session model advice

Delegation notes work per message. When the whole session runs on the wrong
model, Jev tells you once the pattern is clear:

- 5 messages in a row sized for a cheaper model than the session's: suggests
  `/model <cheapest model that covers all of them>`
- 3 in a row sized for a stronger model: suggests `/model <that model>`

A message sized for the session's own model, or a model switch, starts the
count over. Switching re-reads the context once without the cache, which the
notice mentions.

The same call also scores how much reasoning effort each message needs
(low, medium, high or xhigh), separately from its size, and Jev suggests
`/effort` on the same pattern: 5 messages in a row needing less effort than
the session runs at, or 3 needing more. This needs the session's effort
level, which only the status line sees, so it works with Jev's status line
installed or wrapped, and stays quiet on models without an effort setting.
`/mynameisjev:status` counts the suggestions shown.

### Topic shifts and handoffs

When Jev flags a new task, `/clear` drops the old context for free. To come
back to the old task later, run `/mynameisjev:handoff` first: Claude writes
a short note (goal, done so far, decisions, open items, key files) to
`~/.claude/mynameisjev/handoffs/<project>-<time>.md`, outside the project so
it is never committed. Start a later session with `@<that path>`.

### Compaction digest

`PreCompact` hooks can't change what a compaction keeps, so Jev saves a
digest from the transcript just before it runs and hands it to Claude right
after (a `SessionStart` hook with source `compact`): your latest 3 requests,
the files edited or written since the previous compaction, and the end of
Claude's last reply. It is built locally from the transcript; nothing is
sent anywhere.

### Overrides

Start a message with one of these to route it yourself. No Jev call is made,
so they also work without an API key and in projects with sizing off.

| Prefix | Routes to |
| --- | --- |
| `+tiny`, `+everyday`, `+large`, `+hardest` | That Claude helper subagent |
| `+codex`, `+codex:<size>` | Codex, with the model for that size (default `everyday`) |
| `+claude` | The session's own model, no hand-off |

Example: `+large research state management options and write a report`.
Claude sees the prefix and is told it is a routing instruction. `!` is not
used because a leading `!` runs a shell command in Claude Code.

Codex tasks run through the Codex plugin's own script with one Bash call, not
through its `codex:codex-rescue` agent, which itself runs on Claude.

Default Codex models per size (change with `/mynameisjev:codex set`):

| Size | Codex model | Effort |
| --- | --- | --- |
| tiny | `gpt-6-luna` | low |
| everyday | `gpt-6-sol` | medium |
| large | `gpt-6-astra` | medium |
| hardest | `gpt-6-astra` | high |

Models missing from your Codex account's list fall back to Codex's default.

### Prefer Codex

`/mynameisjev:prefer codex` makes Codex the first choice at any Claude usage,
the same routing that normally starts at 80%: self-contained work goes to
Codex whole, and for work that needs the conversation Claude keeps the
coordination and hands the self-contained steps to Codex. Tiny one-line jobs
stay on Claude (a hand-off costs more), and work falls back to Claude while
Codex is near its limit. The status line shows `codex-first` while it's on;
`/mynameisjev:prefer claude` switches back.

Claude Code's own conversation always runs on a Claude model. To leave Claude
out entirely, continue in the Codex CLI (`/codex:transfer`, then
`codex resume <id>`).

Claude plan usage thresholds, each announced once per usage window:

| Usage | What happens |
| --- | --- |
| 60% and on pace to run out | Work moves to Codex when available, if the 5h usage pace reaches 100% before the reset within 90 minutes |
| 80% | Work moves to Codex when available |
| 85% | Warning; Claude wraps up; `/codex:transfer` suggested when Codex is available |
| 90% | With auto-transfer on, the session is copied into Codex and the `codex resume` command is shown (and kept on the status line) |

They sit well below 100% on purpose: one long Claude turn can use 10% or more
of a 5-hour window, and at 100% Claude can't act at all, not even to hand work
over. For the same reason usage is also checked after every tool call, not
only when you send a message, so a long turn that crosses a threshold is
caught mid-turn.

The pace is the rise in 5h usage over the last hour of samples, which the
status line records each time the percentage changes. It needs at least 10
minutes of samples, and it measures working time: an idle break doesn't
lower it. The status line shows `→100% ~40m` next to the 5H bar when the
window would run out before its reset.

If a turn still ends because Claude hit its limit, Jev sends a desktop
notification (Claude Code shows no hook messages at that point). With
auto-transfer on and Codex available, it first copies the session into
Codex, and the notification and the status line's Codex line show the
`codex resume` command. A retry within 5 minutes reuses that copy. The
notification uses OSC 9 in iTerm2, WezTerm, Windows Terminal and ConEmu,
OSC 99 in Kitty, and OSC 777 elsewhere (Ghostty, Warp, urxvt).

Notes are suggestions. To make Claude follow them without asking, add this to
your `~/.claude/CLAUDE.md`:

```markdown
- Follow Jev router notes (hook context starting "Jev sized this message"):
  when one says to route the task to Codex or delegate it to a mynameisjev:*
  subagent, do so without asking. Do the work inline only when I ask you to.
```

## Per-project settings

A `.claude/mynameisjev.json` file in a project overrides the global settings
there:

```json
{ "router": false, "prefer": "codex" }
```

| Key | Effect |
| --- | --- |
| `router` | `false` stops sizing in this project: no message text is sent. Limit notices and `+` overrides still work |
| `prefer` | `"codex"` or `"claude"`, overriding `/mynameisjev:prefer` in this project |

If the file can't be read or has an invalid value, Jev tells you once per
session and does not size messages in that project until it is fixed. The
status line shows `off in project` or `project config error`, and
`/mynameisjev:status` shows the file in use.

## Report

`/mynameisjev:report` shows:

- Jev calls and their cost
- Claude helper and Codex notes given, next to the hand-offs that ran (runs
  include hand-offs Claude started without a note)
- `+` overrides used, and notes suppressed because a hand-off would not pay off
- tokens used by `mynameisjev:*` subagents per model (input, cache write,
  cache read, output), read from their transcripts when they finish

Codex tasks bill your ChatGPT plan, so their tokens are not counted.

## Optional features

All off by default, because each one changes things outside the plugin.

| Feature | Turn on | What it changes |
| --- | --- | --- |
| Sync | `/mynameisjev:sync on` | **Replaces** `~/.codex/AGENTS.md` with a copy generated from `~/.claude/CLAUDE.md` (one backup kept as `AGENTS.md.jev.bak`), and installs caveman, superpowers and RTK's Claude hook where missing |
| Caveman | `/mynameisjev:caveman on` | Installs the [caveman](https://github.com/JuliusBrussee/caveman) plugin in Claude Code and, with sync on, adds its rules to Codex |
| Enforce hand-offs | `/mynameisjev:enforce on` | When Jev suggested a Claude helper for the message, a general-purpose subagent that Claude starts without choosing a model runs on that helper's model (effort can't be set this way; the `mynameisjev:*` helpers carry theirs). Named agents, calls that choose a model, Codex routes and other sessions are left alone, and permission prompts are unchanged. When the message is routed to Codex (the whole task, or `→ codex steps` near the limit), Claude's own Edit, Write and NotebookEdit calls are denied with the Codex companion command, so edits use Codex's quota. Edits through Bash are not blocked; the note tells Claude not to make them. Send `+claude` to lift it for a message |
| Auto-transfer | `/mynameisjev:transfer on` | From 90% Claude usage, copies the session into a new Codex thread on every prompt and shows the `codex resume` command. Old copies stay in Codex until you delete them |
| Cold-cache guard | `/mynameisjev:coldguard on` | Blocks the first message after the prompt cache expired on a context of 100k tokens or more, so you can `/compact` or `/clear` before paying to re-cache it. The block message shows your text; send it again to go ahead. Slash commands are never blocked. Jev's status line shows `guard armed` next to the cold cache when the next message would be blocked. Needs the status line, which records the cache state |
| Completeness check | `/mynameisjev:check on` | When Claude finishes a turn, Jev checks that the final reply covers every part of your request: each list item, or each sentence when there is no list, gets a yes/no question. If a part looks missed (and Claude is not waiting on you), Claude continues once with those parts quoted, to finish them or say why they were skipped. It never blocks twice in a turn, and a failed Jev call never blocks. Jev sees only the final reply, so work Claude did but did not mention can be flagged. Adds about 1 to 3 seconds and $0.00003 per turn; `/mynameisjev:status` shows how often it continued |
| Tiebreak | `/mynameisjev:tiebreak on` | Lets Claude ask Jev to pick when it is choosing between 2 to 4 workable approaches mid-task, you stated no preference, and the choice is cheap to reverse. Claude uses the plugin's `jev-tiebreak` skill, which runs `decide` or `compare` and tells you in one line what Jev picked, so you can override it. It asks you instead about product, security, data, destructive, cost or public API choices. At most 2 calls per turn; `/mynameisjev:status` counts them |
| Update check | `/mynameisjev:update on` | Checks daily (in the background) for updates to third-party Claude plugins, the Codex CLI and RTK, and tells you. `/mynameisjev:update` applies them |

### Sync details

The generated `AGENTS.md`:

- swaps the `# CLAUDE.md` title for `# AGENTS.md`
- leaves out anything between `<!-- claude-only:start -->` and
  `<!-- claude-only:end -->` in your CLAUDE.md
- replaces `@file` import lines with the file's contents, because Codex does
  not expand them. A file with the same name in `~/.codex` wins, so Codex can
  have its own variant (for example an `RTK.md` that tells Codex to prefix
  commands with `rtk`)
- appends `~/.codex/AGENTS.local.md` for Codex-only rules
- is regenerated on your next prompt whenever the sources change

## Platform notes

- **Hooks** use Claude Code's exec form (`node` plus the script path as one
  argument), so they run the same under bash, zsh, Git Bash and PowerShell.
- **Windows:** CLIs installed with npm (`claude`, `codex`) are `.cmd` shims;
  the plugin starts them through a shell there, like the Codex plugin does.
  The status line command uses a forward-slash path, which Git Bash needs.
- **Codex background server restart** after a Codex plugin or CLI update is
  automatic on Linux. On macOS and Windows, restart Claude Code instead.
- **Claude Code plugin reloads** can't be triggered by a script on any
  platform: run `/reload-plugins` after `/mynameisjev:update`.

## Privacy

- With the router on, the text of each message you send (and, for topic-shift
  detection, the first 1,000 characters of your previous message) goes to
  OpenRouter and TypeSafe. `/mynameisjev:off` stops it everywhere;
  `"router": false` in a project's `.claude/mynameisjev.json` stops it there.
- With `/mynameisjev:check on`, each turn's request and Claude's final reply
  go to OpenRouter and TypeSafe, with the same redaction.
- With `/mynameisjev:tiebreak on`, Claude may send the options or code it is
  choosing between, with a short summary of the task, as `decide` and
  `compare` do.
- `/mynameisjev:compare` sends the code it compares (file contents, or
  snippets Claude adds) to OpenRouter and TypeSafe, only when you run it,
  with the same redaction. It reads only files inside the project.
- `/mynameisjev:decide` sends its options, criteria and any context Claude
  adds to OpenRouter and TypeSafe, only when you run it, with the same
  redaction.
- Likely secrets are replaced with `[REDACTED]` first: common API key and
  token formats (OpenAI, Anthropic, OpenRouter, GitHub, AWS, Slack, Google,
  Stripe, JWTs, bearer tokens), private key blocks, credentials in URLs, and
  values assigned to names like `API_KEY`, `password` or `client_secret`.
  This is pattern matching, so a secret in an unusual format can still get
  through; turn sizing off for projects where that matters.
- The previous message is kept locally in `~/.claude/mynameisjev/state.json`.
- Nothing else leaves your machine except the calls the optional features
  make (GitHub release checks, marketplace refreshes, Codex).

## Files

Everything the plugin writes lives in `~/.claude/mynameisjev/` (inside
`CLAUDE_CONFIG_DIR` when set): settings and stats, usage, prompt cache and session effort
state, compaction digests (deleted once used), handoff notes, the status line
launcher. Uninstalling the plugin leaves this folder; delete it to remove
all traces:

| OS | Command |
| --- | --- |
| Linux, macOS | `rm -rf ~/.claude/mynameisjev` |
| Windows (PowerShell) | `Remove-Item -Recurse -Force "$HOME\.claude\mynameisjev"` |

Run `/mynameisjev:statusline uninstall` before uninstalling if you installed
the status line.

## Development

```bash
npm test                      # node:test suite, no dependencies
claude plugin validate .      # marketplace manifest
claude plugin validate plugin # plugin manifest
```

To try local changes: `/plugin marketplace add /path/to/mynameisjev`, then
install `mynameisjev@mynameisjev`.

CI runs the tests on Linux, macOS and Windows with Node 18 and 22, and
validates the manifests.

To release:

1. Bump `version` in `plugin/.claude-plugin/plugin.json`. Claude Code only
   offers an update when this changes.
2. Add a `## <version>` section at the top of `CHANGELOG.md`.
3. Commit, then tag and push: `git tag v<version> && git push origin v<version>`.

The release workflow checks the tag matches `plugin.json`, runs the tests, and
publishes a GitHub release with that version's changelog section as notes.

## License

[MIT](LICENSE)
