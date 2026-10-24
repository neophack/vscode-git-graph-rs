# vscode-git-graph-rs Full-Repository Refactoring Plan

| Item | Content |
|---|---|
| Version | v1.1 (supersedes the v1.0 draft: v1.0 covered only the host↔webview protocol layer; this version covers the whole repository and makes "legacy compatibility" a hard constraint) |
| Date | 2026-10-24 |
| Code baseline | `main` @ `b5e0b1d` (1.0.27) |
| Scope | Repository layout, build & release, Rust engine, N-API bindings, extension host, webview, test system, engineering standards, documentation, **compatibility (VS Code 1.38+, old Git, old OSes, Remote)** |
| Status | Draft, pending review (§10 lists the decisions that need to be made) |

---

## 0. Summary

The functionality is complete: 682 test cases on the Node side, 142 on the Rust side, CI covering three platforms. The problem is that **the structure has not kept up with the functionality**.

1. **Two god modules in the extension host.** [src/gitGraphView.ts](../src/gitGraphView.ts) is 2731 lines, of which `handleMessage` is a 775-line `switch` with 86 branches. [src/dataSource.ts](../src/dataSource.ts) is 2617 lines with 104 methods, mixing pass-through reads, 41 kinds of write operations, 4 `cp.spawn` process entry points, and vscode UI calls.
2. **The webview has no module system.** `module: none` global scripts are concatenated into an IIFE in filename order. `web/main.ts` is 3562 lines, with a single `GitGraphView` class containing a 92-branch response `switch`; files that were "extracted" still read and write its fields directly in the form `fn(view: GitGraphView)`.
3. **The Rust engine has three parallel external interfaces.** `api::Engine` (used by Rust), `dispatch.rs` (a JSON method table), and ~40 `#[napi]` exports in `native/node` (what TS actually uses). Adding one read method requires changes in 5 places: `types.rs`, `api.rs`, `dispatch.rs`, `node/lib.rs`, and the hand-written TS mirror in `backend/types.ts`.
4. **Two mutually inconsistent build pipelines, and the CI artifacts violate the declared compatibility (empirically confirmed).** The local `compile-src` uses `src/tsconfig.json` (es6), rewrites `require("fs")` via `package-src.js`, and copies the askpass scripts. CI/release uses `build:ts`, which goes through the root `tsconfig.json` (ES2022). An actual build with the root tsconfig confirmed: **15 files contain native `?.`/`??`, `gitGraphView.js` alone has 59 native class fields, and there are no `askpass/*.sh`**. This means the VSIX produced by CI, although it declares `^1.38.0`, actually requires Node 14 (~VS Code 1.56) to load, and HTTPS credential prompts cannot work (§1.1-B1).
5. **Tests are not layered.** 56 `*.test.mjs` files sit flat in `tests/`, all importing build outputs `out/*.js` or `media/out.min.js`, so a full build is required before running. Some webview tests slice source code with `new Function`; the backend consistency test is a single 1773-line file and partially duplicates the Rust `git_parity` tests.
6. **Compatibility is declared but not guaranteed.** No artifact syntax target, no built-in API availability checks, no tests running on old versions. The Linux engine is built on `ubuntu-latest` (glibc 2.39), so Remote-SSH servers on older distros cannot load it; there are no musl/armhf targets. The engine requires N-API 4, which is unavailable on VS Code 1.38–1.39 (N-API 3), and there is no preflight check before loading (§1.6).
7. **The engine is fast, but the open and operate paths still contain a lot of waiting.** Measured on this repository's first page of 200 commits: engine 12.6 ms, git CLI 205.3 ms (`bench.mjs`, median of 5). The time is mostly spent outside the engine:
   - the webview only requests data after it starts up, and `loadRepoInfo` → `loadCommits` are two serial round trips;
   - ~560 KB of JS must be parsed before first paint (including markdown-it, loaded unconditionally);
   - every write operation triggers a full reload; even operations that only change refs re-walk commits;
   - old requests superseded by new ones are never cancelled;
   - no end-to-end performance measurement or regression gate (§1.7).
8. **Automation assets exist, but they are not run automatically in real VS Code.** The automation catalog has 146 actions covering the control bar, rows, all context menus, details, find, settings, reflog, worktree, and VS Code menus, with three drive modes (UI / request / command) and an in-page shim. Three problems:
   - the only way to run the catalog in real VS Code is manually clicking "Run Automation Test" in an automation VSIX; `test:automation:full` actually runs in jsdom, not real VS Code;
   - there are no real-VS Code tests in CI at all;
   - assertions are weak: only 18 actions check the real state of the git repository after execution; native dialogs (quick pick, input box, save dialog) cannot be driven, so actions involving them are skipped (§1.8).

**The plan**: a single `src/` tree split into three TS projects — `extension` (Node), `webview` (DOM), and `shared` (isomorphic protocol and models) — bundled by esbuild into `dist/`, with **artifact syntax downleveled to `node10.11` and `chrome69` respectively**. Rust converges to "one typed request enum + one N-API entry point", with TS types generated from Rust; the engine is an **optional acceleration layer** that fully falls back to the git CLI whenever it is unavailable in any environment. The host replaces the two god modules with five deep modules: `GitProcess / GitReader / GitWriter / ProtocolHandlers / CommitLoader`. The webview moves to ES modules with a `HostBridge + Store + components` structure. Tests are reorganized into five L0–L4 layers, with each behavior verified in exactly one layer; additionally, compatibility tests C1–C6 ensure **every entry in the support matrix is actually tested by CI** (§3.7, §6.6). For performance, **performance budgets** are defined (§3.8.1) and three paths are redone against the budgets:
- **Open**: the host prefetches data in parallel while the panel is created, first-paint data arrives in one request, the last snapshot is painted immediately, the first-paint bundle slims down, and the engine is prewarmed in the background;
- **Operate**: only the affected parts refresh, the engine traverses commits incrementally, requests are cancellable, and interactive requests take priority;
- **Render**: renders are coalesced per frame, and only changed rows are updated by hash.

Performance tests P1–P5 run in CI **on the same machine against `main`**; regressions beyond the threshold block merging (§6.7).

**Comprehensive VS Code automation testing (§6.8)**:
- upgrade the existing automation catalog into an E2E system that CI runs automatically in **real VS Code**;
- native dialogs are answered automatically via a programmable `UiPort`, and every action asserts the real state of the git repository;
- the coverage matrix requires every command, menu, protocol request, setting, webview control, and write operation to have an E2E scenario — one missing item fails CI;
- the environment matrix covers VS Code 1.38 → insiders, three operating systems, engine / CLI-only, English and Chinese, desktop / mobile layouts, and Remote;
- the old manual smoke checklist S is now executed automatically by CI.

**Effort**: 8 phases, roughly **85–101 person-days**; about 10–11 weeks with two people in parallel. Each PR is independently mergeable and releasable once merged.

---

## 1. Current-State Diagnosis

### 1.1 Repository and Build

| # | Problem | Evidence | Impact |
|---|---|---|---|
| B1 | **Two build pipelines**: CI and release use `npm run build:ts` (root `tsconfig.json`, ES2022) and **do not run** `scripts/package-src.js` | `package.json` scripts; `.github/workflows/native-build.yml:169,224`; `src/askpass/askpassManager.ts:50,99` | **Confirmed**: compiling with the root tsconfig produces 15 files containing native `?.`/`??`, `gitGraphView.js` with 59 native class fields, and `askpass/` containing only `.js` and no `.sh`. The CI artifact fails to load with a syntax error on Node < 14 (VS Code < ~1.56), and HTTPS credential prompts are broken. Whether already-released versions are affected depends on which pipeline built each VSIX; Phase 0 unpacks and checks them one by one |
| B2 | The two tsconfigs disagree on target (root: ES2022; `src/`: es6 + a hand-rolled `@types/node` patch) | `tsconfig.json`, `src/tsconfig.json`, `src/utils/@types/node/index.d.ts` | Local artifacts and release artifacts are not the same code |
| B3 | `engines.vscode: ^1.38.0` is a declaration only: no build configuration or test guarantees the artifact runs on 1.38 (Node 10.11 / Chromium 69); `engines.node >=18` is a development requirement but sits where it can be misread as a runtime requirement | `package.json` | Compatibility is maintained by "happening to use the es6 build"; see §1.6, §3.7 |
| B4 | The webview is concatenated in "utils first, main last, everything else by directory order" order | `scripts/package-web.js:18-27` | Dependencies exist only as filename ordering; no tree-shaking, no unit testing |
| B5 | Webview type checking depends on the host having compiled `out/types/index.d.ts` first | `web/global.d.ts:4` | Build order becomes an implicit contract |
| B6 | One-off scripts and legacy files mixed into the official tooling | `scripts/_fix_sw.py`, `_fix_web2.py`, `repro-dk033a.mjs` (hardcodes `D:/DK033-A`), `repro-view.mjs`, `apply-crab.cjs`, `tests/browserRepro/` | Noise that misleads newcomers |
| B7 | Four platform-specific install scripts duplicating npm scripts | `build-and-install.{bat,sh}`, `build-rust.bat`, `build-vsix-and-install.bat` | Two entry points that drift apart |
| B8 | Outdated docs: `GAPS.md` opens by saying Gerrit was removed, then section 3 says it was partially ported back | `GAPS.md:7,84` | — |
| B9 | Scattered build output directories: `out/` (host), `media/` (webview), `native/<platform>/` (addon, inside the source tree) | `.gitignore` | Complicated clean/packaging rules (`.vscodeignore` is 30 lines) |

### 1.2 Rust engine (`native/`)

Overall quality is good: files organized by theme, `thiserror` errors, `git_parity` tests comparing directly against `git` output. The problems concentrate on the **external interface** side.

| # | Problem | Evidence |
|---|---|---|
| R1 | Three external interfaces: `api::Engine`, `dispatch::answer`'s string `match`, and ~40 `#[napi]` functions in `node/lib.rs`. TS only uses the third; `dispatch` is used only by tests and one `request` export that TS does not use | `native/core/src/dispatch.rs:61`, `native/node/src/lib.rs`, `src/backend/api.ts:200-406` |
| R2 | All modules are `pub mod`; the internal implementation is the public API | `native/core/src/lib.rs:15-31` |
| R3 | Cross-language types are hand-mirrored: `types.rs` ↔ `src/backend/types.ts` ↔ `src/types/git.ts` | `src/backend/types.ts:1-7` — the comment self-describes as "field for field" |
| R4 | JSON strings uploaded over N-API (the `serde-json` feature is enabled but unused); binary content goes through base64 | `native/node/Cargo.toml`, `fileBytes` in `dispatch.rs` |
| R5 | Errors travel as `"Kind: message"` string prefixes that the TS side then parses | `error.rs:63`, `src/backend/addon.ts:237` |

### 1.3 Extension host (`src/`)

| # | Problem | Evidence |
|---|---|---|
| H1 | `GitGraphView` carries 9 responsibilities: panel lifecycle, orphaned tab recovery, HTML/CSP, 86-branch dispatch, commit-page LRU cache, staged loading and follow-ups, Gerrit cache, polling, PR fetching, plus automation hooks | `src/gitGraphView.ts:433-2731` |
| H2 | Whether a write command mutates the repo is decided by the hand-maintained `REPO_MUTATING_COMMANDS`, separate from the handlers | `src/gitGraphView.ts:414,840` |
| H3 | `DataSource`: ~30 read methods are pass-throughs to `GitBackend`; 41 write operations each repeat the preamble "validate args (`checkUnsafeGitArgs`, 42 occurrences) → assemble argv → spawn → format error" | `src/dataSource.ts` |
| H4 | Process entry points scattered across 10 places: 4 in `dataSource.ts`, 3 in `cliBackend.ts`, plus `hexDiff.ts`, `findGit.ts`, `utils/childProcess.ts`; error formats all differ | grep `cp.spawn\|execFile` |
| H5 | The two backends have different error contracts: CLI returns `error: string` inside the result, Native rejects with `GitBackendError` | `src/backend/addon.ts:256` |
| H6 | `FallbackBackend` hand-writes 33 `attempt('x', b => b.x(...))` calls | `src/backend/index.ts` |
| H7 | 23 files import `vscode`, including 6 under `utils/`, so the data layer cannot be tested outside VS Code | grep `from 'vscode'` |
| H8 | 20 files sit flat in the `src/` root with no visible layering; `utils/actions.ts → diffDocProvider → dataSource` forms a reverse dependency | — |
| H9 | The comparison view, binary compare, and automation report write entire HTML, CSS, and JS in template strings inside host TS, with `msg: any` as the protocol | `src/comparisonView.ts:212-346`, `src/binaryCompareView.ts:89` |
| H10 | Dead code: `invalidateRefCache` (empty but still called), `generateGitCommandFormats`, etc. | `src/dataSource.ts:166,652` |
| H11 | The automation subsystem uses `GitGraphView.currentPanel` and static taps as a service locator; the 3577-line `catalog.ts` lives in product source and is excluded by substituting files at packaging time | `src/automation/`, `scripts/automation-packaging.mjs` |

### 1.4 Webview (`web/`)

| # | Problem | Evidence |
|---|---|---|
| W1 | Global scripts, no imports, running by concatenation order (same as B4) | `web/tsconfig.json: module none` |
| W2 | The `GitGraphView` class is 3562 lines with 29 private fields and a 92-branch response `switch`, many branches of which are just the same `refreshOrDisplayError` | `web/main.ts` |
| W3 | Extracted modules (`observers`, `contextMenuActions`, `commitDetailsView`) take `view: GitGraphView` as a parameter and mutate the view's state directly | — |
| W4 | `web/utils.ts` is a grab bag of global constants, DOM helpers, date formatting, HTML escaping, and `VSCODE_API` | `web/utils.ts:6-450` |
| W5 | HTML is built by string concatenation; `strings.ts` has many entries containing HTML; `formatStr` does not escape; whether to escape is up to each call site | `web/strings.ts`, `web/dialog.ts` |
| W6 | i18n has three dictionaries: `web/strings.ts` (1871 lines), `src/i18n.ts` (466 lines), `package.nls*.json`, with consistency checked by the script `check-i18n-parity.cjs` | — |
| W7 | CSS: `main.css` (1900 lines) and `mobile.css` (1473 lines) are split by "device" rather than by "component"; changing one component means touching two files | `web/styles/` |

### 1.5 Tests

| # | Problem | Evidence |
|---|---|---|
| T1 | 56 test files sitting flat, mixing unit tests, real-git integration, jsdom full-page boot, and packaging-tool tests | `tests/` |
| T2 | Tests import `out/*.js` and `media/out.min.js`, coupled to artifact paths (`out/backend/index.js` 12 times, `out/dataSource.js` 10 times, …); a full build is required before testing | grep |
| T3 | 4 tests use `new Function` to execute sliced non-module source | `tests/binaryCompare.test.mjs:327`, `imageDiff.test.mjs:151`, `markdownRenderer.test.mjs:41`, `reflogClassification.test.mjs` |
| T4 | `contract.test.mjs` uses regexes to keep both protocol ends consistent — the compiler's job | `tests/contract.test.mjs` |
| T5 | `backends.test.mjs` is 1773 lines and partially overlaps Rust's `git_parity.rs`: the same "engine answer = git answer" assertion is tested once in each layer | — |
| T6 | No real VS Code end-to-end tests (`extensionHost.test.mjs` uses a hand-written stub); end-to-end coverage relies solely on the product's built-in automation suite triggered manually | `tests/vscodeStub.mjs` |
| T7 | No coverage thresholds; c8 excludes all of `web/**` | `package.json#c8` |

### 1.6 Compatibility status

Already done right: `@types/vscode` pinned to 1.38.0 as a compile-time API guardrail; Codicons feature-detected by VS Code version (`VsCodeVersionRequirement`); Git write operations tiered by version (`GitVersionRequirement`: 1.7.8 / 2.4 / 2.13.2 / 2.17 / 2.40); full CLI fallback when the native engine is absent; the universal VSIX keeps `^1.38.0` and only platform-specific VSIXs are marked `^1.61.0` (a `vsce --target` requirement).

| # | Problem | Evidence | Impact |
|---|---|---|---|
| C1 | No syntax target for artifacts: CI builds output ES2022 (see B1); the webview esbuild minify step sets no `target` and relies on tsc's es6 output happening to be compatible | `tsconfig.json`, `scripts/package-web.js` | Switching build paths or upgrading one dependency can silently break 1.38 |
| C2 | No built-in API availability checks: `lib: ES2022` + `@types/node@22` allows APIs that Node 10 lacks; only manual review catches them | `tsconfig.json`, `package.json` | Same as above |
| C3 | New VS Code APIs scattered as `(vscode.window as any).tabGroups` across 3 places | `src/automation/hostBridge.ts:55,186`, `suiteRunner.ts:280` | Feature detection is neither centralized nor typed |
| C4 | The engine requires N-API 4 (Node 10.16+); VS Code 1.38–1.39 only have N-API 3; no version preflight before loading, relying on `require` failure as the backstop | `native/node/Cargo.toml` (`napi4`), `src/backend/addon.ts` | Users on 1.38–1.39 get no engine acceleration and no visible reason |
| C5 | Linux binaries are built natively on `ubuntu-latest`, so the glibc floor equals the builder's version; no musl (Alpine containers) or armhf targets; the macOS deployment target and Windows CRT linkage are not set explicitly | `.github/workflows/native-build.yml` build matrix | Remote-SSH / Dev Container servers on older distros fail to load (falls back to CLI, invisibly to the user) |
| C6 | Webview CSS uses features Chromium 69 does not support: `main.css`/`settingsWidget.css`/`statisticsView.css` have 4 uses of `gap` (needs Chrome 84 in flex layouts); `mobile.css` has 16 uses of `color-mix()` (Chrome 111) and 6 of `backdrop-filter` (Chrome 76) | `web/styles/*.css` | Layout spacing is lost and mobile colors break on old versions; each site needs a confirmed fallback |
| C7 | No tests run on old versions at all: no minimum-version VS Code, no old Node runtimes, no old Git, no old glibc | CI | Compatibility problems are discovered by users |
| C8 | User data is unversioned: webview state, globalState, and `.vscode/git-graph-rs.json` have no unified version field or migration mechanism | `src/extensionState.ts`, `src/repoManager.ts` | Risk of lost settings or crashes when upgrading/downgrading the extension (to be verified item by item) |

### 1.7 Performance status

Already done right (the refactor must preserve this):
- the engine keeps repository handles resident; the first page is 16× faster than the CLI on this repository;
- after the first page, data is supplemented in stages: remote refs → Gerrit → uncommitted changes;
- both the table and the graph render by viewport window;
- panel restoration uses a snapshot (`GitGraphViewSnapshot`);
- file watching is debounced and change-type-aware, and muted during operations;
- the webview discards stale responses via `refreshId`;
- `retainContextWhenHidden` is configurable.

| # | Problem | Evidence | Impact |
|---|---|---|---|
| F1 | **The open path is serial**: the host sits idle while the webview boots; the webview sends `loadRepoInfo` first and only sends `loadCommits` after the response arrives | `web/main.ts:1257-1293` | First paint waits for "webview startup + 2 round trips + 2 host processing passes" at minimum |
| F2 | **Large first-paint payload**: `out.min.js` 444 KB, `markdown-it.min.js` 104 KB (loaded unconditionally), `out.min.css` 115 KB — all downloaded and parsed before first paint | `media/`; `src/gitGraphView.ts:1836-1864` | Noticeable parse/compile time on low-end machines, paid on every open |
| F3 | **Blocking on the activation path**: `await findGit()` in `activate` spawns a git subprocess; the host is a require chain of 62 separate JS files, so every module (automation, binary compare, Gerrit) loads at activation | `src/extension.ts:62`, `out/` | Slows startup; the engine read path does not need git at all |
| F4 | **Full refresh after operations**: every successful write triggers `refresh(false)`, i.e. `loadRepoInfo` + `loadCommits` — two serial full loads; operations that only change refs (create tag, delete branch) also re-walk commits | `web/main.ts:3251-3256`, `1257-1293` | Operation feedback = git time + a full open |
| F5 | **No cancellation**: superseded requests keep running to completion in the host and the engine; the webview merely discards the results | the `refreshId` mechanism | Rapid branch/filter switching queues up and wastes CPU |
| F6 | **Preflight checks spawn processes**: `areStagedChanges`, `getRemotesContainingCommit`, and similar checks start git only when the operation executes | `GAPS.md` §1 | Each process start costs tens of milliseconds on Windows |
| F7 | **No end-to-end measurement**: `bench.mjs` only measures backend reads; there is no "click → first paint" timing, render frame cost, or size budget, and no CI performance gate | `scripts/bench.mjs` | Performance regressions are discovered by users |

### 1.8 VS Code automation testing status

