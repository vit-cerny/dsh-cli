# DSH CLI — Verified Findings (read-only investigation, round 1)

All facts below were verified by reading files on disk or by running probes. Nothing here is assumed.

## 1. Existing installation (do NOT rebuild what already exists)

- DSH Desktop app checkout: `C:\Program Files\DSH Desktop\resources\app`
  - `package.json` → `dsh-plugin-desktop` v2.0.18
  - **311** packages under `node_modules\@deepseek-ai\`, all pinned `0.2.1-rc.2`
- `dsh` CLI is already installed and on PATH:
  `C:\Users\witek\AppData\Roaming\DSH Desktop\host-commands\desktop\...\bin\dsh.cmd`
- `dsh -V` → `0.2.1-rc.2`
- Profiles live in `C:\Users\witek\.dsh\profiles\`: `argusdev`, `desktop`, `web`, plus `sdk` (created during probing).
- `DSH_HOME` = `C:\Users\witek\.dsh`

## 2. Profile/bundle composition model (this is the extension seam)

From `@deepseek-ai/dsh-app-boot` (`PROFILE_TEMPLATES`):

```js
const PROFILE_TEMPLATES = {
  acp:        { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] },
  web:        { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
  headless:   { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
  sdk:        { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] },
  "sdk-minimal": { bundles: ["@deepseek-ai/dsh-sdk-minimal"] },
};
```

A profile directory contains:
- `cordis.yml` — always rewritten to `[]` (empty root; the tree is composed from patches)
- `cordis.patch.yml` — the user patch layer, applied AFTER all bundle layers
- `package.json` — holds `dsh.profile.bundles` array
- `pnpm-workspace.yaml` — `nodeLinker: hoisted`, `autoInstallPeers: false`

Patch layer is a top-level YAML array of loader patch entries: id-targeted config
overrides, `disabled` flags, and `insert:` lists. `!!js` expressions are allowed.

**Consequence:** a new terminal app is a new bundle package + a profile whose
`bundles` includes it. No fork of the agent core is needed.

## 3. `dsh tui` is NOT shipped — this is the actual gap

- `dsh --help` examples reference `dsh tui`, `dsh --profile tui --resume abc`,
  `dsh plugin --profile tui add <package>`.
- `npm view @deepseek-ai/dsh-tui-app` → **404**. No TUI package exists.
- `PROFILE_TEMPLATES` has no `tui` entry.
- ⇒ The `tui` profile name is reserved/documented but unimplemented. A Claude-Code-style
  terminal surface is the real missing piece.

## 4. The SDK wire protocol — PROVEN WORKING end to end

`@deepseek-ai/dsh-sdk-protocol` README + `dsh-sdk-jsonrpc-server/lib/index.js`:

Newline-delimited JSON-RPC 2.0 over stdio. Methods:

| Direction | Method | Payload |
|---|---|---|
| client→server | `initialize` | `{ cwd, provider, model, reasoningEffort?, maxTokens? }` → `{ serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } }` |
| client→server | `session/prompt` | `{ sessionId, contentBlocks }` → `{ messageId }` (durable enqueue receipt) |
| client→server | `session/resume` | `{ sessionId }` → `{}` |
| client→server | `session/wait` | `{ sessionId }` → `{}` (idle incl. descendants) |
| client→server | `session/working-directory/get` | `{ sessionId }` → `{ cwd }` |
| client→server | `session/working-directory/set` | `{ sessionId, path }` → `{ cwd }` |
| client→server | `shutdown` | — → `{}` |
| server→client | `session.event` | every persisted session fact |
| server→client | `session.status` | whole-agent `running`/`idle` |
| server→client | `subagent.started` | |
| server→client | `subagent.finished` | `{ provider, agentId, parentSessionId, childSessionId, status, stopReason, lastAssistantMessage? }` |

### Live probe result (verbatim, reproducible)

Command: spawn `node <app>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile sdk`,
write `initialize` then `session/prompt` on stdin.

```
INIT OK after 3972 ms: {"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}
EVT: {"type":"agent/inbox/spliced","seq":3,...}
STATUS: {"sessionId":"probe-1","status":"running"}
EVT: {"type":"turn/start","seq":4,...}
EVT: {"type":"step/start","seq":6,...}
EVT: {"type":"system/message","seq":7,... "You are an AI agent powered by DeepSeek Harness..." }
EVT: {"type":"user/message","seq":8,...}
EVT: {"type":"request/header","seq":12,"data":{"header":{"config":{"provider":"deepseek-official","model":"deepseek-flash","maxTokens":256000,"reasoningEffort":"high"},"tools":[...]}}}
EVT: {"type":"assistant/message","seq":16,... "text":"PONG"}
EVT: {"type":"turn/end","seq":18,"data":{"turn":1,"reason":{"kind":"completed"}}}
STATUS: {"sessionId":"probe-1","status":"idle"}
```

**This is the decisive result.** A ~40-line thin client drove a full DSH agent
session: the runtime mounted the complete tool registry, injected the skill
catalog into the system prompt, resolved provider/model route, and streamed
structured events. No Electron, no browser, no HTTP server.

⇒ The RAM-friendly architecture is a **thin viewport over one agent core**,
not a reimplementation.

### Protocol caveats (from README, authoritative)

- No version negotiation; `serverInfo.version` is `0.0.1`, clients do not verify.
- **No cancel / no session-close method** — abandoning a turn means killing the process.
- server→client *requests* are unused capability (reserved for approvals).
- `initialize` must complete before any `session/prompt` (enforced; probe confirmed
  the `SDK server is not initialized` error when racing).
- Requests may be dispatched concurrently — do not assume ordering; await handshake.

## 5. Web search: shipped provider ≠ the documented Search API

You asked to add `https://api-docs.deepseek.com/guides/search` globally.
What actually ships differs:

- Desktop profile config (`~/.dsh/profiles/desktop/cordis.patch.yml`):
  ```yaml
  - id: web
    name: "@deepseek-ai/dsh-web"
    config:
      searchProvider: deepseek-search-api
      fetchProvider: deepseek-fetch-api
  ```
- `@deepseek-ai/dsh-web-search-deepseek` README states its endpoint is the
  **Anthropic-compatible** base `https://api.deepseek.com/anthropic/v1`
  with `/messages` appended (env `$DEEPSEEK_SEARCH_BASE_URL`).
  Credential: `apiKeyEnv: DEEPSEEK_API_KEY`, sent as both `x-api-key` and
  `Authorization: Bearer`.

The documented API you linked is different — raw JSON:

- `POST https://api.deepseek.com/v1/tools/search`
  body `{ query, count=10, ori_question?, localization?, need_content=false }`
  → `{ results: [{ rerank_score, title, url, snippet, summary, content, site_name, site_icon, date, authority }] }`
  - query 1–128 chars, count 1–50
  - operators: `site:`, `-site:`, `-`, `-"…"`, `"…"`, `lang:`, `after:`, `before:`
- `POST https://api.deepseek.com/v1/tools/fetch`
  body `{ url }` (≤8192 chars, http/https, no userinfo) → `{ title, content }` (Markdown)
- Auth: `Authorization: Bearer <DEEPSEEK_API_KEY>`, `Content-Type: application/json`
- Errors: OpenAI-compatible envelope; 400/401/402/403/404/408/413/429/500/504
- QPS: search 100, fetch 25 (per account; fetch also per-domain)
- Billing $0.75 / 1000 successful requests each; free until 2026-11-01 Beijing time

⇒ To honour the request literally, a **new web provider plugin** implementing
`/v1/tools/search` + `/v1/tools/fetch` must be written and registered as
`searchProvider` / `fetchProvider`. Config-only change cannot do it.

## 6. Provider/model inventory found on this machine

`~/.dsh/profiles/desktop/cordis.patch.yml` configures `@deepseek-ai/dsh-llm-pi-ai`
with a `logfare` provider (OpenAI-completions API at `https://logfare.ai/v1`)
carrying ~25 models (GLM 5.3, GPT-5 family, DeepSeek V4.1 Flash/Pro, Kimi K2.6,
Claude Haiku 5.5, Qwen3.8, Gemma 4, MiniMax M3.1…), and sets the default route to
`provider: our-free-model`, `model: experiential/deepseek-v4.1-flash-1017`,
`reasoningEffort: deep`.

**Sync requirement:** the CLI must read the SAME profile patch layer and the same
credential store, so providers/models/skills/MCPs do not fork into two truths.

## 7. Credentials state — BLOCKER for "use my API key"

`C:\Users\witek\.dsh\.credentials.yaml` today contains only:
- `client-connection/browser-session`
- `deepseek-account-platform/device`

There is **no `DEEPSEEK_API_KEY` record**, and no `DEEPSEEK_API_KEY` in the process
environment. The documented Search/Fetch API requires a bearer key. The key must be
supplied (env var, or a `dsh-credentials` record) before live search can be verified.
Note this is distinct from the `deepseek-account-platform` device token used by the
shipped Anthropic-compatible search path.

## 8. Capability inventory that must appear in the CLI to match Desktop

Skills: `C:\Users\witek\.dsh\skills` holds ~59 skill directories (incl. office-xlsx,
pptx, docx, pdf, browser-skill, second-brain, cap…) — the SDK probe showed the
runtime already injects `<available_skills>` into the system prompt, so skills are
inherited automatically by any SDK client. **No per-client work needed.**

MCP: `dsh-mcp-config` plugin is installed; server config lives in the managed block
of `~/.dsh/cordis.patch.yml`; tools surface as `mcp__<server>__<tool>`. Because MCP
is a runtime plugin, SDK clients inherit configured MCP servers the same way.

## 9. RAM-friendly base — researched options

Evidence gathered from public comparisons (treat as indicative, not benchmarked here):

- Rust single-binary harnesses are the low-water mark in this class; Codex CLI
  (codex-rs) and jcode are the commonly cited examples, with jcode claiming
  ~14 ms to first frame and the lowest RSS in class, versus Node-based Claude Code
  measured in hundreds of MB.
  [openhuman harness comparison](https://github.com/senamakel/openhuman/blob/e28044872abd9b8321590cc2b528e7cc1a93a5f6/docs/harness-comparison-2026-07-22.md),
  [jcode notes](https://raw.githubusercontent.com/weijt606/ai-agent-map/5c48c0484021787a89fbea36f742f95a7897abba/agents/jcode.md)

**Constraint discovered on THIS machine: no Rust toolchain.** `cargo`/`rustc` are
absent (checked `~/.cargo/bin`, `Program Files\Rust*`, `LocalAppData\Programs\Rust*`;
`winget` and `go` also unavailable). Node 26.8.1 and pnpm 11.8.0 are present.

**Architectural conclusion (the actual RAM win):** RAM cost in this system is
dominated by the *agent runtime* (Node + 311 packages + tool registry + skill
catalog), not by the terminal renderer. Duplicating the runtime in Rust would add a
second copy of everything. Running ONE `dsh` SDK runtime process and rendering it in
a thin client means total RSS ≈ one runtime, regardless of how many viewports attach.

So: thin client (low cost to build, zero runtime duplication) + optionally a native
renderer later. A from-scratch Rust agent core is explicitly the *worst* option for
the user's stated goal, because it would re-earn providers/skills/MCP/sessions that
already work.

## 10. Interop requirement (user's added constraint)

"let other agent harnesses start a new DSH CLI session on the same project."

Two already-shipped surfaces serve this, and both are cheaper than inventing one:
- `dsh-sdk-app` / `dsh-sdk-jsonrpc-server` — this very JSON-RPC stdio protocol.
  Any harness that can spawn a child process and write JSON lines can drive it.
- `dsh-acp-app` — Agent Client Protocol bundle (`dsh-acp`, `@agentclientprotocol/sdk`
  1.4.0 in devDeps), the emerging cross-harness standard (Zed et al.).
- Also `dsh headless "task"` for one-shot non-interactive invocation.

⇒ "Callable by other harnesses" = ACP + SDK stdio + headless one-shot, all reusing
the same session store and project working directory.
