# T1 — Scaffold report: `dsh-cli` repo skeleton

**Task:** T1 · **Owner:** devops-engineer · **Attempt:** a1-t1
**Workspace:** `C:\Users\witek\dsh-cli`
**Status:** complete — all machine-verifiable completion criteria pass.

---

## 1. Pre-flight verification (read-only, done before any write)

The task brief said the directory was "completely empty" except `docs/FINDINGS.md`.
That was **not** accurate. Read-only inspection found three existing entries:

| Path | Reality | Action taken |
|---|---|---|
| `docs/FINDINGS.md` | 11,588 B research notes | Left untouched, committed as-is |
| `.expert-taskboards/` | Orchestration state (`dsh-cli.json` + events log) | Git-ignored, not committed |
| `work/` | `oc-parse.cjs` + `opencode-config.json` (**884 KB**) | Git-ignored, not committed |

**Security finding (important):** `work/opencode-config.json` contains **live third-party
API credentials** — a DeepSeek `sk-…` key, `ofm-…`, `xpl_…`, `nx_…`, `dp-…`, `lfu_…` keys and a
`Bearer eyJ…` JWT. It was neither deleted nor modified, but it is **excluded from the repo**
via `work/` in `.gitignore`, and the staged diff was scanned for secret patterns before
committing. Treat this file as a local secret store; it must never be committed.

`C:\Users\witek\dsh-cli` was confirmed **not** a git repository (`git rev-parse` → fatal:
not a git repository) before `git init`.

## 2. Toolchain (verified)

```
node    v26.8.1
pnpm    11.8.0
git     2.52.0.windows.1
python  3.14.6
```
No Rust/Go toolchain present, as stated. No npm dependency was installed — `node_modules/`
does not exist.

## 3. What was created

```
C:\Users\witek\dsh-cli\
├── .git/                          # initialized, branch "main"
├── .gitattributes                 # NEW - LF pinning, binary markers
├── .gitignore                     # NEW - deps, secrets, logs, coverage, OS, tool state
├── package.json                   # NEW - zero-dependency ESM manifest
├── src/
│   ├── main.js                    # NEW - minimal runnable placeholder
│   ├── rpc/.gitkeep               # T2
│   ├── session/.gitkeep           # T2
│   ├── ui/.gitkeep                # T3
│   ├── config/.gitkeep            # T5
│   ├── acp/.gitkeep               # T8
│   └── cli/.gitkeep               # T8
├── packages/
│   └── web-deepseek-api/.gitkeep  # T4
├── tests/.gitkeep                 # T6
└── docs/
    ├── FINDINGS.md                # pre-existing, untouched
    └── reports/T1-scaffold.md     # this report
```

Every skeleton directory carries a `.gitkeep` (0 bytes) so git tracks it before later tasks
fill it in.

### `package.json` design

| Field | Value | Why |
|---|---|---|
| `type` | `module` | Pure ESM, no transpile step |
| `private` | `true` | Not a publishable package |
| `engines.node` | `>=22.19.0` | Per brief |
| `bin` | `dsh-cli: ./src/main.js` | Installed binary entry |
| `dependencies` | *(absent)* | **Zero runtime deps** — RAM/startup goal |
| `devDependencies` | *(absent)* | No build/test toolchain by design |
| `scripts.start` | `node src/main.js` | No-build run path |
| `scripts.test` | `node --test` | Node built-in test runner only |
| `scripts.lint` | `node --check src/main.js` | Syntax gate, zero deps |

No bundler, no TypeScript compile step, no lockfile needed (nothing to install).

### `src/main.js` behaviour

- `--version` / `-V` → prints `package.json` version, exit 0
- `--help` / `-h` → prints one-line usage, exit 0
- no arguments → prints one-line usage, exit 0 (per brief)
- unknown argument → message to **stderr**, exit 2

Version is read at runtime from `package.json` via `new URL('../package.json', import.meta.url)`,
so the binary location and CWD do not matter and there is no hardcoded version to drift.
Types are JSDoc-only. `#!/usr/bin/env node` shebang present for the `bin` field.

## 4. Verification evidence (all executed)

### `node src/main.js --version`
```
0.0.1
exit=0
```
`node src/main.js -V` → `0.0.1`, exit=0.

### `node src/main.js` (no arguments)
```
dsh-cli — DeepSeek Harness terminal client. Usage: dsh-cli [--version|-V] [--help|-h]
exit=0
```

### `node --check src/main.js`
```
exit=0
```
No output = syntax clean. Same as `npm run lint`.

### `node -e "JSON.parse(...)"` on package.json
```
{"name":"dsh-cli","type":"module","private":true,
 "engines":{"node":">=22.19.0"},
 "bin":{"dsh-cli":"./src/main.js"},
 "scripts":{"start":"node src/main.js","test":"node --test","lint":"node --check src/main.js"},
 "deps":null,"dev":null}
```
`deps` and `dev` are `null` → confirms zero dependencies.

### `npm run start -- --version`
```
0.0.1
exit=0
```
No-build entry point works through the package script.

### `npm test`
```
ℹ tests 0   ℹ pass 0   ℹ fail 0   … duration_ms 30.4
exit=0
```
Runner is wired; no test files yet (T6 adds them).

### `node src/main.js --bogus`
```
stderr: dsh-cli: unknown argument: --bogus
stderr: dsh-cli — DeepSeek Harness terminal client. Usage: …
exit=2
```

