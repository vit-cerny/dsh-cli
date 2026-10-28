# ADR-001: RAM-frugal DSH CLI stack and REA assessment

**Status:** Accepted  
**Decision date:** 2026-10-23  
**Scope:** CLI process model and renderer, not Desktop runtime or global profile configuration.

## Decision

Build the terminal surface as a dependency-free Node.js ESM client that starts exactly one existing DSH SDK runtime child for each CLI session and speaks its newline-delimited JSON-RPC 2.0 protocol over stdio. Render events incrementally: the terminal viewport must retain only the visible window and bounded working state, not an unbounded transcript. Reuse the runtime's profile, session persistence, providers/models, tools, skills, and MCP configuration rather than recreating them in a second agent core. Keep model/provider selection profile-scoped and read shared Desktop profile state instead of copying credentials or maintaining a parallel registry.

The CLI declares **zero npm runtime dependencies**. Node built-ins implement the client, input, rendering, process management, and bounded transcript behavior. Add cold-start and steady-state RSS checks as CI budget tests; CI must fail when the agreed budget is exceeded. One runtime plus one small viewport is the intended process/RAM model. Do not claim a quantified RAM saving until those benchmarks are executed on a defined host and baseline.

This choice does not attempt to make the agent runtime itself small. It prevents the CLI from adding a duplicate runtime. A native renderer is a later option only if measured renderer RSS is material; a Rust/C agent core is not justified because it would duplicate runtime responsibilities and the machine has no Rust/C toolchain installed.

## Decision table

| Option | RAM / process consequence | Runtime and ecosystem consequence | Decision |
|---|---|---|---|
| Thin Node ESM client + one DSH SDK JSON-RPC child | One agent runtime, one bounded terminal viewport; no second copy of the agent core | Reuses the proven SDK wire protocol and existing DSH profile capabilities; no npm runtime dependencies in CLI | **Choose** |
| Reimplement agent core in Rust/C | Adds a separately maintained agent core; does not remove the existing DSH runtime if compatibility with its profiles/capabilities is required | No compiler toolchain is installed; requires bootstrapping tooling and re-earning providers, tools, skills, MCP and session persistence | **Reject** |
| Electron/embedded web renderer | Adds a browser/renderer footprint to a terminal use case | Existing Desktop is a shell, not required to drive SDK protocol | **Reject** |
| Rust/native terminal renderer only | Potentially lowers renderer overhead, but leaves the DSH runtime as the dominant process | Adds a toolchain/build and maintenance burden before evidence that renderer cost matters | **Defer; benchmark first** |
| npm terminal UI framework/dependency tree | Adds package and dependency/runtime cost | Not needed for a basic terminal viewport; conflicts with zero-dependency goal | **Reject for initial CLI** |

## Executed evidence

Findings and probes referenced below were collected from the local machine, with detailed investigation in [FINDINGS.md](../FINDINGS.md).

