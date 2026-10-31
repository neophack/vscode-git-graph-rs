# Post-Refactor Optimization Plan

| Item | Content |
|---|---|
| Date | 2026-10-26 |
| Code baseline | `dev-refactor` @ `fe79dbf` (1.1.0) |
| Relationship to other docs | Follows the executed REFACTOR-PLAN (retired from `docs/`; its DoD ledger is [dod-status.md](dod-status.md), its decisions the ADRs) and audits [dod-status.md](dod-status.md). Where this plan corrects the DoD ledger, the correction is backed by a command in §1. |
| Viewpoints | Software architecture · VS Code platform · Rust engine · webview frontend · quality/CI |
| Status | M0 complete; waves 1–4 (§12) landed R1–R8, V1–V5, S2–S7, G1–G5, D, F1–F7, A1–A7, P1–P3 and the D-1/D-2/D-4 decisions. D-2 is taken: `retainContextWhenHidden` stays `true` (ADR-0007 measured 52 ms retained vs 227 ms non-retained restore). The size gate's KNOWN list is empty — no production file is over the 600-line limit. Wave 8 closed the first Actions run's size finding: the Commit Details View is on demand, and both ADR-0005 first-paint budgets hold again (entry 160.4/200 KB, closure 332.7/360 KB) |

---

## 0. Summary

The refactor got the hard structural work done. The god modules are gone, the engine has
one typed protocol with generated TS types, writes go through `GitWriter` with declared
`effects`, the open path is host-pushed, the webview is ES modules with on-demand chunks, and
the test tree is layered. Three problems remain:

1. **The DoD ledger claims more than the tree holds.** Items 3, 5, 6, 7 and 11 are marked
   "held" or "mostly held", but simple commands disprove them (§1). The plan's own rules are
   only as strong as their enforcement, and today **CI does not run the host typecheck,
   ESLint, stylelint, dependency-cruiser or the ts-rs drift check at all**.
2. **The migration stopped at the seams.** The new modules exist, but much of the old shape
   survives inside them: a static panel singleton used as a service locator, 12-argument
   constructors, two config readers (`getConfig()` has 44 call sites, `takeSnapshot()` has 3),
   six production files that spawn processes outside `git/process/`, a 1111-line `RepoLoader`
   that replaced `web/main.ts` as the webview's god class, and 323 comments that point at
   plan task numbers or deleted files.
3. **Production-grade concerns were outside the refactor's scope.** Workspace Trust is
   undeclared. Activation awaits a `git` spawn before it registers commands. The engine has no
   handle eviction or memory budget. The webview has almost no accessibility semantics.
   There are no timing markers anywhere, so none of the §3.8.1 timing budgets has ever been
   measured.

This plan has eight workstreams (§2–§9) totalling roughly **45–55 person-days**, in four
milestones (§11). M0 (truth and gates, ~4 days) comes first because it makes every later
claim verifiable.

---

## 1. Audit: claimed vs. measured

Every row is reproducible from a clean checkout of `fe79dbf`.

| DoD # | Ledger says | Measured | Evidence |
|---|---|---|---|
| 3 | **held** ("no non-generated file > 600 lines") | **not held**: 16 production files exceed 600 lines | `git ls-files 'src/**/*.ts' 'native/**/*.rs' \| grep -v -e shared/engine -e shared/i18n -e '\.test\.ts' -e native/core/tests \| xargs wc -l \| awk '$1>600'` → `types/messages.ts` 1246, `platform/config.ts` 1204, `graph/loading/repoLoader.ts` 1111, `settingsWidget.ts` 988, `automation/server.ts` 955, `commitLoader.ts` 894, `repoManager.ts` 872, `read/log.rs` 872, `commitDetails.ts` 861, `suiteRunner.ts` 845, `fixture.ts` 826, `panel.ts` 753, `read/gerrit.rs` 746, `contextMenuActions.ts` 717, `storage.ts` 681, `gitReader.ts` 635 |
| 5 | "CI checks `git diff --exit-code src/shared/engine`" | **not in any workflow** | `grep -rn "shared/engine\|exit-code" .github/` → no matches |
| 6 | **held** ("`child_process` only in `git/process/`; argSafety 1 call site") | **not held**: 6 production files outside `git/process/` import `child_process`; `checkUnsafeGitArgs` has 2 call sites | `grep -rl "from 'child_process'" src --include=*.ts \| grep -v test` → `git/read/cli/process.ts`, `git/read/cli/files.ts`, `views/binaryCompare/hexDiff.ts`, `hexDiffSources.ts`, `utils/childProcess.ts`, `utils/findGit.ts` (+ automation); `graphView/handlers/files.ts:2` imports `checkUnsafeGitArgs` |
| 7 | "mostly held; coverage thresholds a CI-side setting" | **no coverage configuration exists** | `vitest.config.ts` has no `coverage` block; no workflow runs `vitest --coverage` |
| 2 | "held with one pocket" | holds, but the baseline is stale: 15 known + **9 stale** entries | `npx depcruise src --config .dependency-cruiser.cjs` |
| 11 | "floors by construction; measured in CI" | the musl/armhf targets exist in `build-addon.mjs` but **are not in the CI or release matrix** | `.github/workflows/native-build.yml:102` matrix lists 6 gnu/msvc/darwin targets only |
| — (§1.6 C1/C2) | ESLint gates the compat floors | ESLint and stylelint **are never run by CI**; 221 warnings today, `no-explicit-any` **rose** from 48 (Phase 1.6) to 54 | `.github/workflows/*.yml` has no eslint/stylelint/depcruise/tsc step; `npx eslint src scripts` → 0 errors / 221 warnings |
| — (§3.8.2 F3) | "`findGit` no longer blocks `activate`" | `activate()` still `await`s `findGit` **before** constructing `CommandManager` | `src/extension.ts`, `gitExecutable = await findGit(extensionState)` precedes command registration |
| — (§3.8.7) | T0–T5 markers, "Show Performance Trace" | **no `performance.mark` call site exists** | `grep -rn "performance\.mark" src --include=*.ts` → none; docs/performance.md says the same |
| — (H11) | "no more static `currentPanel` access" | 16 references in `panel.ts` + `extension.ts` (prewarm reads panel state through it) | `grep -rn "GitGraphView.currentPanel" src` |
| — (W6) | single i18n dictionary | a fourth dictionary survives: `webview/binaryCompare/strings.ts` (49 zh-cn literals) | `grep -cP '[\x{4e00}-\x{9fa5}]' src/webview/binaryCompare/strings.ts` |
| — (W7) | per-component CSS, mobile rules in the same file | `src/webview/styles/mobile/` still holds 11 per-device files | `ls src/webview/styles/mobile` |
| — (§3.7.2) | `engines.node` moves out of `package.json` | still `"node": ">=18"` | `package.json#engines` |

**Action (part of M0):** rewrite `dod-status.md` with these rows, and change the ledger's
rule to "a row is *held* only if a CI job fails when it regresses". Anything weaker is
"held locally" or "not held".

---

## 2. Workstream G: Gates and truth (do first)

The repository has good rules but weak enforcement. Every later workstream depends on this one.

### G1. One `npm run check` and one CI static job (1 day)

- Add `typecheck` (`tsc -p tsconfig.json --noEmit` + `tsc -p src/webview --noEmit` + `tsc -p test/e2e --noEmit`),
  then `check` = `typecheck` + `lint:js` + `lint:css` + `lint:deps` + `lint` (cargo) + the ts-rs drift check.
- New CI job `static` (ubuntu, no matrix) runs `npm run check`, then
  `cargo test -p git-graph-core --test protocol && git diff --exit-code src/shared/engine`.
- Replace every `npm ci || npm install` with `npm ci`. The fallback hides lockfile drift,
  and this branch currently has an uncommitted `package-lock.json` change of −429 lines.

Acceptance: a PR that adds an `any`, a cycle, a stale generated type or a type error fails CI.

### G2. Ratchets that actually ratchet (0.5 day)

- ESLint: move the 221 warnings into **bulk suppressions** (`eslint --suppress-all`, which
  writes `eslint-suppressions.json`, ESLint ≥ 9.24) and promote every rule to `error`. New
  violations then fail, and fixed ones get pruned with `--prune-suppressions`. This replaces
  the honour-system "counts may only go down" comments in `eslint.config.mjs`.
- dependency-cruiser: run `--baseline-mode shrink-only` in CI so stale entries fail the
  job. That removes the 9 stale entries now and blocks new ones from building up.
- File size: add `max-lines: ['error', 600]` with the 16 current offenders in the
  suppression file. The rule then guards new code, and each split in §3/§6 removes an entry.

### G3. Type-aware linting (1 day)

Enable `typescript-eslint`'s type-checked rules for `src/**` (not tests at first):
`no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`,
`await-thenable`, `no-unnecessary-condition` (warn), `prefer-nullish-coalescing` is **not**
enabled (the output is downlevelled anyway; it is noise). REFACTOR-PLAN §7 already requires
`no-floating-promises` at error, and the current config does not include it. Expect a
backlog: put it in suppressions (G2) and burn it down per file as the §3 work touches it.

### G4. Coverage that gates (0.5 day)

Add a `coverage` block to `vitest.config.ts` (v8 provider). Set **per-glob thresholds at
today's measured values minus 1 pt**, not the §6.5 end-state numbers, then ratchet upward
with `thresholds.autoUpdate` off and a manual bump in each PR that raises coverage. Run it in
the ubuntu integration job.

### G5. TS configuration consolidation (1 day)

Three host configs disagree today:

| File | Used by | `lib` |
|---|---|---|
| `tsconfig.json` | `build:ts`, ad-hoc typecheck | ES2022 |
| `src/tsconfig.json` | the esbuild host bundle (`scripts/build/build.mjs:135`) | es6 + a hand-rolled `@types/node` patch |
| `src/webview/tsconfig.json` | webview typecheck | es2018 + dom |