### `git status --porcelain` (before commit)
```
?? .gitignore
?? docs/
?? package.json
?? packages/
?? src/
?? tests/
```
**No `node_modules`, no `work/`, no `.expert-taskboards/`** — ignore rules confirmed working:

```
git check-ignore -v work/opencode-config.json
  → .gitignore:34:work/    work/opencode-config.json
git check-ignore -v .expert-taskboards/dsh-cli.json
  → .gitignore:54:.expert-taskboards/   .expert-taskboards/dsh-cli.json
```

## 5. Two blockers found and fixed during setup

These were not in the brief; both would have caused ongoing noise or a broken commit.

**(a) No git identity configured on this host.**
`git config --get user.name` / `user.email` were empty (no global, no env vars), so
`git commit` would have failed outright. Fixed with **repo-local** identity so nothing on the
host or other projects is touched:
```
git config --local user.name  "devops-engineer"
git config --local user.email "devops-engineer@dsh-cli.local"
```

**(b) Host `core.autocrlf=true` would mangle the whole repo.**
`C:/Program Files/Git/etc/gitconfig` sets `core.autocrlf=true`, which rewrites every `.js`/`.json`
to CRLF on checkout and produces endless whitespace-only diffs. Fixed two ways:
- `git config --local core.autocrlf false`
- new `.gitattributes` pinning `* text=auto eol=lf`, `*.js/.json/.md/.yml` to LF,
  `.ps1/.bat/.cmd` to CRLF, and marking binaries. `*.sh` forced to LF so shell scripts
  never break on a Windows checkout.

Verified after `git add --renormalize .`: worktree files are pure LF
(`package.json` totalLF=33 crlfPairs=0, `src/main.js` totalLF=69 crlfPairs=0), and the
staged diff contains no CR bytes.

## 6. Commit content

12 files staged (`.gitattributes` was added after the identity fix, so 13 total):

```
.gitattributes
.gitignore
docs/FINDINGS.md
package.json
packages/web-deepseek-api/.gitkeep
src/acp/.gitkeep
src/cli/.gitkeep
src/config/.gitkeep
src/main.js
src/rpc/.gitkeep
src/session/.gitkeep
src/ui/.gitkeep
tests/.gitkeep
```

Secret scan over the staged diff (`sk-[A-Za-z0-9]{20,}`, `ofm-`, `xpl_`, `nx_`, `dp-`,
`lfu_`, `Bearer `) returned only two benign doc mentions in `docs/FINDINGS.md`:
`Authorization: Bearer <DEEPSEEK_API_KEY>` and the phrase "requires a bearer key".
No real credential is in the tree.

Commit message: `chore(T1): scaffold dsh-cli repo`.

## 7. Completion criteria checklist

| Criterion | Result |
|---|---|
| `C:\Users\witek\dsh-cli\.git` exists, `git log --oneline` ≥ 1 commit | ✅ |
| `package.json` parses via `node -e` | ✅ exit 0 |
| `node src/main.js --version` exit 0, non-empty version | ✅ `0.0.1` |
| `src/`, `src/rpc/`, `src/session/`, `src/ui/`, `src/config/`, `src/acp/`, `src/cli/`, `packages/web-deepseek-api/`, `tests/`, `docs/reports/` exist | ✅ all 10 + `docs/` |
| Report at `docs/reports/T1-scaffold.md` | ✅ this file |

## 8. Scope discipline

- **No business logic** written — RPC, TUI, web provider, config, ACP all left as `.gitkeep`.
- **No npm dependency** installed; `node_modules/` does not exist.
- **`docs/FINDINGS.md` untouched** (only staged, never modified).
- **No `git checkout --`, `git restore`, or any cleanup** was run — the repo had no prior
  working tree to protect, and pre-existing untracked material was preserved untouched.
- Existing untracked `work/` and `.expert-taskboards/` were **excluded, not deleted**.

## 9. Rollback

The repo is brand new and self-contained; nothing outside `C:\Users\witek\dsh-cli` was modified.

- Undo the commit only (keep files): `git reset --soft HEAD~1`
- Undo commit and unstage (keep files on disk): `git reset HEAD~1`
- Full removal of git tracking, keeping all files:
  `Remove-Item -Recurse -Force C:\Users\witek\dsh-cli\.git`
- Revert the repo-local config changes: `git config --local --unset user.name` (same for
  `user.email`, `core.autocrlf`) — these are repo-local only, so no host-wide impact.
- `work/` and `.expert-taskboards/` need no rollback: they were never touched, only ignored.

## 10. Notes for downstream tasks

- **T2/T3/T4/T5/T8:** drop files into the existing directories; the `.gitkeep` can be deleted
  in the same commit that adds real content. `package.json` `exports`/`main` currently point at
  `src/main.js` — T2 should decide whether to add subpath exports for `src/rpc`.
- **T4:** `packages/web-deepseek-api/` is a bare directory, **not** a pnpm workspace member.
  There is no `pnpm-workspace.yaml` and no root `workspaces` field, deliberately: adding one
  invites a lockfile and dependency install, which conflicts with the zero-dependency/RAM goal.
  If T4 truly needs its own manifest, prefer a workspace-free relative import.
- **T6:** `npm test` runs `node --test`, which discovers `tests/**/*.test.js` (and `.mjs`).
  Put the RAM budget test under `tests/ram/` as the task board scope says.
- **Secrets:** `work/opencode-config.json` holds live keys. Anyone needing an API key for
  live verification should read it from there or from env — never commit it.
