# Module contracts

Interfaces the new features are built against. Written before the code so parallel
work cannot drift. Every module here is pure ESM with no runtime dependencies.

> Status: all five modules are implemented and covered by tests. Where the
> implementation corrected a contract, the correction is recorded inline and in
> the section it affects.

## 1. Usage accounting — `src/session/usage.js`

Aggregates the provider-reported token counts and turns them into money.

The runtime reports per-message usage on `assistant/message`:

```json
{ "inputTokens": 4005, "outputTokens": 133, "totalTokens": 20522, "cacheReadTokens": 16384 }
```

`totalTokens` is the whole prompt size for that request (cached prefix included), so
it is **not** additive across steps. `inputTokens` and `outputTokens` are the
additive quantities; cost is derived from the cached/uncached split.

```js
export class UsageMeter {
  constructor({ provider, model, pricing })
  record(usage)        // -> void; ignores null/invalid, never throws
  get totals()         // -> { inputTokens, outputTokens, cacheReadTokens, totalTokens, calls, costUsd, priced }
  get priced()         // -> boolean; false when no rate table matched
  reset()
}

export function lookupPricing({ provider, model }, options) // -> { input, output, cacheRead, cacheWrite } | null
export function formatUsage(totals)  // -> "12.3k in · 4.1k out · 9.2k cached · $0.0042"
export function formatCost(costUsd, priced) // -> "$0.0042" | "cost unknown"
```

`pricing` rates are USD per 1,000,000 tokens. `lookupPricing` reads the installed
pi-ai catalog under the DSH app (never the network), matching by model id and
falling back to a profile-declared override; it returns `null` when nothing
matches, and the meter then reports `priced: false` rather than inventing `$0`.

### Corrections found during implementation

Verified against 4,923 real usage records in the session store:

- `totalTokens` is **not** reliably `inputTokens + cacheReadTokens + outputTokens`
  (220 of 4,897 records disagree). It is never summed, and the meter derives its
  own total from the three counters.
- `cacheWriteTokens` is present in the wire data and always `0`; it is not counted.
- A profile cannot declare rates: the installed `dsh-llm-pi-ai` config schema has
  no cost field. The "profile-declared override" above is therefore realised as
  `$DSH_HOME/dsh-cli-pricing.json` (`src/cli/pricing-config.js`), consulted last,
  after the catalog. Keys are `provider/model`, `provider/*`, `model`, or `*`.

`record()` must be called **once per assistant message**, not once per normalized
event: `normalizeContentBlocks` fans one message out to one event per content
block, each carrying the same usage record.

## 2. Resource sampling — `src/session/resources.js`

```js
export function sampleRss()            // -> { rssBytes, heapUsedBytes, externalBytes, at } | null
export function sampleRuntimeRss(pid)  // -> number | null; best-effort, may be null
export function formatBytes(n)         // -> "84.2 MiB"
export class ResourceSampler {
  constructor({ intervalMs = 2000, runtimePid, now, rss })
  start()            // idempotent
  stop()
  get snapshot()     // -> { clientRss, runtimeRss, totalRss, at }
}
```

Client RSS comes from `process.memoryUsage()`, which is always available.
Runtime RSS needs an OS probe; on Windows that is `tasklist`, elsewhere `ps`.
Every probe is bounded, non-fatal, and cached between samples: a missing probe
yields `null` and the status bar shows client RSS only. `intervalMs` defaults to
2000 because a status line does not need more, and a per-second process spawn
would cost more than it displays.

## 3. Top toolbar — `src/ui/toolbar.js`

A single row above the transcript, repainted in place, plus the picker it opens.

```js
export class Toolbar {
  constructor({ width, theme, interactive })
  render(model)   // -> string (one row, already width-clipped, no trailing newline)
  pick(model)     // -> string[] rows for the open picker
}
```

`model` shape (all fields optional; absent fields are omitted from the row):

```js
{
  sessionTitle: string,   // label of the active session
  sessions: number,       // how many sessions exist for this workspace
  provider: string,
  model: string,
  tokens: number | null,
  cost: string | null,    // pre-formatted, e.g. "$0.0042"
  rss: string | null,     // pre-formatted, e.g. "250 MiB"
  status: 'idle' | 'busy' | 'error',
}
```

Row layout, left to right: `[session ▸ title] · model · tokens · cost · rss · status`.
Segments are dropped from the right as width shrinks, so the session label — the
one thing the user changes most — always survives.

## 4. Plugin menu — `src/cli/plugins.js`

Reads what Desktop has installed and what the CLI profile will actually mount.

```js
export function readInstalledPlugins(dshHome)   // -> PluginRow[]
export function readPluginProfileRows(dshHome, profile) // -> Set<string> of enabled ids
export function diffPlugins(desktopRows, cliRows) // -> { missing, extra, disabled }
```

```js
/** @typedef {{
 *   id: string, name: string, enabled: boolean, source: 'desktop'|'dsh-cli'|'home',
 *   config?: object, bundled: boolean
 * }} PluginRow */
```

`bundled` marks rows whose `name` starts with `@deepseek-ai/` (shipped with the
runtime, cannot be uninstalled). Rows come from the patch layers the runtime
itself reads: `profiles/<profile>/cordis.patch.yml` and `$DSH_HOME/cordis.patch.yml`.

## 5. Harness migration — `src/cli/migrate.js`

Import skills, MCP servers, sessions and projects from another harness.

```js
export function detectSources(homeDir, env)          // -> SourceRow[]
export function planMigration(source, options)       // -> Plan { items: PlanItem[] }
export function applyMigration(plan, options)        // -> { applied, skipped, failed }
```

`PlanItem` is `{ kind: 'skill'|'mcp'|'session'|'project', from: string, to: string,
action: 'copy'|'convert'|'skip', reason?: string }`.

Rules that keep this safe:

- **never overwrite** an existing destination without `--force`; a skip is reported,
  not silent;
- MCP servers convert between JSON shapes only; secrets are copied as *references*
  (`{ envVar: 'NAME' }`), never inlined into a file the repo could capture;
- sessions are copied, never moved, and only when the target store lacks that id;
- a dry run is the default; `--apply` is required to write.

## 6. Command surface

New subcommands join the existing table in `src/cli/args.js`:

| Command | Purpose |
|---|---|
| `dsh-cli plugins` | list Desktop plugins and their CLI profile status |
| `dsh-cli plugins sync` | copy missing capability rows into the `dsh-cli` profile |
| `dsh-cli migrate [source]` | plan (or `--apply`) an import from another harness |
| `dsh-cli usage` | token and cost totals for one session or the whole store |
| `dsh-cli doctor` | runtime, profile, credential and plugin checks in one pass |

Interactive slash commands gain `/plugins`, `/usage`, `/migrate`, `/toolbar`.