Target: `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
evaluated separately) with three leaf projects (`src/extension` lib es2018, `src/webview` lib
es2018+dom, `test`), plus `tsc -b` for the typecheck. Delete `src/tsconfig.json` and
`src/utils/@types/node`. Turn on `noUncheckedIndexedAccess` behind suppressions. The
commit-table and lookup code (`commitLookup: { [hash]: number }`) is where an unchecked index
becomes a runtime `undefined`.

---

## 3. Workstream A: Host architecture (finishing the migration)

### A1. Drain the flat root (2 days, pure moves first)

`src/extension.ts`, `src/i18n.ts`, `src/types/` (incl. the 1246-line `messages.ts`),
`src/utils/` (6 files still `import 'vscode'`), `src/askpass/` and `src/automation/` sit
outside the layered tree. They are also the "last exemption pocket" of the dependency rules.

- `extension.ts` → `extension/main.ts`; `askpass/` → `extension/git/process/askpass/`;
  `automation/` → `extension/automation/` (still define-gated).
- `types/messages.ts` is the webview protocol. Fold it into `shared/protocol/graphView.ts`
  and split by domain (`loading`, `branches`, `commits`, …) to mirror `handlers/`.
  `types/git.ts` / `repoState.ts` → `shared/model/`.
- `utils/`: delete it as a directory. Each file moves to its consumer's layer
  (`findGit` → `git/executable/`, `childProcess` → `git/process/`, `actions.ts`'s vscode
  wrappers → `platform/notifications.ts`, pure helpers → `shared/util/`).
- Then remove the depcruise exemption, so `vscode-only-via-platform` covers all of `src/extension/**`.

Rule: pure-move PRs per REFACTOR-PLAN §2.3; import-only diffs.

### A2. A real composition root (3 days)

The composition root wires things by hand, and the wiring leaks:

- `GitGraphView.createOrShow/restore/watchForOrphanedTabs` each take **9 positional
  collaborators**, and `CommandManager` takes 12.
- `GitGraphView.currentPanel` (static) doubles as a service locator, e.g. prewarm reads
  `currentPanel.automationState()` to decide whether the user is busy.
- `forwardBackend()` in `extension.ts` hand-writes all ~30 `GitBackend` members to forward
  them to a swappable cell. That is the same "N hand-written delegations" problem H6 removed
  from `FallbackBackend`.
- Names like `LegacyViewPort`, `LegacyGitExecutable` and the identity function
  `toProcessExecutable` are migration scaffolding that shipped.

Change:

1. `ExtensionServices`: one frozen object built once in `main.ts` (`repo`, `reader`, `git`,
   `state`, `avatars`, `repos`, `logger`, `ui`, `scheduler`, `paths`). Constructors take
   `(services, …own args)`. No container library. The point is one parameter and an
   explicit dependency list, not magic.
2. `PanelRegistry` (instance, owned by `main.ts`) replaces the static field. It exposes
   `current()`, `onDidChangeActivity`, and the `isBusy()` that prewarm needs. Prewarm then
   depends on a 2-method port, not on the panel class.
3. Swappable reader: replace the hand-written forwarder with a generated delegating proxy
   built from the same method table `fallbackReader.ts` uses (one table, two consumers), or
   with a `Swappable<GitBackend>` that re-resolves per call. Either way it is one source of
   method names.
4. Rename the ports (`AuxiliaryViewsPort`, `GitExecutable`), delete the identity helpers,
   and make `deactivate()` close engine handles explicitly. Today it is empty, and the
   `closeAll` relies on disposal order.

Acceptance: `GitGraphView.currentPanel` deleted; no constructor has more than 4 parameters;
`main.ts` ≤ 200 lines and contains only construction and wiring.

### A3. One process adapter (2 days)

`git/process/gitProcess.ts` is meant to be the single process seam. Today there are five more:

| Site | What it does |
|---|---|
| `git/read/cli/process.ts` | `execFile` path + a lazily built second `GitProcess` |
| `git/read/cli/files.ts` | its own `execFile` |
| `utils/findGit.ts` + `utils/childProcess.ts` | `spawn` for `--version`, output resolution |
| `views/binaryCompare/hexDiff*.ts` | `cp.ChildProcess` streams |

Give `GitProcess` three verbs: `run` (buffered, with `maxBuffer` and `AbortSignal`), `collect`
(stdout as `Buffer`), and `stream` (a `Readable` plus an exit promise). Every site above
becomes a caller. Add a depcruise rule `child-process-only-in-process` that forbids
`child_process` everywhere except `src/extension/git/process/**` and
`src/extension/automation/**`. Move the `checkUnsafeGitArgs` call in `handlers/files.ts`
behind a reader/writer method, so `argSafety` really has one call site.

Benefit beyond tidiness: one place for Windows `windowsHide`, the askpass env, cancellation,
output caps and the error shape. Today the CLI read path and the write path can disagree on
all five.

### A4. One configuration model (3 days)

`platform/config.ts` (1204 lines) contains both the new `ConfigSnapshot`/`takeSnapshot` (3
call sites) and the legacy `getConfig()` class with per-key getters (44 call sites). The two
sometimes carry their own defaults for the same key (`retainContextWhenHidden` is read at
`config.ts:434` and again at `:1106`).

- **Schema from the manifest.** Generate a typed `ConfigKey → type/default` table from
  `package.json#contributes.configuration` at build time (or check it in and test parity).
  Defaults then exist in exactly one place, the manifest that VS Code also reads.
- **Snapshot per request.** Handlers receive `ctx.config` (REFACTOR-PLAN §3.3 `HandlerContext`).
  Long-lived services subscribe with `onConfigChange` and hold the latest snapshot. Delete `getConfig()`.
- Split: `config/schema.ts` (generated or checked), `config/snapshot.ts`, `config/migrations.ts`.

Acceptance: `getConfig` deleted; every default is defined once; config test asserts
manifest ↔ schema parity.

### A5. Decompose the remaining large modules (4 days, after A1–A4 shrink them)

| File | Split along |
|---|---|
| `graphView/commitLoader.ts` (894) | `openPath.ts` (loadView push), `followUps.ts` (staged follow-ups), `pageCache` already exists; keep `CommitLoader` as the facade |
| `repos/repoManager.ts` (872) | `RepoRegistry` (state + events), discovery already separate, `RepoSettingsStore` (`.vscode/git-graph-rs.json`) |
| `graphView/panel.ts` (753) | `PanelHost` (vscode panel lifecycle), `MessageRouter` (inbound validation → handler table), `ViewState` |
| `platform/storage.ts` (681) | per-store modules (avatars, code reviews, view snapshot) over one versioned KV |
| `git/read/gitReader.ts` (635) | contract types vs the Native adapter |
| `webview/.../settingsWidget.ts` (1009) | one module per settings section (repo, remotes, integrations, tools); the widget keeps the shell |
| `webview/.../commitDetails.ts` (953) | view shell vs file list vs the body/review panes; `fileTree.ts` and `fileActions.ts` already exist |
| `webview/.../contextMenuActions.ts` (717) | one module per menu (branch, commit, remote, stash, tag, uncommitted); the chunk is already on demand |
| `webview/.../commitTable.ts` (640) | row-model building vs DOM patching |
| `automation/server.ts`, `suiteRunner.ts`, `fixture.ts` | not shipped; split, but lowest priority |

### A6. Synchronous IO off the host's event loop (1 day)

The extension host is shared by every extension in the window, so sync IO there stalls all
of them. Current sync calls in production paths:

- `graphView/html.ts:46`: `readFileSync` + `statSync` of `package.json` **on every HTML
  render** (cache-bust version). Compute it once at activation from `context.extension.packageJSON` (or the 1.38-safe `require` of the manifest).
- `git/operationState.ts`: `existsSync`/`readFileSync` per state probe.
- `platform/logger.ts`: `writeFileSync` truncation; `gerrit.ts` hook install.

Add `n/no-sync` at error for `src/extension/**` (excluding askpass, which is a separate short-lived process).

### A7. Comments describe the present (1 day, mechanical)

There are 323 references to plan task numbers or sections in 157 production files, 138
"legacy" mentions and 48 `DataSource` mentions. Most point at code that no longer exists,
e.g. `hexDiffSources.ts:22` says "`DataSource` satisfies this". Per REFACTOR-PLAN §7
("write why, not what"):

- Remove task/phase numbers from code comments. That history is in git and the ADRs.
- Replace "legacy X" with a description of the behaviour it preserves.
- Add a lint rule (`no-restricted-syntax` on comments isn't possible; use a small
  `scripts/dev/check-comments.mjs` grep in `npm run check`) that rejects `task \d+\.\d+`,
  `REFACTOR-PLAN` and `DataSource` in `src/**` except `docs/`.

---

## 4. Workstream V: VS Code platform

### V1. Activation that never waits (2 days)

Today `activate()` awaits `findGit()` (a `git --version` spawn, ~30–80 ms on Windows, much
more under AV scanning) **before** it constructs `CommandManager`. A user who runs a command
in that window waits on it. It also shows an information message on every activation when the
platform has no engine binary.

- Register commands, the serializer and the content provider **first, synchronously**.
  Resolve Git in the background into a `Deferred<GitExecutable | null>`. Engine reads never
  wait for it, and writes await it.
- Cache the last good `{path, version, mtime}` in `globalState`, use it immediately, and
  revalidate in the background.
- "No engine for this platform" / "running without Git": show **once per extension version**
  (globalState flag), then keep the information in the settings page's backend section,
  which already exists for engine failures.
- The `ggs` `mobileAdaptation` seeding writes user settings during activation. Move it to
  first panel open, or better, express it as a default inside the snapshot reader without
  writing settings.
- Measure: add the activation marker (P-workstream) and hold the §3.8.1 "≤ 20 ms sync" budget.
- Revisit `activationEvents`. `workspaceContains:.git` activates during window startup in
  every Git workspace. On ≥ 1.47, `onStartupFinished` already covers the status bar and
  prewarm without contending with startup. Keep `workspaceContains` only for <1.47 (it's
  harmless there), and confirm with the P4 cold-start measurement before changing anything.

### V2. Workspace Trust and virtual workspaces (1 day + decision D-1)

`package.json` declares no `capabilities`. On VS Code ≥ 1.56 that means the extension is
**disabled in Restricted Mode**. This is safe, but the decision was made by omission. Running
the `git` CLI in an untrusted folder is a real code-execution vector (`core.fsmonitor`,
`core.sshCommand`, hooks, `diff.external`), while the in-process engine reads do not execute
repository-configured programs.

Proposal: declare `"untrustedWorkspaces": { "supported": "limited", "description": … }` and
`"virtualWorkspaces": false`. In restricted mode, serve reads from the engine only
(`createBackend` with no `gitPath`, the same code path as "Git not installed", which is
already tested), disable writes and CLI fallbacks, and show a banner. Feature-detect
`vscode.workspace.isTrusted` through `vscodeCompat.ts`, since it is absent on 1.38 and the
old behaviour stays there.

### V3. Webview lifecycle and memory (1.5 days + decision D-2)

- `retainContextWhenHidden` defaults to `true` (memory cost on every hidden panel). Snapshot
  first paint (D10) now exists, so measure hidden→visible restore with and without retained
  context (P3/P4). If snapshot restore meets the "snapshot first paint ≤ 150 ms" budget,
  propose flipping the default.
- Inbound message validation: confirm the router rejects unknown `command`s and unknown
  `repo` paths before dispatch (REFACTOR-PLAN §3.2 minimal guard). Add a fuzz test (random
  JSON → router) to `test/integration/host`.
- `localResourceRoots` is `media/` only, which is correct. Keep the CSP without
  `unsafe-inline`/`unsafe-eval` outside the automation build, and add a tooling test that
  asserts this on the generated HTML for both builds.

### V4. VSIX hygiene (0.5 day)

Measured in `git-graph-rs-1.1.0.vsix`:

- `media/vendor/markdown-it.min.js` (103 KB) ships, but nothing loads it: the webview uses
  the on-demand `chunks/markdown-it-*.js`. The only reference is a comment in
  `graph/text/markdown.ts`. Delete it from the vendor step and the allowlist.
- `media/vendor/highlight.min.js` (165 KB) is the full highlight.js for the comparison view.
  Build a language subset (the commonly diffed languages plus auto-detect fallback) through
  the existing `scripts/highlight-entry.js`, or lazy-load per language.
- Add P5 rows for the **total VSIX size** and **per-platform `.node` size** with a 2% growth
  rule, so a regression like this one gets caught.

### V5. Diagnostics without telemetry (1 day)

Add a "Git Graph RS: Show Diagnostics" command that collects backend in use, engine
version/failure class, Git path/version, VS Code/Electron/Node versions, the last 20 perf
traces (P-workstream) and the active non-default settings into an untitled document, ready
to paste into an issue. This is the §3.8.7 "Show Performance Trace" command, extended, and
needs no telemetry.

---

## 5. Workstream R: Rust engine

The engine is the strongest part of the codebase: one typed protocol, `pub(crate)`
internals, `catch_unwind` at the boundary, cooperative cancellation, git-parity tests and
property tests for incremental traversal. The remaining work is lifecycle, resource bounds
and toolchain discipline.

### R1. Repository handle lifecycle (1.5 days)

`repository::RepoManager`:

- **Poison safety.** `get/close/close_all/open_count` call `.lock().unwrap()`. A panic while
  the lock is held poisons it, and every later request then panics. `catch_unwind` turns each
  of those into `Internal`, so the engine is effectively dead for the session and silently
  falls back to the CLI. `incremental::Store` already uses
  `unwrap_or_else(PoisonError::into_inner)`; apply the same everywhere (or switch to
  `parking_lot::Mutex`, which does not poison).
- **Keying.** Handles are keyed by the path the request names, not the discovered root. Verify
  that every host call passes a root. If any passes a subdirectory (e.g. file-history
  requests), two handles to one repository coexist with two object caches. Key by
  `gix::Repository::git_dir()` canonicalised, with a small path→root memo.
- **Eviction** (REFACTOR-PLAN §3.8.6, never implemented): track `last_used: Instant` per
  handle; on each `get`, evict non-current handles idle > 10 min. Expose `stats()` (open
  count, cache bytes) through the protocol for the diagnostics command (V5).

### R2. Cache budgets in bytes, not entries (1 day)

`incremental::Store` caps at 64 entries and **clears everything** when full. Each entry
holds a whole window of `CommitRecord`s plus a `visited` set of hex `String`s (≈ 64 B heap +
24 B header per hash vs 20 B for an `ObjectId`).

- Store `ObjectId` in `visited`/`tips`. This halves memory and removes an allocation per commit.
- Replace "clear all at 64" with LRU by approximate bytes (sum of record sizes, tracked on
  insert), with a budget (e.g. 64 MB) set by the host in `open` params.
- P1 bench: measure an incremental refresh on M/L before and after.

### R3. Respect the shared libuv thread pool (0.5 day + measurement)

`AsyncTask` runs `compute` on **libuv's thread pool** (4 threads by default), which the whole
extension host shares for `fs`, `crypto`, `zlib` and `dns`. Four concurrent long traversals
(open + follow-ups + prewarm + avatars) can stall every other extension's file IO. The host
scheduler limits *background* work to 1, but interactive work is unlimited.

N-API 3 rules out a `ThreadsafeFunction`-based private pool, so the fix is a cap: an
in-binding semaphore that allows **≤ 2 engine tasks in compute at once** (further requests
wait on the Rust side, in a single dedicated waiter thread that does not occupy a libuv
slot). Alternatively the host scheduler caps in-flight engine requests at 2 overall.
Validate with a P2 scenario: run an `fs.readFile` latency probe during a full M-tier load.

### R4. Toolchain and lint policy (1 day)

- `rust-toolchain.toml` pinning the dev toolchain (CI uses `dtolnay/rust-toolchain@stable`
  today, so a new stable's clippy lints can break unrelated PRs).
- A CI step `cargo +1.82 check --workspace` holding `rust-version` (REFACTOR-PLAN §3.7.4,
  not implemented).
- `[workspace.lints]`: `unsafe_code = "forbid"` (the "no `unsafe` in the engine" rule
  becomes a compiler error), `clippy::pedantic` subset (`needless_pass_by_value`,
  `redundant_clone`, `inefficient_to_string`, `large_types_passed_by_value`,
  `doc_markdown`), and `missing_docs` warn on `pub` items.
- `cargo-deny` (licenses, advisories, duplicate versions, banned crates) in the static job.
  Hold the license allowlist next to `licenses/`.

### R5. Dependency surface (0.5 day)

- `ts-rs` is a normal dependency of `git-graph-core`, so it compiles into every release
  build. Gate it: `[features] ts = ["dep:ts-rs"]`, `#[cfg_attr(feature = "ts", derive(TS))]`,
  and enable the feature only in the `protocol` test via
  `[dev-dependencies] git-graph-core = { path = ".", features = ["ts"] }`.
- `base64`: the comment says `fileBytes` still answers base64 over the JSON protocol. The
  binding has `request_bytes` returning a `Buffer`. If no host path uses the base64 variant
  (grep the reader), delete the method and the dependency.

### R6. Binary size budget (1 day)

The Windows `.node` is **5.9 MB**, the largest file in the VSIX by 13×.

- Add `cargo bloat --release --crates` to the addon build, and make the P5 report fail on >2% growth.
- Experiments (keep only what P1 shows is free): `lto = "fat"`; audit `gix` features
  (`parallel` pulls in threads that `AsyncTask` concurrency already provides; `dirwalk`/`status`
  needed); `regex` → `regex-lite` where patterns are simple (check `read/gerrit.rs`, `text.rs`).
  Keep `opt-level = "s"` unless P1 says `3` is worth the size.

### R7. Fuzzing the boundary (1 day)

The protocol decoder takes host JSON, and the parsers take repository bytes (commit
encodings, Gerrit NoteDb meta, mailmap). Add `cargo-fuzz` targets for `protocol::request`
(arbitrary JSON) and the Gerrit meta parser. Run them nightly for 10 minutes and commit any
crash as a regression test. `catch_unwind` keeps a crash from taking down the host, but a
panic still means silent CLI fallback.

### R8. Module size and the platform matrix (2 days)

- Split `read/log.rs` (872) into walk/ordering/window and `read/gerrit.rs` (746) into meta
  parsing/state derivation. These are pure moves within the crate.
- Add `x86_64/aarch64-unknown-linux-musl` and `armv7-unknown-linux-gnueabihf` to the
  `native-build.yml` full matrix and the release matrix (`build-addon.mjs` already supports
  them via zigbuild), plus a C3 container smoke (`alpine`, `centos:7`). Until this runs,
  DoD #11 is "not held".

---

## 6. Workstream F: Webview frontend

The ES-module split, `SafeHtml`, the coalesced render scheduler and on-demand chunks are the
right foundations. What remains is the state model and component discipline: the parts that
make a large imperative UI maintainable without a framework (D6 stays "no framework").

### F1. A store with slices and change sets (3 days)

`state/store.ts` is a class of ~30 **public mutable fields** (`commits`, `gitBranches`,
`currentRepo!`, …) with two listener lists (config, render invalidation). Any module can
assign any field, nothing records *what* changed, and every change invalidates the whole
render.

Target, still framework-free:

- Slices (`repos`, `refs`, `commits`, `details`, `ui`, `integrations`), each `readonly` from
  outside, changed only through a slice's named actions (`commits.replacePage(...)`,
  `refs.apply(snapshot)`).
- Every action emits a typed change (`{ slice: 'refs', keys: [...] }`). The render scheduler
  collects one frame's changes and calls only the renderers subscribed to those slices. The
  table's keyed-by-hash patching (5.10) then gets precise inputs instead of "something changed".
- `commitLookup` becomes a `Map<string, number>` owned by the commits slice and kept in sync
  by the slice's own actions. Today it is a plain object whose consistency with `commits`
  is every caller's job.

Migrate slice by slice behind the existing class's getters, so each PR stays small.

### F2. `RepoLoader` → an explicit load state machine (3 days)

`loading/repoLoader.ts` (1111 lines, ~45 methods) is now the webview's god class. It owns
snapshot painting, repo switching, pushed `loadView` reconciliation, staged follow-ups
(remote refs, uncommitted, Gerrit, PRs), avatars, error display and refresh. Its flags
(`currentRepoLoading`, `refreshState`, "snapshot refreshing", "pending scroll commit",
`remoteRefsPending`, `uncommittedPending`) encode an implicit state machine. The latest merge
("the reseed hazards the smoke run exposed") is the symptom.

- Model the lifecycle explicitly: `Idle → SnapshotPainted → Loading(requestId) → Loaded →
  Refreshing(requestId) → Loaded`, plus `Error`. Each response is accepted only in states
  that expect it, keyed by `requestId`, and anything else is dropped and logged.
  Transitions are a pure reducer, unit-tested exhaustively (table-driven: state × event).
- Split out the side effects: `LoadRequests` (issue/cancel), `FollowUps` (PRs, avatars,
  Gerrit), `LoadErrors` (display).
- Acceptance: no file over 400 lines in `loading/`; the transition table has a test per
  (state, event) pair; the E2E smoke reseed scenarios pass with no special-casing.

### F3. Component lifecycle and DOM ownership (2 days)

Measured: **143** `document.getElementById/querySelector*` calls across 25 files, and
**153** `addEventListener` vs **7** `removeEventListener`. The component convention (§3.4:
"mutates DOM only under its own root; no cross-component `getElementById`") is not enforced,
and listeners are never torn down. That is harmless while the page lives forever, but
repo-switches and widget re-creation leak handlers and keep detached DOM alive.

- `Component` base: constructed with `(root, store, bridge)`, owns a `DisposableStore`, and
  has `listen(el, type, fn, opts)` that registers its own removal. `dispose()` is called by
  the parent.
- Delegated events at the component root (`data-action` attributes, which the coverage
  matrix already extracts) instead of per-row listeners.
- ESLint `no-restricted-properties` for `document.getElementById/querySelector` outside
  `main.ts` and `common/dom.ts`. Burn down the existing sites through suppressions (G2).

### F4. Layout read/write discipline (1 day)

64 layout reads (`offsetHeight`, `getBoundingClientRect`, `clientWidth`, `scrollHeight`, …)
sit outside `render/measure.ts`, against §3.8.5's rule. Route them through `measure.ts`
(batched reads before writes in the frame) and add the same lint restriction. Use P3's
long-task observer to confirm no forced-reflow regression on 10 K rows.

### F5. Accessibility (3 days)

The whole webview has **31** `aria-*`/`role` usages. A Git history view is primarily a data
grid, and today it is not navigable by screen reader or keyboard alone.

- Commit table: `role="grid"`, `aria-rowcount`/`aria-rowindex` (required for the virtualized
  window), roving `tabindex`, ↑/↓/PgUp/PgDn/Home/End navigation, Enter = open details,
  Shift+F10 / ContextMenu key opens the row's context menu.
- Context menus and dropdowns: `role="menu"`/`menuitem`, arrow keys, Escape, and focus
  return to the invoker.
- Dialogs: `role="dialog"`, `aria-modal`, focus trap, initial focus, focus restore.
- Graph SVG: `aria-hidden` (the table carries the information); ref labels get
  `aria-label` ("branch main, HEAD").
- Themes: 123 hard-coded colours in CSS. Map them to `--vscode-*` tokens, and verify both
  high-contrast themes with the existing `scripts/dev/theme-audit` harness.
- Gate: `axe-core` run inside P3's Chromium page (no new runtime dependency) and failing on
  serious/critical violations.

### F6. CSS architecture (1.5 days)

Finish W7: merge `styles/mobile/*.css` (11 files) into their component files under
`.mobileMode`/`@media` sections, and introduce `tokens.css` as the only place that reads
`--vscode-*` variables. Components then use semantic tokens (`--gg-row-hover`, …). Keep the
stylelint Chromium-69 gate.

### F7. One dictionary, really (0.5 day)

Move `webview/binaryCompare/strings.ts` and the locale literals in `common/dates.ts` into
`shared/i18n/{en,zh-cn}.ts`, so the `satisfies Record<keyof typeof en, string>` parity check
covers them.

---

## 7. Workstream P: Performance and observability

Without timing measurements the budgets are guesses: every §3.8.1 timing row says "pending".

### P1. The markers (2 days)

- `shared/perf/trace.ts`: a tiny isomorphic trace API (`mark(name)`, `span(name, fn)`).
  Host: `perf_hooks.performance` (Node 8.5+). Webview: `performance.mark`. Off by default,
  ≤ 1 µs per call when off.
- Mark T0 (command), T1 (panel created), T2 (webview script start), T3 (host data ready), T4
  (webview receive), T5 (rAF after first rows), plus load-more, expand-details, refs-only op
  and HEAD op. The webview sends its marks to the host in one message after T5. The host
  keeps a 20-trace ring buffer (feeds V5) and writes to the log when `enableLog` is on.
- `analyze-log.mjs` already aggregates; extend it to trace P50/P95.

### P2. Calibrate, then gate (2 days)

- Add the S/M/L fixture generator (REFACTOR-PLAN task 0.5, not present per docs/performance.md).
- Implement P4 in the E2E launcher (read the trace ring buffer after scenarios) and run S/M
  nightly.
- Calibrate the timing budgets once against real numbers (ADR-0007), then they only tighten.
- Note on ADR-0005: the critical-JS budget was raised from 200 KB to 360 KB (entry
  closure). That was an allowed one-time recalibration. Hold the line now: the P5 >2% rule
  applies to the closure as well as the entry.

### P3. Activation and host bundle (1 day, after P1 measures it)

`dist/extension.js` is 442 KB minified and evaluated in full at activation. The automation
code is already define-gated. If the activation marker shows module evaluation over the
20 ms budget, emit `views/binaryCompare`, `integrations/gerrit`, `integrations/pullRequests`
and `avatars` as separate CJS entry bundles and `require()` them on first use. esbuild cannot
code-split CJS, so these are separate entries that share nothing big. Do this only on measured evidence.

---

## 8. Workstream S: Security and supply chain

| # | Item | Change |
|---|---|---|
| S1 | Workspace Trust undeclared | V2 |
| S2 | Rebase editor generated as JS source strings (`graphView/writeFlows.ts:469-472`), written to temp files, run via `process.execPath` + `ELECTRON_RUN_AS_NODE` | Ship them as real files `dist/editors/{sequence,message}.js` (like askpass), unit-test them, pass data only via argv/env. Write temp files with `fs.mkdtemp` under `os.tmpdir()` and mode `0o600`, and clean up the directory, not 4 named files |
| S3 | Argument validation has 2 call sites | A3 |
| S4 | CI supply chain: `curl … \| sh` installs cargo-zigbuild (`perf.yml:70`); actions pinned by tag (`@v4`, `@stable`) | Install via `taiki-e/install-action` with a pinned version; pin third-party actions by commit SHA (Dependabot keeps them current) |
| S5 | No dependency auditing | `cargo-deny` (R4); `npm audit --omit=dev` (runtime deps: only `iconv-lite@0.5.0`, from 2019, which should be bumped or replaced with `TextDecoder` where the encodings allow) |
| S6 | Webview CSP | Tooling test asserting no `unsafe-*` in the production HTML (V3) |
| S7 | Inbound protocol | Router fuzz test (V3); engine protocol fuzz (R7) |

---

## 9. Workstream D: Repository and documentation hygiene (1 day)

- Delete or rewrite `GAPS.md`. It describes `DataSource`, `tests/backends.test.mjs` and
  `src/gerrit.ts`, none of which exist; DoD's last bullet requires it to contain no outdated
  descriptions. The still-true content (write path not on the engine, deviations table)
  moves to `docs/BACKENDS.md` §"Known deviations".
- Root clutter: `build-vsix.bat` (untracked; REFACTOR-PLAN B7 merges installers into
  `npm run dev:install`), the 3 MB `git-graph-rs-1.1.0.vsix`, `tsconfig.tsbuildinfo`, `out/`
  and `.zcode/`. Add them to `.gitignore` or remove them. `build:ts`/`out/` survive only for
  `test/perf/lib/env.mjs`; switch that to esbuild-on-the-fly (`esbuild.build` with
  `write:false`) and delete `build:ts`.
- `engines.node` → `.nvmrc` + CONTRIBUTING (REFACTOR-PLAN §3.7.2).
- `dod-status.md` rewritten per §1, with the stricter "held = CI fails on regression" rule.
- `ARCHITECTURE.md` §9 ("honest list") gains the items of this plan, and each one is
  removed when it lands.

---

## 10. Decisions needed

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D-1 | Restricted Mode behaviour | `supported: "limited"`: engine-only reads, no writes, no CLI | Engine reads don't run repository-configured programs; today's implicit "disabled" is safe but unhelpful |
| D-2 | `retainContextWhenHidden` default | Decide from P3/P4 data: flip to `false` if snapshot restore ≤ 150 ms | Memory per hidden panel vs restore latency, with snapshot first paint in place |
| D-3 | ESLint backlog handling | Bulk suppressions + all rules at error | Makes the ratchet mechanical; warnings nobody reads are not gates |
| D-4 | Engine concurrency cap | ≤ 2 concurrent engine computes | Protects the shared libuv pool; measured by R3's probe |
| D-5 | Coverage thresholds | Start at measured − 1 pt, ratchet up | The §6.5 end-state numbers today would fail or be waived; a waived gate is no gate |
| D-6 | `noUncheckedIndexedAccess` | On, with suppressions | Highest-yield strictness flag for index-heavy table/graph code |

---

## 11. Milestones

Estimates in person-days; one person unless noted. Every PR follows REFACTOR-PLAN §2.3
(≤ 800 net lines, pure moves separate, tests replaced rather than stacked).

| Milestone | Contents | Estimate | Exit criteria |
|---|---|---|---|
| **M0: Truth and gates** | G1–G5, D (docs/ledger), S4 | 4–5 | `npm run check` green in a CI `static` job; ESLint/depcruise/tsc/drift/coverage all fail on regression; `dod-status.md` matches §1 |
| **M1: Host and platform** | A1, A2, A3, A6, A7, V1, V2, V4, S2 | 14–16 | `src/` root holds only `extension/`, `webview/`, `shared/`; no static panel; one process adapter (depcruise-enforced); activation registers commands before any spawn; Workspace Trust declared |
| **M2: Engine and performance** (parallel with M1, second person) | R1–R8, P1, P2 | 12–14 | Poison-safe, evicting handle cache; byte-budgeted caches; toolchain/MSRV/deny in CI; musl/armhf built and smoked; T0–T5 markers live; timing budgets calibrated (ADR-0007); P4 nightly |
| **M3: Frontend** | F1–F7, V3, P3 (if measured) | 14–16 | Store slices with change sets; load state machine with exhaustive transition tests; no global DOM queries outside entry/dom; axe gate green; mobile CSS merged |
| **M4: Close-out** | A4, A5, V5 | 7–8 | `getConfig` deleted, manifest-derived schema; no production file > 600 lines (suppression list empty); Diagnostics command shipped |

Total ≈ **51–59 person-days**, ≈ 6–7 weeks with two people (M1 ∥ M2, then M3, then M4).

### Order of risk

- **Highest risk:** F1/F2 (state model under a live, performance-sensitive UI). Land the
  transition-table tests and P3 measurements before moving any field. Ship behind a
  pre-release (REFACTOR-PLAN §9 rollback rule).
- **Medium:** A3 (process adapter). Windows quoting, `windowsHide` and askpass env differences
  between the current paths. Characterise each site's argv/env in tests first.
- **Low:** G-workstream, D, R4/R5, V4. These are mechanical and start immediately.

### What this plan deliberately does not do

- No frontend framework, no Prettier, no `engines.vscode` bump (REFACTOR-PLAN D1/D4/D6 stand).
- No migration of writes onto the engine (still a non-goal. `gix` has no push, and the seam exists).
- No new runtime dependencies. `axe-core`, `cargo-deny`, `cargo-fuzz` and `cargo-bloat` are dev/CI only.

---

## 12. Progress

### M0 (branch `task/m0-gates`)

Landed: G1, G2, G4, G5, S4, and D except the `build:ts` removal. G3 landed without
`no-unnecessary-condition`. [dod-status.md](dod-status.md) is rewritten under the "held = CI fails
on regression" rule.

Measured while doing it, correcting §1:

- `checkUnsafeGitArgs` has **19 call sites in 6 files**, not 2. A3's "one call site" target is
  correspondingly larger.
- The `max-lines` backlog is 15 TypeScript files plus 2 Rust files. `commitTable.ts` crossed 600
  lines after this plan was written; the i18n dictionaries are data tables and are exempt.
- **The test tree was never typechecked.** The old root `tsconfig.json` covered `src/` only, so
  `test/**` held 94 type errors. They are fixed, and the tests are now the root project.
- ESLint's backlog is 306 suppressions. The type-aware rules added 74 `no-floating-promises` and
  7 `no-misused-promises` findings, all suppressed and due for burn-down as §3 touches each file.

Deviations from the text above:

- **G5, `tsc -b`**: not used. Project references would force `composite` and declaration emit
  for every leaf, and buy only incremental builds. `npm run typecheck` runs the four leaves
  (`src/tsconfig.json` host, `src/webview/tsconfig.json`, root `tsconfig.json` tests,
  `test/e2e/tsconfig.json`) over a shared `tsconfig.base.json`. The host leaf stays at
  `src/tsconfig.json` until A1 empties the flat root, because esbuild and Vitest resolve the
  nearest config. The bundles are byte-identical to before, apart from two `return undefined`
  statements that `noImplicitReturns` required.
- **G5 / D-6, `noUncheckedIndexedAccess`**: not enabled. It reports 332 host and 886 webview
  errors, and TypeScript has no bulk-suppression file, so "on, with suppressions" would mean
  about 1,200 `@ts-expect-error` comments. Proposal: enable it per directory as F1/F2 rewrite
  the code it matters most for (`commitLookup`, the table).
- **G3, `no-unnecessary-condition`**: left out. With `noUncheckedIndexedAccess` off, TypeScript
  treats every indexed read as defined, so the rule flags every legitimate `if (arr[i])` guard.
  Enable it together with D-6.
- **D, `build-vsix.bat`**: kept. It is tracked (commit 58fc9d6), not untracked clutter. The other
  root artifacts listed in §9 were already gitignored.
- **D, `build:ts`**: kept, now compiling the host leaf only. Moving `test/perf/lib/env.mjs` to an
  in-memory esbuild build is left for when P2 is next touched.
- **G4**: the Vitest default timeout is raised to 20 s, and one fixed-tick wait in
  `repoManager.test.ts` became a `vi.waitFor`. Under coverage instrumentation the suite
  otherwise failed 1–3 different load-sensitive tests per run.

Found, not fixed: `docs/performance.md` still cites the deleted `scripts/bench.mjs`.

### Wave 1: M1 ∥ M2 ∥ M3 groundwork (branch `task/m0-gates`, 2026-10-27)

Seven parallel agents over disjoint file domains; integrated and landed as ten workstream
commits. Landed: **R1, R2, R3, R4, R8, V1, V2, V4, S2, F6, F7**, plus the F2 transition-table
core (unwired, per the order-of-risk rule). Every gate green: `npm run check`, the full test
suite (143 files), the size gate.

Decisions taken per the recommendations: **D-1** (`untrustedWorkspaces: "limited"`,
engine-only reads, no writes, no CLI) and **D-4** (engine compute cap 2, in the binding).

Measured while doing it, correcting this plan:

- **The 1.82 MSRV was fiction.** 67 of 194 locked crates declare `rust-version` above 1.82
  (gix 0.90 and the napi 3 families need 1.88); `cargo +1.82 check` cannot even resolve the
  workspace. `rust-version` is now 1.88, and `docs/compatibility.md` + REFACTOR-PLAN §3.7.4
  follow. `rust-gates.yml` holds it with `cargo check --locked` and adds cargo-deny.
- **The 165 KB highlight.js was already a 35-language subset**, not the full build. Trimmed to
  27 languages (164,741 → 136,226 bytes; the dropped ones ride `highlightAuto`).
- **F7 tripped the fresh VSIX size gate at +2.56%**: esbuild cannot tree-shake object
  properties, so both single-file IIFE pages embedded the full bilingual dictionaries
  (+149 KB each). Fixed with a generated 141-key subset redirected at build time
  (`gen-compare-subset.mjs`, drift-checked by `check:generated`); the pages are back to
  60/76 KB and the VSIX lands at **+0.42%** over baseline.
- **The S2 rewrite fixed a real bug**: the old generated editor code matched only abbreviated
  hashes, gluing the commit subject onto the author-change `exec` line (git read the subject
  words as pathspecs). Regression-covered now.
- **The V2 sketch was unsafe on engine-less machines**: a backend built with `gitPath: null`
  degrades to `CliBackend('git')`, which would run the CLI in an untrusted folder. Restricted
  mode uses an explicit `engineOnly` backend plus an `unavailable` proxy instead.
- **R3's constraint is hard**: under N-API 3 no background thread can settle a promise
  (napi-rs's deferred is N-API 4-gated precisely for that). Design: free slot → inline on the
  caller's libuv thread; overflow → two dedicated Rust workers; one sentinel AsyncTask per
  overflow episode delivers results. Max uv occupancy while waiting: one parked thread.
- **DoD #3's Rust backlog is empty** (31 production `.rs` files, none over 600): the R8a
  splits and moving the incremental store's inline tests to `incremental/tests.rs`.

Deviations from the text above:

- **R2**: the byte budget defaults to 64 MiB; the host-tunable budget through `open` params is
  deferred. The `engineStats` protocol method feeds V5 later.
- **R4**: `missing_docs` deferred (it would flood dozens of files at once);
  `cargo-deny`'s config is CI-verified only (not installed locally); `multiple-versions` is
  warn, not deny (duplicates exist in the gix tree today); `unsafe_code = "forbid"` is
  engine-only — in the binding, napi-derive's generated `#[allow(unsafe_code)]` makes a forbid
  a hard E0453 error, so that crate keeps a scoped, documented allow.
- **R8b**: the musl/armhf binaries build and ship, but `addonLoader.ts` cannot select them yet
  (libc/armv7 detection is the follow-up), the C3 alpine/centos smoke is still open, and the
  build job's missing cargo-zigbuild install turned out to affect the existing linux-gnu legs
  too — fixed for all of them.
- **V2**: webview write buttons in restricted mode surface the misleading no-Git error (a
  protocol change to disable them properly is out of scope); the restricted banner is
  per-session; `spawnStream` cannot await the deferred Git resolution and can error once in
  the ~50 ms first-activation window.
- **F6**: `styles/tablet/**` still has the per-device layout (same merge treatment is the
  follow-up); the comparison/binaryCompare standalone sheets still read `--vscode-*` directly
  (they do not import tokens.css); `out.min.css` is 63 KB against the 60 KB budget line — an
  overflow that predates this wave (61 KB), now 3 KB over after the defensive token fallbacks.
- **F2**: the state machine (11 states, 8 events, 136 tests) is deliberately unwired; the
  wiring sketch lives in the module docs, and three flag-machine hazards are already provably
  gone from the table (a pushed `loadView` can no longer stomp a running cycle).

Found, not fixed:

- `dropdown.test.ts` leaks a timer that surfaces as a post-teardown error under heavy parallel
  load (all 143 files green on re-run; the file is untouched by this wave).
- `docs/baseline-2026-10.md` still names the removed vendor file; regenerate with
  `npm run baseline`.
- `docs/performance.md` / `scripts/bench.mjs` (from M0), and the activation budget (≤ 20 ms
  sync) remains unmeasured until P1.

Remaining for M1: A1 (flat-root drain), A2 (composition root), A3 (process adapter — the
19-call-site argSafety finding from M0 still stands), A6, A7, V3, S5 remainder. Remaining for
M2: R5, R6, R7, P1, P2. Remaining for M3: F1, F3, F4, F5, V3 webview side, and the F2 wiring.

### Wave 2: M1 ∥ M2 ∥ M3 (branch `task/m0-gates`, 2026-10-27)

Seven parallel agents over disjoint file domains; integrated and landed as seven workstream
commits. Landed: **A1, A6, R5, R6, R7, P1, the F2 wiring, F5, V3's test gates (router fuzz +
CSP pin), S5, and the `build:ts` removal (D)**. Every gate green: `npm run check`, the full
test suite, and the size gate against the fat-LTO binary.

Measured while doing it, correcting this plan:

- **A6's headline example no longer existed**: `html.ts` already caches its per-render
  `readFileSync`/`statSync` behind module-level lazy caches (fixed at `fe79dbf`, before this
  plan was written). The remaining sites (operationState, the logger's file mirror, the
  Gerrit hook install) are async now; `n/no-sync` is an error for `src/extension/**` with
  12 sites fixed and the rest suppressed with per-file reasons.
- **R6's `parallel` suspicion was exactly inverted**: gix's `parallel` feature is not about
  extra worker threads — it is what makes the handle types `Send + Sync` (without it they
  hold `Rc`), and the warm-handle `RepoManager` fails to compile without it. All eight gix
  features are load-bearing; the audit lives as a comment on the dependency.
- **Fat LTO shrinks the Windows `.node` by 5.1%** (5,985,792 → 5,683,200 B) and the size
  baseline ratchets down with it. `opt-level = "z"` measured another −7.7% on top but is
  not landed: unmeasured hot-loop cost, held for P2's benchmarks. `panic = "abort"` is
  ruled out — `catch_unwind` is load-bearing.
- **R7 found no panics**: 50,000 seeded iterations per target (protocol decoder, Gerrit meta
  parser) plus fixed attack strings — clean. The nightly libFuzzer job is the ongoing gate.
- **The F2 wiring shrank the load-path safety margin to zero**: first-paint critical JS is
  at 360/360 KB (the machine now ships in the entry, +13 KB). The next webview feature that
  adds entry-closure bytes trips ADR-0005's gate.
- **F5's axe gate caught two real bugs** in the existing dialogs: unnamed text inputs
  (the name lived in an adjacent table cell) and positive `tabindex` values. Fixed.
- **A1 drained 79 files as pure moves**; `src/` now holds only `extension/`, `webview/`,
  `shared/` and `tsconfig.json`. The webview's protocol seam (`common/protocol.ts`) re-exports
  the new domain modules, which is why the F2/F5 agents' pre-drain code merged untouched.
- **Wave 1's "found, not fixed" items are closed**: the `dropdown.test.ts` timer leak is
  fixed, the baseline no longer names the removed vendor file (`npm run baseline` regenerated
  it), and `docs/performance.md` no longer cites the deleted `scripts/bench.mjs`.
- **Worktree-only ghost, documented for the next parallel wave**: through a junctioned
  `node_modules`, `vscode` resolves outside the workspace and seven depcruise baseline
  entries look stale. `.dependency-cruiser.cjs` now sets `preserveSymlinks: true`; the main
  checkout confirms `no stale entries`.

Deviations from the text above:

- **A1**: `docs/depcruise-baseline.json` regenerated (8 entries drained, 14 transition-debt
  entries added — they are A3's seams, e.g. `platform/*` imports now living inside the git
  layer's stricter scope). `main.ts` joins the composition-root vscode exception until A2.
- **F2**: fully wired, but three documented tightenings ship with it — a refresh during the
  boot push is dropped instead of racing it, a pushed `loadView` after a switch is dropped
  instead of adopted, and a soft-refresh error keeps rows on screen. `loadMachine.ts` stays
  at 533 lines (the transition table is its bulk). The E2E smoke did not run during the wave
  (a sibling's transient node_modules repair broke esbuild mid-run); the automationRunner
  reseed coverage ran in its place, and the smoke re-run is on the next wave's checklist.
- **F5**: scoped to semantics + keyboard + the axe gate; the theme-colour mapping and
  `dropdown.ts` focus-return are deferred (overlay panels are toggled panels, not dialogs).
- **P1**: the activation mark was wired by integration after A1 landed (`main.ts`). Host and
  webview clocks are not synchronised — durations are within-origin only, by design. T0 opens
  a trace only for the two view-opening commands; other entry points (restore, orphan
  replacement) auto-open a `session` trace.
- **R5**: `requestBytes` (the raw-Buffer channel that replaced base64) currently has **zero
  host callers**; deleting it is a separate, deliberate decision. `Cargo.lock` format bumped
  to v4 by cargo 1.97 (readable by the 1.88 MSRV toolchain).
- **V3**: the CSP test pins `script-src` (no `unsafe-inline`/`unsafe-eval` in production,
  automation's only delta being `unsafe-eval`); `style-src 'unsafe-inline'` is kept — the
  page's inline theme block needs it, so the plan's literal "no unsafe-*" is unachievable
  there. The pre-dispatch repo-path allowlist does not exist (it is panel.ts's job); the
  fuzz test documents the gap and pins the strongest true guarantee instead: a forged write
  to an unknown repo is refused with zero git spawns.

Found, not fixed:

- `requestBytes`'s zero host callers (above), the overlay panels' dialog semantics, the
  control-bar dropdowns' focus return, and the E2E smoke re-run — all queued for wave 3.

### Wave 3: M1 ∥ M2 ∥ M3 ∥ M4 groundwork (branch `task/m0-gates`, 2026-10-27)

Seven parallel agents over disjoint file domains; integrated and landed as seven workstream
commits. Landed: **A2, A3, the automation rows of A5, P2, F3, the F6 close-out, the R8b
close-outs (libc/armhf engine selection, the C3 container smoke) and the R5 leftover
(`requestBytes` deleted)**. Decision taken: **D-2** — `retainContextWhenHidden` stays `true`
(ADR-0007 measured a 52 ms restore with a retained page against 227 ms without; the 150 ms
bar for flipping is not met). Every gate green: `npm run check`, the full test suite, and the
size gate — the Windows `.node` ratchets down again to 5,661,184 B with `request_bytes` gone.

Measured while doing it, correcting this plan:

- **A3's rule lands with zero exceptions**: after the `run`/`collect`/`stream` verbs absorbed
  the CLI read path, commit files, findGit's probes and the hex-diff streams, no production
  file outside `git/process/**` and `automation/**` imports `child_process`. The
  characterization tests caught two deliberate deltas: probe spawns now carry
  `windowsHide: true` (killing a Windows console flash), and ENOENT messages are uniform.
- **F3's burn-down**: `document.*` DOM queries in the webview went from ~140 to 27 (8
  sanctioned in main.ts, 19 suppressed — the standalone compare pages and the frozen loading
  modules), enforced by a `no-restricted-properties` rule. 73 raw `addEventListener` calls on
  converted widgets now run through listener stores, and the page's components dispose on
  reset.
- **F6's close-out brings the first-paint CSS back under budget**: 65,233 → 61,216 B
  (unreachable fallback vars, unified two-line row rules, dialog-only tokens moved to their
  consumers). The theme audit shows a 0.0000% pixel diff on the tokenized compare pages
  across all four themes.
- **ADR-0007 lands a partial calibration**: S tier, engine path — open-hard 116 ms,
  open-cached 95, load-more 19, expand-details 0.8, refs 3.6, HEAD 16 — every §3.8.1 budget
  confirmed as written, only-tighten from here. The CLI fallback's latencies are recorded but
  deliberately not a relaxation basis. M/L and the in-editor T0–T5 sums remain pending (the
  nightly owns them).
- **R8b's selection order**: the musl builds carry their libc statically, so when the runtime
  cannot name its libc the musl binary is the primary candidate — it loads everywhere;
  leading with gnu would hand the rarest host a binary that cannot load there.

Deviations from the text above:

- **A2**: `main.ts` is 199 lines and every composition-root-constructed class takes ≤ 4
  parameters, but the three view controllers keep 7–9-parameter `open` factories (they are
  not composition-root-built). The `automation/graphViewPort` module-level singleton remains
  by design.
- **F6**: full tokenization of the compare pages would have re-inflated the first-paint
  sheet; page-specific `--vscode-*` reads stay, documented as the second exception in
  tokens.css. `styles/tablet/` is deleted, the two sheets the widget TS imported as text
  included.
- **F3**: delegated `data-action` events landed only where per-item listeners piled up
  (context menu items, custom-select options); the compare webviews keep their document
  queries behind suppressions.
- **P2**: the calibration used the pipeline half of the P2 gate — the collector found a real
  defect in the log mirror on the way (below), so the in-editor trace sums are pending on it.
- **A5**: `cleanupActionSurfaces` gained an explicit `currentTerminals` getter parameter to
  keep the vscode seam inside the already-baselined suiteRunner.

Found, not fixed (wave 4's queue):

- **`external/commit-appears` fails deterministically in the E2E smoke** (22 passed / 1
  failed / 2 skipped on VS Code 1.143.1): the watcher-driven refresh never reaches a view
  whose repository is not the workspace folder — `refreshMessages 0`, rows stale. Reproduced
  on the wave-2 tree too; the smoke had not run between the F2 wiring and the P2 harness.
  Suspects: `vscode.workspace.createFileSystemWatcher` delivering nothing for
  out-of-workspace `RelativePattern`s on current VS Code, or a mute window that never
  resumes. Fixing it is wave 4's first item.
- **The session logger's mirror died once in the E2E profile** (~100 ms after activation):
  a failed truncate nulled `logFile` while `enabled` stayed true, and the equal-value guard
  in `setEnabled` pinned the session to channel-only forever. **Fixed in this wave** — any
  enable now rebuilds the mirror when the configured path lost its live file — with a
  recovery regression test.
- The automation build prints 367 KB of first-paint critical JS against the 360 KB budget;
  the production P5 is the referee (the automation bundle has always been the fatter
  variant).
- The theme-audit references for the `out` pages are stale; regenerate with
  `theme-audit --update-reference` (F6's close-out verified the current outputs
  pixel-identical).

### Wave 4: M4 (A4, A5 groundwork, P3 evidence) ∥ M3 close-out (F1) ∥ the watcher defect (branch `task/m0-gates`, 2026-10-27)

Three parallel agents over disjoint file domains (the `external/commit-appears` defect, A4, F1),
plus the gate consolidation and the P3 evidence measurement. The watcher defect's engine leg is
the wave's remaining item; this section is finalized when it lands.

Landed: **A4** (one configuration model), **F1** (store slices and change sets), the **P3
evidence** (no entry split), and the **600-line gate consolidation**.

- **A4** — `platform/config.ts` (1189 lines) is replaced by `platform/config/`: `schema.ts`
  (99 keyed rows; the `[K in SnapshotField]` shape makes a row's default unable to drift from
  its field's type at compile time), `snapshot.ts` (`takeSnapshot`, `onConfigChange`),
  `migrations.ts`, `cooked.ts` (every former per-key getter as a pure `*Of(snapshot)` view),
  `service.ts` (`ConfigProvider`/`ConfigService`), and a 47-line `legacy.ts` shim kept only
  for `repoManager.ts` (deleted when the A5 split migrates it). `getConfig()` is gone; ~57
  call sites across 17 production files migrated; the contract test (676 lines) asserts
  manifest ↔ schema parity in both directions plus the snapshot/cooked/service semantics.
  The migration drained the last 2 `git-layer-isolation` depcruise violations (`findGit` and
  `childProcess` take the paths/values as parameters instead of reading platform config).
  Found, later resolved as a false alarm: the manifest key
  `sourceCodeProviderIntegrationLocation` IS consumed — by the `scm/title` `when` clauses in
  the manifest itself (see wave 5's record).
- **F1** — the store is six slices (`repos`, `refs`, `commits`, `details`, `ui`,
  `integrations`) behind `state/slices/`, changed only through named actions, each emitting a
  typed `SliceChange` (`state/changes.ts`; row-scoped changes carry `hashes`, the keyed
  patcher's future input). The render scheduler routes by subscription: a pass runs only the
  renderers subscribed to the frame's slices, in pass order. `commitLookup` is a
  `Map<string, number>` owned by the commits slice (3 write sites, pinned by tests). Grep
  proves zero store-field writes outside `state/`. Deviation from the plan text, deliberate:
  actions emit only where the old code invalidated render (or where the same response's
  `renderSync` satisfies it) — literal "every action emits" measurably regressed the
  seamless-update guarantees; the routing mechanism is exercised by the pull-request path
  and the scheduler tests.
- **P3 evidence (no split)** — `scripts/dev/measure-activation.mjs` loads `dist/extension.js`
  (440 KB) under plain Node with a `vscode` stub: module evaluation **median 6.15 ms**
  (21 samples), `activate()`'s sync phase ~11.75 ms — both inside the §3.8.1 20 ms budget, so
  the entry stays whole (the plan's "only on measured evidence" line). The P4 event-loop probe
  remains the final authority on in-host blocking.
- **Gate consolidation** — the 600-line limit is enforced once, by
  `scripts/dev/check-file-size.mjs`, for TypeScript and Rust alike; ESLint's `max-lines` rule
  and its bulk suppressions are retired (a suppressed max-lines file could grow without
  limit; the size gate's KNOWN list holds each file at its recorded size and fails on
  growth). KNOWN holds 9 files; the A5 table above gained their webview rows. Suppression
  burn-down: 136 lines left `eslint-suppressions.json`.
- **The watcher defect (`external/commit-appears`)** — root-caused past the TS chain: the
  watcher fires, the refresh cycles, and the response applies — but the engine serves the
  **pre-change commit page while `head_id()` answers the new commit** (a page whose head is
  not among its own commits), persisting across handle close/re-open and incremental-store
  invalidation, only inside the long-lived extension-host session (isolated engine calls are
  always fresh). Landed remedies: the panel drops the engine handle on `commitsAffected`
  (mirroring the automation reseed), `close()`/`close_all()` invalidate the process-wide
  incremental store, and the page mirrors truthful load diagnostics onto `<body>` data
  attributes (the scenario's old `data-gg-refresh` counter read an attribute nothing wrote).
  The engine-leg fix and the scenario verdict are recorded in the addendum below.

**The watcher defect, closed.** Three faults stacked; each fix is landed and pinned:

1. **The engine's date-ordered window had no topological guarantee.** gix's
   `Sorting::ByCommitTime` is a pure date queue, so a tip whose committer date is older than the
   history around it (an out-of-band commit under a pinned date, an imported branch) fell
   outside the traversal window — a page whose `head` (read fresh) is not among its own commits.
   `walk_date_order_window` (read/log/walk.rs) now collects the window the way git's
   `--date-order` does: one pass counting every reachable commit's children (git's
   `limit_list`), then a date-ranked ready set over the counted graph. The shape is pinned by
   `an_out_of_band_commit_older_than_history_stays_on_the_first_page` (compares the engine's
   page against real `git log --date-order`), and the incremental property suites confirm the
   cost is not measurable (the incremental suite runs in its pre-fix time; it was never fast —
   its cost is git spawns, not reads). A first attempted "seed the tips into the window" fix was
   disproved by that same test: a window boundary commit's child count is undercounted (its
   other child sits outside the window), letting the boundary commit pop early — exactness
   needs the full count.
2. **The E2E harness pinned the out-of-band commit's dates.** The launcher sets
   `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` for every git process (fixture determinism), and the
   scenario's "a commit the way a user's terminal would" inherited the pins — tying it with the
   fixture's whole history, where the (now correct) tie order buried the row at position 286 of
   304, outside the 55-row rendered window. The pre-action setup now strips the two variables
   for that one spawn (`SetupGitEnv`): the commit carries the wall clock, is the newest commit
   in the repository, and the scenario asserts what it always meant to.
3. **The automation shim could wedge on a never-settling step.** An eval whose poll died in a
   `setTimeout` callback (a transient DOM throw) never settled its promise, and the shim then
   answered every later batch "a step batch is already running" — a whole-suite stall that
   masqueraded as the watcher defect twice. The shim gained a batch watchdog (60 s, well past
   the longest legitimate step) and the scenario's poll is exception-proof. The page also
   mirrors the LAST APPLIED commit response's own truth (`data-gg-last-commits`: count, head,
   head-in-list, head index, first entries) — "the response applied" and "the response was
   fresh" are finally separable, which is what cracked 1 and 2.

Reverted with intent: the transitional engine-handle drop on `commitsAffected` and the
close-invalidates-the-incremental-store change (both landed mid-investigation against the
stale-handle theory the ordering fix disproved; the handle drop also forced a full re-walk on
every external change). Freshness is the incremental store's guards' job, as before. The
watcher's purposeful log line stays, and `externalChange.contract.test.ts` pins the
head-in-its-own-list invariant at the reader seam. Full smoke: 23 passed, 0 failed,
2 skipped (VS Code 1.143.1, engine backend) — the scenario green for the first time since the
F2 wiring.

### Wave 4b/4c: the A5 splits ∥ F4 ∥ V5 ∥ A7 (branch `task/m0-gates`, 2026-10-28)

Eight parallel agents over disjoint file domains (five host splits, two webview split pairs,
the diagnostics command), then F4 on the integrated tree, then the A7 burn-down after
everything else landed (it touches every file). Twelve commits. Every gate green after
integration: `npm run check` (now including the comments gate), the full suite 156 files /
1727 tests, and the size gate with an EMPTY known-exceptions list — the first time no
production file is over the 600-line limit.

Landed: **A5** (all nine rows), **F4**, **V5**, **A7**, the **A4 shim deletion**
(`platform/config/legacy.ts` — the exit condition its own header stated, taken when
repoManager migrated to the snapshot), and the **P3 harness repair** (below).

- **A5** — the nine files and their new shapes: `commitLoader` → `openPath.ts` +
  `followUpStages.ts` (facade keeps the run state private through closure contexts);
  `repoManager` → `repoRegistry.ts` + `repoSettingsStore.ts` (both vscode-free; the facade
  keeps the 14-member public surface); `panel` → `messageRouter.ts` + `viewState.ts` (the
  fuzz suite's scope note follows the dispatch path); `storage` → per-store modules over a
  `VersionedStateKv`; `gitReader` → `backend.ts` (the contract) + `nativeBackend.ts` (the
  adapter) behind a 16-line re-export; `settingsWidget` → a 228-line shell + seven section
  modules; `commitDetails` → shell + summary/fileView/codeReview panes + `panelGeometry`;
  `contextMenuActions` → six per-menu modules behind a barrel (one on-demand chunk still);
  `commitTable` → `rowModel.ts` + `rowPatcher.ts`. All public surfaces unchanged — the
  importers needed zero edits (tsc-proven), and the moved code is verbatim.
- **F4** — 65 of the 71 layout reads outside `render/measure.ts` now go through read helpers
  (`measureClientSize`, `measureOffsetHeight/Top`, `measureBoundingClientRect`); a
  `no-restricted-syntax` rule rejects the geometry reads anywhere in src/webview except
  measure.ts. The 12 remaining reads are suppressed with reasons: the standalone
  comparison/binaryCompare bundles must not depend on the graph view's render modules, and
  `common/` sits below `graph/` in the layering — draining them needs a shared measure home
  in common/ (a layering decision, queued). The P3 no-forced-reflow check ran interleaved
  pre/post on this Windows box (7-sample runs): longtasks-10k medians {2,2,4} vs {3,2,3} and
  scroll-p99 overlap within the machine's spread (t2t5 on identical binaries ranged 48–114 ms),
  so no directional regression is observable here; the nightly on the reference runner stays
  the referee — and the harness had to be repaired first: `p3-webview.mjs` still loaded the
  A4-deleted `platform/config.ts`/`getConfig`; it now takes a real snapshot and maps it
  through the production `getWebviewConfig` (the harness can no longer drift from the real
  mapping). Note for the nightly owner: scroll-p99 on this dev box measures 138–185 ms against
  the 16 ms absolute budget on BOTH sides of F4 — pre-existing and environmental here.
- **V5** — `git-graph-rs.showDiagnostics` collects environment versions, the backend in use
  with the engine version or failure class, the Git executable, the last 20 traces (the ring
  buffer built as this seam), and the non-default settings (schema-row diff, structural
  equality, GitLab token redacted) into an untitled markdown document. The pure half is
  unit-tested; no telemetry.
- **A7** — 788 stale-history references rewritten across 488 scanned files (the count had
  grown from the plan's 323: the later waves' comments cited their own task numbers).
  Citations deleted, facts kept; `DataSource` sentences now name what the code is; "legacy X
  did Y" became present-tense descriptions; ~dozens of stale descriptions fixed on the way
  (dead `src/` paths, wrong module owners, comments describing deleted code). The gate
  (`scripts/dev/check-comments.mjs`, wired into `npm run check`) rejects task numbers, both
  plan names, `DataSource`, and `§N` markers in src/** — one deliberate extension beyond the
  plan's three patterns: OPTIMIZATION-PLAN citations and bare section markers are the same
  category and the later waves were adding more of them. Inert test titles carrying the
  patterns were edited (nothing filters on titles — verified); generated files are exempt.

Deviations from the plan text (all deliberate, all recorded in the commits):

- `followUps.ts` is named `followUpStages.ts` (distinct from the existing `followUpChange.ts`
  predicate module); `panel.ts` keeps the PanelHost body rather than gaining a vscode-importing
  `panelHost.ts` sibling (the depcruise vscode grant names panel.ts exactly); the gitReader
  contract lives in `backend.ts` because re-exporting the adapter through `gitReader.ts` would
  close a cycle; `settingsWidget` needed seven modules, not the plan's four (the global-settings
  column and the commit-author identity model are independent seams); `commitDetails` extracted
  `panelGeometry` beyond the three-way seam to fit 600; the menus gained `viewIssueAction.ts`
  for the shared builder.
- `repoManager.ts` sits at exactly 600 lines — no headroom; the next edit either shrinks it or
  re-enters KNOWN.

Found, not fixed (wave 5's queue) — **all four closed by wave 5** (below):

- `src/extension/platform/INVENTORY.md` is a finished-migration survey whose numbered entries
  17 code comments still cite; fold into docs/ or re-anchor the comments (needs a small
  decision, not mechanical).
- The 12 suppressed layout reads (F4, above) need a `common/` measure home — a layering
  decision, not a mechanical move.
- The Rust doc comments still carry `task N.N` references (e.g. the `annotate` request) — they
  surface in the generated `src/shared/engine/` types, which the comments gate exempts by
  design; cleaning them means a Rust-side pass plus regeneration.
- The manifest key `sourceCodeProviderIntegrationLocation` still has no consumer (carried
  from wave 4's A4 finding, kept for parity, still flagged).

### Wave 5: the queue closed (branch `task/m0-gates`, 2026-10-28)

Three commits closing every queued item; all gates green after each.

- **The Rust comment pass + the gate's second tree** — 29 citations removed from 16 engine
  files (the plan's grep had shown 21 `task N.N`; the sweep also caught `§N` and lowercase
  plan-name forms). The generated `src/shared/engine/protocol.ts` regenerated with the one
  expected doc delta, and `check-comments.mjs` now walks `native/**.rs` with the same five
  patterns (`native/core/tests` exempt, mirroring the size gate). Fixing the script's
  exemption paths to repo-relative forward slashes also repaired a Windows quirk: the
  `subset.generated.ts` exemption had silently never matched under backslash paths.
- **The inventory retired** — the 24 citation tags leave the code comments (the interim-binding
  note in `actions.ts` restated in the present tense), `INVENTORY.md` deleted: the migration it
  surveyed is complete and the ESLint rule holds it, so the document was spent history.
- **The common measure home** — the generic element-geometry reads live in
  `webview/common/measure.ts` now (the layering-valid home for the standalone bundles and
  `common/helpTooltip`); `graph/render/measure.ts` re-exports them and keeps the graph-specific
  batches. The 12 suppressed reads route through it and the suppressions drain; the rule names
  the two homes and nothing sits behind it. (`hexView.ts` landed at exactly 600 — same
  no-headroom note as `repoManager.ts`.)
- **The manifest key resolved as NOT a defect** — `sourceCodeProviderIntegrationLocation` has a
  consumer all along: its own manifest. The `scm/title` `when` clauses
  (`config.git-graph-rs.sourceCodeProviderIntegrationLocation == 'Inline' | 'More Actions'`)
  place the view button in the navigation group or the overflow group, evaluated by VS Code's
  context engine — no TypeScript reader was ever needed, which is why the A4 "no consumer"
  flag looked true. No decision required; the schema row stays for manifest parity, which is
  exactly the contract the parity test holds.

### Wave 6: the coverage ratchet ∥ the dependency baseline drained (branch `task/m0-gates`, 2026-10-28)

Four commits: the coverage matrix stops being counting-only, the depcruise baseline reaches
zero, and four matrix dimensions hold at full catalog coverage. All gates green (the check
chain now includes `lint:coverage`); 157 files / 1738 tests.

- **The coverage ratchet (G9's stepping stone)** — `check-coverage-matrix.mjs` turns the
  extractor into a gate: `docs/coverage-baseline.json` records the 1458 uncovered items per
  dimension; a NEW uncovered item fails CI, stale entries must shrink via `--update` (which
  refuses to absorb growth), and exemptions are capped at five with written reasons — the same
  shrink-only ratchet as the depcruise baseline and the size gate's KNOWN list. From here,
  coverage may only grow; the long tail (settings 168, webview-controls 44, ui-languages 1179
  uncovered at the recording) is later waves' burn-down under the ratchet.
- **The dependency baseline: 19 → 0** — the git layer takes localizers, the terminal port and
  the askpass input as injected parameters (the A4 pattern extended); the repos watchers and
  the status bar go through new platform adapters (`workspace.ts`, `statusBar.ts`) that are the
  only vscode importers; `globalSettings`/`orphanedTabs`/`panelContext` route through
  `config/write.ts`, `vscodeCompat.tabGroups` and the actions seams; `repoManager` shrank
  600 → 581. The four automation modules keep their direct vscode imports by a documented
  rule carve-out (the child_process rule's dev-only rationale) — a deliberate decision, not an
  inversion: tooling that drives whole VS Code instances does not go through platform
  adapters. DoD row 2 flips to held.
- **Four dimensions at 100% catalog coverage** — 32 new catalog entries (146 → 178): the six
  remaining palette commands with their zhCn SCM twins, twenty-two protocol-request entries
  (host and commit-details groups) driving the real pipeline with documented refusal branches,
  and the UiPort surface via the command entries plus the three archive flows that genuinely
  raise a save dialog (`nativeSaveDialog` declared in the catalog types). Three justified
  exemptions (of G9's five): `removeGitRepository` (its only drive path unregisters the active
  repository mid-run), the `ready` boot handshake (a lifecycle message, not a control), and
  `withProgress` (no host call site routes through the port yet — the same seam gap
  actions.ts documents). Write-operations improved as a side effect (17 → 13 uncovered).
  The registry test got stronger: its reachability model no longer normalizes `.zhCn` ids
  away.

Found, not fixed (the next queue):

- The coverage long tail: settings (168), webview-controls (44), ui-languages (1179) — each
  needs catalog entries or justified exemptions, under the ratchet now.
- `withProgress` still has no host call site through the port (its exemption's root cause);
  routing the host's own progress reporting through `uiPort` drains the exemption.
- DoD rows 8/9/11 keep their "defined but not yet observed by Actions" status — e2e.yml, the
  C3–C6 workflows and the release-matrix legs need a pushed branch to run; the loader's
  libc/armhf selection and the C3 container smoke landed in wave 3, so row 11's prose is
  partly stale (the vsce platform targets remain unexercised).

### Wave 7: the C-series gets its nightly home ∥ the vsce targets held (branch `task/m0-gates`, 2026-10-28)

Two files and a ledger refresh; all gates green.

- **The per-platform VSIX contract is held, not just described** — `package-platforms.mjs`
  becomes importable the way `automation-packaging.mjs` already is (`VSCE_TARGET` exported,
  `findBuiltPlatforms` taking an injectable root, `main()` behind a direct-run guard), and
  `test/tooling/vsixPlatforms.test.ts` holds the target table against both of the things it
  must agree with: the loader's engine table (`addonLoader.ts` — every shipped engine has a
  target, no target names an engine that is not shipped) and vsce's documented platform
  identifiers (no two engines sharing one). The three Marketplace-specific targets the binary
  matrix added — `alpine-x64`, `alpine-arm64`, `linux-armhf` — are the row's named concern.
  The machinery itself was exercised end to end by a real packaging run on the one locally
  built engine: one VSIX out, exactly one binary inside, the engines bump and the binary
  stash restored clean.
- **C4/C5 get a workflow** (`.github/workflows/compat.yml`, nightly at 02:40 UTC + dispatch):
  C4 runs the E2E smoke tier on the VS Code version matrix — 1.38.0 and 1.40.0 warn-only
  until the first runs show whether their Electrons start on the runner image, stable
  blocking, insiders warn-only per the compat section; C5 runs the Reader contract suite's
  CLI legs plus the Writer integration tests on latest Git and on debian:10's git 2.20.1 —
  the oldest image whose glibc can still carry Node 20, with the exact 2.17.1 floor and the
  pre-2.4 tiers left to the self-built image the compat section itself defers. The header
  records all of it, including the UNTESTED-IN-CI status.
- **The ledger's stale prose refreshed** — row 11's "still open" list (loader selection, C3
  smoke, unexercised vsce targets) described work that landed in wave 3 plus this one; the
  row now says what is actually open: the first Actions observation of all three definitions.
  Row 9's evidence names compat.yml as C4/C5's home.

Found, not fixed (unchanged): the coverage long tail (settings 168, webview-controls 44,
ui-languages 1179) and the `withProgress` host seam — both under the ratchet, both later
waves. Rows 8/9/11 keep their "defined but not yet observed" status until the branch is
pushed and CI's first run comes back.

Added to the queue by the first CI observations (the branch's first Actions runs, fixed or
pending as noted): `continueOperation` spawns `<type> --continue` with no editor guard, so
the commit-message editor git may open hangs a real user the same way it hung the contract
tests on CI (their env guards landed; the write-layer fix belongs with its env work); the
first-paint critical JS measured 366 KB against ADR-0005's 360 KB budget on the affected
tier's build and needs its own burn-down; and the rowCoordinates/scrollWindow windowed-
render assertions flake under full-suite load — retried once each now, root-caused never.

### Wave 8: the first-paint burn-down (branch `task/m0-gates`, 2026-10-28)

One commit closing the queue's size item: the Commit Details View joins the on-demand half,
and both ADR-0005 budgets hold again with room to grow.

- **The move** — `CommitDetails` never renders before a user expands a commit, yet its whole
  module group (the shell, the panes, the file tree, the line counts, the code-review pane —
  37.5 KB minified) sat inside the entry chunk because `main.ts` constructed it at boot. It now
  rides the widgets' lazy mechanism end to end: a `CommitDetailsSurface`
  (`commitDetails/detailsSurface.ts`) types what the rest of the view may call, `LazyCommitDetails`
  (`widgets/lazy.ts`) stands in from boot, the context holds the facade, and
  `import('./commitDetails/commitDetails')` loads on the first `load()` — idle-prefetched with
  the widgets, so the first expand resolves from the module cache. The surface's not-loaded
  semantics follow the widgets' rule (not loaded = not open: `isOpen` FALSE, `openElem` NULL,
  close/refresh no-ops, responses dropped); what makes the synchronous reads safe is the
  store's own invariant — `expandedCommit` is written only by the loaded module's open path, so
  every caller reading an open-view fact (`openElem`, a re-request) already implies the module
  is in. One signature tightening rode along: `createFileTree` left the surface (the response
  router forwarded a view-side product it had no business building); `showDetails` /
  `showComparison` build the file tree inside, and only when the files actually changed.
- **The numbers** (P5, `npm run build:dist -- --production`): the entry chunk
  **212.9 → 160.4 KB** against the 200 KB §3.8.2 target, the first-paint closure
  **368.4 → 332.7 KB** against ADR-0005's 360 KB, the commitDetails chunk 38.1 KB on demand,
  CSS unchanged at 58.9 KB. Both budgets were over since the F2 wiring pushed the machine into
  the entry (wave 2 measured 360/360 exactly; the wave-7 CI observation caught 366 KB). The
  ratchet direction ADR-0005 set — the budget only tightens, never reopens — is restored, and
  the perf workflow now ENFORCES the absolute budgets (`--enforce-budgets` on both of its P5
  invocations; the flag's own condition — the entry inside its 200 KB target — is met).
- **Verified**: the four typecheck leaves, `npm run check` (the whole static chain), the full
  suite 159 files / 1752 tests (one first-run failure in the known rowCoordinates/scrollWindow
  flake family, green on the rerun and in isolation), P3 booting the real chunked artifact
  in headless Chromium (t2t5 medians unchanged on this box), and the E2E smoke tier in real
  VS Code: 23 passed / 0 failed / 2 skipped (the two designed skips; 1.143.1, engine backend) —
  including S3 (expand details + open a file's diff) and row/compare-rows, the two scenarios
  that walk the lazy path. The jsdom harness needed no edits: its `pump` loop already awaits
  the request chains a lazy open produces.

Remaining in the queue: the coverage long tail (settings 168, webview-controls 44,
ui-languages 1179), the `withProgress` host seam, the rowCoordinates/scrollWindow flake
root cause, and the nightly observations (compat.yml C4/C5 and the E2E full tier fire on the
default branch's schedule only).
