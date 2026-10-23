# dsh-import-models

Import the models, providers, API keys and OAuth logins that other agent harnesses
keep on this machine into **DeepSeek Harness**, then enable, disable and remove them
from a **Settings → Model Manager** page.

## What it reads

| Source | File | Becomes |
| --- | --- | --- |
| **opencode** | `~/.config/opencode/opencode.jsonc` (`providers`, models, endpoints) | `llm-pi-ai` provider routes + API-key credentials |
| **opencode auth** | `~/.local/share/opencode/auth.json` | API-key credentials (and routes when opencode declared a provider) |
| **Codex / ChatGPT** | `~/.codex/auth.json` | `openai-codex` OAuth grant, or an OpenAI API-key route |
| **Claude Code** | `~/.claude/.credentials.json`, `~/.claude/settings.json` | `anthropic` OAuth grant or API key |
| **Gemini CLI** | `~/.gemini/oauth_creds.json` | `google` OAuth grant |
| **Qwen Code** | `~/.qwen/oauth_creds.json` | `qwen-token-plan` OAuth grant |
| **`.env` files** | `<cwd>/.env`, `~/.env`, `~/.dsh/.env`, `~/.config/dsh/.env`, `~/.config/opencode/.env` | API-key credentials (keys are imported; endpoints are not guessed) |

Every secret is redacted before it reaches the browser or the model: the page only
sees hints like `sk-ab…(51 chars)`. Imports re-read the source inside the Host, so a
key value never travels through the page.

## What you can do

- **Import** — scan, tick what you want, preview the plan, import. Per-source
  "Import" buttons do the same for one harness.
- **Providers** — disable (the route is stashed, not deleted), re-enable, or remove.
- **Models** — open a route's model list, search it, disable or re-enable single models.
- **Add a provider** — any OpenAI-compatible or Anthropic-compatible endpoint, with an
  optional key written straight to the credential store.
- **Agent tools** — `model_manager_sources`, `model_manager_plan`,
  `model_manager_import`, `model_manager_routes`, `model_manager_toggle_route`,
  `model_manager_toggle_model`, `model_manager_add_route`,
  `model_manager_remove_route`, `model_manager_set_secret`.

## Install

```text
plugin_manager install_bundle  target: <path-to>/dsh-import-models
```

The bundle inserts one row:

```yaml
- insert:
    - id: model-manager
      name: 'dsh-import-models'
```

Refresh the Web GUI once, then open **Settings → Model Manager**.

### Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the plugin off without uninstalling. |
| `allowWrite` | `true` | Refuse every import/toggle/add write (read-only page). |
| `announceToAgent` | `true` | Add a short system-prompt section describing the tools. |
| `stateFile` | `~/.dsh/model-manager/state.json` | Where disabled routes/models and extra `.env` paths are remembered. |

## How writes work

Only first-class Host seams, never a hand-edited file:

- provider routes go through `configEditor.edit()` on the live `llm-pi-ai` row
  (falling back to `settings.mutate('llm-pi-ai', …)` when no editor is mounted);
- API keys go to `credentials.set(ref, value)`;
- OAuth logins become the credential record `llm-pi-ai/<route>`
  (`{ kind: 'grant', payload: { type: 'oauth', access, refresh, expires, accountId } }`).

Disabling a provider stashes its route config in the plugin state file and removes it
from the live config, so re-enabling restores it exactly. Model toggles rewrite the
route's `models` array the same way.

## Security

- HTTP routes are loopback-only; writes additionally require a same-origin
  `Origin`/`Host` pair or `Sec-Fetch-Site: same-origin`.
- No secret appears in a response, a log line, or the plugin state file.
- Other harnesses' files are read only; nothing outside DSH is modified.

## Limitations

- OAuth grants are copied as-is. If the other harness already rotated the refresh
  token, import again.
- `.env` keys that match no known provider are stored as credential references only.
- The plugin performs no interactive sign-in of its own; use DSH's own Models page for
  that.
- Non-chat models (embeddings, TTS, image generation) are filtered out of imported
  routes and counted in the plan summary.

## License

MIT
