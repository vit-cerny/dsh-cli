# DeepSeek Search/Fetch provider audit

**Scope:** read-only inspection of the installed DSH Desktop packages and the selected Desktop profile. No credential values were read or printed, no live Search/Fetch calls were made, and no installed runtime/profile files or provider IDs were changed or duplicated.

## Which provider is selected

The Desktop profile selects `deepseek-search-api` and `deepseek-fetch-api` in `C:\Users\user\.dsh\profiles\desktop\cordis.patch.yml:54-58`. These IDs belong to the installed `@deepseek-ai/dsh-web-deepseek-api` package (`C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-web-deepseek-api\lib\index.js`), not to the similarly named Messages provider.

The installed `dsh-base` bundle includes the API package and its providers. Its `cordis.patch.yml:454-481` describes the selected Search/Fetch API pair and mounts the `web-deepseek-api` row; it also mounts the separate Messages-search row. In the package implementation, IDs are declared at `lib/index.js:213-218` and `304-305`, and both are registered at `375-389`. Search and Fetch use the raw tools endpoints: the default base is `https://api.deepseek.com/v1/tools` (`216-218`), with `/search` and `/fetch` appended (`268-284`, `322-326`). The settings page confirms the paired switch behavior: `dsh-client-ui-settings-web-search/lib/client.js:195-230` maps the API selection to these two IDs and the Messages selection to `deepseek-official` plus local `http` fetch.

The other installed package, `@deepseek-ai/dsh-web-search-deepseek`, implements native web search through the Anthropic-compatible Messages API. It registers search ID `deepseek-official` (`lib/index.js:13-20`, `86-102`), calls `/messages` (`103-145`), and is not the selected search provider in the Desktop profile. It is not the raw `/v1/tools/search` + `/v1/tools/fetch` implementation.

## Confirmed implementation gaps

- **URL validation and credentials:** the API package's `available()` methods call only `URL.canParse(baseURL)` (`lib/index.js:264-267`, `318-321`). They do not constrain the configured API base to HTTPS, an approved host/origin, or a particular path. The outgoing URL is formed by appending `/search` or `/fetch` (`268-284`, `322-326`); redirects are rejected (`67-79`). Fetch forwards the caller's `request.url` in the JSON body (`326`). No package-level validation of that target's scheme or userinfo is visible in this dispatch path. Credentials are resolved per operation (`14-30`) and sent as bearer authorization (`130-144`), or as an account token on the account route (`130-136`). Consequently, an untrusted custom base URL could receive credentials. The settings schema marks the literal key secret/volatile and defaults the credential reference (`352-357`), but that does not replace destination validation.
- **Cancellation and timeout:** an incoming signal is checked and passed to `fetch` (`59-79`, `99-105`), and credential resolution races the signal (`169-198`). This is cancellation support, not a provider-owned deadline: this package has no `timeoutMs`, timer, or `AbortSignal.timeout` implementation. A caller that supplies no timeout signal can wait indefinitely on transport or a resolver.
- **Transport-error redaction:** a caught network error is interpolated with `String(error)` and retained as a cause (`80-83`); credential-resolver errors are also stringified and retained (`169-176`). API error response details are forwarded (`84-98`), and endpoint URLs appear in error guidance (`120-121`). The request's authorization headers are not part of the recorded request; however, raw transport/resolver error messages and causes are not guaranteed secret-free. A safer implementation should map errors to stable codes/statuses and avoid exposing arbitrary error strings or raw causes.

## Historical and current credential observations

These observations are separated in time and remain unresolved; this audit did not test credentials:

- An earlier probe recorded HTTP 200 from both raw Search and Fetch endpoints in `docs/FINDINGS.md:168-184`.
- Later project status records one Search and one Fetch returning HTTP 401, and asks for a credential refresh before relying on live web requests (`README.md:50`, `docs/INTEROP.md:27-32`, `docs/reports/ADR-RAM-REA.md:17-29`).

The prior success does not establish current validity, and the later 401s do not establish that a key is absent or explain the cause. Do not infer or disclose credential state from those reports. Live verification is blocked until the user refreshes or confirms the intended credential in DSH settings and authorizes a smoke test.

## Safe next step

Keep the installed package and profile untouched. Ask the user to refresh/confirm the DeepSeek credential through DSH settings; only after that, perform an explicitly authorized Search and Fetch smoke test. Separately, propose an upgrade-compatible, reviewable change to the upstream/plugin source that constrains outbound API bases and fetch-target URLs (including rejecting userinfo), adds a bounded request timeout while preserving cancellation, and sanitizes errors without leaking arbitrary transport details. Keep the existing selected IDs if extending the shipped provider; do not register duplicates. If changes must be delivered as an add-on instead, use a distinct plugin/provider identity and version-align its DSH peer dependencies.

## Sources

- Installed `@deepseek-ai/dsh-web-deepseek-api`: `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-web-deepseek-api\lib\index.js` and `package.json:1-4,31-42`.
- Installed `dsh-base` composition: `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:454-481`.
- Installed settings selection: `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-client-ui-settings-web-search\lib\client.js:195-230`.
- Separate Messages provider: `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-web-search-deepseek\lib\index.js:13-20,86-105,133-169,177-231`.
- Historical/current observations: `docs/FINDINGS.md:168-184`, `README.md:50`, `docs/INTEROP.md:27-32`, `docs/reports/ADR-RAM-REA.md:17-29`.