- **Existing runtime protocol works:** the SDK process `node <DSH app>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile sdk` accepts newline-delimited JSON-RPC 2.0 over stdin/stdout. The live probe initialized in 3,972 ms, prompted a session, observed a running-to-idle transition, and received `PONG`. Its events included the resolved provider/model and tool registry. This was a roughly 40-line client, no Electron renderer or HTTP server. See [FINDINGS.md, SDK probe](../FINDINGS.md#L51-L105).
- **Capability reuse:** the same runtime injects the mounted skill catalog and tools; MCP tools and profile providers are runtime configuration. Desktop and SDK surfaces therefore need not fork these inventories. See [FINDINGS.md, inventory](../FINDINGS.md#L144-L195).
- **Compiler/toolchain constraint:** the documented local check found no `cargo`, `rustc`, C compiler, Go, Zig, or `winget`; Node 26.8.1 and pnpm 11.8.0 were present. `rustup-init.exe` availability does not change the choice: installing a compiler would add substantial tooling while leaving the duplicated-core problem intact. See [FINDINGS.md, RAM research](../FINDINGS.md#L197-L221).
- **REA compatibility check (executed; no toolchain/profile changes):** installed versions were Node `v26.8.1` and npm `11.19.0`. The official [REA README](https://github.com/morluto/rea) specifies Node 22.23.4+, 24.22.1+, or **26.12.1+**, plus npm. Node 26.8.1 is below its supported 26 line, and 22/24 are not the active Node installation. Accordingly `npx rea-agents@latest analyze-javascript-application ...` was tried without installing globally or changing Node. It completed with exit code 0 against the shipped DSH runtime package at `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh`. This is evidence that the available REA command did run in this environment despite its documented version mismatch; it is **not** a compatibility guarantee. The command analyzed the directory statically and did not start DSH or alter the profile/install.
- **REA result, bounded summary:** REA Evidence ID `ev_3765c67a3e9a4156bfb848f0e81cdac3f7fa23a33cf28c50ab44712988e3de2b`, root artifact SHA-256 `3cdcfe84f49f90f1fc30249d03874f9b5538c981d43d630e22862a8a647d835f`, analyzer `REA JavaScript application analyzer` version `1`, graph schema `JavaScriptApplicationGraph`; 86 graph nodes, 148 edges, and zero reported integrity contradictions. It selected 8 JS/package files for semantic inspection; the graph reported static imports/exports and module relationships. REA output explicitly limits these to static candidates, not proof of runtime execution. The generated evidence JSON was 4,562,011 bytes in the temporary subprocess output log; the target's full installed application directory was much larger (27,930 files, ~809 MB), so the initial full-app scan was stopped and the bounded `@deepseek-ai/dsh` package was analyzed instead. The very large detailed JSON is temporary tool output, not a product artifact.
- **Measured CLI-only RSS check:** `npm run ram:check` completed successfully on Windows x64 / Node `v26.8.1`, three repetitions each. Its baseline peak was 46.902 MiB; `--help` peaked at 50.406 MiB (incremental 3.504 MiB) and `--version` at 50.414 MiB (incremental 3.512 MiB), against a 64 MiB ceiling. The check explicitly measures only the CLI process for help/version **without a DSH profile or runtime child**. This is a measured CLI-only signal, not the complete session RSS, and cannot establish total runtime/renderer savings. See `npm run ram:check` output recorded during this ADR task and the benchmark script `tests/ram/benchmark.mjs`.
- **Steady-state/full-session gap:** the current check is not a cold-start/steady-state measurement of the child runtime + interactive CLI, and the RSS check does not yet enforce the requested full-session budgets. Add reproducible cold-start and steady-state process-tree RSS budgets and make CI fail on regression before claiming a quantified complete-session RAM win.

## REA (Reverse Engineer Anything): applicable scope and limits

[REA](https://github.com/morluto/rea) is a reverse-engineering MCP server and CLI, not an agent runtime or a suitable foundation for this CLI. Its README describes static JavaScript/Electron application analysis (modules, imports, source maps, routes/IPC relationships and native add-on links) and optional runtime observation. Those methods can help investigate the shipped DSH JavaScript; they can also be complemented by reading its on-disk JS directly. The static analysis was run as a research check above, with the tool's explicit limits preserved.

REA's native-binary capabilities—decompilation, assembly, symbols/calls and native analysis-provider workflows—are not applicable to the DSH runtime package analyzed here: the DSH runtime is plain JavaScript on disk, not a native binary requiring a native decompiler. This does not preclude analyzing any separate native Electron add-on or executable if a specific investigation later establishes one; it is simply outside this evidence run.

`npx rea-agents setup` is **not relevant to product setup**. README describes it as an interactive operation to register REA's MCP server and matching workflows with a supported agent. This CLI does not need REA in its runtime, and the analysis was run directly with the REA CLI. Do not run setup for this product or modify DSH agent/profile registrations as part of the CLI. REA may be used as an optional external research tool, not as a product dependency.

## Explicitly not built

- **No replacement agent core** in Rust, C, or Node: the SDK runtime already supplies the agent and the required shared capabilities; a parallel core would duplicate maintenance and configuration.
- **No Electron renderer, web server, or browser shell** for the terminal viewport: the stdio JSON-RPC interface makes these unnecessary.
- **No npm runtime dependencies or TUI framework**: Node built-ins are sufficient for the initial viewport and this preserves the zero-dependency constraint.
- **No REA dependency, bundled executable, or setup registration**: REA is an optional external research tool, not part of the user-facing CLI.
- **No native-binary reverse engineering of DSH JS**: binary RE is the wrong analysis mode for the plain-JS runtime package.
- **No second transcript/session store or copied provider/credential registry**: persisted session facts and configured capabilities come from the SDK runtime/profile. The renderer will keep bounded viewport state only.
- **No complete-session RAM savings assertion**: the available CLI-only help/version measurement passed, but did not include DSH runtime process RSS or interactive steady state. Process-tree cold-start and steady-state CI checks must establish and enforce those limits first.
- **No modification to the installed DSH application, user profiles, credentials, or global agent setup** as part of this architecture decision.

## Consequences and follow-up

1. Keep one SDK runtime child per CLI session and ensure process cleanup is explicit; the protocol currently has no session cancel/close method, so process termination is the escape hatch. See [FINDINGS.md, protocol caveats](../FINDINGS.md#L98-L105).
2. Keep terminal rendering incremental and bound retained messages/content independently of the runtime's durable history.
3. Implement reproducible cold-start and steady-state RSS budget tests. Set limits from measured CI/target-machine baselines; fail CI on regression.
4. Treat REA output as static evidence with conservative interpretation. Use direct source reading and runtime protocol probes to corroborate behavior.

## References

- [Local verified findings](../FINDINGS.md)
- [REA official repository and README](https://github.com/morluto/rea)
