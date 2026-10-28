# CLI vs Desktop coding-session parity

Scope: user-facing capabilities relevant to coding sessions, compared from the local DSH Desktop package composition/docs and this CLI's code. “Inherited from SDK” means the SDK runtime has the capability and the CLI delegates to it; it is not proof that every Desktop/Web behavior is reproduced. Package presence alone is not counted as implementation.

Statuses: **implemented** = CLI explicitly exposes it and it was exercised; **inherited from SDK** = runtime behavior used by CLI; **inventory-only** = CLI reports configuration, does not operate the feature; **unavailable** = current CLI/session protocol has no equivalent; **unverified** = code/config indicates a possibility but operation or equivalence is not proven.

| Capability | Status | Evidence and boundary |
|---|---|---|
| Interactive coding prompts, streaming answer and tool activity | implemented | CLI entry dispatches the TUI and one-shot `run` ([`src/main.js`](../../src/main.js)); the UI renders assistant/tool events ([`src/ui/renderer.js`](../../src/ui/renderer.js)). Verified live: prompts stream, tool cards render, `run` writes the answer to stdout. |
| File read/write/edit, shell, skills, web tools, subagents, compaction | inherited from SDK | The `dsh-cli` profile mounts `dsh-base` + `dsh-sdk-app` plus the Desktop capability rows ([`scripts/install-profile.mjs`](../../scripts/install-profile.mjs)). Live checks: a turn wrote and read back a file through the `write`/`read` tools, and `web_search`/`web_fetch` returned real results. |
| User approval and workspace sandbox | inherited from SDK | Base owns sandbox/approval policy; the CLI copies the Desktop `permission` row. The CLI has no separate approval UI, so behaviour follows the profile and the runtime. |
| Persisted sessions, resume and working-directory control | implemented | `sessions`, `resume`, `/cwd` ([`src/cli/store.js`](../../src/cli/store.js), [`src/cli/interactive.js`](../../src/cli/interactive.js)). Resume rejects an unknown id via the runtime. Verified live. |
| Providers, models, skills and MCP configuration visibility | inventory-only | `models`/`providers`/`mcp` parse the profile patch and `skills` lists skill directories ([`src/cli/info.js`](../../src/cli/info.js)). Current inventory: 8 routes, 402 models, 60 skills, 0 configured MCP servers. Names are not proof of runtime availability. |
| Session transcript/history on resume | implemented | The SDK loads history into the agent but does not replay it as events, so the CLI reads the same persisted log: [`readSessionHistory`](../../src/cli/store.js) walks Zstandard frames (DSH appends one frame per batch, so a single-shot decompress yields only the header) and rebuilds user/assistant messages, bounded by message count, compressed bytes and decompressed bytes. Rendered on resume in [`src/cli/interactive.js`](../../src/cli/interactive.js); tests in [`tests/session-store.test.js`](../../tests/session-store.test.js). Verified live: resume printed 4 prior messages. |
| Model switching mid-session | implemented | `/model <name>` or `/model <provider>/<name>` ([`src/ui/commands.js`](../../src/ui/commands.js), [`src/cli/interactive.js`](../../src/cli/interactive.js)). The protocol has no re-route method and the live runtime holds the session write lock, so switching closes that runtime and opens a new one on the new route with a fresh session id; the previous session stays on disk for `resume`. Verified live across providers (`deepseek-official` → `logfare`). |
| Graceful per-turn cancel / retain runtime after abort | unavailable | The SDK protocol has no cancel or per-session close ([`docs/INTEROP.md`](../INTEROP.md)); the driver terminates the runtime process ([`src/session/driver.js`](../../src/session/driver.js)). This is a protocol limitation, not an unfinished CLI path. |
| Desktop Web UI: visual workspace, session search/timeline, file/image previews, settings panels, plugin/profile management | unavailable in this CLI surface | Desktop Web composes browser UI and workspace/settings controllers. The CLI is a terminal renderer plus read-only inventory. This classifies the interface, not what the SDK agent can do underneath. |
| ACP/client interoperability | unverified | An ACP bundle ships with Desktop, but this CLI implements SDK JSON-RPC, not ACP. Package presence does not establish that the CLI exposes it. |
| Runtime resource footprint vs Desktop | implemented (measured) | `npm run ram:check` (CLI-only), `ram:runtime` (runtime child) and `ram:session` (whole tree for one real turn). Measured: ~4 MiB CLI increment, ~250 MiB for a full turn of which the runtime child is ~200 MiB, against DSH Desktop's 506–532 MiB across 8 Electron processes. See [`docs/reports/RAM-BUDGET.md`](RAM-BUDGET.md). |

## Highest-priority gaps

1. **Control parity:** graceful per-turn cancellation and runtime reuse need SDK protocol support (a cancel or session-close method). Until then interrupting kills the runtime and any session it owns.
2. **Desktop browser surfaces:** workspace preview, session search/timeline, image previews and settings panels are Web UI, not terminal features; the CLI does not attempt them.
3. **MCP:** the profile currently configures no MCP servers, so `mcp` reports an empty list. Adding one in Desktop and re-running `install-profile.mjs` carries it into the CLI profile.
4. **Long-session RAM:** the measured ~250 MiB is a short turn. Tool-heavy or long sessions grow the runtime; that growth is not bounded by the CLI.

## Evidence basis

- REA static analysis of the installed DSH runtime (`@deepseek-ai/dsh`): evidence id `ev_1c873db31f46369b2364802ebf67bed763976a5128101eb06311b274492ecd3f`, root artifact SHA-256 `3cdcfe84f49f90f1fc30249d03874f9b5538c981d43d630e22862a8a647d835f`, 87 graph nodes, 149 edges, 7 parsed JavaScript files, 3,533 AST nodes, **0 integrity contradictions**. Static candidates only — it does not prove runtime behaviour.
- Live probes through `dsh-cli` on this machine: one-shot turn, tool use, web search, web fetch, resume with history, cross-provider model switch.

This is a source-and-probe based comparison, not a claim of full Desktop parity. No Desktop profile, credential or runtime install was modified.