Existing assets (the refactor must preserve and upgrade them):
- 146 actions in `src/automation/catalog.ts` across 18 groups: control-bar 13, row 8, menu-commit 19, menu-branch 13, menu-remote-branch 9, menu-stash 6, menu-tag 5, menu-uncommitted 4, menu-vscode 13, cdv 14, find 5, settings 18, reflog 5, worktree 3, statistics 1, keyboard 3, host 6, external 1;
- every action can be driven three ways: UI (the in-page shim clicking real controls), request (injecting protocol requests), and command (executing VS Code commands);
- `fixture.ts` uses fast-import to build fixtures with 2000+ commits and a bare remote, resetting the repo to its initial state before and after write operations;
- there is a report page and the safety rule "only read-only suites run in repositories without the `.gg-fixture` marker".

| # | Problem | Evidence | Impact |
|---|---|---|---|
| E1 | The only entry point to run the catalog in real VS Code is the "Run Automation Test" button inside the automation VSIX, triggered manually | `src/automation/suiteRunner.ts` | Cannot enter CI; regressions depend on someone remembering to run it |
| E2 | `npm run test:automation:full` actually runs the catalog in a jsdom harness, not real VS Code, Chromium, and the extension host | `scripts/automation/full-test.mjs:135` (`bootRealView`) | Cannot test the real webview's layout, CSP, resource loading, panel lifecycle, or VS Code API behavior |
| E3 | No real VS Code tests in CI; `extensionHost.test.mjs` uses a hand-written stub | `tests/vscodeStub.mjs` | The "glue" code integrating with VS Code is unverified |
| E4 | Weak assertions: 149 places accept "received the expected host response"; only 18 `verify` checks inspect the repository's real state after execution | `src/automation/catalog.ts` | "Request was sent" ≠ "repository became what we expect" |
| E5 | Native UI cannot be driven: quick pick, input box, modal confirmation, save/open dialogs (12 places in the host). Save-dialog actions are marked `nativeSaveDialog` and skipped outright; modal confirmations can only click the primary button | `catalog.ts:80-86, 1025` | A batch of commands and branch paths has never been automation-covered |
| E6 | Coverage is not measured: unknown which of the 45 commands, all menu items, 86 protocol requests, and ~90 settings lack any automation action | — | "Comprehensive" cannot be verified |
| E7 | No environment matrix: runs only on the VS Code version, OS, and language the developer happened to use | — | Compatibility (§3.7) and multilingual problems cannot be found automatically |

---

## 2. Goals, Non-Goals, and Principles

### 2.1 Goals (all measurable)

| ID | Goal | Criteria |
|---|---|---|
| G1 | One build pipeline | Local, CI, and release all run the same `npm run build`; `dist/` is the only artifact directory |
| G2 | Modules with single responsibilities and one-way dependencies | Non-generated files ≤ 600 lines (string tables and generated code excepted); dependency rules (§3.6) enforced by CI; no circular dependencies |
| G3 | Cross-boundary contracts guaranteed by the compiler | A missing protocol handler fails compilation; Rust ↔ TS types guaranteed by generated code, with CI checking that generated results have no drift |
| G4 | One process entry point, one write path | `child_process` appears only in `extension/git/process/`; argument safety validation has exactly 1 call site |
| G5 | Layered tests, no redundancy, runnable directly from source | Tests no longer import `out/`; each behavior has exactly one owning layer in the case mapping table (Appendix B); coverage thresholds in §6.5 |
| G6 | Zero behavior regressions | All existing cases green after every PR (only "replacement" deletions allowed; the PR description must list the mapping) |
| G7 | Compatibility guaranteed by actual testing | Every entry of the §3.7 support matrix has a corresponding CI test (C1–C6); artifact syntax scans pass; zero `as any`-style API probes; every reason the engine is unavailable falls back to CLI and is visible on the settings page |
| G8 | Fast to open, fast to operate | All performance budgets in §3.8.1 met; P1–P5 run in CI and regressions beyond the threshold against `main` block merging; serial round trips on the open path drop from 2 to 0 (data is pushed by the host) |
| G9 | Comprehensive automation testing in VS Code | Every command, menu, protocol request, setting, webview control, and write operation in the §6.8.4 coverage matrix reaches 100% (exemptions have written justification and total ≤ 5); every write operation asserts the repository's real state; the §6.8.5 environment matrix runs in CI; releases depend on no manual test steps |

### 2.2 Non-Goals

- **No changes to UI appearance or interaction**, and no frontend framework (React/Vue, etc.). The virtualized table and the SVG graph are performance-sensitive imperative code; switching frameworks means a rewrite.
- **No migration of write operations to the engine** (the roadmap in GAPS.md §2). This plan only gives the write path a seam (`GitWriter`); a future migration adds one adapter.
- **No changes to public contracts**: command IDs, configuration keys, the keys of `package.nls*.json`, the `.vscode/git-graph-rs.json` format, and the structure of webview persisted state (`WebViewState`).
- **No raising of `engines.vscode` (stays `^1.38.0`) and no dropping of any existing platform.** New capabilities may only be added with feature detection plus degradation.
- **No new runtime dependencies.** New dev dependencies are limited to those listed in §4.2; no polyfill packages.

### 2.3 Principles

1. **Preserve behavior, replace incrementally.** New modules coexist with old code; call sites migrate in batches; old code is deleted only after the last call site moves. Refactoring and bug fixes never share a commit.
2. **Lock behavior before touching structure.** Before working on a module, write characterization tests against its **new** interface.
3. **Replace tests, don't stack them.** Once deeper tests are in place, delete the corresponding shallower ones and list the mapping in the PR.
4. **Pure moves are their own PRs.** Use `git mv` to preserve history; move PRs only change import paths.
5. **PR size**: net changes ≤ 800 lines (pure moves and generated code excepted).
6. **One adapter does not make a seam.** Introduce an interface type only when both production and tests need substitution.
7. **The commit convention** stays Conventional Commits (`refactor(host): …`, `test(webview): …`).
8. **Compatibility is a hard constraint, not an optimization item.** No PR may raise the minimum runtime; capabilities needing newer environments must come with feature detection and a degradation path, registered in the §3.7 matrix. The dev toolchain may use new versions; **artifacts** must satisfy the floor.
9. **Performance budgets are acceptance criteria.** Every budget has an automated measurement; no PR may regress a budget item beyond the threshold. Performance work must measure first, optimize second, and attach before/after data. During the refactor, structural cleanliness must not come at the price of performance; when the two conflict, the budget wins and the decision is recorded in an ADR.

---

## 3. Target Architecture

### 3.1 Top-level repository layout

```
.
├── src/
│   ├── extension/            # Extension host (Node + vscode)
│   ├── webview/              # All webview frontends (DOM; no vscode, no Node)
│   └── shared/               # Isomorphic code: protocol, domain models, i18n dictionaries, pure functions (no vscode, no DOM, no Node)
├── native/
│   ├── core/                 # git-graph-core: the engine (pure Rust, no Node)
│   └── node/                 # git-graph-node: thin N-API binding
├── test/                     # Cross-module tests (integration / e2e / tooling); unit tests live next to their sources
│   ├── support/              # Shared fixtures: repository builders, vscode fakes, jsdom host, assertion helpers
│   ├── integration/
│   ├── e2e/
│   └── tooling/
├── scripts/
│   ├── build/                # build.mjs (single entry), esbuild configs, addon build
│   ├── release/              # Packaging, platform VSIXs, versioning
│   └── dev/                  # bench, log analysis, theme audit, icon generation (developer tools, not in CI)
├── resources/                # Static assets such as icons (upstream originals move to docs/assets or are deleted)
├── docs/
│   ├── ARCHITECTURE.md       # End-state description after this plan (replaces the structural part of BACKENDS.md)
│   ├── adr/                  # Architecture decision records
│   └── ...
├── dist/                     # The only build output (gitignored): extension.js, webview/*.js|css, native/*.node, askpass/
├── package.json  Cargo.toml  tsconfig.base.json  eslint.config.mjs  vitest.config.ts
└── CONTRIBUTING.md           # Build, test, directory conventions, new-feature checklists
```

`build-*.bat` / `build-*.sh` merge into `npm run dev:install` (a cross-platform Node script).

### 3.2 `src/shared/`: protocol and models

```
shared/
├── protocol/
│   ├── graphView.ts          # Main-view protocol: RequestMap / ResponseMap (see below)
│   ├── comparison.ts         # Comparison-view protocol (replaces msg: any)
│   ├── binaryCompare.ts
│   └── common.ts             # ErrorInfo, LossWarning, Envelope
├── model/                    # Domain types: GitCommit, GitRepoState, config snapshot, …
├── engine/                   # ← generated from Rust (ts-rs); hand edits forbidden
├── i18n/
│   ├── en.ts                 # The single dictionary shared by host and webview
│   ├── zh-cn.ts              # satisfies Record<keyof typeof en, string>: a missing key is a compile error
│   └── format.ts
└── util/                     # Pure functions (array comparison, paths, dates, etc.)
```

**Protocol definition style**: each request is declared exactly once; the request, the response, and whether it mutates the repo all live in one place.

```ts
// shared/protocol/graphView.ts
export interface GraphViewRequests {
	checkoutBranch: { req: { repo: string; branchName: string; remoteBranch: string | null }; res: ActionResult };
	loadCommits:    { req: LoadCommitsParams; res: LoadCommitsResult };
	// …
}
export type RequestCommand = keyof GraphViewRequests;
```

The host handler table is declared with `satisfies { [K in RequestCommand]: Handler<K> }`; **a missing or extra entry fails compilation**, so the protocol portion of `contract.test.mjs` can be deleted. `mutates: true` lives on the handler, replacing `REPO_MUTATING_COMMANDS`. Inbound messages are validated by a minimal runtime guard: `command` must be in the table, and `repo` must be a known repository.

### 3.3 `src/extension/`: the host

```
extension/
├── main.ts                       # activate/deactivate: the composition root; only constructs and wires
├── platform/                     # Thin adapters over the vscode API (the only place in the host allowed to import 'vscode', apart from views/ and commands/)
│   ├── config.ts                 # Read config → ConfigSnapshot (pure data), onDidChange
│   ├── notifications.ts  terminal.ts  clipboard.ts  storage.ts (formerly extensionState)
│   └── logger.ts
├── git/                          # Everything that talks to Git; must not import vscode
│   ├── executable/               # findGit, version checks
│   ├── process/
│   │   ├── gitProcess.ts         # The single process adapter: run / runWithInput / stream
│   │   ├── errors.ts             # Unified error format → GitError { kind, message, stderr }
│   │   └── askpass/              # askpassMain.ts + *.sh (copied to dist/askpass by the build)
│   ├── read/
│   │   ├── gitReader.ts          # Read interface (formerly GitBackend)
│   │   ├── nativeReader.ts       # Engine adapter: one request() call + generated types
│   │   ├── cli/                  # The former 1527-line cliBackend.ts split by theme: log.ts refs.ts details.ts config.ts stats.ts parse/
│   │   ├── fallbackReader.ts     # A Proxy generated from a method table, replacing the 33 hand-written attempt()s
│   │   └── addonLoader.ts        # Platform directory, loading, capability detection
│   ├── write/
│   │   ├── gitWriter.ts          # The only place writes execute: run(repo, op) → ActionResult: validation → argv → process → error mapping, all in one place
│   │   ├── ops/                  # Pure functions: WriteOp → argv[]. branch.ts tag.ts remote.ts commit.ts stash.ts worktree.ts mergeRebase.ts config.ts files.ts
│   │   ├── argSafety.ts          # Formerly checkUnsafeGitArgs (1 call site: gitWriter)
│   │   └── lossGuard.ts          # Data-loss warnings (detached commits, hard reset)
│   ├── operationState.ts         # rebase/merge/cherry-pick state detection
│   └── gitRepository.ts          # External facade: reader + writer + state (replaces DataSource)
├── repos/                        # repoManager, repository discovery, file watching, .vscode/git-graph-rs.json
├── graphView/
│   ├── panel.ts                  # Panel lifecycle, serialization restore, orphaned tabs
│   ├── html.ts                   # HTML shell + CSP + nonce (webview assets served from dist/webview)
│   ├── commitLoader.ts           # Staged loading, follow-up ordering, cancellation (AbortSignal)
│   ├── caches/                   # commitPageCache.ts (LRU), gerritCache.ts
│   ├── poller.ts  uncommittedStabiliser.ts
│   └── handlers/                 # Organized by domain; each file exports a group of Handlers
│       ├── index.ts              # Assembles the HandlerTable (satisfies exhaustively)
│       ├── loading.ts  branches.ts  commits.ts  tags.ts  remotes.ts  stash.ts
│       ├── worktrees.ts  operations.ts  files.ts  settings.ts  codeReview.ts  gerrit.ts  misc.ts
├── views/                        # Host-side controllers for auxiliary panels (the frontend code lives in webview/)
│   ├── comparison/  binaryCompare/  diffDocProvider.ts
├── integrations/                 # gerrit/ pullRequests/ avatars/
├── commands/                     # One file per command group + registry.ts (aligned with package.json contributes)
├── statusBar.ts
└── automation/                   # Packaged only in automation builds (esbuild define switch); a dependency-injected GraphViewPort; no more static currentPanel access
```

**The `HandlerContext` port** (handlers may touch the outside world only through it, making substitution easy in tests):

```ts
interface HandlerContext {
	readonly repo: GitRepository;      // read, write, state
	readonly config: ConfigSnapshot;   // Snapshot taken at the start of this request: no more deep getConfig() calls
	readonly ui: UiPort;               // notifications, confirmations, terminal, clipboard
	readonly loader: CommitLoader;
	send(msg: GraphViewResponse): void;
}
```

### 3.4 `src/webview/`: the frontend

```
webview/
├── common/
│   ├── host/bridge.ts            # The sole holder of acquireVsCodeApi: send<K>(cmd, req), on<K>(cmd, fn)
│   ├── html.ts                   # SafeHtml + html`` tagged template (auto-escaping); raw() requires an explicit marker
│   ├── dom.ts  icons.ts  dates.ts  classNames.ts
│   └── i18n.ts                   # Reads shared/i18n
├── graph/                        # Main view (entry: main.ts)
│   ├── main.ts                   # Entry: create the store, mount components, connect the bridge
│   ├── state/                    # store.ts (single source of truth + subscriptions), persistence.ts (getState/setState)
│   ├── responses.ts              # ResponseRouter: command → store action (replaces the 92-branch switch)
│   ├── layout/                   # Lane layout: pure functions, no DOM (the computational part of the former graph.ts)
│   ├── render/                   # graphSvg.ts, commitTable.ts (virtualized), refLabels.ts, columns.ts
│   ├── commitDetails/            # commitDetailsView, fileTree, codeReview
│   ├── actions/                  # contextMenu items, dialog actions, dataLossRisk
│   ├── widgets/                  # dialog, contextMenu, dropdown, findWidget, settings/, reflog, statistics, worktreeDialog, conflictBanner
│   └── integrations/             # gerritView, pullRequestView
├── comparison/main.ts            # Migrated out of the host's template strings
├── binaryCompare/main.ts         # Includes the hexDiff/imageDiff frontend
├── automationReport/main.ts
└── styles/
    ├── tokens.css                # VS Code theme variable mapping
    └── <component>.css           # One file per component; mobile rules live in the same file's @media / .mobileMode sections
```

Component conventions: a component is a class or factory function that receives `store`, `bridge`, and a root element at construction, subscribes to the state slices it cares about, and mutates DOM only under its own root element. Cross-component communication always goes through store actions; fetching elements across components with `document.getElementById` is not allowed.

### 3.5 `native/`: the engine

```
native/core/src/
├── lib.rs                    # Exports only Engine, Request/Response, model types, Error; everything else pub(crate)
├── engine.rs                 # Formerly api.rs: the single Rust-side entry point
├── protocol.rs               # Formerly dispatch.rs: #[serde(tag = "method", content = "params")] enum Request
│                             #   → Engine method → Response; the string match and hand-rolled arg parsing both disappear
├── repository/               # repository.rs + RepoManager (handle cache)
├── read/                     # log graph refs details diff blob stash status config stats gerrit
├── model/                    # Formerly types.rs, split by theme; #[derive(TS)] exported to src/shared/engine/
├── text.rs
└── error.rs                  # ErrorKind #[non_exhaustive] + serde serialization as { kind, message }
native/core/tests/            # Integration tests: keep the current theme-based split; common/ becomes a fixture builder
native/node/src/lib.rs        # Keeps only open / close / closeAll / request(json) / requestBytes(Buffer) / cancel(requestId)
native/core/benches/          # criterion benchmarks (P1)
```

Benefit: adding a read method requires only one new `Request` variant plus one `engine.rs` method; the TS types are generated automatically, and neither N-API nor the TS adapter changes.

### 3.6 Dependency rules (enforced in CI by `dependency-cruiser`)

```
shared/**           → may import only shared/**
webview/**          → webview/**, shared/**; node:*, vscode forbidden
extension/git/**    → extension/git/**, shared/**, node:*; vscode, graphView/**, platform/** forbidden
extension/graphView/handlers/** → must not import graphView/panel.ts (only via HandlerContext)
extension/platform/** → the only vscode entry point (views/, commands/, and graphView/panel.ts may use vscode UI types directly)
any directory       → circular dependencies forbidden; importing test/** forbidden
```

### 3.7 Compatibility architecture

#### 3.7.1 Support matrix (the external promise, recorded in `docs/compatibility.md` and the README)

| Dimension | Promised floor | Notes |
|---|---|---|
| VS Code | **1.38.0** | `engines.vscode` stays `^1.38.0`, verified by C4 |
| VS Code derivatives | VSCodium, Code - OSS, Git Graph Studio (`uriScheme === 'ggs'`), and other VS Code-based editors | Depends only on 1.38 APIs; no Marketplace-exclusive capabilities |
| Where it runs | Local; Remote-SSH / WSL / Dev Containers / Codespaces | `extensionKind: workspace`; the host runs remotely, so engine binaries must cover the remote platform. The pure-browser vscode.dev environment is not supported (it needs Git) |
| Git CLI | Determined by D7 (proposed: all read features usable from 2.0; write features tiered by the capability table) | Below a threshold, only that feature is disabled with a localized notice; everything else keeps working |
| Operating systems | Windows 7+, macOS 10.13+, Linux with glibc 2.17+, musl Linux (Alpine) | Systems the engine does not cover use the CLI with full functionality (see 3.7.4) |
| Rust engine | Optional acceleration layer | Unavailable for any reason → CLI fallback; the reason is shown in the backend section of the settings page |

**Runtime anchors** (Phase 0 prints `process.versions` in each version to verify them, then records them in `docs/compatibility.md`):

| VS Code | Electron | Node | Chromium | Significance for this project |
|---|---|---|---|---|
| 1.38 | 4.2 | 10.11 | 69 | **Promised floor**: host artifact baseline `node10.11`, webview artifact baseline `chrome69`; N-API 3 |
| 1.40 | 6 | 12.4 | 76 | N-API 4 first available: if 2.7 fails to bring the engine down to N-API 3, this is the minimum version that can load the engine |
| 1.56 | 12 | 14.16 | 89 | Native `?.`/`??` first available: **the de facto floor of today's CI artifacts** (B1) |
| 1.61 | — | — | — | First version for platform-specific VSIXs (`vsce --target`); earlier versions use the universal VSIX |

#### 3.7.2 Layered strategy

| Layer | Means | Enforced by |
|---|---|---|
| **Syntax** | Source may use modern TS; esbuild downlevels the artifacts: host `target: 'node10.11'`, each webview entry `target: 'chrome69'`; after building, `es-check es2018` scans `dist/**/*.js` to prevent dependencies or vendored code from bringing in newer syntax | Build script + C1 |
| **Built-in APIs** (those downleveling cannot fix) | Host: tsconfig `lib: ["es2018"]` + `eslint-plugin-n` (`no-unsupported-features/{node-builtins,es-builtins}`, version set to `>=10.11.0`). Webview: `lib: ["es2018","dom"]` + `eslint-plugin-compat` (browserslist `chrome 69`). The few shims genuinely needed are centralized in `shared/util/compat.ts` with tests | ESLint (error level) |
| **VS Code API** | `@types/vscode` **permanently pinned to 1.38.0** as the compile-time guardrail. Post-1.38 APIs (tabGroups, l10n, LogOutputChannel, …) are accessible only through `extension/platform/vscodeCompat.ts`: locally declared types, runtime feature detection, degraded behavior. `(vscode.x as any)` is forbidden, enforced by an ESLint rule. `package.json#contributes` uses only fields 1.38 understands; before adding a field, C4 confirms that old versions ignore it rather than error | tsc + ESLint + C4 |
| **Native engine** | See 3.7.4 | C3 |
| **Git CLI** | `git/executable/capabilities.ts` centrally maintains the "version → capability" table, replacing the 5 `doesVersionMeetRequirement` checks scattered in `dataSource.ts`. Write ops declare `requires: GitCapability` in `ops/`; `GitWriter` checks uniformly and returns a localized notice. The CLI read path uses only parameters supported by the floor version; where newer parameters are required, branch by capability | Unit tests + C5 |
| **Repository formats** | bare, worktree, submodule, shallow, partial clone, reftable, SHA-256 object format: when the engine meets an unsupported format it must return `Unsupported`, and the fallback layer hands off to the CLI (SHA-256 status to be verified in Phase 0). The Reader contract suite keeps one fixture per format; fixtures whose required Git version is unmet are skipped | L3 + C5 |
| **Webview CSS** | Baseline Chromium 69; newer features (flex `gap`, `color-mix()`, `backdrop-filter`, …) are progressive enhancement only and must be preceded by a fallback declaration that works on 69 (e.g. spacing via margin, hard-coded translucent colors). Checked by `stylelint` + `plugin/no-unsupported-browser-features` (the same browserslist); rules with an existing fallback are exempted by a comment | stylelint |
| **User data** | Config keys are added, never removed: deprecated keys keep being read and migrate via the `migrations` table in `platform/config.ts`. Webview state, globalState, and `.vscode/git-graph-rs.json` carry a `version` field; readers are "lenient read, strict write": all old versions are readable, and unknown fields written by newer versions are preserved as-is, supporting user downgrades | Unit tests (one sample per historical version) |
| **Separating the dev environment from the runtime environment** | Dev and CI tooling (Vitest, esbuild, ESLint) use Node ≥ 20; artifacts run on Node 10.11+. `engines.node >=18` moves from `package.json#engines` to `.nvmrc` and CONTRIBUTING so it is not misread as a runtime requirement | Documentation |

