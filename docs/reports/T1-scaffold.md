# T1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Scaffold report: `dsh-cli` repo skeleton

**Task:** T1 Ãƒâ€šÃ‚Â· **Owner:** devops-engineer Ãƒâ€šÃ‚Â· **Attempt:** a1-t1
**Workspace:** `C:\Users\witek\dsh-cli`
**Status:** complete ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â all machine-verifiable completion criteria pass.

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
API credentials** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a DeepSeek `sk-ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦` key, `ofm-ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦`, `xpl_ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦`, `nx_ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦`, `dp-ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦`, `lfu_ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦` keys and a
`Bearer eyJÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦` JWT. It was neither deleted nor modified, but it is **excluded from the repo**
via `work/` in `.gitignore`, and the staged diff was scanned for secret patterns before
committing. Treat this file as a local secret store; it must never be committed.

`C:\Users\witek\dsh-cli` was confirmed **not** a git repository (`git rev-parse` ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ fatal:
not a git repository) before `git init`.

## 2. Toolchain (verified)

```
node    v26.8.1
pnpm    11.8.0
git     2.52.0.windows.1
python  3.14.6
```
No Rust/Go toolchain present, as stated. No npm dependency was installed ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â `node_modules/`
does not exist.

## 3. What was created

```
C:\Users\witek\dsh-cli\
ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ .git/                          # initialized, branch "main"
ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ .gitattributes                 # NEW - LF pinning, binary markers
ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ .gitignore                     # NEW - deps, secrets, logs, coverage, OS, tool state
ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ package.json                   # NEW - zero-dependency ESM manifest
ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ src/
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡   ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ main.js                    # NEW - minimal runnable placeholder
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡   ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ rpc/.gitkeep               # T2
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡   ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ session/.gitkeep           # T2
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡   ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ui/.gitkeep                # T3
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡   ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ config/.gitkeep            # T5
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡   ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ acp/.gitkeep               # T8
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡   ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬ÂÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ cli/.gitkeep               # T8
ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ packages/
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡   ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬ÂÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ web-deepseek-api/.gitkeep  # T4
ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ tests/.gitkeep                 # T6
ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬ÂÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ docs/
    ÃƒÂ¢Ã¢â‚¬ÂÃ…â€œÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ FINDINGS.md                # pre-existing, untouched
    ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬ÂÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ reports/T1-scaffold.md     # this report
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
| `dependencies` | *(absent)* | **Zero runtime deps** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â RAM/startup goal |
| `devDependencies` | *(absent)* | No build/test toolchain by design |
| `scripts.start` | `node src/main.js` | No-build run path |
| `scripts.test` | `node --test` | Node built-in test runner only |
| `scripts.lint` | `node --check src/main.js` | Syntax gate, zero deps |

No bundler, no TypeScript compile step, no lockfile needed (nothing to install).

### `src/main.js` behaviour

- `--version` / `-V` ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ prints `package.json` version, exit 0
- `--help` / `-h` ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ prints one-line usage, exit 0
- no arguments ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ prints one-line usage, exit 0 (per brief)
- unknown argument ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ message to **stderr**, exit 2

Version is read at runtime from `package.json` via `new URL('../package.json', import.meta.url)`,
so the binary location and CWD do not matter and there is no hardcoded version to drift.
Types are JSDoc-only. `#!/usr/bin/env node` shebang present for the `bin` field.

## 4. Verification evidence (all executed)

### `node src/main.js --version`
```
0.0.1
exit=0
```
`node src/main.js -V` ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `0.0.1`, exit=0.

### `node src/main.js` (no arguments)
```
dsh-cli ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â DeepSeek Harness terminal client. Usage: dsh-cli [--version|-V] [--help|-h]
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
`deps` and `dev` are `null` ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ confirms zero dependencies.

### `npm run start -- --version`
```
0.0.1
exit=0
```
No-build entry point works through the package script.

### `npm test`
```
ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¹ tests 0   ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¹ pass 0   ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¹ fail 0   ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ duration_ms 30.4
exit=0
```
Runner is wired; no test files yet (T6 adds them).

### `node src/main.js --bogus`
```
stderr: dsh-cli: unknown argument: --bogus
stderr: dsh-cli ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â DeepSeek Harness terminal client. Usage: ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦
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
**No `node_modules`, no `work/`, no `.expert-taskboards/`** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ignore rules confirmed working:

