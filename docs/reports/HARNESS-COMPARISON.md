# Harness comparison: what to base a RAM-frugal DSH CLI on

**Question (from the goal):** "find the best most RAM friendly agent harness online and base it on that."

**Answer, in one line:** keep the existing architecture — a thin terminal viewport over one DSH SDK runtime — because every measured byte of the session is inside the runtime's plugin tree, and no external harness can remove it while staying DSH-compatible.

## What was measured here

All figures are from this machine (Windows x64, Node v26.8.1). Sources and method: [RAM-BUDGET.md](RAM-BUDGET.md).

| Configuration | Runtime child, idle | Whole turn, peak tree |
|---|---:|---:|
| `sdk-minimal` (JSON-RPC + one adapter + shell + sessions) | ~83 MiB | 83.0 MiB |
| `sdk` (`dsh-base` + SDK server) | 172.2 MiB | — |
| `dsh-cli` (same + Desktop capability rows) | 171.1 MiB | ~250 MiB |
| DSH Desktop (8 Electron processes, idle) | — | 506–532 MiB |

Two facts fall out of this table:

1. **~90 MiB is `dsh-base`'s plugin tree.** Layering the Desktop provider/model/web rows on top costs roughly nothing.
2. **The client is the cheap part.** A `dsh-cli` turn is ~250 MiB, of which the runtime child is ~200 MiB; the Node viewport is ~50 MiB.

`npm run ram:check` puts the CLI's own incremental cost at ~4–5.7 MiB over an empty Node baseline (64 MiB ceiling enforced).

## Candidates considered

| Candidate | Language | Why it is attractive | Why it does not fit |
|---|---|---|---|
| **[rab](https://github.com/markokocic/rab)** | Rust | Lightweight, explicitly "inspired by pi"; multi-provider ([OI]/Anthropic/Gemini/Responses), crossterm TUI, tree-sitter AST tools, MCP over SSE/WS, Rhai scripting, JSONL sessions, compaction. ~43.6K lines agent + ~15.3K lines TUI. | Its own agent core, providers, tools, sessions and config. Adopting it means abandoning DSH profiles, DSH skills, DSH MCP wiring and DSH session history — the exact things this CLI exists to reuse. It is also a work in progress with no DSH adapter. |
| **[jcode](https://github.com/rothnic/jcode)** | Rust | Advertised as resource-efficient with a native TUI. | Same structural problem: a separate agent core. No DSH integration. |
| **`sdk-minimal` DSH profile** | JS (DSH) | Genuinely 83 MiB — the smallest measured DSH runtime. | It omits `llm-pi-ai`, `web`, `web-deepseek-api`, `agent-default-model` and `permission`, so the Desktop provider catalog and Search/Fetch providers **cannot be layered onto it** — the loader rejects those patch entries as "not found". Getting 83 MiB means giving up the synced capability set. |
| **Trimmed `dsh-base` overlay** | JS (DSH) | Tried: disable ~20 non-essential rows (telemetry, sqlite projection, plugin manager, PTC runtime, spill, etc.). | Disabling `authorization`/`deepseek-account` silently changed which credential resolved and broke authentication. The saving is real but not reachable safely without per-row verification that was not completed. |
| **This CLI + DSH runtime** | JS | Reuses every DSH capability; 183 tests; verified end-to-end (CLI, ACP/T3 Code). | The runtime child dominates and cannot be shrunk from the client side. |

## Why the language choice does not move the number

The goal asked for Rust/C "or the best RAM efficient language". The measurement says the language of the *viewport* is nearly irrelevant:

- A Rust viewport would replace a ~50 MiB Node process with a ~10 MiB native one — a saving of roughly 40 MiB.
- The ~200 MiB runtime child stays exactly where it is, because it is the thing that actually runs models, tools, skills and MCP.
- A Rust *agent core* would remove the runtime child only by reimplementing it, and then it would no longer be DSH.

So the realistic ceiling for "rewrite the client in Rust" is about 40 MiB out of ~250 MiB, i.e. ~16%, at the cost of a second toolchain, a second build, and a second renderer to maintain. No Rust/C/Go/Zig compiler is installed on this machine, so even that would start with a toolchain bootstrap.

This is why [ADR-001-stack.md](ADR-001-stack.md) chose the Node viewport and why that decision still holds.

## What would change the answer

- If DSH shipped a leaner runtime bundle that still carried provider/model/web rows, the runtime child would drop toward the 83 MiB measured for `sdk-minimal`. That is an upstream change, not a client change.
- If a future DSH release adds a cancel/session-close method, the CLI's process-kill workaround could go away, but that affects behaviour, not RSS.
- If the viewport's ~50 MiB ever became material (for example on a 256 MiB target), a native renderer becomes worth costing — but only after the runtime child is addressed, because it is 4× larger.

## Decision

**Keep the current architecture.** It is the only option that delivers DSH Desktop's models, providers, skills, MCP wiring and session history at ~250 MiB instead of ~520 MiB, and it does so without a second agent core. The alternatives either shrink a component that is not the bottleneck (native viewport) or discard the DSH integration that is the product (rab, jcode).

## Evidence limits

- The `sdk-minimal` and per-profile figures come from `npm run ram:runtime` with `DSH_CLI_RAM_PROFILE`; the turn figures come from `tests/ram/session-rss.ps1` sampling the process tree every 150 ms.
- rab and jcode were assessed from their published READMEs, not from a local build. Their RAM claims are therefore **not** independently measured here.
- No long tool-heavy session was measured; growth beyond a short turn is unquantified.
