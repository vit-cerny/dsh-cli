# Architecture decision: reuse the DSH SDK runtime

**Status:** Accepted for the CLI prototype · **Date:** 2026-10-23

## Decision

Keep the CLI as a dependency-free Node ESM terminal client over DSH's existing SDK JSON-RPC process. Do not port the agent core to Rust or C. A second runtime would duplicate DSH's providers, tools, skills, MCPs, and session machinery; the larger RAM cost is the agent runtime, not the thin terminal renderer. A native renderer is only worth revisiting if RSS measurements show the CLI layer itself is material.

Keep Desktop inventory read-only and explicitly profile-scoped. The Desktop profile is Electron-managed; live CLI sessions use the SDK profile. This avoids pretending the Desktop Electron runtime is a standalone CLI backend.

## REA assessment

[morluto/rea](https://github.com/morluto/rea) is a reverse-engineering MCP/CLI for inspecting applications and binaries; it is not an agent-harness implementation to base this CLI on. Its static JavaScript/Electron analysis and runtime observation are relevant methods for examining DSH.

REA was **not executed** during this assessment: `rea` is not installed, and the host is Node v26.8.1 while the repository README currently lists Node 26.12.1+ (or supported 22.x/24.x releases). No package was installed and no runtime was upgraded. The local DSH protocol and bundle findings below were already collected from the checkout and a prior SDK probe; they should not be misrepresented as an REA-generated report. Run REA after providing a supported Node version if its evidence is still needed.

## Evidence and limits

- The local investigation documents the SDK's NDJSON JSON-RPC methods and a live session probe in [FINDINGS.md](../FINDINGS.md#L51-L105).
- The same investigation records that the Desktop profile is Electron-only, while SDK is the CLI runtime profile, and that mounted skills/MCP tools come from the DSH runtime rather than a second implementation ([FINDINGS.md](../FINDINGS.md#L16-L49), [FINDINGS.md](../FINDINGS.md#L186-L195)).
- The current CLI is pure ESM with no declared runtime dependencies ([package.json](../../package.json#L1-L25)); `npm test` passed 59 tests including the CLI RSS budget check.
- A CLI-only peak RSS sample is now recorded in [RAM-BUDGET.md](RAM-BUDGET.md): 3.41–3.52 MiB incremental on help/version. DSH runtime-child, total-agent, and Electron RSS remain explicitly unmeasured.
- The built-in Desktop Search/Fetch provider is already selected, but its configured credential returned HTTP 401 in one search and one fetch attempt. The provider also has offline-verified input/timeout/error-sanitization gaps. No credential or Desktop profile was changed.

## Consequences

- Continue extending the thin SDK client and keep its no-dependency boundary unless a measured gap justifies a dependency.
- Do not advertise successful live prompts or working Search/Fetch until valid credentials are supplied and one successful smoke test is run.
- Address provider hardening as a separate, reviewable change to the shipped provider/plugin integration; do not register duplicate IDs or patch the installed DSH application in place.
