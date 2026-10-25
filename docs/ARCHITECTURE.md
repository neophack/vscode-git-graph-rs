# Architecture

This document describes the repository **as it is now**, after the first waves of the refactor
documented in `docs/REFACTOR-PLAN.md` (Phase 0 baseline/cleanup and the Phase 1 engineering
foundation, plus the early Phase 4/5 extractions). The plan remains the description of the
*end state*; this file is kept in sync with the tree as each wave lands (goal U8). Where a
subsystem is still mid-migration, that is said explicitly rather than papered over.

## 1. Top-level layout

```
.
├── src/                     # TypeScript sources (see §2)
├── native/                  # Rust workspace members (see §3)
│   ├── core/                #   git-graph-core: the pure-Rust engine
│   ├── node/                #   git-graph-node: the N-API binding crate
│   └── <platform>/          #   built git-graph.node binaries (gitignored, six platforms max)
├── tests/                   # The legacy Node test suite (*.test.mjs) + fixtures (see §7)
├── scripts/
│   ├── build/               # build.mjs (dist pipeline), webview.mjs, compat.mjs, es2018.mjs
│   ├── dev/                 # install.mjs: the cross-platform build+package+install chain
│   └── ...                  # packaging, bench, automation and audit tooling (pre-migration)
├── docs/                    # REFACTOR-PLAN.md (the plan), this file, ADRs, references
├── resources/               # Icons and static assets shipped in the VSIX
├── media/                   # Compiled webview bundles (gitignored build output)
├── out/                     # Compiled extension host (gitignored, the v1.0 pipeline's output)
├── dist/                    # Bundled host + askpass (gitignored, the new pipeline's output)
├── Cargo.toml               # Workspace: native/core + native/node
├── package.json             # npm scripts, VS Code extension manifest
└── vitest.config.ts         # The colocated unit-test suite (src/**/*.test.ts)
```

## 2. The `src/` tree

`src/` carries the **new layered tree** plus the remaining flat v1.0 host files. Most of the
flat half has been migrated: the files listed in §2.4 as shims are compatibility re-exports
kept only so legacy imports and the out/-compiled tests keep working; they drain as callers
move. Nothing new should be added to `src/*.ts`.

### 2.1 `src/extension/` — the extension host layer (Node + vscode)

