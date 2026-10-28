# RAM budget: CLI and SDK process measurements

## CLI-only startup result

Measured on 2026-10-23 21:12 UTC, Windows (`win32` x64), Node v26.8.1. `npm run ram:check` ran three fresh processes for each case and reports median peaks.

| Process | OS peak RSS | 20 ms sampled peak | Empty-Node baseline | Increment above baseline |
|---|---:|---:|---:|---:|
| Empty Node baseline (same probe/flags) | 46.86 MiB | — | — | — |
| `node src/main.js --help` | 50.49 MiB | 50.48 MiB | 46.86 MiB | **3.63 MiB** |
| `node src/main.js --version` | 50.39 MiB | 50.38 MiB | 46.86 MiB | **3.53 MiB** |

**The only enforced RSS ceiling is at most 64 MiB incremental peak RSS** for the actual CLI Node process in these no-runtime commands. `npm test` runs the same CLI-path measurement once and fails if either increment exceeds the ceiling. This budget does not apply to the DSH SDK runtime or to an agent session.

## SDK-backed offline initialization result

Measured on 2026-10-23 21:20 UTC with the same Windows x64 / Node v26.8.1 host. `npm run ram:runtime` opened a real `SessionDriver` against the installed DSH SDK runtime, waited idle for 1.5 seconds, and closed it. It sent no prompt and did not request model generation.

| Process | RSS at idle sample | OS high-water RSS | 200 ms sampled peak |
|---|---:|---:|---:|
| SDK client harness (Node process) | — | 50.86 MiB | 50.85 MiB |
| DSH SDK runtime child | 172.30 MiB | 173.73 MiB | 172.72 MiB |

The initialize-to-ready time was 6.20 seconds; the runtime idle sample was 157 ms old when read. These are **separate per-process measurements**. Do not sum their high-water values into a total-agent RSS estimate: peaks need not coincide, Windows per-process RSS can double-count shared pages, and this harness does not include the interactive renderer.

`ram:runtime` uses a temporary isolated `DSH_HOME`, `HOME`/`USERPROFILE`, `APPDATA`, and `LOCALAPPDATA`; it does not inherit user DSH profile variables or credentials. It is an optional benchmark, not part of `npm test`, because it requires the installed DSH runtime.

## Where the runtime RAM actually comes from

Measured 2026-10-28 with `DSH_CLI_RAM_PROFILE=<name> npm run ram:runtime` (the harness reads that variable). The SDK runtime's footprint tracks **how many plugins the profile mounts**, not the model or the client:

| Profile | Mounted bundles | Runtime child, idle | Runtime child, peak |
|---|---|---:|---:|
| `sdk-minimal` | `dsh-sdk-minimal` only (JSON-RPC, one DeepSeek adapter, shell, JSONL sessions) | **~83 MiB** (measured during a real turn) | 83.0 MiB |
| `sdk` | `dsh-base` + `dsh-sdk-app` | 172.2 MiB | 173.9 MiB |
| `dsh-cli` | `dsh-base` + `dsh-sdk-app` + Desktop capability rows | 171.1 MiB | 172.7 MiB |

So ~90 MiB of the runtime is `dsh-base`'s plugin tree, and adding the Desktop provider/model/web rows costs roughly nothing on top of it.

**Why the CLI does not ship the lean profile.** `sdk-minimal` omits `llm-pi-ai`, `web`, `web-deepseek-api`, `agent-default-model` and `permission`, so the Desktop provider catalog and Search/Fetch providers cannot be layered onto it — the loader rejects those patch entries as "not found". Getting the 83 MiB figure means giving up the Desktop-synced models, providers and web tools, which is the thing this CLI exists to provide. A trimmed `dsh-base` overlay was attempted and abandoned: disabling `authorization`/`deepseek-account` changed which credential resolved and broke authentication. The measured saving is real but not reachable without dropping the synced capability set.

## Full-turn result (CLI + runtime child)

Measured on 2026-10-26 23:17 UTC with the same Windows x64 / Node v26.8.1 host, using `tests/ram/session-rss.ps1`. Each run submitted one real prompt (`Reply with exactly: PONG`) through `dsh-cli run` and sampled the whole Node process tree every 150 ms.

| Run | Elapsed | Peak tree RSS | Peak runtime-child RSS | Answer |
|---|---:|---:|---:|---|
| 1 | 10.8 s | 251.9 MiB | 200.2 MiB | PONG |
| 2 | 10.2 s | 249.9 MiB | 198.2 MiB | PONG |
| 3 | 9.4 s | 249.8 MiB | 198.4 MiB | PONG |
| 4 | 10.4 s | 250.8 MiB | 199.2 MiB | PONG |

The CLI's own share is the remainder — roughly 50 MiB, matching the CLI-only figure above. **The runtime child dominates: about 200 MiB of a ~250 MiB turn.** For comparison, DSH Desktop measured 506–532 MiB across its 8 Electron processes while idle on the same host.

This is the honest end-to-end number for a short turn. It is not a ceiling: a long tool-heavy session grows the runtime, and that growth is not measured here.

Reproduce with:

```powershell
pwsh -NoProfile -File tests/ram/session-rss.ps1
```

## Reproduction and method

- `npm run ram:check` measures the CLI `--help`/`--version` entry paths against an empty Node baseline. They return before resolving DSH context, reading a profile, or spawning the SDK runtime.
- `npm test` enforces the CLI-only 64 MiB incremental budget and checks that no npm dependency sections or installed root packages are added. The root `node_modules` currently contains only pnpm metadata markers, not installed packages.
- `npm run ram:runtime` uses `SessionDriver.open()` plus JSON-RPC `initialize` to boot the real runtime offline; it waits idle and does not call `prompt()`/`send()`. A preloader passed through `NODE_OPTIONS` samples the runtime child, while another preloader measures the harness process. The temporary home is deleted after the child exits. Set `DSH_CLI_RAM_PROFILE=<profile>` to compare profiles.
- Both commands use only Node/platform stdlib. No measurement dependency was added.

The probes use `process.resourceUsage().maxRSS` as the OS high-water figure (Windows reports it in KiB, converted to MiB) and sample `process.memoryUsage().rss` every 20 ms for CLI-only commands and every 200 ms for the runtime child. The OS high-water figure is used for peak reporting because short transient spikes can fall between samples. No elevated permissions or external process monitor are required.

## Limits and caveats

- **Coverage:** CLI-only figures cover the real `src/main.js` startup paths for help/version; the SDK-backed figure covers the actual runtime child initialized via `SessionDriver`, plus its harness process; the full-turn figure covers a real one-prompt turn including the runtime child. None of these is a long interactive session.
- **Not measured:** a long multi-turn interactive TUI session, tool-heavy workloads, image/attachment turns, or Desktop-vs-CLI equivalence on identical work.
- **Runtime-dominates caveat:** the SDK child reached 173.73 MiB OS high-water RSS in offline initialization and ~200 MiB during a real turn, far above the 3.4–3.7 MiB CLI-only startup increment. The runtime is the dominant RAM component; the CLI viewport is small.
- **Windows sampling limit:** the runtime's idle value is a 200 ms sample; the OS high-water figure is per-process and cannot be combined into a precise simultaneous process-tree total. CLI samples use a 20 ms interval, the turn measurement 150 ms.
- The `run` path no longer buffers the response: assistant text is written to stdout as it streams. The display transcript and retained event list are bounded (see `src/session/driver.js`).

See [ADR-RAM-REA.md](ADR-RAM-REA.md) for the architecture decision and its evidence boundaries.