#### 3.7.3 How feature detection is written (the only allowed form)

```ts
// extension/platform/vscodeCompat.ts
interface TabGroupsLike { readonly all: ReadonlyArray<{ readonly tabs: ReadonlyArray<unknown> }>; close?(tab: unknown, preserveFocus?: boolean): Thenable<boolean>; }

/** VS Code 1.67+ only; NULL on older editors and stubs, and every caller has a fallback. */
export function tabGroups(): TabGroupsLike | null {
	const candidate = (vscode.window as { tabGroups?: unknown }).tabGroups;
	return isTabGroupsLike(candidate) ? candidate : null;
}
```

Callers get either "present" or NULL, and must handle the NULL branch. Every compat function has two unit tests: a fake vscode with the API and one without.

#### 3.7.4 Native engine compatibility

| Item | Measure |
|---|---|
| N-API version | **Spike (task 2.7)**: implement the unified `request` entry with `AsyncTask` (`napi_create_async_work`, available since N-API 1), drop the `napi4`/`async` features, target N-API 3 so 1.38–1.39 can also use the engine. If napi-rs 3 cannot do it, keep N-API 4 and have `addonLoader` compare `process.versions.napi` first, going straight to the CLI without attempting `require` |
| Linux glibc | gnu targets switch to `cargo zigbuild --target x86_64-unknown-linux-gnu.2.17` (likewise arm64), pinning the glibc floor at 2.17 (CentOS 7 / Ubuntu 14.04 and later). CI asserts via `objdump -T` that the highest `GLIBC_` version referenced by the binary is ≤ 2.17 |
| New Linux targets | Add `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` (Alpine containers, matching the platform VSIXs `alpine-x64`/`alpine-arm64`) and `armv7-unknown-linux-gnueabihf` (`linux-armhf`, e.g. Raspberry Pi); `addonLoader` distinguishes glibc from musl |
| macOS | Set `MACOSX_DEPLOYMENT_TARGET=10.13` explicitly; CI asserts minos with `vtool -show-build` (or `otool -l`) |
| Windows | `-C target-feature=+crt-static`, no VC++ runtime dependency. Since Rust 1.78 the MSVC target requires Windows 10, so Windows 7/8.1 go through the CLI (D9) |
| MSRV | `rust-toolchain.toml` pins the dev toolchain; CI additionally runs `cargo +1.82 check` to hold the `rust-version` line |
| Failure classification | `addonLoader` distinguishes: no binary for the platform / insufficient N-API version / libc mismatch / load exception / runtime panic (converted to an error via `catch_unwind`). Every class falls back to the CLI, logs once, and is displayed on the settings page |

### 3.8 Performance architecture

#### 3.8.1 Performance budgets

**Reference environments**: CI's Linux runner (4 vCPU, SSD) plus one Windows dev machine (process starts are slower on Windows; recorded separately). **Reference repositories** are generated by the fixture generator with `git fast-import` from fixed seeds (reusing `automation/fixture.ts`'s generation capability), guaranteeing reproducibility without network access:

| Tier | Commits | Branches / tags | Worktree | Use |
|---|---|---|---|---|
| S | 1 K | 20 / 20 | 200 files | Every PR |
| M | 100 K | 2 K / 10 K | 20 K files | Every PR (P1, P2), nightly |
| L | 1 M | 20 K / 50 K | 100 K files | Nightly, before release |

**Timing points** (both host and webview mark with `Date.now()`, directly comparable on the same machine): T0 user triggers the command → T1 panel created → T2 webview script starts executing → T3 host first-paint data ready → T4 webview receives the data → T5 first commit rows painted (the next `requestAnimationFrame` after the data is rendered).

**Budgets** (P95; "hot" means the engine handle is open and the memory cache hits, "cold" means the first open after VS Code starts):

