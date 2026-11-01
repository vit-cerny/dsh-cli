# dsh-cli

A terminal client for an installed [[DSH]](https://github.com/deepseek-ai/deepseek-harness) (DSH) Desktop app.

It does not reimplement the agent. It drives the SDK runtime that Desktop already ships over JSON-RPC on stdio, so the models, providers, skills, MCP servers, sandbox and approval policy are the same ones the GUI uses. No Electron, no browser, no build step, no `node_modules`.

```
dsh-cli          # interactive terminal UI
dsh-cli run "why does the build fail?" --cwd . --timeout 5m
```

## Why it exists

`dsh` can boot a `web` profile, a `headless` profile, or an `sdk` profile. It cannot boot a terminal UI: the documented `dsh tui` profile has no package behind it (`npm view @deepseek-ai/dsh-tui-app` is a 404). This is that missing surface, built on the protocol DSH already exposes.

RAM is the second reason. A second agent core would mean a second copy of the whole runtime. One SDK runtime plus a thin renderer measures ~250 MiB for a live turn, of which the runtime child is ~200 MiB, against 506–532 MiB across 8 Electron processes for the Desktop app. See [docs/reports/RAM-BUDGET.md](docs/reports/RAM-BUDGET.md) for the measurements and [docs/reports/HARNESS-COMPARISON.md](docs/reports/HARNESS-COMPARISON.md) for why no external harness (including Rust options like rab and jcode) was adopted instead.

## Requirements

- Node.js 22.19 or newer
- DSH Desktop installed (it supplies the runtime packages and profiles)

The runtime is located automatically. If Desktop lives somewhere unusual, set `DSH_CLI_RUNTIME_BIN` to its `resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js`.

## Install

```powershell
git clone <this repo> dsh-cli
cd dsh-cli
node scripts/install.mjs
```

That does two things:

1. writes a launcher into `~/.dsh-cli/bin` (Windows) or `~/.local/bin` (macOS, Linux);
2. generates the `dsh-cli` DSH profile from your Desktop profile.

If the launcher directory is not on `PATH`, the installer says so and prints the line to add it. Run `node scripts/install.mjs --dry-run` first if you want to see the changes without writing.

The launcher is a wrapper, not a copy: `git pull` updates the installed command in place.

### Choose the command name

`dsh-cli` is always installed. To also type `dsh` or `deepseek`, ask for those names:

```powershell
node scripts/install.mjs --alias dsh,deepseek
node scripts/install.mjs --alias dsh --alias deepseek   # same thing
```

Each alias is a second launcher in the same directory pointing at the same entry point, so all of them stay in sync and `git pull` updates them together. Put them in a directory that is already on `PATH` with `--dir`:

```powershell
node scripts/install.mjs --dir "$env:USERPROFILE\bin" --alias dsh,deepseek
```

The names you choose are recorded in `~/.dsh-cli/installed.json`; that manifest is what lets `uninstall.mjs` remove exactly those files and nothing else in the directory.

Two things to know before aliasing `dsh`:

- **Desktop's own `dsh` shim wins inside DSH sessions.** Desktop prepends its `dsh` shim to `PATH` for the shells it spawns, and that shim boots the web profile. Your alias works in a normal terminal; inside a DSH session `dsh` still means Desktop's launcher. Desktop does not install a permanent `dsh`, so a normal terminal has no collision.
- **A name that another tool already owns is refused.** The installer checks the live `PATH`: if `dsh`, `node` or anything else already resolves in a directory ahead of the install target, it stops and names the file that won. Use `--force` to override deliberately. A dry run prints every path it would write.

Launcher names are validated: letters, digits, `.`, `_` and `-` only, and no Windows reserved device names.

### Why a second profile

The stock `sdk` profile speaks JSON-RPC but carries no Desktop capability rows. The `desktop` profile has them but cannot be booted from a terminal — the launcher rejects it with `profile "desktop" is managed exclusively by the Electron application`.

`dsh-cli` is therefore `dsh-base` + `dsh-sdk-app` plus the capability rows copied from your Desktop profile: default route, providers and models, web search/fetch, permissions, subagents. It never edits the Desktop profile, never reads credentials, and re-running it is a no-op when nothing changed.

Re-run it after changing models or providers in Desktop:

```powershell
node scripts/install-profile.mjs
```

Because the default route is copied from Desktop, re-running resets it to whatever Desktop uses. Pick another per invocation with `--provider`/`--model`, or switch mid-session with `/model`.

## T3 Code (ACP v1)

The installer also writes `~/.dsh/profiles/dsh-cli-acp`, a sibling profile that speaks **Agent Client Protocol v1** instead of the terminal JSON-RPC protocol. Use it when T3 Code should drive DSH.

```powershell
node scripts/install-profile.mjs --provider 7api --model gpt-6-luna
node scripts/register-t3-provider.mjs --dry-run   # show what it would add
node scripts/register-t3-provider.mjs             # add the provider to T3
```

`register-t3-provider.mjs` adds one `providerInstances` entry to `~/.t3/userdata/settings.json` (or `$T3CODE_HOME`):

| Field | Value |
|---|---|
| Instance id | `acpRegistry` |
| Driver | `acpRegistry`, source **Local command** |
| Executable | `C:\Program Files\nodejs\node.exe` |
| Arguments | `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js --profile dsh-cli-acp` |

It never touches project data, sessions or credentials, and leaves an existing entry alone unless you pass `--force`. Restart the T3 server, then pick **DSH CLI** as the provider.

T3 then creates sessions through DSH, streams replies, and uses the same tools/providers/skills as `dsh-cli`. Verified end-to-end: a T3 thread writes and reads a file through the DSH ACP profile.

The ACP bundle owns session defaults separately from `agent-default-model`, so the installer pins its route too (`- id: acp`). Without that, ACP sessions would start on the stock DeepSeek adapter even when the catalog points elsewhere.

## Uninstall

```powershell
node scripts/uninstall.mjs --dry-run   # see what would go
node scripts/uninstall.mjs
```

It removes exactly what the installer created: every launcher it wrote (including `--alias` names, read from `~/.dsh-cli/installed.json`), the `dsh-cli` profile, and (with `--purge`) session logs minted by this client. Keep the profile with `--keep-profile`. It never touches the Desktop profile, the credential store, other files in the launcher directory, or sessions written by Desktop or the runtime. Delete the checkout directory to finish.

## Commands

| Command | What it does |
|---|---|
| `dsh-cli` | interactive terminal UI |
| `dsh-cli run <prompt>` | one prompt, streamed to stdout, exit |
| `dsh-cli resume <sessionId>` | reopen a persisted session |
| `dsh-cli sessions` | list persisted sessions |
| `dsh-cli models` / `providers` | what the active profile configures |
| `dsh-cli skills` / `mcp` | what the runtime mounts |
| `dsh-cli plugins` | Desktop plugins vs. what this profile mounts |
| `dsh-cli plugins sync --apply` | copy missing capability rows into the CLI profile |
| `dsh-cli migrate` | which other harnesses are present |
| `dsh-cli migrate opencode` | plan an import (dry run) |
| `dsh-cli migrate opencode --apply` | perform it |
| `dsh-cli usage` | token and cost totals across the session store |
| `dsh-cli usage <sessionId>` | totals for one session |
| `dsh-cli doctor` | runtime, profile, route, plugins, skills in one pass |

Every command takes `--profile`, `--provider`, `--model` and `--cwd`. `--json` on the inventory and migrate commands emits machine-readable output.

Exit codes: `0` success, `1` failure, `2` usage error, `130` interrupted.

## The interactive UI

A full-screen layout on the alternate screen, in the shape opencode uses:

```
❯ why does the build fail
● pwsh({"command":"npm run build","workdir":"."})  ✓ 1.2s
  src/index.ts(12,4): error TS2304: Cannot find name 'foo'.

╭──────────────────────────────────────────────────────────────╮
│ ❯ fix that                                                   │
╰──────────────────────────────────────────────────────────────╯
idle · logfare/deepseek-v4.1-flash · 12.4k tok · $0.0031 · ~/proj
```

The transcript scrolls in a fixed viewport; the input box is a rounded border that grows with the prompt (up to the available height); the status bar is pinned to the last row. A tool call appears once and its glyph flips from `○` running to `● ✓ done` when the result arrives, rather than printing a second card.

The status bar is ordered by priority, and narrow terminals drop segments from the end instead of clipping the row. State (`idle` / `working…` / `interrupted`) always survives, because it is the one thing the bar exists to say; the working directory is the first to go.

Cost is priced from the model catalog installed with Desktop, split correctly between cached and uncached input. When a route has no catalog entry the bar says `cost unknown` rather than inventing a number. Third-party gateways are the common case, since a gateway's model id usually is not in the catalog. Declare the real rates once in `$DSH_HOME/dsh-cli-pricing.json` (USD per 1M tokens) and they are used:

```json
{
  "logfare/deepseek-v4.1-flash-1017": { "input": 0.28, "output": 1.1, "cacheRead": 0.03 },
  "logfare/*": { "input": 0.5, "output": 2.0 }
}
```

An exact `provider/model` key wins over `provider/*`, which wins over `*`. A malformed or absent file means "no override", never a failure to start.

Slash commands: `/help`, `/sessions`, `/model [<provider>/<model>]`, `/usage`, `/plugins`, `/migrate`, `/cwd`, `/clear`, `/quit`. Type `/` to get the completion menu; `Tab` accepts the highlighted entry and `Enter` always runs what you typed.

### Choosing a model

A profile can carry hundreds of models across a dozen providers, so `/model` with a typed id is the slow path. `/model` with no argument opens a searchable picker instead: type a few letters, arrow to the row, `Enter`.

```
 models  type to filter · Enter select · Tab favourite · Esc cancel
 ❯ deep
 ★ api7/gpt-6-sol                     GPT-6 Sol
 ★ api7/gpt-6-luna                    GPT-6 Luna
   logfare/deepseek-v4.1-flash-1017   DeepSeek V4.1 Flash 1017
   api7/kimi-k3                       Kimi K3
```

`Tab` stars the highlighted model and it sorts to the top, so the handful of routes you actually use stay reachable without searching at all. Favourites live in `$DSH_CLI_HOME/favourites.json` (default `~/.dsh-cli/`); a missing or corrupt file reads as "no favourites" rather than breaking the picker. `/sessions` opens the same picker over persisted sessions.

Keys: `Enter` send · `Ctrl+J` newline · `↑`/`↓` history · `Tab` accept completion · `Ctrl+O` expand the last tool output · `Ctrl+L` clear · `Ctrl+C` abort or quit · `Ctrl+D` quit.

Piping works: each line is one prompt, and each turn finishes before the next line is read. A pipe is not a terminal, so it gets the plain line-oriented output instead of the full-screen layout.

### Terminal readability

The palette uses the terminal's own 16 ANSI colours, so it inherits whatever contrast your terminal theme already provides rather than fighting it. Two things it does not leave to chance:

- **No colour-only signals.** Status is a glyph *and* a word (`● busy`, `○ idle`, `✗ error`), tool results carry `ok`/`failed`/`cancelled` labels, and every glyph has an ASCII fallback for a non-UTF-8 code page.
- **`DSH_CLI_NO_DIM=1`** drops the `dim` attribute entirely. SGR 2 fades text by an amount the terminal decides, which on a light background can fall below the 4.5:1 readable minimum — and it is used for real information (token counts, cost, memory), not decoration. With the switch on, that text stays at full contrast and reasoning blocks stay distinct through italics alone.

`NO_COLOR` and `FORCE_COLOR` are honoured as usual. `dsh-cli doctor` reports the route and profile; empty states say what is empty rather than rendering a blank screen.

## Migrating from another harness

```powershell
dsh-cli migrate                      # what is present
dsh-cli migrate opencode             # plan, writes nothing
dsh-cli migrate opencode --apply     # do it
```

Imports skills, MCP servers, sessions and projects. opencode is implemented today; the source layer is per-harness, so others can be added without touching the planner.

Safety rules are not configurable:

- dry run by default; writes need `--apply`;
- nothing is overwritten without `--force`, and every skip prints its reason;
- MCP secrets become credential *references* (environment variable names), never inlined values. Anything that looks like a literal secret is skipped and reported;
- sessions are copied, never moved, and only when the id is not already in the DSH store.

## Memory

Client memory is bounded rather than growing with the conversation: the display transcript is capped by entry count and total characters, one-shot `run` streams instead of buffering, the retained event list is capped, and stderr is capped.

```powershell
npm run ram:check     # CLI-only RSS for --help/--version
npm run ram:runtime   # the SDK runtime process on its own
npm run ram:session   # one real turn, whole process tree
```

## Limitations

These are protocol and surface facts, not unfinished work.

- **No graceful cancel.** The SDK protocol has no cancel or session-close method, so interrupting terminates the runtime process; any other session it owns dies with it.
- **No Desktop browser surfaces.** The visual workspace, session search timeline, image previews and settings panels are Web UI. The CLI does not attempt to reproduce them.
- **MCP and skills are whatever the profile configures.** The CLI reports them; it does not add servers itself.
- **Long sessions grow the runtime.** The measured ~250 MiB is a short turn; tool-heavy sessions grow the agent process, which the client does not bound.
- **Web search needs a live DeepSeek key.** The profile routes `web_search` to DeepSeek's `/v1/tools/search`, which bills against your API key; a rejected key returns HTTP 401. `web_fetch` is independent — the CLI profile sets `fetchProvider: http`, which fetches pages directly and needs no credential, so page reads keep working when search does not.

## Development

```powershell
npm test            # unit suite, about a second
npm run test:gui    # drives the real TUI in a terminal
```

On an unrestricted machine plain `node --test` works. Inside a sandbox that blocks child processes, the runner cannot spawn its per-file workers and fails with `spawn EPERM`; `--test-isolation=none` runs the same files in-process.

### GUI tests

The interactive UI cannot be tested through a pipe. `App` checks `stdin.isTTY && stdout.isTTY` and takes a different code path in line mode, so a piped test passes while the real screen is broken. Every bug this project shipped — the cursor arithmetic that erased the transcript on each keystroke, Enter never submitting, Ctrl+D hanging, a resize blanking the frame — was invisible to piped tests and obvious in a terminal.

`npm run test:gui` therefore allocates a Windows pseudo-terminal (`node-pty`), replays the byte stream into `@xterm/headless`, and asserts on the rendered cell grid: the input box is a closed rectangle, the status bar stays on the last row, the prompt glyph never smears, Enter clears the box, Tab accepts a completion (and cycles the header tabs when no menu is open), a tab's command output actually reaches the screen, a narrow terminal keeps its state marker, and Ctrl+D exits with code 0.

Both packages ship with DSH Desktop, so this adds no dependency to the CLI. The cases are skipped by default because each launches the application and its child runtime (about a minute for all nine); `DSH_CLI_GUI=1` enables them, which `npm run test:gui` sets for you.

Two things the harness deliberately cannot cover, both documented at the point of omission in `tests/helpers/pty-harness.js`:

- **Resize.** A Windows ConPTY never notifies the child, so `process.stdout.columns` keeps its original value and no `resize` event fires. The app's handler is covered by `tests/ui-resize.test.js`, which drives a fake TTY and fires the event directly.
- **Real model turns.** The cases drive the UI, not the provider, so they need no credential and cost nothing. The transcript path is covered by the unit tests instead.

`tests/gui/capture.mjs` prints one live frame, for when a case fails and the screen itself is the evidence.

Zero runtime dependencies, pure ESM, no build step. Architecture decisions and the protocol evidence behind them: [docs/FINDINGS.md](docs/FINDINGS.md), [docs/reports/ADR-001-stack.md](docs/reports/ADR-001-stack.md), [docs/reports/CLI-PARITY.md](docs/reports/CLI-PARITY.md), [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Licence

UNLICENSED — this is a personal tool, not a published package.
