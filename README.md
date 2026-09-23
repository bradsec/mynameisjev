# mynameisjev

A Claude Code plugin that sizes every message you send and tells Claude when
a cheaper model, a stronger one, or Codex would handle it better.

It asks [Jev](https://openrouter.ai/docs/guides/community/jev), TypeSafe's
structured decision model on OpenRouter, a few typed questions about your
message (how big is the job, does it need the earlier conversation, will it
produce bulky output, is it coding, is it a new topic) and turns the answers
into a short routing note for Claude. One Jev call costs about $0.00002.

- **Model-aware delegation.** Knows which Claude model the session runs and
  only suggests a helper (`mynameisjev:tiny` on Haiku, `:everyday` on Sonnet,
  `:large` on Opus) when it is cheaper, stronger, or keeps bulky output out of
  your main context. Tiny jobs and jobs that need the conversation stay put.
- **Topic-shift notices.** Tells you when a message starts an unrelated task,
  so you can `/clear` instead of paying for stale context.
- **Codex routing (only if you use Codex).** With the Codex plugin installed,
  self-contained coding work goes to a Codex model picked by size, and all
  self-contained work moves to Codex when your Claude plan runs low.
- **Status line (optional).** Router state and OpenRouter access, context,
  Claude 5-hour and 7-day usage, cache health, git, cost, plus a Codex usage
  line when Codex is available.

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

While the repository is private, only accounts with access can add it. Claude
Code clones it with your existing git credentials (`gh auth login`, the macOS
Keychain, or Git Credential Manager on Windows).

### 4. Status line (optional)

Plugins can't set Claude Code's main status line, so this is a separate step:

```text
/mynameisjev:statusline install
```

It saves your current status line and `/mynameisjev:statusline uninstall`
puts it back. The status line also records your Claude plan usage, which the
router needs for its limit-aware features; without it those stay quiet.

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
| `/mynameisjev:limits` | Claude and Codex plan usage and reset times |
| `/mynameisjev:codex` | Show or set the Codex model per task size: `set <tier> <model> [effort]`, `reset` |
| `/mynameisjev:statusline` | `install` or `uninstall` the status line |
| `/mynameisjev:sync` | Opt-in, see below |
| `/mynameisjev:caveman` | Opt-in, see below |
| `/mynameisjev:transfer` | Opt-in, see below |
| `/mynameisjev:update` | Opt-in, see below |

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
| Claude plan at 85% or more, Codex has headroom | route any self-contained work to Codex |

Codex tasks run through the Codex plugin's own script with one Bash call, not
through its `codex:codex-rescue` agent, which itself runs on Claude.

Default Codex models per size (change with `/mynameisjev:codex set`):

| Size | Codex model | Effort |
| --- | --- | --- |
| tiny | `gpt-5.6-luna` | low |
| everyday | `gpt-5.6-terra` | medium |
| large | `gpt-6-astra` | medium |
| hardest | `gpt-6-astra` | high |

Models missing from your Codex account's list fall back to Codex's default.

Usage notices appear once per threshold: at 85% Claude usage (routing moves to
Codex when available) and at 90% (a warning, plus `/codex:transfer` when Codex
is available).

Notes are suggestions. To make Claude follow them without asking, add this to
your `~/.claude/CLAUDE.md`:

```markdown
- Follow Jev router notes (hook context starting "Jev sized this message"):
  when one says to route the task to Codex or delegate it to a mynameisjev:*
  subagent, do so without asking. Do the work inline only when I ask you to.
```

## Optional features

All off by default, because each one changes things outside the plugin.

| Feature | Turn on | What it changes |
| --- | --- | --- |
| Sync | `/mynameisjev:sync on` | **Replaces** `~/.codex/AGENTS.md` with a copy generated from `~/.claude/CLAUDE.md` (one backup kept as `AGENTS.md.jev.bak`), and installs caveman, superpowers and RTK's Claude hook where missing |
| Caveman | `/mynameisjev:caveman on` | Installs the [caveman](https://github.com/JuliusBrussee/caveman) plugin in Claude Code and, with sync on, adds its rules to Codex |
| Auto-transfer | `/mynameisjev:transfer on` | From 95% Claude usage, copies the session into a new Codex thread on every prompt and shows the `codex resume` command. Old copies stay in Codex until you delete them |
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
  OpenRouter and TypeSafe. `/mynameisjev:off` stops it.
- The previous message is kept locally in `~/.claude/mynameisjev/state.json`.
- Nothing else leaves your machine except the calls the optional features
  make (GitHub release checks, marketplace refreshes, Codex).

## Files

Everything the plugin writes lives in `~/.claude/mynameisjev/` (inside
`CLAUDE_CONFIG_DIR` when set): settings and stats, usage caches, the status
line launcher. Uninstalling the plugin leaves this folder; delete it to remove
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

## License

[MIT](LICENSE)