| Scenario | Metric | S | M | L |
|---|---|---|---|---|
| Activation | Time `activate()` occupies the main thread synchronously | ≤ 20 ms | ≤ 20 ms | ≤ 20 ms |
| Open view (cold) | T0 → T5 | ≤ 400 ms | ≤ 600 ms | ≤ 1200 ms |
| Open view (hot, prewarmed) | T0 → T5 | ≤ 200 ms | ≤ 250 ms | ≤ 500 ms |
| Open view (snapshot first paint) | T0 → snapshot painted | ≤ 150 ms | ≤ 150 ms | ≤ 150 ms |
| Open view: own time | T2 → T5 (excluding VS Code's own webview creation) | ≤ 80 ms | ≤ 120 ms | ≤ 300 ms |
| Load more (100 commits) | Click → painted | ≤ 50 ms | ≤ 80 ms | ≤ 150 ms |
| Expand commit details | Click → painted | ≤ 60 ms | ≤ 100 ms | ≤ 200 ms |
| Refs-only operations (create/delete tag or branch, rename) | git process exit → UI updated | ≤ 60 ms | ≤ 100 ms | ≤ 200 ms |
| Operations changing HEAD or commits (checkout, commit, reset, merge) | git process exit → UI updated | ≤ 120 ms | ≤ 200 ms | ≤ 450 ms |
| Immediate feedback after a click | Click → pending state shown | ≤ 16 ms (1 frame) | same | same |
| Find | Typing → highlights updated (over the loaded commits) | ≤ 50 ms | ≤ 50 ms | ≤ 100 ms |
| Scrolling | Frame-time P99 with 10 K rows loaded; long tasks > 50 ms | ≤ 16 ms; 0 | same | same |
| Memory | webview (10 K rows loaded) / host increment (opening one repo) | ≤ 150 MB / ≤ 40 MB | ≤ 150 MB / ≤ 60 MB | ≤ 250 MB / ≤ 120 MB |
| Size | First-paint critical JS / critical CSS (minified, not gzipped) | ≤ 200 KB / ≤ 60 KB | — | — |

Rules: after Phase 0 measures the baselines, the budgets are **calibrated once** (confirmed achievable by real measurement within a week, and recorded in an ADR); afterwards the budgets may only **tighten**. T0 → T1 → T2 include VS Code's own webview creation cost, which this project does not control; hence the separate "own time" metric as the hard number this project can influence.

#### 3.8.2 The open path

```
Today   T0 ─ create panel ─ webview parses ~560KB ─ loadRepoInfo ⇄ host/engine ─ loadCommits ⇄ host/engine ─ render T5
                       (host idle)             ↑ round trip 1                ↑ round trip 2
Target  T0 ─ create panel ─ webview parses ≤200KB ─ paint snapshot ─ ready → data already ready (host pushes) ─ reconciled render T5
        └─ host in parallel: loadView(repo) → engine (handle prewarmed, memory cache hit) ┘
```

| Measure | Notes |
|---|---|
| **Parallel prefetch** | While `Panel` is being created, `CommitLoader.loadView(repo)` starts running; once the webview boots it sends `ready`, and the host pushes the completed or nearly-completed result. Request round trips on the open path drop from 2 to 0 |
| **Merged request** | A new `loadView`: one engine call returns repoInfo and the first page of commits (the engine's `GitCommitData` already carries the branch list; only the remaining fields need filling in). `loadRepoInfo` and `loadCommits` remain, for partial refreshes |
| **Snapshot first paint** (D10) | After each stable render, store the visible window's rows and the graph layout inputs in compact form into webview state (capped at 200 KB); the next open paints immediately, marked "refreshing", and reconciles without flicker by hash when fresh data arrives (reusing the existing seamless update). The snapshot is not used when it disagrees with the current HEAD or config |
| **Prewarming** (D11) | Starting 2 s idle after `onStartupFinished` activation, open engine handles at low priority for recently opened repositories (at most 3) and prefetch the first page into the memory cache; respect memory caps and yield to user actions; can be disabled in settings |
| **First-paint bundle slimming** | The webview uses esbuild `splitting` + `format: 'esm'` + `<script type="module">` (Chromium 61+ supports module scripts, 63+ dynamic `import()`, satisfying the 1.38 floor). First paint includes only the table, graph, and control bar; markdown-it, highlight.js, settings, statistics, reflog, Gerrit, PR, worktree, and dialogs are all loaded on demand via `import()` and prefetched when idle. CSS splits the same way into critical and on-demand parts |
| **Activation slimming** | The host bundles to a single file; heavy modules (automation, binary compare, hexDiff, Gerrit, PR, avatars) are `require`d on first use. `findGit` no longer blocks `activate`: commands register first, git detection runs in the background, and the engine read path does not wait for it. Repository discovery uses the engine's in-process `repoRoot` (no process spawn), parallel and cancellable, with results cached in workspaceState; the next startup uses the cache first and re-validates in the background |

#### 3.8.3 The operate path

| Measure | Notes |
|---|---|
| **Impact-based refresh** | Each `WriteOp` declares `effects` (`refs` / `head` / `commits` / `worktree` / `stash` / `config`), and `CommitLoader` picks the minimal refresh: `refs` → do not re-walk commits, just re-read refs and re-annotate the cached commits; `worktree` → refresh only the uncommitted-changes row; `config` → reload config only; `commits` → incremental traversal. Replaces today's "every operation does `refresh(false)`" |
| **Incremental commit traversal** (engine) | The engine caches the previous traversal per "repository + traversal options"; if the new tips only add commits on top of the old tips, only the new part is traversed and prepended; history-rewriting cases (rebase, reset) automatically fall back to a full traversal. Correctness is guaranteed by property tests: under random operation sequences, the incremental result ≡ the full result |
| **Immediate feedback** | After a click, show a pending state within the same frame (disable controls, show progress) without waiting for the host. **No** data-level optimistic updates (D12), to avoid diverging from git's actual result |
| **Preflight checks in-process** | The unreachable-commit count for loss warnings, `areStagedChanges`, `getRemotesContainingCommit`, and similar preflight reads are answered by the engine in-process, in parallel with operation preparation |
| **One refresh per operation** | The refresh after an operation completes is driven by `GitWriter`'s result; during that window, file watching stays muted (keeping the existing mute mechanism). Tests assert exactly 1 refresh per operation type |
| **Cancellation and priority** | Every request carries a `requestId`; a new request of the same kind invalidates the old one: the host cancels via `AbortSignal`, the engine returns early via cooperative cancellation (traversal loops check an `AtomicBool`). The host scheduler has two levels: interactive requests first; background tasks (follow-ups, prewarming, avatars, PR) are limited to concurrency 1 and yield when interactive requests arrive |
| **A fast CLI fallback too** | The CLI read path reuses a resident `git cat-file --batch` process for object reads, merges commands where possible, and reduces process spawns (especially visible on Windows) |

#### 3.8.4 Data transfer

Today: the engine produces a JSON string → the host runs `JSON.parse` → `postMessage` structured clone → the webview. At 300 commits on the first page the volume is small and this is not a bottleneck; for "load all" or tens of thousands of commits the serialization cost becomes noticeable — Phase 0 measures first. **Decide after measuring** whether to adopt the following, and only if the gain is ≥ 20%:

- commit pages use a compact format: columnar arrays, authors and e-mails deduplicated via a string table, produced directly by the engine;
- the host does not parse commit-page content but forwards the string to the webview verbatim, where `JSON.parse` runs, saving one deep copy.

#### 3.8.5 Webview runtime

| Measure | Notes |
|---|---|
| Frame budget | ≤ 16 ms per frame while scrolling, expanding, filtering; any synchronous task ≤ 50 ms; longer work splits across `requestAnimationFrame` or idle callbacks |
| Render coalescing | Multiple store changes merge into one render on the next frame; a single response never triggers multiple render passes |
| Only changed rows | The windowed table does keyed patches by hash, touching only changed rows; rows clone from `<template>`; rows and the details panel get `contain: layout paint` (Chromium 52+) |
| Avoid forced layout | Read sizes in batches, then write DOM in batches; never interleave reads and writes; measurement logic centralizes in `render/measure.ts` |
| Graph layout | Pure functions with incremental computation: newly added commits only compute lanes for the new rows. If measurements show large-page layout above 8 ms, move it into a Web Worker |
| Events | `scroll`, `wheel`, and `touch` listeners are passive; the find input debounces with incremental matching and cancels stale searches |

#### 3.8.6 Memory and resources

- commit-page caches, details caches, and avatar caches all have both an entry cap and a byte cap (LRU);
- engine handles not belonging to the current repository close after 10 minutes idle;
- the host does not retain large payloads already present in the webview, only cache keys and necessary state;
- `retainContextWhenHidden` keeps its existing setting: enabled, tab switches need no reload, at the cost of memory. The default is decided together with D10.

#### 3.8.7 Observability

- A unified `perf` marker: the host uses `perf_hooks` (Node 8.5+), the webview uses `performance.mark`. Every open or operation produces a trace (T0–T5, or the phases of an operation); written to the log when `enableLog` is on, and attached to automation reports;
- `analyze-log.mjs` aggregates P50 / P95 per scenario, for triaging user-reported performance issues;
- a new developer command "Git Graph RS: Show Performance Trace" shows the last 20 traces so users can attach them to feedback.

---

## 4. Engineering Foundation

### 4.1 Build

| Today | Target |
|---|---|
| `tsc` outputs `out/` + `package-src.js` text rewriting + `package-web.js` concatenation + separate highlight/markdown bundling | `scripts/build/build.mjs` calls esbuild: `extension/main.ts → dist/extension.js` (cjs, external: vscode); each webview entry → `dist/webview/<name>.{js,css}` (iife, esm sources); copies askpass and vendored files |
| `require("fs") → original-fs` via a string-scanning rewrite | An esbuild plugin, or an explicit `requireWithFallback` in `platform/fs.ts` |
| Type checking coupled with bundling | `tsc -b --noEmit` (project references: shared / extension / webview / test), separated from bundling and parallelizable |
| Artifact syntax depends on which pipeline ran | esbuild sets `target` explicitly: host `node10.11`, webview `chrome69`; the final build step runs `es-check es2018 'dist/**/*.js'`, failing the build on error |
| 10+ scripts such as `npm run compile` / `build:ts` / `compile-web` | `build`, `build:watch`, `typecheck`, `lint`, `test`, `test:unit`, `test:integration`, `test:e2e`, `package`, `dev:install` |

`dist/` becomes the only packaging input; `.vscodeignore` becomes an allowlist (`!dist/**`, `!resources/**`, `!package*.json`, `!licenses/**`).

### 4.2 New dev dependencies

| Dependency | Purpose | Replaces |
|---|---|---|
| `vitest` + `@vitest/coverage-v8` | Run TS sources directly; built-in jsdom environment, mocks, coverage | `node --test` + precompilation + c8 |
| `eslint` + `typescript-eslint` | Code standards (rule set in §7) | none |
| `dependency-cruiser` | The dependency rules of §3.6, cycle detection | none |
| `@vscode/test-electron` | The L4 E2E launcher: downloads a specified VS Code version (1.38 → insiders) and runs extension tests; C4 reuses it | Part of the hand-written `vscodeStub.mjs`'s job; the manual "Run Automation Test" click |
| `playwright` (Electron driver) + an openvscode-server container image | The native-UI suite (stable) and the Remote suite in L4 | none |
| `eslint-plugin-n`, `eslint-plugin-compat` | Built-in API availability checks for host Node 10.11 and webview Chromium 69 | none |
| `stylelint` + `stylelint-no-unsupported-browser-features` | Chromium 69 checks for CSS features | none |
| `es-check` | Artifact syntax scan (C1) | none |
| Rust: `ts-rs` (dev generation); the CI tool `cargo-zigbuild` | Generate TS types from Rust models; Linux builds with a pinned glibc floor | The hand-written mirror `backend/types.ts`; native-runner builds |
| Rust: `criterion` (dev) | Engine microbenchmarks P1 | none |
| `playwright-core` + Chromium | Webview rendering benchmark P3: measures first paint, frame times, long tasks, and memory in a real browser (jsdom has no layout engine and cannot measure these) | The ad-hoc approach in `tests/browserRepro/` |

Formatting: keep the existing style (tabs, single quotes) via a `.editorconfig` + ESLint stylistic rules, and **do not introduce Prettier**, to avoid a repo-wide formatting diff. If decision D4 chooses Prettier, make a dedicated formatting commit and record it in `.git-blame-ignore-revs`.

---

## 5. Phased Implementation

### 5.0 Phase overview

| Phase | Name | Depends on | Estimate (person-days) | Risk |
|---|---|---|---|---|
| 0 | Baseline, safety net, compatibility hotfix, performance baseline, **E2E baseline** | — | 8–9 | Low |
| 1 | Engineering foundation (layout, build, test framework, compatibility gates, activation slimming, **E2E into PRs**) | 0 | 11–13 | Medium |
| 2 | Rust engine interface convergence + type generation + binary compatibility + engine performance | 0 | 11–13 | Medium-high |
| 3 | Host Git layer (Process / Reader / Writer / capability table / in-process preflight) | 1, 2 | 10–12 | Medium |
| 4 | Host protocol and main-view split + open-path and operate-path redo + **native UI scripting and assertions** | 1, 3 | 14–16 | Medium-high |
| 5 | Webview modularization + first-paint and rendering performance | 1; the protocol part of 4 | 15–18 | High |
| 6 | Auxiliary views, automation, i18n unification + **coverage matrix** | 4, 5 | 8–10 | Medium |
| 7 | Test wrap-up, **full E2E matrix**, compatibility matrix, performance gate wrap-up, docs | all | 8–10 | Medium |
| | **Total** | | **85–101** | |

The E2E infrastructure is deliberately pulled forward into phases 0 and 1: phases 3–5 later rework the host and webview at scale, and that is only safe once a regression net runs automatically in real VS Code.

```
0 ──▶ 1 ──┬──▶ 3 ──▶ 4 ──┬──▶ 6 ──▶ 7
     │    │              │
     └──▶ 2 ─┘           └──▶ 5 ──┘
                    (5 can start once 4's protocol definitions land)
```

Parallelizable tracks: **A (engine)** 2; **B (host)** 3 → 4; **C (frontend)** after 1 completes, do 5.1–5.2 first, then 5.3+ once 4.1 lands.

### 5.0.1 Acceptance rules

Each task's acceptance consists of three parts, **all of which must hold to count as done**:

1. **The universal acceptance criteria U1–U9** (the table below), applying to every PR;
2. **Task acceptance criteria**: itemized in each phase's "Acceptance criteria" section, each stating its verification method;
3. **Phase exit**: after all tasks in the phase pass, the phase-level conditions are checked once more.

The acceptance conclusions are checked item by item by the PR author in the PR description with evidence (CI links, command output, screenshots), and re-checked item by item by reviewers. Missing evidence counts as not passed.

**Universal acceptance criteria (every PR must satisfy them)**

| ID | Criterion | Verification |
|---|---|---|
| U1 | CI fully green: `build`, `typecheck`, `lint`, `test`, `cargo fmt/clippy/test`; plus C1, C2 once the gates go live | CI status |
| U2 | Behavior unchanged (except tasks explicitly marked as bug fixes): existing cases do not decrease; "replacement" deletions must attach an "old case → new case" mapping table in the PR description | PR description + review |
| U3 | Coverage (lines, branches) not lower than `main` | CI coverage diff |
| U4 | No new lint warnings, no new dependency-rule violations (against the ratchet baseline file); new files ≤ 600 lines; no `any` | `npm run lint` + depcruise ratchet |
| U5 | Packageable: `npm run package` succeeds and the VSIX manifest test passes | CI |
| U6 | PRs touching runtime code: the E2E smoke and affected tiers pass (VS Code stable); the previous night's full-tier 1.38 combination is not red. **Until task 1.10 lands**, instead run the smoke checklist S manually on 1.38 and stable | CI (before 1.10: checked results attached in the PR description) |
| U7 | Pure-move PRs: `git diff -M --stat` shows only renames and import-path changes, with every file ≥ 90% similarity | Command output attached to the PR |
| U8 | When structure or decisions change, update `ARCHITECTURE.md`, `CONTRIBUTING.md`, or an ADR in sync | Review |
| U9 | No performance regression (once the gate is live): P1, P2, P3, P5 compared against `main` on the same machine; no item regresses more than 5% (size no more than 2%); PRs claiming performance gains attach before/after data | CI performance report |

**Smoke checklist S** (executed automatically by the E2E smoke tier from task 1.10 onward, scenario IDs `smoke/S1` … `smoke/S9`; before that, run manually in about 10 minutes. "S passes" below always refers to this list)

| ID | Action | Pass condition |
|---|---|---|
| S1 | Open the Git Graph view | The commit graph of the current repository loads without error notifications |
| S2 | Scroll to the bottom in a 1000+ commit repository and "load more" | Row coordinates do not jump; new commits continue seamlessly |
| S3 | Expand a commit's details and open one file's diff | File tree and diff render correctly |
| S4 | Context-click a branch and check it out | Succeeds; the HEAD marker moves to that branch |
| S5 | Create a tag, then delete it | Both operations succeed and show up in the graph |
| S6 | Push to an HTTPS remote that needs credentials | The credential prompt appears (verifies askpass) and the push succeeds |
| S7 | Run "Developer: Restart Extension Host" | The panel recovers with its state (repository, scroll position) preserved |
| S8 | Switch the UI language to zh-cn | Views, dialogs, and notifications all show Chinese |
| S9 | Delete the engine binaries under `native/` and restart | S1–S4 still work; the settings page shows the CLI in use and why |

---

### Phase 0 · Baseline, safety net, compatibility hotfix, performance baseline, E2E baseline (8–9 person-days)

| Task | Description | Deliverable |
|---|---|---|
| 0.1 Compatibility hotfix (B1, confirmed) | CI and release switch `build:ts` to `compile-src` (es6 + askpass copy + `original-fs` rewrite); delete or align the root `tsconfig.json`. CI gains two checks: `es-check es2018 'out/**/*.js'`; `out/askpass/askpass.sh` exists. Unpack every VSIX already released on GitHub Releases and the Marketplace, determine the affected versions, and note them in the CHANGELOG | Hotfix PR + patch release + affected-version list |
| 0.2 Fix the baseline | Record case counts (Node 682 / Rust 142), Rust coverage, package sizes, `bench.mjs` first-paint times | `docs/baseline-2026-10.md` |
| 0.2b Compatibility baseline | Print `process.versions` in VS Code 1.38 / 1.40 / 1.56 / stable and verify the §3.7.1 anchor table; manually smoke the current version on 1.38 (local es6 build); try loading the existing Linux binaries in `centos:7`, `ubuntu:18.04`, and `alpine` containers and record the results; check how the engine handles SHA-256 and reftable repositories | First draft of `docs/compatibility.md` |
| 0.3 Characterization tests | Lock behavior on the **future interfaces**: (a) a table-driven test of every request command → response command / whether it triggers a refresh; (b) `loadCommits` follow-up order (remote refs → Gerrit → uncommitted); (c) argv snapshots of the 41 write operations (intercepted with a recording git double) | 3 test files — the safety net for the later phases |
| 0.4 Legacy cleanup | Delete `_fix_*.py`, `repro-*.mjs`, `apply-crab.cjs`, `tests/browserRepro/`; fix the self-contradicting passages in `GAPS.md` | 1 PR |
| 0.5 Performance baseline | Add T0–T5 markers to the **existing code** (add only, change nothing); write the S/M/L fixture generator; measure every §3.8.1 scenario in the reference environments, 20 runs each, recording P50 / P95; measure the serialization cost of "load all" (decides §3.8.4); calibrate the budgets against the measurements | `docs/performance.md` (baseline + calibrated budgets) + ADR |
| 0.6 E2E baseline | Build the minimal §6.8.1 pipeline on the **existing code**: `test/e2e/launcher.ts` starts real VS Code via `@vscode/test-electron` and loads the automation build; `entry.ts` generates the fixtures and invokes the existing `suiteRunner` to run all 146 actions (read + write), emitting JUnit and JSON; run once each on Linux × stable and Linux × 1.38; turn the smoke checklist S1–S9 into catalog actions; generate the first coverage matrix (counting only, no gate) | Nightly CI job + `docs/e2e-baseline.md` (pass / fail / skip / flaky lists + coverage matrix) |

#### Acceptance criteria

**0.1 Compatibility hotfix**
- [ ] CI artifacts pass `npx es-check es2018 'out/**/*.js'`. Verify: CI logs.
- [ ] `out/askpass/askpass.sh` and `askpass-empty.sh` exist, and exist inside the VSIX. Verify: `unzip -l *.vsix | grep askpass` output attached to the PR.
- [ ] The patch-release VSIX passes S1 and S6 on VS Code 1.38, and all of S on stable. Verify: checked results + screenshots.
- [ ] The impact list of released versions (version number, build source, affected or not) is written into the CHANGELOG. Verify: review.

**0.2 Fix the baseline**
- [ ] `docs/baseline-2026-10.md` contains: Node/Rust case counts; respective line and branch coverage; sizes of the universal VSIX and each platform VSIX; `bench.mjs` first-paint times (small, medium, and large repositories, median of 5 each); the depcruise violation count; the 10 largest files by line count. Verify: review.
- [ ] The data above is generated by the script `npm run baseline` and is reproducible. Verify: a reviewer reruns it locally; results within ≤ 5%.

**0.2b Compatibility baseline**
- [ ] The first draft of `docs/compatibility.md` includes measured `process.versions` output from VS Code 1.38 / 1.40 / 1.56 / stable; anything disagreeing with the §3.7.1 anchor table is corrected. Verify: review.
- [ ] Records exist for loading the current Linux binaries in `centos:7`, `ubuntu:18.04`, and `alpine`, and for the engine's behavior on SHA-256 and reftable repositories, each with commands and output. Verify: review.

**0.3 Characterization tests**
- [ ] (a) Covers every request command: the command table in the test is compared item by item against the `RequestMessage` union; one missing fails. Verify: CI.
- [ ] (b) The follow-up order covers 4 combinations: plain, Gerrit enabled, delayed remote refs, delayed uncommitted changes. Verify: CI.
- [ ] (c) Each of the 41 write operations has at least 1 argv snapshot. Verify: the case count in CI.
- [ ] The tests can catch regressions: the PR demonstrates 3 deliberate breaks (change one argv, swap the follow-up order, delete one case) and the tests fail each time. Verify: failure output attached to the PR description.

**0.4 Legacy cleanup**
- [ ] `_fix_*.py`, `repro-*.mjs`, `apply-crab.cjs`, and `tests/browserRepro/` no longer appear in `git ls-files`. Verify: command output.
- [ ] The Gerrit descriptions in `GAPS.md` are consistent. Verify: review.

**0.5 Performance baseline**
- [ ] The markers cover T0–T5 plus the start/end of "load more", "expand details", "refs-only operations", "HEAD-changing operations", and "find"; overhead when markers are off ≤ 1 ms. Verify: unit tests + a before/after bench comparison.
- [ ] The fixture generator produces S/M/L repositories from fixed seeds; the same seed twice yields identical commit hashes. Verify: tests.
- [ ] Every §3.8.1 scenario in `docs/performance.md` has S/M/L P50 / P95 (L at least nightly) with the measurement command attached; a reviewer can reproduce it within ≤ 10%. Verify: a reviewer reruns it.
- [ ] The calibrated budgets are recorded in an ADR; every budget item is marked "already achievable" or "to be achieved by which task of which phase". Verify: review.

**0.6 E2E baseline**
- [ ] `npm run test:e2e -- --tier full` starts **real VS Code** (not jsdom) in CI, running all actions once each on Linux × stable and Linux × 1.38, with the exit code reflecting the result. Verify: the CI logs show VS Code's startup info and version number.
- [ ] Outputs JUnit (directly displayable by CI), JSON, and HTML reports; failures attach the evidence listed in §6.8.6. Verify: CI artifacts.
- [ ] S1–S9 are all catalog actions executable automatically, and pass on stable. Verify: the report.
- [ ] `docs/e2e-baseline.md` lists each action's result on both versions; every failing and flaky (5 consecutive runs) action has a corresponding issue. Verify: review.
- [ ] The first coverage matrix (the 8 dimensions of §6.8.4) is generated, listing the uncovered items per dimension. Verify: the report.

**Phase exit**: 0.1's patch release is published; the compatibility, performance, and E2E baseline documents are merged; 0.3's tests are green on the current code; the E2E full tier runs automatically every night.

---

### Phase 1 · Engineering foundation (11–13 person-days)

| Task | Description |
|---|---|
| 1.1 Directory migration (pure move) | `git mv src/* src/extension/`, `web/* src/webview/graph/`; the parts of `src/types/` shared by host and webview move to `src/shared/`. Only import paths change |
| 1.2 tsconfig project references | `tsconfig.base.json` + 4 sub-projects; delete the `src/utils/@types/node` patch; the webview imports types from `shared/` (eliminating B5) |
| 1.3 esbuild unified build | `scripts/build/build.mjs`; the host bundles to a single file; askpass copied; `original-fs` handled. **The webview temporarily uses a shim entry**: a `main.ts` that imports in the old order (`import './utils'` …; each file becomes a side-effect module first, truly modularized in Phase 5) |
| 1.4 CI/release switch to `npm run build` | Local and CI share one command (eliminating B1/B2); `.vscodeignore` becomes an allowlist; a VSIX contents manifest test (`test/tooling/vsixContents.test.ts`: asserts `dist/askpass/*.sh`, `dist/webview/*`, no `src/`) |
| 1.5 Introduce Vitest | New tests are `*.test.ts` run by Vitest; the old `*.test.mjs` based on `node:test` cannot be executed by Vitest directly, so they remain as `npm run test:legacy` (`npm test` runs both), draining progressively as the migration proceeds, deleted in Phase 7 |
| 1.6 ESLint + dependency-cruiser | The dependency rules go live at `warn` level first with a violation list; at the end of each phase, the relevant directory's rules become `error` |
| 1.7 Developer scripts | `build-*.bat/.sh` → `npm run dev:install`; dev tools move to `scripts/dev/` |
| 1.8 Compatibility gates | Bring up per §3.7.2: esbuild `target`, `es-check`, tightened `lib` for host and webview, `eslint-plugin-n`/`eslint-plugin-compat`/stylelint (existing violations listed first, zeroed in their phases); a new `platform/vscodeCompat.ts` migrating the existing 3 `(vscode.window as any).tabGroups` sites; C2 (Node 10.11 runtime smoke) enters every PR's CI |
| 1.9 Activation slimming + performance gates | Per §3.8.2: heavy modules are `require`d on first use; `findGit` moves off `activate`'s critical path; repository discovery uses the engine's `repoRoot` with cached results; markdown-it is inserted as a `<script>` only when markdown first needs rendering (independent of Phase 5's modularization). P2 (host pipeline bench) and P5 (size budget) enter every PR's CI, compared against `main` on the same machine |
| 1.10 E2E into PRs | E2E switches to the `dist/` automation build (1.3; temporarily keeping the current packaging-time file substitution, replaced by a compile-time switch in 6.2); implement §6.8.6's isolation and determinism measures; tag the scenarios and build the smoke and affected tiers (the directory-to-domain mapping) into every PR; failure evidence auto-uploaded; local dev experience (§6.8.7); convert `test:automation:full`'s jsdom mode into `test:e2e`, keeping the jsdom harness only for L3 full-page journey tests |

#### Acceptance criteria

**1.1 Directory migration**
- [ ] U7 holds (only renames and import changes); `git log --follow` traces the pre-migration history. Verify: spot-check 5 files.
- [ ] `src/` contains only the three directories `extension/`, `webview/`, `shared/`; no `web/` directory. Verify: `ls`.

**1.2 tsconfig project references**
- [ ] `npx tsc -b --noEmit` reports 0 errors. Verify: CI.
- [ ] Zero references to `out/` in the webview; `src/utils/@types/node` deleted. Verify: `grep -r "out/" src/webview` produces no output.
- [ ] In a fresh clone, the webview's type check completes standalone without building the host first. Verify: a dedicated CI job.

**1.3 esbuild unified build**
- [ ] A single `npm run build` in a fresh clone produces a complete `dist/`. Verify: CI.
- [ ] `dist/extension.js` is a single file whose only externals are `vscode` and `.node` files. Verify: a test inspecting the esbuild metafile.
- [ ] The `original-fs` fallback logic has unit tests; `dist/askpass/*.sh` exists. Verify: CI.
- [ ] Full build time does not exceed today's (`npm run compile`). Verify: CI timing attached to the PR.

**1.4 CI/release switch to `npm run build`**
- [ ] Zero occurrences of `build:ts`, `compile-src`, and `compile-web` in the workflow files. Verify: `grep -r` over `.github/`.
- [ ] The VSIX manifest test passes: it must include `dist/**`, `resources/**`, `licenses/**`; it must not include `src/`, `test/`, `*.ts`, `*.map` (unless publishing maps is decided). Verify: CI.
- [ ] A diff of the old vs new VSIX file lists is attached to the PR and contains only the expected changes (`out/`, `media/` → `dist/`). Verify: review.

**1.5 Introduce Vitest**
- [ ] `npm test` runs both Vitest and the legacy tests; either side failing fails the command. Verify: the PR demonstrates one intentionally failing case on each side.
- [ ] In a fresh clone, `npx vitest run` passes without building. Verify: a dedicated CI job.
- [ ] The `test/support/` skeleton and at least 1 migrated sample test are merged; local unit-test time ≤ 15 s. Verify: CI timing.

**1.6 ESLint + dependency-cruiser**
- [ ] `npm run lint` runs in CI; the dependency-violation baseline `docs/depcruise-baseline.json` is committed. Verify: CI.
- [ ] The ratchet works: adding one violation fails CI. Verify: demonstrated in a PR.

**1.7 Developer scripts**
- [ ] The 4 `.bat`/`.sh` files are deleted; `scripts/` contains only the three subdirectories `build/`, `release/`, `dev/`. Verify: `ls`.
- [ ] `npm run dev:install` succeeds once each on Windows, macOS, and Linux (build, package, install VSIX). Verify: execution records attached to the PR.

**1.8 Compatibility gates**
- [ ] `es-check` is integrated into `npm run build`: deliberately introducing `??` into an artifact fails the build. Verify: demonstrated in a PR.
- [ ] `eslint-plugin-n`, `eslint-plugin-compat`, and stylelint run in CI; the existing-violation list is committed and ratcheted. Verify: CI.
- [ ] `grep -rn "as any).tabGroups" src` produces no output; every function in `vscodeCompat.ts` has both an "API present" and an "API absent" case. Verify: CI.
- [ ] C2 runs on every PR; Node 10.11 / 12.4 / LTS all pass. Verify: CI.

**1.9 Activation slimming + performance gates**
- [ ] `activate()`'s synchronous main-thread time is ≤ 20 ms; `activate` no longer `await`s any subprocess. Verify: marker data (S/M, 20 runs each, P95) + review.
- [ ] The modules loaded at activation exclude automation, binaryCompare, hexDiff, gerrit, pullRequests, and avatar. Verify: a test inspecting esbuild's module registry or `require.cache` after activation.
- [ ] On a machine without git installed, activation and view opening are unaffected by git detection (T0 → T5 within ≤ 10% of the with-git time in the S9 scenario). Verify: C2 scenario timing.
- [ ] On the second startup, the repository list comes straight from the cache (T0 → repo dropdown usable ≤ 50 ms); background revalidation updates it on change. Verify: tests + markers.
- [ ] markdown-it no longer loads at first paint; it loads when a markdown commit detail is first expanded, rendering identically to today. Verify: P5 size report + tests.
- [ ] P2 and P5 run on every PR; exceeding the U9 thresholds fails CI. Verify: the PR deliberately adds a 50 ms sleep to demonstrate the CI failure.

**1.10 E2E into PRs**
- [ ] Every PR automatically runs the smoke tier (≤ 8 minutes) and the affected tier (≤ 15 minutes); failures block merging. Verify: CI config + a PR deliberately breaking a feature to demonstrate the block.
- [ ] Correct affected selection: changing `src/webview/graph/widgets/dialog*` selects every scenario tagged `dialog`; directories not covered by the mapping select the full tier. Verify: selector unit tests.
- [ ] Isolation: on a dev machine with other extensions and a custom global git config, the results match CI. Verify: execution records.
- [ ] Stability: the smoke tier runs 20 consecutive times in CI with 0 failures. Verify: CI records.
- [ ] `npm run test:e2e -- --grep <id> --headed --keep-open` runs a single scenario locally and keeps the window open after failure; `launch.json` supports breakpoint debugging of the extension host. Verify: a reviewer demos it locally.
- [ ] `scripts/automation/full-test.mjs` is deleted; the catalog no longer runs in jsdom. Verify: `ls` + `grep bootRealView`.

**Phase exit**: three-platform CI fully green; C1, C2, P2, P5 pass; the E2E smoke and affected tiers run automatically on every PR (from here on, the smoke checklist S no longer needs manual execution); subsequent PRs produce no `out/` or `media/`.

**Risk**: esbuild bundling changes `__dirname` semantics (askpass, addon loading, vendored paths). Mitigation: all runtime paths centralize in `platform/paths.ts`, backed by 1.4's VSIX manifest test + manual smoke.

---

### Phase 2 · Rust engine interface convergence, binary compatibility, and engine performance (11–13 person-days, parallelizable with Phase 1)

| Task | Description |
|---|---|
| 2.1 Typed request enum | `protocol.rs`: `enum Request { LoadCommits(LogOptions), CommitDetails { hash }, … }`, deserialized via serde tag/content; `Engine::handle(Request) -> Result<Response>`. Delete `dispatch.rs`'s string match and hand-rolled arg parsing |
| 2.2 Structured errors | `Error` serializes as `{ kind, message }`; `ErrorKind` gains `#[non_exhaustive]`; the TS side no longer parses the `"Kind: "` prefix |
| 2.3 ts-rs generation | `model/*` and `Request` derive `TS`; `cargo test` exports to `src/shared/engine/` (committed); CI runs `git diff --exit-code src/shared/engine` |
| 2.4 Narrow the N-API surface | `node/lib.rs` keeps only `open/close/closeAll/openCount/engineVersion/request/requestBytes` (`cancel` added in 2.9); `requestBytes` returns a `Buffer`, replacing base64 |
| 2.5 TS adapter switch | `nativeReader.ts` becomes a single generic method `request<M>(method, params): Promise<EngineResponse<M>>`; delete the hand-written mirror `backend/types.ts` |
| 2.6 Visibility and module tidy-up | Everything except `Engine`, the protocol, and the models becomes `pub(crate)`; regroup into `read/`, `model/` per §3.5; the pure parsing functions' unit tests (`text.rs`, gerrit parsing) move into module-level `#[cfg(test)]` |
| 2.7 N-API floor spike | Per §3.7.4, implement `request` with `AsyncTask`, try to reach N-API 3, and verify loading in Node 10.11; write the conclusion into an ADR. Either way, `addonLoader` gains an N-API version preflight and failure classification |
| 2.8 Binary compatibility | The Linux gnu targets switch to zigbuild with glibc pinned at 2.17; add the musl and armhf targets with matching platform VSIXs; macOS deployment target, Windows `crt-static`; CI asserts glibc symbol versions and minos on the artifacts; add an MSRV check |
| 2.9 Cooperative cancellation | `request` accepts a cancellation token (the host-side `requestId` mapping to an engine-side `AtomicBool`); the commit-traversal, status-scan, statistics, and history-search loops check periodically and return `Cancelled` when cancelled; N-API gains `cancel(requestId)` |
| 2.10 Incremental traversal and refs re-annotation | Per §3.8.3: traversal results cached per "repository + options"; when tips only advance, only the new commits are traversed; add `Request::Refs` + `Request::Annotate` (re-annotate refs over a given commit list) for refs-only operations; add `Request::LoadView` (repoInfo + first page in one call). Enable and exploit commit-graph files in gix |
| 2.11 Engine microbenchmarks P1 | `criterion` benchmarks for traversal (first page / load more / incremental), refs, commit details, status, and statistics, over S/M fixtures; CI compares against `main` on the same machine |

**Tests**: `native/core/tests/dispatch.rs` becomes a table-driven test of `protocol.rs` (one round-trip case per variant); `git_parity.rs` stays unchanged — it is the sole authority on engine correctness.

#### Acceptance criteria

**2.1 Typed request enum**
- [ ] `dispatch.rs` is deleted; no code in `protocol.rs` matches method names by string. Verify: review.
- [ ] Every `Request` variant has ≥ 1 round-trip test; unknown method, wrong parameter type, and missing parameter each have a test returning a structured error. Verify: `cargo test`.
- [ ] The CONTRIBUTING steps for "adding an engine read method" work: a PR follows the steps to add a sample method and reverts it, touching only `protocol.rs` and `engine.rs` in the process. Verify: review.

**2.2 Structured errors**
- [ ] Zero TS code parsing the `"Kind: "` prefix. Verify: `grep`.
- [ ] Every `ErrorKind` has a mapping case on the TS side; the user-visible error text matches today (snapshot comparison). Verify: CI.

**2.3 ts-rs generation**
- [ ] Every file in `src/shared/engine/` is marked generated in its header; CI checks drift with `git diff --exit-code`. Verify: a PR demonstrates CI failing after changing a Rust type without regenerating.
- [ ] Before the switch, a bidirectional `expectTypeOf` equivalence test between the generated and hand-written types passes. Verify: CI (the test is deleted once 2.5 lands).

**2.4 Narrow the N-API surface**
- [ ] Exactly 7 exported N-API functions (8 once 2.9 lands). Verify: an assertion test on `Object.keys(addon)`.
- [ ] `requestBytes` returns a `Buffer`: files with NUL bytes, non-UTF-8, and 10 MB round-trip byte-identical. Verify: tests.
- [ ] Reading file content is no slower than the base64 scheme. Verify: bench results attached to the PR.

**2.5 TS adapter switch**
- [ ] `src/backend/types.ts` is deleted; `nativeReader.ts` ≤ 200 lines. Verify: `wc -l`.
- [ ] The Reader contract suite (currently `backends.test.mjs`) is fully green. Verify: CI.
- [ ] First-paint time regresses no more than 5% against the baseline. Verify: bench results attached to the PR.

**2.6 Visibility and module tidy-up**
- [ ] `lib.rs` publicly exports only `Engine`, the protocol, the models, and `Error`. Verify: the public API list from `cargo doc` attached to the PR.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes; core coverage is no lower than the baseline. Verify: CI.

**2.7 N-API floor spike**
- [ ] The conclusion (feasible or not) with evidence is written into an ADR. Verify: review.
- [ ] If feasible: the engine loads in Node 10.11 and completes one `request`. Verify: the assertion in C2.
- [ ] If not feasible: on Node 10.11 the loader does not call `require`, goes straight to the CLI, logs exactly 1 line, and the settings page shows "N-API version too low". Verify: the assertion in C2 + a screenshot.
- [ ] In both cases, the loader's 5 failure classes (no binary / N-API too low / libc mismatch / load exception / runtime panic) each have a unit test. Verify: CI.

**2.8 Binary compatibility**
- [ ] CI asserts that the Linux gnu binary references no `GLIBC_` version above 2.17. Verify: the `objdump -T` step in CI.
- [ ] The macOS binary's minos is 10.13; the Windows binary does not depend on `VCRUNTIME140.dll`. Verify: the `vtool` / `dumpbin /dependents` steps in CI.
- [ ] Produces the musl ×2 and armhf binaries plus the three platform VSIXs `alpine-x64`, `alpine-arm64`, and `linux-armhf`. Verify: the CI artifact list.
- [ ] `cargo +1.82 check --workspace` passes; C3 passes. Verify: CI.

**2.9 Cooperative cancellation**
- [ ] Cancelling a full traversal of an M/L repository returns `Cancelled` within ≤ 10 ms. Verify: timed in tests.
- [ ] Cancellation leaves handles and caches intact: re-issuing the same request immediately after cancelling yields the same result as never cancelling. Verify: tests.
- [ ] With the cancellation checks added, normal traversal time increases ≤ 2%. Verify: P1.

**2.10 Incremental traversal and refs re-annotation**
- [ ] Property tests: over randomly generated operation sequences (commit, branch, tag, merge, rebase, reset, simulated fetch), each step's incremental traversal result is identical to the full result (commit order, parents, ref annotations), under both date and topo ordering, ≥ 500 random cases. Verify: `cargo test`.
- [ ] Refreshing an M repository after adding 1 commit takes ≤ 20% of a full traversal. Verify: P1.
- [ ] `Annotate` re-annotates a 300-commit page on an M repository in ≤ 5 ms; the result is identical to a full load. Verify: P1 + tests.
- [ ] `LoadView`'s result is identical to calling `loadRepoInfo` + `loadCommits` separately, taking ≤ 70% of their combined time. Verify: tests + P1.
- [ ] On M/L repositories with a commit-graph file, first-page traversal is faster than without one; behavior is unchanged when the file is absent. Verify: P1 (both fixtures) + tests.

**2.11 Engine microbenchmarks P1**
- [ ] The benchmarks cover all operations listed above; S/M run every PR, L nightly; results are output as JSON and saved as CI artifacts. Verify: CI.
- [ ] Compared against `main` on the same machine; regressions beyond 5% fail CI. Verify: demonstrated in a PR.
- [ ] Two consecutive runs of the same commit fluctuate ≤ 3% (proving the gate is trustworthy; otherwise adjust the sampling count or switch to instruction counting). Verify: CI records.

**Phase exit**: the TS side compiles against generated types; the Reader contract suite is fully green; the N-API exports are 7 (8 with `cancel`; 2.4's assertion is updated in sync); C3 passes; the P1 gate is live; first-page traversal time on S/M is no worse than the Phase 0 baseline.

---

### Phase 3 · Host Git layer (10–12 person-days)

Order: build the process layer first, then migrate writes and reads onto it, and finally replace `DataSource` with `GitRepository`.

| Task | Description |
|---|---|
| 3.1 `GitProcess` | `run(args, { cwd, input?, env?, signal? }) → { code, stdout: Buffer, stderr }`; askpass environment variables are injected uniformly here; `errors.ts` unifies the error format (following DataSource's current format, locked by 0.3's snapshots). Migrate the 10 process entry points one by one |
| 3.2 Write operations → `ops/` pure functions | Each write operation becomes `(params) => WriteOp` (argv, whether askpass is needed, which caches to invalidate on success). **Unit tests cover the argv**, replacing 0.3(c)'s snapshots |
| 3.3 `GitWriter` | The only place writes execute: `argSafety` → `GitProcess` → error mapping → emit a "repository changed" event. Policies such as `signCommits` come in via the `ConfigSnapshot` parameter |
| 3.4 `lossGuard` | Extract `detachedCommitsLossWarning` and `hardResetLossWarning` into independently testable functions |
| 3.5 Read-layer tidy-up | `cliBackend.ts` splits by theme into `read/cli/`; `FallbackReader` becomes a Proxy based on a method-name table; unify the two adapters' error contracts: both reject `GitError`, converted to `ErrorInfo` at the handler layer |
| 3.6 `GitRepository` facade | Composes reader + writer + operationState; migrate `DataSource`'s call sites one by one (`commands.ts`, `gitGraphView.ts`, `avatarManager`, `repoManager`, `diffDocProvider`), then delete `dataSource.ts` |
| 3.7 Remove vscode | The `vscode.Uri`, `showErrorMessage`, and terminal calls inside `git/**` move to `platform/`, passed in by callers; the `git/**` dependency rule rises to `error` |
| 3.8 Git capability table | `git/executable/capabilities.ts`: centralize `GitVersionRequirement`'s 5 thresholds and the scattered checks; `WriteOp.requires` is checked uniformly by `GitWriter`; every threshold has "below / equal / above" table-driven cases; places in the CLI read path that depend on newer parameters branch by capability |
| 3.9 Write-path performance | Every `WriteOp` declares `effects` (§3.8.3) for Phase 4's impact-based refresh; the preflight reads — the loss-warning unreachable-commit count, `areStagedChanges`, `getRemotesContainingCommit` — are answered by the engine, in parallel with operation preparation; the CLI read path reuses a resident `git cat-file --batch` process (exits after 30 s idle) |

#### Acceptance criteria

**3.1 `GitProcess`**
- [ ] `child_process` appears only in `extension/git/process/`, with the corresponding depcruise rule at error level. Verify: CI.
- [ ] All 10 original process entry points are migrated; error text matches 0.3's snapshots. Verify: CI.
- [ ] Unit tests cover: non-zero exit codes, stdin input, abort cancellation, > 10 MB output, non-UTF-8 output, askpass environment injection. Verify: CI.

**3.2 Write operations → `ops/`**
- [ ] All 41 write operations are pure functions in `ops/`, touching no processes, config, or vscode. Verify: depcruise rules + review.
- [ ] Table-driven argv tests cover every option branch of every operation; `ops/` line coverage ≥ 95%, branch coverage ≥ 90%. Verify: the CI coverage report.
- [ ] 0.3(c)'s snapshot tests are deleted; the mapping table is attached to the PR. Verify: review.

**3.3 `GitWriter`**
- [ ] `argSafety` has exactly 1 call site; zero `getConfig` calls inside `git/**`. Verify: `grep`.
- [ ] Failure-path tests: rejected argument injection, process failure, credentials required, insufficient Git version — at least 1 each. Verify: CI.

**3.4 `lossGuard`**
- [ ] Unit tests cover: no risk; N unreachable commits on detached HEAD; hard reset discarding uncommitted changes; unreachable commits preserved by a stash. Verify: CI.
- [ ] Results match the old implementation: 0.3's corresponding cases pass on the new implementation. Verify: CI.

**3.5 Read-layer tidy-up**
- [ ] No file in `read/cli/` exceeds 600 lines. Verify: `wc -l`.
- [ ] Zero hand-written `attempt(...)`; adding a read method requires no change to `fallbackReader.ts`. Verify: review.
- [ ] Error contracts unified: in the contract suite, given the same failing input, both adapters reject a `GitError` of the same `kind`. Verify: CI.

**3.6 `GitRepository` facade**
- [ ] `src/extension/dataSource.ts` is deleted and all call sites are migrated. Verify: `grep -r DataSource src` produces no output.
- [ ] `GitRepository` itself has ≤ 15 public methods (reads, writes, and state each live on sub-objects). Verify: review.

**3.7 Remove vscode**
- [ ] The depcruise rule `git/** ↛ vscode` is at error level and passes. Verify: CI.
- [ ] Tests for `git/**` run without loading a fake vscode. Verify: Vitest's node environment config.

**3.8 Git capability table**
- [ ] Zero calls to `doesVersionMeetRequirement` outside `capabilities.ts`. Verify: `grep`.
- [ ] Every threshold has "below / equal / above" cases. Verify: CI.
- [ ] On the floor-version Git (C5), features below a threshold show a localized notice while everything else works. Verify: C5.

**3.9 Write-path performance**
- [ ] All 41 `WriteOp`s declare `effects` (omission is a type error); every declaration is tested: execute the operation on a real repository and compare refs, HEAD, commits, worktree, stash, and config before and after — the actual changes must be a subset of the declared `effects`. Verify: L3 table-driven tests.
- [ ] With the engine present, no git processes other than the operation's own are started during a write (e.g. the remote check before pushing a tag). Verify: tests counting `GitProcess` invocations.
- [ ] On the Windows reference machine, expanding commit details in CLI-fallback mode is ≥ 30% faster than the Phase 0 baseline. Verify: P2 (CLI mode).
- [ ] The resident `cat-file` process rebuilds itself after an abnormal exit with no hung requests; exits after 30 s idle. Verify: tests.

**Phase exit**: `dataSource.ts` deleted; `child_process` appears only in `git/process/`; `git/**` does not import `vscode`; `argSafety` has exactly 1 call site; the smoke checklist S passes; P2 is no worse than the Phase 0 baseline.

---

### Phase 4 · Host protocol and main-view split, open-path and operate-path redo, native UI scripting (14–16 person-days)

| Task | Description |
|---|---|
| 4.1 Protocol types | `shared/protocol/graphView.ts` adopts §3.2's `RequestMap` form; mechanically converted from the current `types/messages.ts` (1191 lines); the old `Request*`/`Response*` names stay as type aliases until Phase 5 ends |
| 4.2 Handler table | `graphView/handlers/*.ts` takes over the 86 cases by domain; `index.ts` uses `satisfies` for exhaustiveness; the `mutates` field replaces `REPO_MUTATING_COMMANDS`; unknown commands are logged and answered with an error (no longer silently dropped) |
| 4.3 `CommitLoader` | Extracted from `GitGraphView`: commit-page LRU cache, staged follow-ups, the Gerrit stage, and the uncommitted-changes stabiliser; the follow-up chain is uniformly cancellable via `AbortSignal` and carries a catch (fixing the unhandled rejection) |
| 4.4 `Panel` | The remaining lifecycle, serialization restore, orphaned tabs, and HTML/CSP split into `panel.ts` and `html.ts` |
| 4.5 Config snapshot | Take one `ConfigSnapshot` at the start of each request and pass it to the handlers; config changes invalidate only the caches depending on that item (cache keys include the policy values) |
| 4.6 commands split | `commands.ts` (840 lines) splits by command group; `registry.ts` declares the command ID list, and a test compares it against `package.json#contributes` (replacing `contract.test.mjs`'s command part + `contributedMenus.test.mjs`) |
| 4.7 Open path | Per §3.8.2: `Panel` calls `CommitLoader.loadView` in parallel at creation; once the webview sends `ready`, the host pushes the data; a new `loadView` protocol command (engine-side using 2.10's `LoadView`); the webview's initial load no longer sends `loadRepoInfo` / `loadCommits` |
| 4.8 Impact-based refresh + scheduling and cancellation | `CommitLoader.refreshAfter(effects)` picks the minimal refresh per §3.8.3 (`refs` → `Refs` + `Annotate`; `worktree` → refresh only the uncommitted row; `commits` → incremental traversal); the webview's write-success handling switches from `refresh(false)` to waiting for the host's pushed partial update; the host scheduler (interactive first, background concurrency 1); same-kind new requests invalidate old ones via 2.9's cancellation |
| 4.9 Prewarming | Per §3.8.2: while idle, open handles and prefetch first pages for recently opened repositories (at most 3); respect memory caps and yield to interactive requests; a new setting `git-graph-rs.prewarm` (D11) — the switch changes only speed, never functionality |
| 4.10 Native UI scripting + scenario assertions | All native interactions in the host (quick pick, input box, modal confirmation, save/open dialogs, notifications) go through `UiPort`; the E2E build injects a `ScriptedUiPort` (§6.8.2); the catalog grows from "actions" into "scenarios" (§6.8.3: `given` / `when` / `answers` / `then`); implement `GitStateProbe` and add `then.git` assertions plus failure-path scenarios for all 41 write operations; remove the `nativeSaveDialog` skip |

**Tests**: handler unit tests use a `RecordingContext` (recording send and ui calls) + a fake `GitRepository`; `CommitLoader` is tested against a fake reader for follow-up order and cancellation. 0.3(a)(b)'s characterization tests are replaced by these tests and deleted at the end of this phase.

#### Acceptance criteria

**4.1 Protocol types**
- [ ] Both host and webview import the protocol types from `shared/protocol/`; `types/messages.ts` is deleted, or reduced to `@deprecated` type aliases. Verify: `grep`.

**4.2 Handler table**
- [ ] The compiler guarantees exhaustiveness: the PR demonstrates `tsc` erroring after deleting one handler. Verify: the error output attached to the PR description.
- [ ] `REPO_MUTATING_COMMANDS` is deleted; each handler's `mutates` matches the old set (compared once in the migration PR; the comparison test is deleted after passing). Verify: CI.
- [ ] Unknown commands receive an error and log 1 line. Verify: tests.
- [ ] Every handler has ≥ 1 success case and ≥ 1 failure case; every file under `handlers/` is ≤ 400 lines; `handlers/**` line coverage ≥ 90%. Verify: CI.

**4.3 `CommitLoader`**
- [ ] Tests cover: the 4 follow-up order combinations; after a new request arrives, the old request's follow-ups are no longer sent; cache hits and invalidation. Verify: CI.
- [ ] Follow-up errors are caught and reported to the webview: a test listening on `unhandledRejection` records 0 occurrences. Verify: CI.
- [ ] 0.3(a)(b) are deleted; the mapping table is attached to the PR. Verify: review.

**4.4 `Panel`**
- [ ] `gitGraphView.ts` is deleted; `panel.ts` ≤ 400 lines. Verify: `wc -l`.
- [ ] Panel restoration and orphaned tabs both have tests (fake vscode); S7 passes. Verify: CI + smoke.
- [ ] The generated HTML carries a nonce; the CSP has no `'unsafe-inline'` script source. Verify: an assertion test on the HTML.

**4.5 Config snapshot**
- [ ] Zero `getConfig()` calls in `handlers/` and `git/`. Verify: `grep`.
- [ ] Changing a setting unrelated to commit pages does not flush the commit-page cache; changing a related one does. Verify: tests.

**4.6 commands split**
- [ ] `commands.ts` is deleted; every file under `commands/` is ≤ 300 lines. Verify: `wc -l`.
- [ ] `registry.ts` and `package.json#contributes` compare bidirectionally: one extra or one missing command fails the test. Verify: demonstrated in a PR.
- [ ] `contract.test.mjs` and `contributedMenus.test.mjs` are deleted. Verify: `ls`.

**4.7 Open path**
- [ ] From T1 to T5, the webview sends zero `loadRepoInfo` / `loadCommits` requests; all data is pushed by the host. Verify: tests recording the messages sent by the webview.
- [ ] Host data loading overlaps webview startup: T3 earlier than T4 − round-trip time, or T3 ≤ T2 + 20 ms. Verify: P4 markers.
- [ ] Under the 4 orderings "switch repository the instant it opens", "close the panel the instant it opens", "data ready before `ready`", and "`ready` before data ready", the results are correct and no unfinished requests leak. Verify: `CommitLoader` timing tests.
- [ ] "Open view (cold/hot)" and "own time" meet the §3.8.1 budgets on S/M (the snapshot part is accepted in 5.9). Verify: P4.

**4.8 Impact-based refresh + scheduling and cancellation**
- [ ] After creating/deleting a tag or branch, or renaming, the engine receives only `Refs` + `Annotate`, no traversal request. Verify: tests recording engine requests.
- [ ] Exactly 1 refresh per write-operation type (including file-watch events). Verify: table-driven tests covering all 41 operations.
- [ ] "Refs-only operations" and "HEAD/commit-changing operations" meet the §3.8.1 budgets on S/M. Verify: P2 + P4.
- [ ] After 10 rapid branch-filter switches, only the last request's result is rendered and the first 9 are cancelled in the engine (`Cancelled` count 9); the final result completes within ≤ 1.5× a single request's time. Verify: tests + P2.
- [ ] With background tasks (follow-ups, prewarming, avatars, PR) running, an interactive request's latency is within ≤ 10% of the no-background case. Verify: P2.

**4.9 Prewarming**
- [ ] With prewarming on, "open view (hot)" meets the budget on S/M; with it off, functionality is completely identical, only slower. Verify: P4 (both settings) + tests.
- [ ] Prewarming's host memory increment stays within the §3.8.1 budget; handles opened for non-current repositories close after 10 minutes idle. Verify: tests + memory sampling.
- [ ] Within 10 s after VS Code startup, prewarming uses ≤ 50% of one core and starts only after 2 s idle. Verify: CPU sampling in P4.

**4.10 Native UI scripting + scenario assertions**
- [ ] Zero direct calls to `vscode.window.show*` (QuickPick / InputBox / *Message / SaveDialog / OpenDialog) outside `platform/` in the host, enforced by an ESLint rule. Verify: CI.
- [ ] Zero actions in the catalog skipped as `nativeSaveDialog`; scenarios involving save dialogs, such as `archive`, are answered via `ScriptedUiPort` and run. Verify: the "skipped" count in the E2E report.
- [ ] Every branch of every `UiPort` call site (confirm, cancel, each option, invalid input) has ≥ 1 scenario. Verify: the "native dialogs" row of the coverage matrix reaches 100%.
- [ ] All 41 write operations have success and failure scenarios, all with `then.git` assertions; the total `then.git` assertions ≥ 82 (previously 18). Verify: the statistics in the report.
- [ ] `GitStateProbe` itself has L3 tests: after known modifications to fixtures, every assertion type (refs, HEAD, commits, worktree, stash, config, remotes) correctly judges both pass and fail. Verify: CI.
- [ ] The scenarios' `refreshes` assertions agree in E2E with 4.8's result: 1 refresh per write operation. Verify: the E2E report.

**Phase exit**: `gitGraphView.ts` deleted; no file under `graphView/` exceeds 600 lines; `contract.test.mjs` deleted; the E2E smoke and affected tiers fully green; the previous night's full tier (including 1.38) fully green; the open and operate budgets on S/M all met (except snapshot first paint).

---

### Phase 5 · Webview modularization and first-paint / rendering performance (15–18 person-days, highest risk, finest-grained PRs)

| Task | Description |
|---|---|
| 5.1 ES modules | Convert every file to explicit `export`/`import`, starting from the leaf modules (the post-split `dates`, `html`, `icons` of utils) and working upward; the esbuild bundle's behavior is guarded by jsdom full-page tests |
| 5.2 `HostBridge` | `acquireVsCodeApi` is called only in `bridge.ts` (the shared convention with the automation shim is kept); all `postMessage` literals become `bridge.send('cmd', {...})`, type-checked against `RequestMap` |
| 5.3 `ResponseRouter` | The 92-branch switch → a table; the ~60 "refresh or report error" branches merge into one generic action handler (`ActionResult` → refresh / error dialog) |
| 5.4 Store | Migrate `GitGraphView`'s 29 fields into `state/store.ts`; config has a single source (eliminating the dual source of `initialState.config` and `this.config`); persistence moves into `persistence.ts` |
| 5.5 Component split | Split out `commitTable`, `graphSvg`, `commitDetails`, `controlBar`, and the widgets per §3.4; `layout/` holds pure functions with standalone unit tests; the split order follows the hotspots: main → observers → contextMenuActions → commitDetailsView |
| 5.6 SafeHtml | The `html` tagged template escapes by default; entries containing HTML in `strings` are typed `SafeHtml`; `formatStr` escapes parameters; an ESLint rule forbids assigning plain strings to `innerHTML` |
| 5.7 CSS organized by component | Split `main.css` and `mobile.css` by component, with mobile rules co-located; extract `tokens.css`; the theme audit harness (`theme-audit-harness`) stays in `scripts/dev/`. Also zero the stylelint compatibility violations: every `gap`, `color-mix()`, and `backdrop-filter` listed in §1.6-C6 gains a fallback declaration that works on Chromium 69 |
| 5.8 Webview compatibility | Zero the existing `eslint-plugin-compat` violations; user-visible webview features on VS Code 1.38 are smoke-covered by C4 (loading, scrolling, details, context menus, dialogs) |
| 5.9 First-paint performance | Per §3.8.2: esbuild `splitting` + module scripts; first paint contains only the table, graph, and control bar; everything else loads on demand via `import()` with idle prefetch; critical CSS separated from on-demand CSS; snapshot first paint (D10) |
| 5.10 Rendering performance | Per §3.8.5: store changes render coalesced per frame; keyed patches by hash; row template cloning; `contain`; centralized measurement with read/write separation; incremental graph layout; passive listeners; find debouncing, incremental matching, cancellable; P3 (rendering benchmarks in real Chromium) enters every PR's CI |

**Tests**: component tests mount a single component in jsdom with a fake store and fake bridge; full-page pipeline tests keep only 3–5 key journeys (load → scroll → expand details → context-menu action → refresh preserving position), merged from the former `webviewSeamlessUpdate`, `webviewRowCoordinates`, and `webviewRealPipeline`.

#### Acceptance criteria

**5.1 ES modules**
- [ ] The webview tsconfig no longer has `module: none`; `scripts/package-web.js` is deleted. Verify: `grep`, `ls`.
- [ ] Modules do not communicate via globals: `isolatedModules` on; ESLint `no-implicit-globals` at error. Verify: CI.
- [ ] The full-page journey tests are green; the bundle size grows ≤ 5% over the baseline. Verify: CI + size report.

**5.2 `HostBridge`**
- [ ] Zero occurrences of `postMessage(` outside `bridge.ts`; `acquireVsCodeApi` has exactly 1 call site. Verify: `grep`.
- [ ] The test sharing the API instance with the automation shim passes. Verify: CI.

**5.3 `ResponseRouter`**
- [ ] Zero `switch (msg.command)` in the webview. Verify: `grep`.
- [ ] The compiler guarantees full response coverage: the PR demonstrates `tsc` erroring after deleting one handler. Verify: the PR description.
- [ ] The generic `ActionResult` handler's unit tests cover: refresh on success, showing errors, replaying after data-loss-warning confirmation. Verify: CI.

**5.4 Store**
- [ ] Zero reads of `initialState.config`. Verify: `grep`.
- [ ] After a config change, every component reads the new value: tests cover the former 16 sites reading stale config. Verify: CI.
- [ ] Every released version's webview state sample loads without losing fields. Verify: the user-data sample tests.

**5.5 Component split**
- [ ] No webview file exceeds 600 lines. Verify: `wc -l`.
- [ ] Component files call no `document.getElementById` / `querySelector` outside their mount points (a custom ESLint rule). Verify: CI.
- [ ] `layout/` line coverage ≥ 90%. Verify: CI.
- [ ] `theme-audit-harness` screenshots compare pixel-identical before and after the split; any diff is attached and confirmed as an expected change by review. Verify: the screenshot comparison report.

**5.6 SafeHtml**
- [ ] Only `SafeHtml` can be assigned to `innerHTML`: the ESLint rule is at error with 0 violations. Verify: CI.
- [ ] XSS regression tests: commit messages, branch names, tag names, author names, and file paths containing `<img src=x onerror=…>` all render as text, ≥ 1 case each. Verify: CI.

**5.7 CSS organized by component**
- [ ] `main.css` and `mobile.css` are deleted; one CSS file per component. Verify: `ls`.
- [ ] Zero stylelint compatibility violations. Verify: CI.
- [ ] Screenshots on VS Code 1.38 verify the degraded spacing and colors are acceptable per review; mobile-layout screenshots on stable show no regression. Verify: screenshots attached to the PR.

**5.8 Webview compatibility**
- [ ] Zero `eslint-plugin-compat` violations. Verify: CI.
- [ ] C4 covers loading, scrolling, details, context menus, and dialogs on VS Code 1.38, all passing. Verify: C4.

**5.9 First-paint performance**
- [ ] First-paint critical JS ≤ 200 KB, critical CSS ≤ 60 KB (minified, not gzipped). Verify: P5.
- [ ] Each on-demand module's first-use load time is ≤ 30 ms (S-tier reference machine); on-demand modules are prefetched when idle after first paint, with ≥ 90% cache hits on first use (counted in P3 scenarios). Verify: P3.
- [ ] Module scripts and dynamic `import()` work on VS Code 1.38. Verify: C4.
- [ ] Snapshot first paint: reopening takes T0 → snapshot painted ≤ 150 ms; when new data arrives, the visible rows' coordinates do not jump during reconciliation (reusing the seamless update's coordinate assertions); the snapshot is not used when HEAD, config, or repository changed. Verify: P4 + full-page journey tests.
- [ ] The snapshot occupies ≤ 200 KB of webview state; corrupt or version-mismatched snapshots are safely ignored. Verify: tests.

**5.10 Rendering performance**
- [ ] In P3 with 10 K rows loaded: scroll frame-time P99 ≤ 16 ms; 0 long tasks > 50 ms; webview memory ≤ 150 MB. Verify: P3.
- [ ] After a "refs-only operation", the only DOM rows rewritten are those whose refs changed (counted via MutationObserver); the other visible rows are not replaced. Verify: P3 / full-page journey tests.
- [ ] One response triggers exactly 1 render: the tests count render invocations. Verify: tests.
- [ ] On S/M, "load more", "expand commit details", and "find" meet the §3.8.1 budgets. Verify: P3 + P4.
- [ ] P3 runs on every PR, compared against `main` on the same machine; exceeding the U9 threshold fails CI. Verify: demonstrated in a PR.

**Phase exit**: `web/main.ts` is gone; the entry `graph/main.ts` ≤ 150 lines; no test uses `new Function` or reads `media/out.min.js`; the webview is included in coverage; the smoke checklist S passes on VS Code 1.38 and stable; every §3.8.1 budget on S/M is met.

---

### Phase 6 · Auxiliary views, automation, i18n, coverage matrix (8–10 person-days)

| Task | Description |
|---|---|
| 6.1 Comparison-view frontend extraction | The HTML/CSS/JS template strings in `comparisonView.ts` and `binaryCompareView.ts` move to `webview/comparison` and `webview/binaryCompare`; the host keeps only controllers; the protocols use `shared/protocol/*`; the CSP switches to nonce + external scripts with no more inline scripts |
| 6.2 Automation decoupling | `automation/` accesses the view through an injected `GraphViewPort`; delete the static `currentPanel` and the taps; esbuild `define: { __AUTOMATION__ }` decides packaging, replacing the file substitution at package time; `catalog.ts` splits into data files by domain |
| 6.3 i18n unification | Host and webview share `shared/i18n/{en,zh-cn}.ts`; key consistency is guaranteed at compile time, deleting `check-i18n-parity.cjs`; `package.nls*.json` stays separate (a VS Code requirement), compared by one test |
| 6.4 Coverage matrix gate | Per §6.8.4: all 8 dimensions' lists are auto-extracted from sources (`package.json`, `shared/protocol`, the webview's menu and action definitions, `git/write/ops`, the `UiPort` call sites); fill in every uncovered scenario, including table-driven scenarios for the ~90 settings; establish the exemption list; the matrix enters the full tier, failing on any row below 100% |

#### Acceptance criteria

**6.1 Comparison-view frontend extraction**
- [ ] Apart from the shell in `graphView/html.ts`, no host TS contains template strings with `<script` or `<style`. Verify: `grep`.
- [ ] The comparison and binary-compare protocols are typed, with zero `msg: any`; the CSP has no inline scripts. Verify: `grep` + HTML assertion tests.
- [ ] The tests for `binaryCompare`, `imageDiff`, and `hexDiff` import modules; zero `new Function`. Verify: `grep`.
- [ ] Manual verification: opening a comparison of two commits and a binary (image) comparison both work on 1.38 and stable. Verify: screenshots attached to the PR.

**6.2 Automation decoupling**
- [ ] Zero references to `currentPanel` in `automation/`; the static taps are deleted. Verify: `grep`.
- [ ] The normal build's `dist/` contains no automation code: searching the bundle for the automation module's identifier strings yields 0. Verify: the VSIX manifest test.
- [ ] The automation build's E2E full tier fully passes; the packaging-time file-substitution script is deleted; `AutomationEngine` and `suiteRunner` are callable as libraries from `test/e2e/entry.ts` (no static state). Verify: the E2E report.
- [ ] The catalog is split into data files by domain; every scenario has `tags`; a scenario without tags fails to load. Verify: tests.

**6.3 i18n unification**
- [ ] `check-i18n-parity.cjs` and the two old dictionaries are deleted. Verify: `ls`, `grep`.
- [ ] Key consistency at compile time: the PR demonstrates `tsc` erroring when zh-cn misses one key. Verify: the PR description.
- [ ] The key-comparison test between `package.nls.json` and `package.nls.zh-cn.json` passes; S8 passes. Verify: CI + smoke.

**6.4 Coverage matrix gate**
- [ ] All 8 dimensions' lists are auto-extracted, not hand-written: adding one command to `package.json` (or one protocol request, one setting, one context-menu item) without writing a scenario fails the full tier, naming the missing item. Verify: the PR demonstrates all 4 cases.
- [ ] All 8 dimensions reach 100%; exemptions ≤ 5, each with a reason, owner, and expiry. Verify: the E2E report + `exemptions.ts`.
- [ ] The setting scenarios are table-driven: every setting has a "change → observable effect" assertion without needing a window reload. Verify: the settings dimension detail in the report.
- [ ] Host coverage collected during E2E is merged with L2/L3; `platform/` and `panel.ts` line coverage ≥ 80%. Verify: the merged coverage report.

**Phase exit**: no inline frontend code in the host; the normal VSIX contains no automation code; one i18n dictionary for the whole project; the coverage matrix gate is live and green.

---

### Phase 7 · Test wrap-up, full E2E matrix, compatibility matrix, performance gate wrap-up, docs (8–10 person-days)

| Task | Description |
|---|---|
| 7.1 Drain `test:legacy` | Finish the remaining migration per Appendix B; delete the `tests/` directory, `vscodeStub.mjs`, and the `node --test` runner |
| 7.2 Full E2E matrix | Build all environment combinations of the full tier (nightly) and the release tier (pre-release) per §6.8.5; add the Playwright + Electron native-UI suite (10–15 cases, stable) and the openvscode-server Remote suite; flaky-failure detection, quarantine, and automatic issue creation; the release workflow gates on the release tier |
| 7.3 Coverage thresholds | Configure per §6.5 with a ratchet that only rises |
| 7.4 Docs | `docs/ARCHITECTURE.md` (end-state structure + data flow), `CONTRIBUTING.md` (checklists for adding a request / an engine read method / a setting), `docs/adr/` recording decisions D1–D15; the structure-related parts of `GAPS.md` and `BACKENDS.md` merge into ARCHITECTURE |
| 7.5 Compatibility matrix | §6.6's C3–C6 enter the nightly and pre-release pipelines; finalize `docs/compatibility.md` (support matrix, anchor table, known degraded behaviors); the README gains a "System requirements" section; user-data migration samples cover every released version |
| 7.6 Performance gate wrap-up | P4 (end-to-end markers inside VS Code) enters the nightly and pre-release pipelines; all L-tier scenarios go nightly; finalize `docs/performance.md` (budgets, measurements, trend-chart generation); the "Show Performance Trace" command; performance data goes into the README |

#### Acceptance criteria

**7.1 Drain `test:legacy`**
- [ ] The `tests/` directory, the `test:legacy` script, `scripts/run-tests.mjs`, and `vscodeStub.mjs` are all deleted. Verify: `ls`, `package.json`.
- [ ] Every row of Appendix B is marked done with a PR link. Verify: review.
- [ ] Total coverage (lines, branches) is no lower than the Phase 0 baseline. Verify: the CI coverage report.

**7.2 Full E2E matrix**
- [ ] Every environment combination of §6.8.5's full tier runs nightly, each ≤ 40 minutes; every release-tier combination is wired into the release workflow, and any failure fails the release (except insiders). Verify: CI config + run records.
- [ ] The 1.38 combination runs the full tier's entire scenario set (not just the read-only ones) and passes; scenarios that cannot run on 1.38 are all on the exemption list with reasons. Verify: the report.
- [ ] The native-UI suite covers: running commands from the command palette, quick pick showing and selecting, input box, modal confirmation, notifications, the webview tab icon, keyboard shortcuts, and buttons in the SCM view; the cases all pass, attaching screenshots and screen recordings on failure. Verify: the report.
- [ ] The Remote suite passes in openvscode-server: webview resource loading, engine binary selection (linux-x64 / musl inside the container), the askpass credential prompt, opening the view, and one write operation. Verify: the report.
- [ ] Stability: the smoke tier passes 20 consecutive runs with 0 failures; the full tier runs 7 consecutive nights without new flaky failures; ≤ 3 scenarios in quarantine, all within their deadlines. Verify: nightly records + `quarantine.ts`.
- [ ] The release checklist contains no manual test steps. Verify: the release workflow + `CONTRIBUTING.md`.

**7.3 Coverage thresholds**
- [ ] Vitest's `coverage.thresholds` matches §6.5; coverage below a threshold fails CI. Verify: demonstrated in a PR.
- [ ] When coverage exceeds a threshold by more than 2 percentage points, the ratchet script prompts raising it. Verify: script output.

**7.4 Docs**
- [ ] `ARCHITECTURE.md`'s directory structure matches reality: a script compares the first two directory levels. Verify: CI.
- [ ] A developer not involved in the refactoring follows CONTRIBUTING's checklists to complete one sample change each (new request, new engine read method, new write operation) without needing to ask questions. Verify: the feedback record attached to the PR.
- [ ] ADRs D1–D15 are complete; `GAPS.md` and `BACKENDS.md` contain no outdated structural descriptions. Verify: review.

**7.5 Compatibility matrix**
- [ ] C3–C6 pass 7 consecutive nights in the nightly pipeline; the release workflow depends on these jobs, and any missing or failing job fails the release. Verify: CI config + run records.
- [ ] `docs/compatibility.md` and the README's "System requirements" agree, and both match the C-series measurements. Verify: review.
- [ ] User-data samples cover every released version: the sample directory is compared against the `git tag` list; one missing fails the test. Verify: CI.

**7.6 Performance gate wrap-up**
- [ ] **Every** §3.8.1 budget is met on S/M/L; `docs/performance.md` lists each item's measured P50 / P95 against its budget. Verify: the P1–P5 nightly reports.
- [ ] P4 runs 7 consecutive nights with result fluctuation ≤ 10%; the release workflow depends on P1–P5, and any failure fails the release. Verify: CI config + run records.
- [ ] The "Show Performance Trace" command shows the last 20 traces, each containing T0–T5 or an operation's phases. Verify: an L4 case.
- [ ] Versus the Phase 0 baseline: the P95 of "open view (cold)", "refs-only operations", and "HEAD-changing operations" on S/M drops ≥ 40% (if the baseline already meets the budget, no worse than the baseline). Verify: the before/after comparison in `docs/performance.md`.

**Phase exit**: all acceptance criteria of §11 (Definition of Done) are met.

---

## 6. Test System

### 6.1 Layers

| Layer | Contents | Location | Tooling | When it runs |
|---|---|---|---|---|
| **L0 static** | Type checking, ESLint, dependency rules, clippy/fmt, ts-rs drift, i18n keys (compile time) | — | tsc -b, eslint, depcruise, cargo | Every commit |
| **L1 Rust** | In-module pure-function unit tests; the fixture-repository integration tests and `git_parity` in `tests/` | `native/core/src/**`, `native/core/tests/` | cargo test / llvm-cov | Every commit |
| **L2 TS unit** | Pure functions and deep-module interfaces: write-op argv, CLI parsers, `lossGuard`, `argSafety`, handlers (fake context), `CommitLoader` (fake reader), graph layout, store/reducer, SafeHtml, dates/formatting | `*.test.ts` next to sources | Vitest (node / jsdom environments) | Every commit, < 15 s |
| **L3 integration** | Real git fixtures: the **Reader contract suite** (the same cases run against Native and CLI), `GitWriter` operations on real repositories, webview full-page journeys (jsdom + fake host) | `test/integration/` | Vitest | Every commit |
| **L4 end-to-end** | All user-visible features running in real VS Code: commands, menus, webview controls, settings, write operations, native dialogs, panel lifecycle (details in §6.8) | `test/e2e/` | @vscode/test-electron + the existing automation engine + ScriptedUiPort; Playwright (native UI, Remote) | smoke + affected every PR; full nightly; release pre-release |
| Tooling | Build locks, VSIX manifest, packaging scripts | `test/tooling/` | Vitest | Every commit |
| **Compatibility C1–C6** | Artifact syntax, old Node runtimes, engine loading on old systems, minimum VS Code, old Git, platforms (details in §6.6) | `test/compat/` | Plain Node scripts + containers + @vscode/test-electron | C1, C2 every PR; C3–C6 nightly + pre-release |
| **Performance P1–P5** | Engine microbenchmarks, host pipeline, webview rendering, end-to-end markers, size (details in §6.7) | `native/core/benches/`, `test/perf/` | criterion, Node scripts, playwright-core, @vscode/test-electron | P1, P2, P3, P5 every PR (S/M); P4 and the L tier nightly + pre-release |
| Manual (optional) | The product's built-in "Run Automation Test" button: developers manually run the read-only suite against real repositories; a visual walkthrough before release | — | existing | Not part of any gate |

### 6.2 The "no redundancy" rules

1. **One behavior, one owning layer.** How to decide: if an assertion already holds at a lower layer, the upper layer tests only the "wiring", not the "content".
   - "engine answer = git answer" → only in L1 `git_parity`.
   - "the Native adapter and the CLI adapter produce isomorphic results for the same input" → only in the L3 Reader contract suite, 1–3 representative cases per read method, no more enumerating edge cases (edge cases belong to L1 or the CLI parsers' L2).
   - write-op argv → L2; actually executing writes → L3 with 1 happy path + 1 failure path per operation class.
   - handler business branches → L2; the webview only asserts "the UI state is correct after the response", never re-asserting backend data.
2. **Table-driven first.** Isomorphic cases (41 write operations, 86 requests, all i18n keys) are one table plus one loop, not N copy-pasted `it`s.
3. **Shared fixtures centralize.** `test/support/repoBuilder.ts` (chain-built fixture repositories, replacing each test's self-made repo scripts), `fakeVscode.ts`, `webviewHost.ts`, `recordingContext.ts`. Rust's counterpart is the builder in `native/core/tests/common/`.
4. **No testing implementation details**: no importing private functions, no slicing source, no asserting log text.
5. **Snapshots only for structured argv and protocol tables**; no large HTML snapshots.
6. **Every bug fix ships with a failing-then-passing regression test**, placed in the layer that owns the behavior.
7. **Compatibility tests only verify "it loads and completes the key paths in that environment"; performance tests only measure time** — neither repeats functional assertions. Functional correctness belongs to L1–L3; compatibility tests answer only "does it work in this environment"; performance tests answer only "is it fast enough".
8. **E2E verifies "the user path is wired up and the result is correct", not every branch of the internal logic.** For example, argv combinations belong to L2; in E2E, each write operation needs just one success and one failure scenario, checking the repository's final state. C2–C6's smoke runs and P4 reuse E2E's scenarios and executor directly instead of writing another set of cases.

### 6.3 Naming and organization

- Files: `<module-under-test>.test.ts` next to the source; integration tests named by capability: `test/integration/reader/commits.contract.test.ts`.
- `describe` names the module or capability; `it` names the behavior: `it('rejects a branch name that starts with "-"')`.
- Slow tests (> 1 s) are allowed only in L3/L4.

### 6.4 Expected case counts

After the migration the Node case count **will drop** (estimated 682 → ~550–600); this is deduplication, not lost coverage. Every "replacement deletion" lists its new owning case in the PR, and coverage (lines + branches) must not fall below the Phase 0 baseline.

### 6.5 Coverage thresholds (end state, ratchet only rises)

| Scope | Line coverage | Branch coverage |
|---|---|---|
| `native/core` | ≥ 85% | — |
| `src/extension/git/**`, `graphView/handlers/**`, `graphView/commitLoader.ts` | ≥ 90% | ≥ 80% |
| `src/shared/**` | ≥ 95% | ≥ 85% |
| `src/webview/**/layout`, `state`, `common` | ≥ 85% | ≥ 75% |
| Global | ≥ 80% | ≥ 70% |

vscode glue code such as `platform/` and `panel.ts` is covered by L4 and does not count toward the L2 thresholds.

### 6.6 Compatibility tests (C1–C6)

Vitest itself needs Node 18+ and cannot run on Node 10.11, so the compatibility tests target **build artifacts**, driven by plain scripts independent of any test framework (`node:assert`).

| ID | What it verifies | How | Frequency |
|---|---|---|---|
| C1 | Artifact syntax | `es-check es2018 'dist/**/*.js'`; also asserts that runtime files such as `dist/askpass/*.sh` exist (merged into the VSIX manifest test) | Every PR |
| C2 | Old Node runtimes | CI uses `actions/setup-node` to install **Node 10.11.0**, 12.4.0, and the current LTS; each loads `dist/extension.js` with a fake vscode: run `activate`, complete one read via the CLI (load a commit page) and one write (create a branch), then `deactivate`; assert no unhandled rejections. Also load the engine on Node 10.11, verifying that the N-API preflight does fall back to the CLI (or, if 2.7 succeeded, that the engine does load) | Every PR (Linux only) |
| C3 | Engine loading on old systems | In `centos:7` (glibc 2.17, with Node 16), `ubuntu:18.04`, and `alpine` (musl) containers, `require` the matching `.node` and execute one `request`; armhf runs under QEMU; assert the artifacts' glibc symbol versions and macOS minos | Nightly + pre-release |
| C4 | Minimum and latest VS Code | `@vscode/test-electron` runs **1.38.0**, 1.40.0, stable, and insiders, executing the L4 smoke case set. If 1.38's Electron cannot start on the current CI image, switch to an older container image; if still infeasible, fall back to the oldest startable version and record it in `docs/compatibility.md`, with the Node 10.11 runtime backstopped by C2 | Nightly + pre-release; insiders failures only warn, without blocking |
| C5 | Old and new Git | The CLI Reader contract suite and the Writer integration tests run once each on the **floor Git** (`ubuntu:18.04` ships 2.17.1; if D7 sets it lower, a self-built image) and the latest Git; every threshold in the capability table is verified as "works" on newer Git and "shows the unavailable notice" on older Git | Nightly + pre-release |
| C6 | Platforms | The existing three-platform CI, plus Windows ARM64 and macOS x64 in `full` mode; the Remote scenario runs one L4 smoke in a Dev Container (the extension host inside a Linux container) | Pre-release |

**Upgrading users' data compatibility** (belongs to L2, not the C series): `test/fixtures/user-data/<version>/` holds samples of every released version's webview state, globalState, and `.vscode/git-graph-rs.json`; the migration functions round-trip every sample ("read → migrate → write → read again"), plus a test that "unknown fields written by a newer version are preserved when read by an older reader".

### 6.7 Performance tests (P1–P5)

| ID | What it measures | How | Gate |
|---|---|---|---|
| P1 | Engine | `criterion` benchmarks: traversal (first page / load more / incremental), `LoadView`, refs, `Annotate`, details, status, statistics, search; S/M every PR, L nightly | Same-machine comparison against `main`; regression > 5% fails |
| P2 | Host pipeline | Evolved from `bench.mjs`: drives `CommitLoader` and the handlers over the real engine (and in CLI mode), covering open (`loadView`), load more, details, refs-only operations, HEAD-changing operations, cancellation scenarios, and background-task interference; outputs JSON | Same as above |
| P3 | Webview rendering | `playwright-core` loads the webview artifact in headless Chromium with a fake host and fixture data (S/M, plus 10 K rows), measuring T2 → T5, scroll frame times (`PerformanceObserver` for long tasks, `requestAnimationFrame` intervals), DOM mutation counts, and the JS heap | Same-machine comparison, regression > 5% fails; also checks the absolute budgets of §3.8.1 |
| P4 | End-to-end | Reads the T0–T5 and operation markers inside `@vscode/test-electron`: cold open, hot open, snapshot first paint, 3 operation classes; nightly on S/M/L | Fails beyond budget × 1.2 (VS Code's own overhead fluctuates a lot, hence the absolute budget with margin) |
| P5 | Size | Measures the first-paint critical JS/CSS, the on-demand modules, and the host bundle in `dist/` | Fails over budget; growth > 2% over `main` requires justification in the PR and reviewer approval |

**Noise reduction**: run `main`'s and the PR's artifacts back-to-back in the same job (same-machine comparison) instead of comparing against historical numbers; at least 20 samples per item, compare medians, and use the Mann–Whitney U test to confirm the difference is significant before calling it a regression; the L tier runs nightly only, with the results plotted as trend charts. Performance tests answer only "is it fast"; correctness belongs to L1–L3 (same as §6.2 rule 7).

### 6.8 Comprehensive VS Code automation testing (L4)

Goal: **everything a user can do in VS Code has a test that runs automatically in real VS Code and checks real results**; releases depend on no manual steps.

#### 6.8.1 Architecture

```
CI / local   npm run test:e2e --tier smoke|full --vscode 1.38.0|stable|insiders --backend engine|cli|nogit --lang en|zh-cn
   │
   ▼
test/e2e/launcher.ts        @vscode/test-electron: download and cache the specified version → launch with an isolated user-data-dir / extensions-dir
   │                         --extensionDevelopmentPath=<dist's e2e build>  --extensionTestsPath=test/e2e/entry
   ▼  (inside the extension host process)
test/e2e/entry.ts           generate fixtures → select scenarios → hand them to the existing AutomationEngine → output JUnit + JSON + HTML reports → report the result via the exit code
   │
   ├─ command drive  vscode.commands.executeCommand (argument shapes match what package.json menus pass in)
   ├─ request drive  inject protocol requests (only for backend paths and timing measurement)
   ├─ UI drive       in-page shim clicks, types, right-clicks, and key presses on real controls in the real webview
   └─ native UI      ScriptedUiPort: answer quick picks, input boxes, modal confirmations, and save/open dialogs per the scenario script, recording what was shown
   │
   ▼
Assertions  host responses · webview DOM · the git repository's real state (GitStateProbe, read via the git CLI) · editor / tab / terminal · UiPort records · notifications · no errors in the logs
```

Key points:
- **Reuse instead of building another set**: the executor is the existing `AutomationEngine` and `suiteRunner`. After 6.2's dependency-injection rework, they become libraries callable from the test entry; the "Run Automation Test" button stays, for developers to run the read-only suite manually on real repositories;
- **Builds**: E2E uses the `__AUTOMATION__=true` build (6.2) with the same syntax targets as the release artifacts (`node10.11` / `chrome69`), so it also runs on 1.38;
- **No Mocha**: scenarios are data (the catalog) and the executor already exists. The entry only selects scenarios, aggregates results, and sets the exit code (D14).

#### 6.8.2 Driving the native UI

| Method | Coverage | Supported versions | Use |
|---|---|---|---|
| **ScriptedUiPort** (primary) | All native interactions in the host go through the `UiPort` in `platform/` (centralized by tasks 3.7 and 4.4); the E2E build injects a scripted implementation: answer quick picks, input boxes, modal confirmations, and save/open dialogs with per-scenario preset answers, recording titles, options, and copy for assertions. Replaces the `nativeSaveDialog` skip and the "primary button only" limitation | All versions (including 1.38) | Covers every branch of every command: confirm, cancel, invalid input, different options |
| **Playwright + Electron** (supplement, D13) | Launch real VS Code with `_electron.launch` and operate the native UI like a user: the command palette, quick picks actually shown, notifications, tab icons, keyboard shortcuts, buttons in the SCM view | stable only | Verifies that `UiPort`'s real implementation actually shows things — the glue layer itself; 10–15 cases |
| **openvscode-server + Playwright** (Remote) | The extension host runs in a Linux container with the UI in a browser, matching the Remote-SSH / Dev Container topology: resource URIs go through `vscode-remote`, webview assets are forwarded remotely | stable | Verifies resource loading, askpass, and engine binary selection in Remote scenarios |

#### 6.8.3 Scenarios and assertions

The catalog grows from "actions" to "scenarios" and splits into data files by domain (6.2):

```ts
{
	id: 'menu-branch/delete-merged',
	tags: ['write', 'branch', 'smoke'],          // used for tier selection
	given: { fixture: 'standard', settings: { 'git-graph-rs.dialog.deleteBranch.forceDelete': false }, branch: 'feature/merged' },
	when:  { ui: [{ op: 'contextmenu', selector: '.gitRef[data-name="feature/merged"]', item: ['Delete Branch...', '删除分支...'] },
	              { op: 'click', selector: '#dialogAction' }] },
	answers: [],                                  // ScriptedUiPort's answers to native dialogs (none in this example)
	then:  {
		responses: ['deleteBranch'],
		git: [{ kind: 'branchAbsent', name: 'feature/merged' }, { kind: 'headIs', name: 'main' }],   // GitStateProbe
		dom: [{ absent: '.gitRef[data-name="feature/merged"]' }],
		refreshes: 1,                             // consistent with §3.8.3's "one refresh per operation"
		noErrors: true                            // no errors in the host logs or the webview console
	}
}
```

Rules:
- **every write operation has at least a `then.git` assertion**, checking the repository's real state (refs, HEAD, commits, worktree, stash, config, remotes), not merely "a response arrived";
- every write operation has ≥ 1 **failure-path** scenario: conflict, remote rejection (a `pre-receive` hook on the bare remote), invalid input, insufficient Git version, Git not installed;
- all scenarios forbid fixed-duration sleeps; wait only on conditions (host response, DOM selector, git state), with timeouts declared by the scenario;
- the executor resets the repository state before and after each scenario (reusing the existing bare-remote reset mechanism), so scenarios are independent of each other and can run in any order.

#### 6.8.4 Coverage matrix (completeness gate)

After an E2E run, a "coverage matrix" is generated; any row below 100% fails CI. Exemptions must be listed in `test/e2e/exemptions.ts` with a reason, owner, and expiry, totaling ≤ 5:

| Dimension | List source (auto-extracted, never hand-written) | Criterion for "covered" | Target |
|---|---|---|---|
| Contributed commands | `package.json#contributes.commands` (45) | ≥ 1 scenario executes it via the command drive, with `then` assertions | 100% |
| Menu items | Every (menu location × command × when clause) combination in `contributes.menus` | Executed with the argument shape that menu passes in | 100% |
| Protocol requests | `RequestCommand` in `shared/protocol` (~86) | Actually issued during a run (recorded via taps) | 100% |
| Webview controls | Static extraction: context-menu item definitions, dialog actions, control-bar buttons, elements with `data-action`, keyboard shortcut tables | ≥ 1 UI-driven scenario clicks or triggers it | 100% |
| Settings | All keys of `contributes.configuration` (~90) | Table-driven setting scenarios: after changing the setting, an observable effect (DOM, request parameters, or behavior) matches expectations, without a reload | 100% |
| Write operations | All `WriteOp`s in `git/write/ops` (41) | Have success and failure scenarios, both with `then.git` assertions | 100% |
| Native dialogs | Every `UiPort` call site | Every option branch (confirm, cancel, each option) has been answered | 100% |
| UI language | `en`, `zh-cn` | The smoke tier passes under both languages | 100% |

The matrix is part of the HTML report and is uploaded as a CI artifact on every run. `NODE_V8_COVERAGE` also collects the extension host's code coverage during E2E, merged with L2/L3 coverage, to check glue code such as `platform/` and `panel.ts` (§6.5).

#### 6.8.5 Environment matrix and tiers

| Tier | Scenario scope | Environments | Duration budget | When |
|---|---|---|---|---|
| **smoke** | The smoke checklist S1–S9 + the most critical scenario per domain (~40, tag `smoke`) | Linux × stable × engine × en | ≤ 8 minutes | Every PR, blocks merging |
| **affected** | All scenarios in the domains of the PR's changed files (selected via the directory-to-tag mapping) | Linux × stable × engine | ≤ 15 minutes | Every PR, blocks merging |
| **full** | All scenarios + the coverage matrix | {Linux, Windows, macOS} × stable × {engine, cli}; Linux × 1.38 × {engine, cli}; Linux × stable × nogit (read-only parts); Linux × stable × zh-cn; Linux × stable × mobile layout; Linux × insiders | Each combination ≤ 40 minutes, combinations in parallel | Nightly |
| **release** | full + the Playwright native-UI suite + openvscode-server (Remote) + P4 performance + the two intermediate versions 1.40 / 1.56 | As above, plus Windows ARM64 and macOS x64 | — | Pre-release, blocks release |

insiders failures only warn without blocking, but get an issue within 2 business days: they are an early warning about future VS Code versions.

#### 6.8.6 Stability (no "occasionally fails" allowed)

- **Isolation**: every run uses a fresh `--user-data-dir` and `--extensions-dir` plus `--disable-extensions` (loading only this extension); `HOME`, `GIT_CONFIG_GLOBAL`, and `GIT_CONFIG_NOSYSTEM` point at temp directories; `TZ=UTC`, locale, window size, and `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` are pinned;
- **Determinism**: fixtures are generated from fixed seeds (identical seeds yield identical commit hashes); time-dependent displays (relative times, etc.) use an injectable clock in E2E builds;
- **No retries**: a failure in a PR gate is a failure; there is no automatic retry, because an occasional failure is itself a defect. Nightly reruns each failed scenario 2 more times to separate stable from flaky failures;
- **Quarantine**: flaky scenarios move into `quarantine.ts` with an owner and a deadline of ≤ 14 days; at most 3 scenarios in quarantine — more blocks merging;
- **Failure evidence**: on failure, automatically save the webview DOM (via the shim's `outerHTML`), the webview console, the host logs, VS Code's `--logsPath` directory, perf traces, and a git state diff from before and after execution; the Playwright tier additionally saves screenshots and screen recordings.

#### 6.8.7 Developer experience

- `npm run test:e2e`: the first run downloads VS Code and caches it into `.vscode-test/`; combine `--grep <id|tag>`, `--vscode <version>`, `--backend`, `--lang`, `--headed` (show the window), and `--keep-open` (keep the window open after failure for debugging);
- `.vscode/launch.json` provides an "E2E: current scenario" configuration supporting breakpoint debugging of both the extension host and the webview;
- when adding a feature, just add a scenario to the domain's scenario file; the coverage matrix automatically flags the missing items (Appendix C).

---

## 7. Code Standards (written into CONTRIBUTING.md and enforced by tooling wherever possible)

| Aspect | Rule |
|---|---|
| Files | One primary export per file; camelCase filenames (snake_case in Rust); no `utils.ts`-style grab bags — name by theme; barrel `index.ts` only at directory boundaries |
| Size | Files ≤ 600 lines, functions ≤ 60 lines (ESLint `max-lines` / `max-lines-per-function` at warn, error for new code) |
| Types | `strict` + `noUncheckedIndexedAccess`; no `any` (`@typescript-eslint/no-explicit-any` at error; use `unknown` plus guards at boundaries); protocol and engine types come only from `shared/` |
| Errors | `git/**` throws `GitError`; the handler layer converts uniformly to `ErrorInfo`; no swallowed rejections (`no-floating-promises` at error) |
| Async | Cancellable flows use `AbortSignal`; no bare `setTimeout` polling (handled uniformly by `poller.ts`) |
| Comments | Write "why", not "what"; keep the existing high-quality comments on git behavior details |
| Rust | A subset of `clippy::pedantic`; `#[non_exhaustive]` on external types; no `unsafe`; every new public function has a doc comment |
| Security | In the webview, only `SafeHtml` produced by `html`` ` may be assigned to `innerHTML`; git arguments are validated only via `GitWriter`; the CSP uses no `unsafe-inline` script sources |
| Compatibility | Do not upgrade `@types/vscode`; new VS Code APIs only via `vscodeCompat.ts`; new Node or DOM APIs must pass `eslint-plugin-n`/`compat`, else go into `shared/util/compat.ts` with a fallback; new CSS features need a fallback declaration first; new Git parameters must be registered in the capability table; new persisted fields must ship migrations and samples; no dependency may require a higher runtime (vendored libraries must also pass `es-check`) |
| E2E | Every new user-visible feature must have a scenario (the coverage matrix enforces it); write-op scenarios must have `then.git` assertions; no fixed-duration sleeps — wait only on conditions; native interactions in the host go only through `UiPort`; new controls carry stable selectors (`data-action` / `id`) and must not be selected by CSS structure or text (menu items selected by text must list both Chinese and English) |
| Performance | No new synchronous work, subprocesses, or serial round trips on the first-paint path (activation, opening the view through T5); new features load on demand by default; no synchronous file IO or synchronous subprocesses in the host (ESLint forbids `*Sync` and `execSync`, except in build scripts); no reading layout properties inside loops in the webview (`offsetHeight` etc. only inside `measure.ts`); new requests must be cancellable; new caches must have caps; new expensive operations must be marked |

---

## 8. CI end state

```
lint-and-typecheck (ubuntu)   : eslint (incl. n/compat) · stylelint · depcruise · tsc -b · cargo fmt · clippy · ts-rs drift check · cargo +1.82 check
engine (3 OS)                 : cargo test (llvm-cov on ubuntu)
build-addon (matrix)          : gnu targets via zigbuild (glibc 2.17); add musl ×2, armhf; artifact symbol-version / minos assertions
unit-and-integration (3 OS)   : npm run build (incl. es-check = C1) · vitest run --coverage (thresholds)
compat-runtime (ubuntu)       : C2: Node 10.11 / 12.4 / LTS load the dist smoke
perf (ubuntu + windows)       : run main then the PR back-to-back on the same machine: P1 (S/M) · P2 · P3 (ubuntu only) · P5 → generate the comparison report and comment it on the PR
e2e-pr (ubuntu, xvfb)         : E2E smoke tier + affected tier (stable × engine × en), blocks merging
package                       : npm run package · VSIX manifest test
nightly                       : E2E full tier across all environment combinations + coverage matrix · C3 container loading · C5 Git floor / latest · P4 · the L tier of P1–P3 · flaky detection · trend charts
pre-release                   : E2E release tier (full + native UI + Remote + 1.40 / 1.56) · C3–C6 · P1–P5
```

C4 (minimum through insiders) and C6 (all platforms) are carried directly by the E2E full / release tiers and no longer run separately. The release workflow reuses the jobs above with no separate build commands; the E2E release tier, C3–C6, and P1–P5 must all pass before a release is allowed. Performance jobs should use fixed-spec runners; if GitHub-hosted runner noise causes fluctuation above 3%, switch to self-hosted runners, or switch P1's gate metric to instruction counting (e.g. `iai-callgrind`).

---

## 9. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| esbuild bundling changes runtime paths (addon, askpass, vendored) | Medium | High | Centralize paths in `platform/paths.ts`; VSIX manifest test; L4 smoke; publish a pre-release first after Phase 1 lands |
| Webview modularization introduces rendering/scrolling regressions | High | High | Split Phase 5 into 15+ small PRs; land the full-page journey tests first; run `theme-audit-harness` screenshot comparisons before and after splitting `main.ts` |
| The protocol rewrite drifts field names and breaks persisted webview state | Low | High | `WebViewState` is a frozen contract; add a "read old-version state" compatibility test |
| ts-rs-generated types differ in detail from the existing TS types (`readonly`, `null` vs optional fields) | Medium | Medium | Phase 2.3 generates first and does a bidirectional `expectTypeOf` comparison against the hand-written types; switch only after confirming equivalence |
| The long-running refactor conflicts with feature development | High | Medium | Land pure-move PRs within a day or two with advance notice; split the hot files (gitGraphView, main.ts) first; tag each phase's end |
| Test deduplication accidentally deletes valid coverage | Medium | Medium | Every deletion carries a mapping; coverage ratchet; reviewers check against Appendix B |
| Old VS Code (1.38's Electron 4) cannot start on modern CI images, making C4 untestable | Medium | Medium | Switch to an older distro container image; if still infeasible, fall back to the oldest startable version, backstopped threefold by C2 (artifacts on Node 10.11) + es-check + the pinned `@types/vscode`, and recorded honestly in `docs/compatibility.md` |
| Syntax esbuild cannot downlevel (e.g. the regex `v` flag, BigInt literals) or dependencies shipping newer syntax | Low | High | C1's `es-check` fails the build; the vendored libraries (highlight.js, markdown-it) are version-locked and pass C1 before any upgrade |
| zigbuild artifacts behave differently from native builds | Low | Medium | The engine tests still run on native runners; C3 loads the zigbuild artifacts in the target systems and executes requests |
| Compatibility constraints slow feature development | Medium | Low | All constraints are checked automatically by tooling, not by manual review; `vscodeCompat.ts` provides a ready feature-detection template |
| Incremental traversal is wrong, dropping or misordering commits in the graph | Medium | High | Property tests (incremental result ≡ full result); any uncertainty falls back to a full traversal; a switch lets users disable incremental traversal in settings when problems arise |
| Snapshot first paint shows stale data that users mistake for the current state | Medium | Medium | Show a "refreshing" marker; never use the snapshot when HEAD, config, or repository changed; keep the action buttons disabled during reconciliation; D10 allows disabling it |
| Prefetch and prewarming waste resources (users switch repositories right after opening, or never open) | Medium | Low | Prefetch is cancellable; prewarming runs only when idle, with CPU and memory caps, and can be disabled; P4 measures the startup-phase CPU usage |
| Performance-test noise causes false positives/negatives and erodes trust in the gate | High | Medium | Same-machine comparison + multiple samples + significance testing; switch runners or metrics when run-to-run fluctuation exceeds 3%; false positives can be exempted per PR with a label, but reviewer approval is required |
| On-demand loading causes a hitch the first time a feature is used | Medium | Low | Prefetch when idle after first paint; 5.9's acceptance requires ≥ 90% prefetch hit rate and ≤ 30 ms per-module load |
| Many E2E flaky failures, and everyone starts ignoring red CI | High | High | §6.8.6: isolated runs, deterministic fixtures, condition-only waits, no retries; quarantine with caps and deadlines; flaky failures are treated as defects with owners |
| E2E takes too long and slows the PR cadence | Medium | Medium | PRs run only smoke + affected (≤ 15 minutes); the full tier moves to nightly; combinations run in parallel; VS Code downloads and fixtures are cached |
| `ScriptedUiPort` behaves differently from the real UI (e.g. a real quick pick filters options while the script selects directly) | Medium | Medium | The Playwright native-UI suite covers each `UiPort` method's real implementation on stable; the `UiPort` interface stays thin, with real implementations only forwarding |
| macOS / Windows runners running E2E unstably or at high cost in CI | Medium | Medium | The PR tier runs only on Linux; macOS / Windows run nightly only; on failure, first check whether it is platform-related before deciding on quarantine |
| The coverage matrix's "auto-extraction" misses a class of controls, making the "100%" hollow | Medium | Medium | The extractor itself is tested (fixed sample sources → expected lists); review spot-checks that new controls appear in the matrix; webview controls uniformly use `data-action` for easy extraction |

**Rollback**: every PR is independently revertible; the big changes of Phases 1 and 5 ship as pre-releases first (`vsce package --pre-release`), observed for a week before the official release.

---

## 10. Decisions To Be Made

| # | Decision | Recommendation | Rationale |
|---|---|---|---|
| D1 | Whether to raise `engines.vscode` above `^1.38.0` | **Decided: keep `^1.38.0`** and make it a tested fact (§3.7) | Legacy compatibility is a product requirement. Today's problem is not the declaration but the CI artifacts violating it (B1); the fix is making the build and tests hold the floor |
| D2 | Test framework | **Vitest** | Runs TS directly with built-in jsdom and coverage, no build needed before testing; not `node --test` + type stripping, because CI's Node 20 does not support it. Vitest is a dev tool only and does not affect runtime compatibility; old runtimes are covered by the artifact-targeting C-series tests in §6.6 |
| D3 | Unit tests next to sources or in a mirror directory | **Next to sources** (integration and e2e in `test/`) | Better locality — tests move together with files; esbuild bundles only from entries, so tests never enter the artifacts |
| D4 | Whether to introduce Prettier | **No**; use ESLint stylistic to freeze the existing style | Avoids a repo-wide formatting diff destroying blame |
| D5 | Whether N-API converges to a single `request` entry | **Converge** | One method table, one type-generation path; the JSON overhead equals today's (today already passes JSON strings) |
| D6 | Whether `web/` adopts a frontend framework | **No** | See §2.2; store + component conventions achieve the same maintainability while avoiding framework runtime requirements on Chromium 69 |
| D7 | Minimum supported Git version | **2.0**: all read features available, write features tiered by the capability table (the existing thresholds range from 1.7.8 to 2.40) | Covers the vast majority of environments beyond CentOS 7's 1.8.3; if 1.8.x must be supported, C5 needs a self-built image and the CLI read path needs parameter-by-parameter verification |
| D8 | Linux glibc floor | **2.17** | CentOS 7 / RHEL 7 remain common on enterprise Remote-SSH servers; pinning the floor with zigbuild costs nothing extra |
| D9 | Windows 7/8.1 | **The extension supports them, the engine does not** (CLI) | Since Rust 1.78 the MSVC target requires Windows 10; maintaining a tier-3 target for old Windows is not worth it, and the CLI is fully functional |
| D10 | Whether snapshot first paint is on by default; the default of `retainContextWhenHidden` | **Snapshot first paint on by default** (disableable in settings); `retainContextWhenHidden` keeps its current default | Snapshot first paint is the biggest "fast open" win and is backstopped by the "refreshing" marker and consistency checks; retaining context trades memory for speed and stays the user's choice |
| D11 | Whether background prewarming is on by default | **On by default**, at most 3 repositories, starting after 2 s idle | Turns cold opens into hot opens; CPU and memory are capped and it can be disabled |
| D12 | Whether write operations get data-level optimistic updates | **No**; only same-frame pending feedback | git's outcomes (hooks, conflicts, rejections) are unpredictable; optimistic updates followed by rollbacks feel worse; and impact-based refresh already brings refs-only operations to ≤ 100 ms |
| D13 | How the native UI is driven | **`ScriptedUiPort` as primary** (all versions), **Playwright + Electron as supplement** (10–15 cases, on stable only) | Scripted answers run stably on all versions from 1.38 to insiders and cover every branch; real-UI driving depends on VS Code's DOM structure and is fragile across versions — it is used only to validate the glue layer. ExTester is not chosen because it supports only the last few VS Code versions |
| D14 | The E2E executor | **Reuse the existing `AutomationEngine` + catalog**; no Mocha | The 146 actions and the in-page shim already exist and have already handled many real-world timing issues; writing a second Mocha suite would create two duplicate sets of cases |
| D15 | The E2E scope in the PR gate | **smoke + affected, total ≤ 15 minutes**; the full tier runs nightly | Balances feedback speed against coverage; full-tier issues surface the next day and are attributable to that day's merged PRs |

---

## 11. Acceptance Criteria (Definition of Done)

- [ ] Local, CI, and release use the same `npm run build`; `dist/` is the only artifact; the VSIX manifest test passes.
- [ ] The dependency rules of the three projects `src/extension`, `src/webview`, and `src/shared` are all at `error` level and pass; no circular dependencies.
- [ ] No non-generated, non-dictionary file exceeds 600 lines.
- [ ] `dataSource.ts`, `gitGraphView.ts`, `web/main.ts`, `contract.test.mjs`, `check-i18n-parity.cjs`, `package-src.js`, and `package-web.js` are deleted.
- [ ] The protocol handlers and the engine request enum are compiler-guaranteed complete; `src/shared/engine/` is generated from Rust and checked drift-free in CI.
- [ ] `child_process` appears only in `extension/git/process/`; `argSafety` has exactly 1 call site.
- [ ] Tests are layered L0–L4; no test imports build artifacts; no `new Function`; coverage meets the §6.5 thresholds.
- [ ] The L4 smoke runs in CI; the product's built-in automation suite is fully green before release.
- [ ] `engines.vscode` is still `^1.38.0` and `@types/vscode` still 1.38.0; C1–C6 all pass in the release pipeline; `docs/compatibility.md` and the README's "System requirements" match the measurements.
- [ ] The host artifacts pass the Node 10.11 runtime smoke; the webview artifacts pass the `chrome69` es-check, eslint-plugin-compat, and stylelint checks.
- [ ] The Linux gnu binaries' glibc floor is ≤ 2.17, with musl and armhf binaries available; every class of engine unavailability falls back to the CLI and is shown on the settings page.
- [ ] No `(vscode.x as any)`-style API probes in the code; all persisted data carries version fields, with migration samples for every released version.
- [ ] Every §3.8.1 performance budget is met on S/M/L, with the measured data recorded in `docs/performance.md`; P1–P5 gate both merging and releasing.
- [ ] No serial request round trips on the open path (data is pushed by the host); first-paint critical JS ≤ 200 KB; no blocking subprocesses in `activate`.
- [ ] Each write operation refreshes exactly once, and only the affected parts; cancellable requests are wired into the cancellation mechanism; all caches have caps.
- [ ] E2E runs in real VS Code: the PR smoke + affected tiers, the nightly full tier (covering every §6.8.5 environment combination), and the pre-release release tier are all gates.
- [ ] All 8 coverage-matrix dimensions reach 100% (exemptions ≤ 5); all 41 write operations have success and failure scenarios asserting the repository's real state; no native-dialog branch is skipped.
- [ ] The release process contains no manual test steps; the E2E flaky quarantine holds ≤ 3 items, all within their deadlines.
- [ ] `ARCHITECTURE.md`, `CONTRIBUTING.md`, and the ADRs are updated; `GAPS.md` contains no outdated descriptions.

---

## Appendix A · Where the major files go

| Current file | Lines | Destination |
|---|---|---|
| `src/gitGraphView.ts` | 2731 | `extension/graphView/{panel,html,commitLoader,poller,uncommittedStabiliser}.ts` + `handlers/*` + `caches/*` |
| `src/dataSource.ts` | 2617 | `extension/git/{gitRepository,operationState}.ts` + `write/{gitWriter,ops/*,argSafety,lossGuard}.ts` + `process/*` |
| `src/backend/cliBackend.ts` | 1527 | `extension/git/read/cli/*` |
| `src/backend/{api,addon,index,types,signatures}.ts` | ~1700 | `read/{gitReader,nativeReader,addonLoader,fallbackReader}.ts`; `types.ts` replaced by `shared/engine/` (generated) |
| `src/types/messages.ts` | 1191 | `shared/protocol/graphView.ts` |
| `src/types/{git,webview,repoState,…}.ts` | — | `shared/model/*` |
| `src/repoManager.ts` | 1188 | `extension/repos/{repoManager,repoDiscovery,repoConfigFile}.ts` |
| `src/commands.ts` | 840 | `extension/commands/*` |
| `src/config.ts` | 758 | `extension/platform/config.ts` + `shared/model/config.ts` (the snapshot types) |
| `src/comparisonView.ts`, `binaryCompareView.ts` | 862+ | Host controllers: `extension/views/*`; frontends: `webview/comparison`, `webview/binaryCompare` |
| `src/binaryCompare.ts`, `hexDiff.ts` | 1439+867 | Computation → `shared/` (pure functions) or `extension/views/binaryCompare/`; `hexDiff`'s process calls → `GitProcess` |
| `src/gerrit.ts`, `pullRequests.ts`, `avatarManager.ts` | — | `extension/integrations/*` |
| `src/i18n.ts`, `web/strings.ts` | 466+1871 | `shared/i18n/{en,zh-cn}.ts` |
| `src/automation/*` | ~7000 | `extension/automation/*` (injected ports, compile-time switch); `catalog.ts` split by domain |
| `src/utils/*` | — | Pure functions → `shared/util/`; the vscode-dependent ones (`actions`, `disposable`, `event`, …) → `extension/platform/` |
| `web/main.ts` | 3562 | `webview/graph/{main,responses}.ts` + `state/*` + `render/*` + `widgets/*` |
| `web/utils.ts` | 887 | `webview/common/{dom,html,icons,dates,classNames}.ts` |
| `web/graph.ts` | 1010 | `webview/graph/layout/*` (pure computation) + `render/graphSvg.ts` |
| `web/{observers,contextMenuActions,commitDetailsView}.ts` | ~5100 | Split into the respective components |
| `native/core/src/{api,dispatch,types}.rs` | — | `engine.rs`, `protocol.rs`, `model/*` |
| `scripts/package-*.js`, `clean.js` | — | `scripts/build/build.mjs` |
| `scripts/{bench,analyze-log,theme-audit-harness,generate-icons}.mjs` | — | `scripts/dev/` |
| `build-*.bat`, `build-*.sh` | — | `npm run dev:install` |

## Appendix B · Where the existing tests go

| Current test file | Destination | Layer | Disposition |
|---|---|---|---|
| `backends.test.mjs` (1773 lines) | `test/integration/reader/*.contract.test.ts`, split by theme, Native/CLI parameterized | L3 | Slimmed: edge cases overlapping `git_parity.rs` sink to L1 or the CLI parsers' L2 |
| `dispatch.test.mjs` | Delete | — | Covered by the Rust `protocol.rs` tests + the Reader contract suite |
| `signatures.test.mjs` | `git/read/signatures.test.ts` | L2 | Migrate |
| `commands.test.mjs`, `checkoutProtection`, `editCommitMessage`, `fixupSquash`, `worktree`, `commitAuthors` | argv → `git/write/ops/*.test.ts`; loss warnings → `lossGuard.test.ts`; real execution → `test/integration/writer/*.test.ts` | L2 + L3 | Split and dedupe: each write-op class keeps happy + failure in L3 |
| `operationState`, `conflictPrediction`, `reflogDataSource`, `repoStatistics`, `repoChangeSignature` | `*.test.ts` next to the corresponding module (those needing real repositories go to L3) | L2/L3 | Migrate |
| `gerrit`, `pullRequests` | `integrations/*/**.test.ts` | L2 | Migrate |
| `gitGraphView`, `uncommittedStabiliser`, `webviewConfigStaleResponse` | `graphView/{handlers,commitLoader,uncommittedStabiliser}.test.ts` | L2 | Migrate, driven by fake contexts |
| `extensionHost`, `mobileAdaptationDefault`, `repoFileWatcher` | `extension/main.test.ts` (fake vscode, logic branches only) + L4 scenarios (activation, panel restore, watching external changes) | L2/L4 | Merge |
| `contract.test.mjs` | The protocol part is deleted (compiler-guaranteed); the commands and icons parts merge into `commands/registry.test.ts` | L0/L2 | Merge |
| `contributedMenus.test.mjs` | Merge into `commands/registry.test.ts` | L2 | Merge |
| `i18n.test.mjs` | Key consistency guaranteed at compile time; keep the formatting and language-switch cases → `shared/i18n/format.test.ts` | L0/L2 | Slim |
| `utils.test.mjs` | Split by owning function into `shared/util/*.test.ts` | L2 | Split |
| `hexDiff`, `binaryCompare`, `imageDiff` | Computation → pure-function tests; frontend → `webview/binaryCompare/*.test.ts` (module imports, no `new Function`) | L2 | Rewrite the entry points, keep the cases |
| `markdownRenderer`, `reflogClassification` | `webview/**/` module tests | L2 | Rewrite the entry points |
| `webviewSeamlessUpdate`, `webviewRowCoordinates`, `webviewScrollWindow`, `webviewRealPipeline(+Harness)`, `webviewGraphDimensions` | `test/integration/webview/journeys.test.ts` (3–5 journeys) + `render/commitTable.test.ts` (the virtualization window math) | L3 + L2 | Merge: the scrolling/coordinate math sinks into pure-function unit tests |
| `webviewMobileAdaptation`, `webviewAuthorIdentity`, `webviewConfigChanged`, `webviewTools` | Corresponding component tests | L2 | Migrate |
| `dropdownKeyboardNav`, `dropdownInfoClick`, `dialogValidationTooltip`, `helpTooltip`, `repoDropdown` | `widgets/{dropdown,dialog}.test.ts` | L2 | Merge into 2 files |
| `automation*.test.mjs` (6) | `extension/automation/*.test.ts`; packaging-related → `test/tooling/` | L2 | Migrate; slim `automationPackaging` with the 6.2 rework |
| `scripts/automation/full-test.mjs`, `fixture.mjs` | `test/e2e/{launcher,entry}.ts`; fixture generation merges into `test/support/repoBuilder.ts` (shared by the P series and E2E) | L4 | Switched to run in real VS Code (tasks 0.6, 1.10) |
| `src/automation/catalog.ts` (146 actions) | `src/extension/automation/scenarios/<domain>.ts`, grown from actions into scenarios (`given` / `when` / `answers` / `then`) | L4 | Upgrade; the coverage matrix fills in the missing scenarios (4.10, 6.4) |
| `buildLock`, `tooling` | `test/tooling/` | Tooling | Migrate; update alongside the build scripts |
| `fuzz.test.mjs` | Split into property tests next to each parser (fixed seeds) | L2 | Split |
| `webviewHarness.mjs`, `vscodeStub.mjs` | `test/support/{webviewHost,fakeVscode}.ts` | — | Rewrite as typed utilities |
| `browserRepro/` | Delete (Phase 0) | — | — |
| Rust `tests/*.rs` | Keep; `dispatch.rs` → table-driven `protocol`; pure-function cases sink into the modules | L1 | Minor tidy-up |

## Appendix C · New-feature checklists (end state, written into CONTRIBUTING.md)

**Adding a webview request**
1. Add an entry (request, response) to `GraphViewRequests` in `shared/protocol/graphView.ts`.
2. Implement the handler in the matching `extension/graphView/handlers/<domain>.ts` (the compiler flags the gap); mark `mutates: true` if needed.
3. Register the response handling in `webview/graph/responses.ts` (the compiler flags the gap), and issue the request from a component via `bridge.send`.
4. Tests: handler unit tests (L2); if there is UI, add component tests (L2).

**Adding an engine read method**
1. Add a variant to `Request` in `native/core/src/protocol.rs` and implement it in `engine.rs`.
2. Run `cargo test` to regenerate `src/shared/engine/`.
3. Add the method to the `git/read/gitReader.ts` interface; the Native adapter picks it up automatically; the CLI adapter implements it (or explicitly declares it unsupported).
4. Tests: Rust integration tests + `git_parity` (L1); 1–3 Reader contract cases (L3).

**Adding a write operation**
1. Write `(params) => WriteOp` in `git/write/ops/<domain>.ts`; if the Git parameters used exceed D7's floor, register them in `capabilities.ts` and declare `requires` on the op.
2. Call `ctx.repo.write(op)` in the handler.
3. Tests: table-driven argv cases (L2); if a new failure mode is involved, add 1 real-repository case in L3; if there is a version threshold, add above/below cases in the capability table.

**Using a newer platform capability** (VS Code API, Node API, DOM API, CSS feature)
1. First check whether it is available in the §3.7.1 floor environment; if yes, use it directly (the toolchain confirms automatically).
2. If not: VS Code APIs go into `platform/vscodeCompat.ts`; Node/DOM APIs go into `shared/util/compat.ts`; CSS gets a fallback declaration first. All three cases must document the degraded behavior.
3. Tests: one case per compat function in each of the "capability present / capability absent" fake environments; register the degraded behavior in `docs/compatibility.md`.

**E2E checklist when adding a feature**
1. Write ≥ 1 scenario in `automation/scenarios/<domain>.ts`, tagged with the domain; add the `smoke` tag for critical-path features.
2. Write operations: write both success and failure scenarios, asserting the repository's real state in `then.git`.
3. Native UI popups: go through `UiPort`, with `answers` for every branch.
4. New controls carry `data-action`; new commands, menus, settings, and requests need no manual registration — the coverage matrix discovers the missing scenarios automatically.
5. Run it locally with `npm run test:e2e -- --grep <id>` before submitting.

**Performance checklist when adding a feature**
1. Is it on the first-paint path? If so, it must be deferred past first paint, or proven not to affect T5 (with P3/P4 data attached).
2. Is its code loaded on demand? Webview features use `import()`; host features `require` on first use.
3. Are its requests cancellable? Does its cache have a cap? Are its expensive operations marked?
4. If it is a write operation, is the `effects` declaration accurate? Could it trigger redundant refreshes?
5. Tests: add a corresponding scenario in P2 or P3 and confirm the U9 regression gate is not triggered.

**Adding a persisted field** (setting, state, repository config file)
1. Add only, never remove; for renames or format changes, add a step in `migrations` and bump `version`.
2. Add a sample for the current version under `test/fixtures/user-data/`; the round-trip tests cover it automatically.




