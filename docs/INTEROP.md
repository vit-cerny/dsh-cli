# Interoperating with dsh-cli

Use the CLI as a child process when another harness needs a DSH turn in the same working directory. It starts the `dsh-cli` profile when installed (falling back to `sdk`) and reuses DSH's persisted sessions, configured providers, skills and tools.

## One-shot invocation

PowerShell example:

```powershell
node C:\Users\witek\dsh-cli\src\main.js `
  --cwd C:\work\my-project `
  run "Review the changed files and summarize risks" `
  --timeout 5m
if ($LASTEXITCODE -ne 0) { throw "dsh-cli exited with $LASTEXITCODE" }
```

Capture stdout for the assistant answer. Progress and errors go to stderr. The command returns `0` on a completed turn, `1` on failure, `2` for invalid CLI usage, and `130` when interrupted. `--json` is currently for inventory commands only, not `run`.

For a persistent terminal session, start `node src/main.js --cwd <project>` and later reopen it with `node src/main.js resume <sessionId>`. `sessions` lists saved sessions. A unique ID prefix is accepted when it is unambiguous.

## Runtime protocol

For integrations that need structured session events rather than a one-shot text answer, DSH already exposes an SDK runtime over newline-delimited JSON-RPC on stdin/stdout. The CLI's transport uses that existing protocol; it does not introduce a second agent API. Relevant methods include `initialize`, `session/prompt`, `session/resume`, `session/wait`, `session/working-directory/get`, `session/working-directory/set`, and `shutdown`. Runtime facts arrive as `session.event`, `session.status`, and subagent notifications. See [the locally verified protocol notes](FINDINGS.md#L51-L105) before implementing a direct client.

The protocol currently has no cancel or session-close method. The CLI therefore terminates the runtime process when an interactive session exits or is interrupted. Await `initialize` before sending a prompt, and do not assume concurrent JSON-RPC responses arrive in request order.

## Profile and credential boundaries

- Live CLI turns boot `dsh-cli` when it is installed, else `sdk`. The `desktop` profile is managed by the Electron application; the CLI reads it for inventory but cannot launch it as a session runtime.
- `scripts/install-profile.mjs` derives `dsh-cli` from the Desktop patch by copying capability rows only. It is read-only towards Desktop and never touches credentials.
- Do not create a separate provider/skill/MCP copy for a calling harness. Configure those in DSH and select the intended profile.
- Credentials are resolved by the DSH runtime. Do not pass API keys as CLI arguments, include them in prompts, or persist them in caller logs.
- The profile selects the built-in DeepSeek Search/Fetch providers, but live requests returned HTTP 401 at the time of writing. Update the DSH credential before relying on web search.

## Status

This interface is suitable for existing agent harnesses that can spawn a process. It is not a stable, version-negotiated public protocol: use the DSH SDK protocol package as the source of truth when DSH changes its wire contract.