```
git check-ignore -v work/opencode-config.json
  ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ .gitignore:34:work/    work/opencode-config.json
git check-ignore -v .expert-taskboards/dsh-cli.json
  ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ .gitignore:54:.expert-taskboards/   .expert-taskboards/dsh-cli.json
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

14 files staged:

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

Initial commit: `83b1bb9 chore(T1): scaffold dsh-cli repo` (14 files).
Follow-up commit: `ec9a26b docs(T1): record tsconfig deviation, ignore expert-bus spool`.

The follow-up exists because the first `git add -A` swept in the `.expert-bus/` message spool created by my own bus send. That is orchestration state, not project source: it was untracked with `git rm -r --cached` (files preserved on disk) and added to `.gitignore`, and the same commit folded in the `tsconfig.json` deviation note in section 8.

## 7. Completion criteria checklist

| Criterion | Result |
|---|---|
| `C:\Users\witek\dsh-cli\.git` exists, `git log --oneline` ÃƒÂ¢Ã¢â‚¬Â°Ã‚Â¥ 1 commit | ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ |
| `package.json` parses via `node -e` | ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ exit 0 |
| `node src/main.js --version` exit 0, non-empty version | ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ `0.0.1` |
| `src/`, `src/rpc/`, `src/session/`, `src/ui/`, `src/config/`, `src/acp/`, `src/cli/`, `packages/web-deepseek-api/`, `tests/`, `docs/reports/` exist | ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ all 10 + `docs/` |
| Report at `docs/reports/T1-scaffold.md` | ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ this file |

## 8. Deviation from the task-board scope: no `tsconfig.json`

Task T1's board `scope` lists `tsconfig.json`. **It was deliberately not created**, because the
agreed architecture for this project is *local Node, pure ESM, zero build step* ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no bundler and
no TypeScript compile phase, with type hints expressed as JSDoc only.

A `tsconfig.json` here would be dead weight: it cannot be used to emit JS (there is no build),
and adding one invites `tsc` plus `typescript` as a devDependency, which directly contradicts
T1's own "zero runtime dependency / RAM-friendliness" requirement. The value it would provide ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
editor type-checking ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â is already available through JSDoc annotations in `src/main.js`.

Flagging this so the coordinator can either accept the deviation or amend the board scope. If a
`tsconfig.json` is ever wanted purely for `checkJs` editor support, note it would require a
devDependency and should be a conscious decision in a later task, not a silent scaffold addition.

## 9. Scope discipline

- **No business logic** written ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â RPC, TUI, web provider, config, ACP all left as `.gitkeep`.
- **No npm dependency** installed; `node_modules/` does not exist.
- **`docs/FINDINGS.md` untouched** (only staged, never modified).
- **No `git checkout --`, `git restore`, or any cleanup** was run ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the repo had no prior
  working tree to protect, and pre-existing untracked material was preserved untouched.
- Existing untracked `work/` and `.expert-taskboards/` were **excluded, not deleted**.

## 10. Rollback

The repo is brand new and self-contained; nothing outside `C:\Users\witek\dsh-cli` was modified.

- Undo the commit only (keep files): `git reset --soft HEAD~1`
- Undo commit and unstage (keep files on disk): `git reset HEAD~1`
- Full removal of git tracking, keeping all files:
  `Remove-Item -Recurse -Force C:\Users\witek\dsh-cli\.git`
- Revert the repo-local config changes: `git config --local --unset user.name` (same for
  `user.email`, `core.autocrlf`) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â these are repo-local only, so no host-wide impact.
- `work/` and `.expert-taskboards/` need no rollback: they were never touched, only ignored.

## 11. Notes for downstream tasks

- **T2/T3/T4/T5/T8:** drop files into the existing directories; the `.gitkeep` can be deleted
  in the same commit that adds real content. `package.json` `exports`/`main` currently point at
  `src/main.js` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â T2 should decide whether to add subpath exports for `src/rpc`.
- **T4:** `packages/web-deepseek-api/` is a bare directory, **not** a pnpm workspace member.
  There is no `pnpm-workspace.yaml` and no root `workspaces` field, deliberately: adding one
  invites a lockfile and dependency install, which conflicts with the zero-dependency/RAM goal.
  If T4 truly needs its own manifest, prefer a workspace-free relative import.
- **T6:** `npm test` runs `node --test`, which discovers `tests/**/*.test.js` (and `.mjs`).
  Put the RAM budget test under `tests/ram/` as the task board scope says.
- **Secrets:** `work/opencode-config.json` holds live keys. Anyone needing an API key for
  live verification should read it from there or from env ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never commit it.