| Directory | Contents |
|---|---|
| `extension/git/` | The git access layer: `process/` (GitProcess + errors), `executable/` (git capability detection), `read/gitReader.ts` (the backend contract + Native adapter), `read/addonLoader.ts` (binary location/loading), `read/backendIndex.ts` (createBackend + fallback routing), `read/cli/` (the CLI reader split by theme: log, details, files, config, parse/*), `read/fallbackReader.ts`, `read/signatures.ts`, `write/` (gitWriter, lossGuard, argSafety, `ops/`), `gitRepository.ts`, `operationState.ts` |
| `extension/graphView/` | The main view's host side (task 4.4): `panel.ts` (lifecycle, snapshot restore, orphaned tabs, message routing via the handler table), `html.ts` (HTML shell + CSP/nonce), `panelContext.ts` (the port wiring behind HandlerContext), `poller.ts`, `pullRequestFetch.ts`, `globalSettings.ts`, `orphanedTabs.ts`, `commitLoader.ts`, `gerritSelection.ts`, `gerritPipeline.ts`, `uncommittedStabiliser.ts`, `caches/`, `handlers/` (the exhaustive per-request handler table, §5) |
| `extension/platform/` | The vscode adapters: `vscodeCompat.ts` (version-optional APIs), `config.ts` (+ ConfigSnapshot), `storage.ts` (globalState), `logger.ts`, `notifications.ts`, `terminal.ts`, `clipboard.ts`, `uiPort.ts` |
| `extension/repos/` | `repoManager.ts` + the split-out `repoConfigFile.ts` (the `.vscode/git-graph-rs.json` seam) and `repoDiscovery.ts`, `repoFileWatcher.ts` |
| `extension/views/` | Host controllers for the auxiliary panels: `comparison/viewController.ts`, `binaryCompare/` (viewController, binaryCompare, hexDiff + hexDiffSources), `diffDocProvider.ts` (frontends live in `webview/`) |
| `extension/integrations/` | `gerrit/` (gerrit + gerritProtocol), `pullRequests.ts`, `avatars/avatarManager.ts` (+ avatarQueue) |
| `extension/commands/` | The declarative command registry and the command manager (task 4.6): registry, commandManager, per-domain command modules |
| `extension/statusBar.ts` | The status bar item |

### 2.2 `src/webview/` — the webview frontends (DOM; no vscode, no Node)

| Directory | Contents |
|---|---|
| `webview/common/` | Shared webview code: `host/bridge.ts` (the HostBridge — the only `acquireVsCodeApi` caller), `protocol.ts` (the type seam), `html.ts`/`dom.ts` (the SafeHtml DOM-write discipline), `i18n/` (re-export of `shared/i18n`), dates, icons, helpTooltip, ... |
| `webview/graph/` | The main graph view, mid-modularization of the v1.0 `main.ts`: `main.ts` + `responses.ts`, `state/`, `render/`, `layout/`, `widgets/`, `actions/`, `commitDetails/`, `controlBar/`, `input/`, `integrations/` (gerrit, pullRequests), `loading/`, `text/`, `context.ts` |
| `webview/comparison/` | The commit-comparison view (typed protocol in `shared/protocol/comparison.ts`) |
| `webview/binaryCompare/` | The binary-compare view (hex grid, image view; protocol in `shared/protocol/binaryCompare.ts`) |
| `webview/styles/` | Stylesheets by component, including `comparison.css` / `binaryCompare.css` |

### 2.3 `src/shared/` — isomorphic code (no vscode, no DOM, no Node)

| Directory | Contents |
|---|---|
| `shared/protocol/` | The typed view protocols: `graphView.ts` (RequestCommand/ResponseCommand unions over the request/response types), `comparison.ts`, `binaryCompare.ts` |
| `shared/engine/` | `protocol.ts` — **generated from Rust via ts-rs; never hand-edit**. Regenerate with `cargo test -p git-graph-core --test protocol` |
| `shared/i18n/` | The single dictionary pair (`en.ts`, `zh-cn.ts`) shared by host and webview, `format.ts`, and the NLS parity test |

### 2.4 The flat legacy host files

What is still real at `src/*.ts`: `extension.ts` (the entry point), `dataSource.ts` (the
repository facade every reader goes through — its retirement onto `git/gitRepository.ts` is
the remaining task 3.6 work), plus the `askpass/`, `automation/`, `types/` (the v1.0
protocol/domain types the typed protocols are derived from) and `utils/` subtrees.
Everything else at the flat root is now a **compatibility shim** re-exporting its migrated
home: `gitGraphView.ts` → `extension/graphView/panel.ts`, `commands.ts` →
`extension/commands/`, `repoManager.ts` / `repoFileWatcher.ts` / `statusBarItem.ts` →
`extension/repos/` + `extension/statusBar.ts`, `config.ts` / `extensionState.ts` /
`logger.ts` → `extension/platform/`, `gerrit.ts` / `pullRequests.ts` / `avatarManager.ts`
→ `extension/integrations/`, `comparisonView.ts` / `binaryCompare.ts` /
`binaryCompareView.ts` / `hexDiff.ts` / `diffDocProvider.ts` → `extension/views/`,
`backend/` → `extension/git/read/`, and `i18n.ts` → `shared/i18n`. The shims exist so the
out/-compiled legacy test suite keeps importing the old paths; they drain as the suite does.

`legacy/` (the frozen v1.0 snapshot the migration started from) has been drained and removed;
`git log --follow` reaches the pre-migration history through the renames.

## 3. `native/` — the Rust engine

- **`native/core` (crate `git-graph-core`)** — the pure engine, built on `gix`, with no Node or
  VS Code dependency: graph walking, refs, details, diff, status, stash, stats, config, text
  decoding, Gerrit NoteDb meta parsing. `protocol.rs` + ts-rs generate
  `src/shared/engine/protocol.ts` in `cargo test`, so the cross-language wire types have one
  source of truth.
- **`native/node` (crate `git-graph-node`)** — the thin N-API binding exposing the engine's
  answer surface as `#[napi]` functions.
- **`native/<platform>/git-graph.node`** — per-platform build outputs (`win32-x64-msvc`,
  `win32-arm64-msvc`, `linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`, `darwin-arm64`),
  built by `scripts/build-addon.mjs` (host build, or cross builds through cargo-zigbuild /
  cargo-xwin). The universal VSIX bundles every binary that is present; per-platform VSIXs
  carry exactly one. Where a platform's binary is missing, the extension falls back to the
  `git` CLI backend — a cost in speed, not in function.

## 4. The backend abstraction

`src/backend/` owns the `GitBackend` interface and the choice of implementation:

- `addon.ts` locates and loads the platform's `git-graph.node`;
- `api.ts` defines `NativeBackend` (the engine over N-API) and the `GitBackend` contract;
- `cliBackend.ts` implements the same contract over the `git` CLI;
- `index.ts` provides `createBackend()`: it prefers the engine and routes calls the engine
  declines (`Unsupported`) to the CLI fallback (`extension/git/read/fallbackReader.ts`), so a
  call is served by whichever backend can answer. The extension also loads and works with no
  `git` installed at all; write operations then report that they need Git.

`DataSource` (`src/dataSource.ts`) is the facade the view layer talks to; it delegates every
read to the backend and runs the 41 write operations over the CLI (the engine write path is
future phases — see `GAPS.md`).

## 5. Data flow

The main graph view round trip:

```
webview (src/webview/graph/**)
    │  user action → HostBridge.send(RequestMessage)
    ▼                       src/webview/common/host/bridge.ts (the only acquireVsCodeApi caller)
extension host
    │  panel.onDidReceiveMessage → request dispatch
    │      today: the message switch in src/gitGraphView.ts
    │      target: HANDLER_TABLE (src/extension/graphView/handlers), one handler per
    │              RequestCommand, exhaustiveness checked by `satisfies`; handlers touch the
    │              world only through HandlerContext ports (wiring into the live panel is the
    │              in-flight task 4.4)
    ▼
DataSource (src/dataSource.ts) — repository facade, config, avatars, follow-up ordering
    ▼
GitBackend (src/backend) — engine call, with Unsupported → CLI fallback
    ▼
native/node (N-API) ──► native/core engine (gix)      or      `git` CLI (extension/git/process)
    ▼
ResponseMessage ── back through the bridge ──► webview responses.ts → state → render
```

The comparison and binary-compare views are the same shape with their own typed protocols
(`shared/protocol/comparison.ts`, `shared/protocol/binaryCompare.ts`) and webview trees; their
host halves are the legacy `comparisonView.ts` / `binaryCompareView.ts` until they migrate.

Gerrit sits across the seam: `src/gerrit.ts` on the host (change-ref parsing, fetch scheduling,
`GerritDataSource`), `src/webview/graph/integrations/gerrit.ts` in the view (change badge,
review info dialog), and the engine's NoteDb meta parsing in `native/core/src/gerrit.rs`.

The automation subsystem (`src/automation/`) is an optional in-process test runner: the default
packaging excludes it (`scripts/package-without-automation.mjs`), the automation build ships it
(`package:automation`), and the host requires it inside a try/catch so its absence is a
non-feature, not an error.

## 6. Build pipelines

The `dist/` pipeline is the packaging pipeline (task 1.4): `package.json#main` points at
`./dist/extension.js`, and local, CI and release all package the same artifact through it.
`npm run package` / `npm run package:automation` build the bundle first
(`scripts/automation-packaging.mjs` → `scripts/build/build.mjs --production`) and then run vsce
against the `.vscodeignore` allowlist, which re-includes exactly: `dist/extension.js`,
`dist/askpass/**`, the webview bundle and vendored libraries under `media/`, the static
resources under `resources/`, `licenses/**`, `native/**/git-graph.node`, the package/nls
manifests and `LICENSE`. The automation variant (`dist/automation/extension.js` as `main`) is
the same chain with `__AUTOMATION__` defined truthy plus a temporary manifest/allowlist patch
during its vsce run — nothing is substituted on disk any more.

| | The `dist/` pipeline (what ships) | The legacy `out/` pipeline (tests only) |
|---|---|---|
| Command | `npm run build:dist` / `npm run package` (`scripts/build/build.mjs`) | `npm run compile-src`, or `npm run build:ts` (kept for the legacy suite; `npm run build` still appends it) |
| Host output | `dist/extension.js` (esbuild, one file on the **node10.11** target; only `vscode` and `original-fs` stay external) | `out/**` (tsc, per-file, + `package-src.js` text rewriting) |
| Askpass | `dist/askpass/*.sh` (launchers) and `askpassMain.js` | `out/askpass/` + `package-src.js` rewrites |
| Webview | `media/out.min.{js,css}` + `media/vendor/*` (`scripts/build/webview.mjs`, chained after the host build; kept at `media/` this wave) | same webview bundle |
| Compatibility gate | `scripts/build/compat.mjs` scans the artifacts and fails the build on post-ES2018 syntax (the es2018 promise, VS Code 1.38 floor) | — |

The `out/` tree survives only as the legacy test suite's import target (`tests/*.test.mjs`
still require `../out/*.js`), which is why CI's integration job still runs `compile-src` after
the dist build and `npm run build` appends `build:ts`; both drain with the suite and disappear
in Phase 7. `tests/distBuild.test.mjs` guards the dist pipeline's shape, and its
`vsce ls`-based manifest test asserts the VSIX contents contract (dist + media + resources, no
src/, no `*.ts`, no `out/`). CI additionally runs `scripts/build/check-binary-compat.mjs` with
`BINARY_COMPAT_REQUIRED=1` on every engine it builds (glibc / minos / static-CRT floors).

`node scripts/dev/install.mjs` is the developer entry point for the full chain (deps → native
addon → compile → tests → VSIX → install into VS Code; `--full`/`--only` build the engine's
cross targets, `--dry-run` prints the steps).

## 7. Tests

- **Colocated unit tests** — `src/**/*.test.ts`, run by Vitest (`npx vitest run`) straight
  against TypeScript sources, no build step. New unit tests go here, next to their module.
- **Legacy suite** — `tests/*.test.mjs` under `node:test`, run by `npm run test:node`
  (`scripts/run-tests.mjs`) against build outputs (`out/`, `media/`); a build is required
  first. Drained as coverage moves into Vitest; deleted in the plan's Phase 7.
- **Rust** — `cargo test --workspace` (`npm run test:rust`): engine tests, parity tests
  against real `git`, and the ts-rs type generation.
- `npm test` runs Rust + Node; `npm run lint` is `cargo clippy -D warnings` + `cargo fmt
  --check` (the TS lint toolchain lands with task 1.6/1.8).

## 8. Dependency rules

The target rules (REFACTOR-PLAN §3.6), enforced going forward by dependency-cruiser as each
directory's migration completes:

```
shared/**           → may import only shared/**
webview/**          → webview/**, shared/**; node:*, vscode forbidden
extension/git/**    → extension/git/**, shared/**, node:*; vscode, graphView/**, platform/** forbidden
extension/graphView/handlers/** → must not import graphView/panel.ts (only via HandlerContext)
extension/platform/** → the only vscode entry point (views/, commands/ and graphView/panel.ts
                        may use vscode UI types directly)
any directory       → circular dependencies forbidden; importing test/** forbidden
```

Today the rules hold inside the new trees (`src/webview` reaches the host only through the
type seam `common/protocol.ts`; the handler modules import neither `vscode` nor the legacy
view); the flat `src/*.ts` files are exempt until they migrate, which is why the cruiser
baseline starts at `warn`.

## 9. What is still legacy (the honest list)

- The flat `src/*.ts` host files (§2.4) — `extension.ts`, `gitGraphView.ts`, `dataSource.ts`,
  `commands.ts` and the rest — including the view's message switch, which the handler table
  replaces as task 4.4 wires it in.
- The `out/` + `package-src.js` tsc pipeline (§6) — no longer packaged anywhere, but still
  built (`compile-src` / `build:ts`) as the legacy test suite's import target until Phase 7.
- The `tests/*.test.mjs` legacy suite and its harnesses (`webviewHarness.mjs`,
  `webviewRealPipelineHarness.mjs`, `vscodeStub.mjs`).
- The loose `scripts/*.mjs` packaging/bench/audit tooling that the plan consolidates into
  `scripts/{build,release,dev}/`.
