# Architecture

This document describes the repository **as it is now**: the refactor waves through the host
and webview rework, the operate/render performance passes (tasks 4.8–4.10, 5.9–5.10), the
native surface shrink (2.6), the test-system drain (7.1) and the tooling that grew around
them. `docs/REFACTOR-PLAN.md` remains the plan of record; where the two disagree, this file
describes the tree.

## 1. Top-level layout

```
.
├── src/                     # TypeScript sources (see §2)
├── native/                  # Rust workspace members (see §3)
│   ├── core/                #   git-graph-core: the pure-Rust engine
│   ├── node/                #   git-graph-node: the N-API binding crate
│   └── <platform>/          #   built git-graph.node binaries (gitignored, six platforms max)
├── test/                    # Cross-module tests (see §7): support/, integration/, tooling/,
│                            #   perf/ (P2/P3/P5), e2e/ (real VS Code), compat/, fixtures/
├── scripts/
│   ├── build/               # build.mjs (the dist pipeline), webview.mjs (the split bundle),
│   │                        #   compat.mjs + es2018.mjs (artifact syntax gates), check-binary-compat.mjs
│   ├── dev/                 # install.mjs, baseline.mjs, theme-audit.mjs (+ pages/themes), coverage-matrix.mjs
│   └── ...                  # packaging, addon build, automation packaging, log analysis
├── docs/                    # REFACTOR-PLAN.md, this file, ADRs, compatibility/performance/baselines
├── resources/               # Icons and static assets shipped in the VSIX
├── media/                   # Compiled webview bundles (gitignored build output)
├── dist/                    # Bundled host + askpass (gitignored, the only packaging input)
├── Cargo.toml               # Workspace: native/core + native/node
├── package.json             # npm scripts, VS Code extension manifest
└── vitest.config.ts         # Colocated unit tests + test/integration + test/tooling
```

There is no `tests/` legacy suite, no `legacy/` snapshot and no `out/` build step any more
(the 7.1 drain deleted them; `npm run build:ts` survives standalone only because
`test/perf/lib/env.mjs` loads compiled sources — it is no longer part of `npm run build`).

## 2. The `src/` tree

### 2.1 `src/extension/` — the extension host layer (Node + vscode)

| Directory | Contents |
|---|---|
| `extension/git/` | The git access layer: `process/` (GitProcess + errors), `executable/` (capabilities), `read/gitReader.ts` + `addonLoader.ts` + `backendIndex.ts` (createBackend: engine preferred, CLI fallback via `fallbackReader.ts`), `read/cli/` (the CLI reader split by theme), `write/` (gitWriter, lossGuard, argSafety, `ops/` — every op declares `effects`), `gitRepository.ts` (the facade), `operationState.ts` |
| `extension/graphView/` | The main view's host side: `panel.ts` + `html.ts`, `panelContext.ts`, `commitLoader.ts` (open-path push, staged follow-ups), `impactRefresh.ts` (task 4.8: minimal refresh per WriteOp effects — refs-only reads run Refs+Annotate, no traversal), `scheduler.ts` (interactive-first, background concurrency 1, same-kind supersession), `poller.ts`, `uncommittedStabiliser.ts`, `caches/`, `handlers/` (the exhaustive per-request handler table), `writeFlows.ts`, gerrit pipeline/selection |
| `extension/platform/` | The vscode adapters: `vscodeCompat.ts`, `config.ts`, `storage.ts` (+ versioned migrations), `logger.ts`, `notifications.ts`, `terminal.ts`, `clipboard.ts`, the `UiPort` |
| `extension/repos/` | `repoManager.ts`, `repoConfigFile.ts`, `repoDiscovery.ts`, `repoFileWatcher.ts`, `prewarm.ts` (task 4.9) |
| `extension/views/` | Host controllers: `comparison/viewController.ts`, `binaryCompare/`, `diffDocProvider.ts` |
| `extension/integrations/` | `gerrit/`, `pullRequests.ts`, `avatars/` |
| `extension/commands/` | The declarative registry + command manager + per-domain modules |
| `extension/statusBar.ts` | The status bar item |

### 2.2 `src/webview/` — the webview frontends (DOM; no vscode, no Node)

| Directory | Contents |
|---|---|
| `webview/common/` | `host/bridge.ts` (the only `acquireVsCodeApi` caller), `html.ts`/`dom.ts` (SafeHtml), `i18n/`, dates, icons, `onDemandStyles.ts` (task 5.9's lazy CSS kicker) |
| `webview/graph/` | The main view: `main.ts` (≤150 lines), `responses.ts` (the response router), `state/` (store, persistence, `firstPaint.ts` — the D10 snapshot), `render/` (commitTable, viewport, scheduler — one coalesced pass per frame, `measure.ts`), `layout/`, `widgets/` (lazy facades for the on-demand surfaces), `loading/` (repoLoader), `actions/`, `commitDetails/`, `controlBar/`, `input/`, `integrations/` |
| `webview/comparison/`, `webview/binaryCompare/` | The auxiliary views (typed protocols in `shared/protocol/`) |
| `webview/styles/` | Per-component stylesheets; `onDemand.ts` is the dynamically-imported widget CSS chunk |

The first paint loads only the entry chunk (`media/out.min.js`, ES modules, Chromium 69
floor): the table, graph and control bar. Everything else — markdown rendering, the settings/
statistics/reflog/worktree/find widgets, the detail panes' extra CSS — loads via dynamic
`import()` and is prefetched when idle (task 5.9). `media/out.testbundle.js` is the single-file
IIFE twin (same graph, imports inlined) that the jsdom suites execute.

### 2.3 `src/shared/` — isomorphic code (no vscode, no DOM, no Node)

`shared/protocol/` (the typed view protocols; `graphView.ts` also carries the per-command
`WRITE_EFFECTS` fallback table of task 4.8), `shared/engine/` (**generated from Rust via
ts-rs; never hand-edit**; regenerate with `cargo test -p git-graph-core --test protocol`),
`shared/i18n/` (the single dictionary pair), `shared/util/`.

### 2.4 The flat `src/*.ts` files

The files still at the flat root are **live production code**, not shims: `extension.ts` (the
esbuild entry and composition root), `config.ts`, `extensionState.ts`, `logger.ts`,
`i18n.ts`, `commands.ts`, `statusBarItem.ts`, `avatarManager.ts`, `diffDocProvider.ts`,
`askpass/`, `automation/` (the in-process runner, catalog and scenario library — packaged only
in the automation build), `types/` (the domain types the typed protocols derive from) and
`utils/`. Every compatibility shim (gitGraphView, dataSource, backend/, gerrit, comparisonView,
binaryCompare*, hexDiff, repoManager, repoFileWatcher, pullRequests) has been deleted together
with its last importer.

## 3. `native/` — the Rust engine

- **`native/core` (crate `git-graph-core`)** — the pure engine on `gix`. The public surface is
  exactly `Engine` (+`GraphOptions`), the `protocol` module (the typed request enum +
  `cancel/close/close_all/open_count` entries), the `model` types and `Error`; `read/`,
  `repository/` and `cancel/` are `pub(crate)` (task 2.6; the one documented exception is the
  `#[doc(hidden)]` incremental-store control the property tests and benches need).
  `protocol.rs` + ts-rs generate `src/shared/engine/protocol.ts` in `cargo test`.
- **`native/node` (crate `git-graph-node`)** — the thin binding: open/close/closeAll/openCount/
  engineVersion/request/requestBytes/cancel, everything over the typed protocol.
- **`native/<platform>/git-graph.node`** — per-platform outputs; a missing binary degrades to
  the CLI backend (speed, not function).

## 4. The backend abstraction

The read plane lives in `extension/git/read/`: `addonLoader.ts` locates and loads the engine
binary (with failure classification and the N-API preflight), `gitReader.ts` defines the
backend contract and the Native adapter, `cli/` implements it over one `GitProcess`, and
`backendIndex.ts`'s `createBackend()` prefers the engine and routes `Unsupported` answers to
`fallbackReader.ts`. Write operations run exclusively through `write/gitWriter.ts` (argSafety
→ GitProcess → error mapping → the repository-changed event that feeds task 4.8's impact
refresh). The facade the view and commands talk to is `git/gitRepository.ts` — `DataSource`
and `src/backend/` are gone.

## 5. Data flow

```
webview (src/webview/graph/**)
    │  user action → HostBridge.send(RequestMessage)
    ▼
extension host
    │  panel.onDidReceiveMessage → HANDLER_TABLE (graphView/handlers, exhaustive `satisfies`,
    │  per-handler `mutates`), handlers touch the world only through HandlerContext ports
    ▼
GitRepository facade (read via createBackend, write via GitWriter) → impact refresh
    ▼
native/node (N-API, typed protocol, cancellable) ──► engine (gix)   or   `git` CLI (GitProcess)
    ▼
ResponseMessage / pushed partial updates ──► webview responses.ts → store → ONE coalesced
render pass per frame (render/scheduler.ts); after a write the webview waits for the host's
impact refresh instead of self-refreshing
```

The open path is host-pushed (task 4.7): while the panel is created, `CommitLoader.loadView`
runs in parallel; on `ready` the host pushes the merged result; a previous session's snapshot
may already be on screen (D10, `state/firstPaint.ts`), marked refreshing until the push
reconciles it by hash.

The automation subsystem (`src/automation/`) is the in-process runner behind the E2E tiers:
the catalog (actions), the scenario wrapper (given/when/answers/then with `GitStateProbe`
git-state assertions), `ScriptedUiPort` (native-dialog answers), and the suite runner —
packaged only in the automation build (`--automation` define), loadable as libraries by
`test/e2e`.

## 6. Build pipelines

One pipeline. `package.json#main` is `./dist/extension.js`; `npm run build` =
`build:native` → `build:dist --production` (esbuild: host single file on the **node10.11**
target, webview ESM split on **chrome69**, askpass copied) with the artifact syntax gates
(`scripts/build/compat.mjs`, es-check) failing the build on post-ES2018 syntax.
`npm run package` / `package:automation` bundle first and run vsce against the
`.vscodeignore` allowlist (`--no-dependencies`: the VSIX never ships node_modules).
`build:ts` (plain tsc → `out/`) remains a standalone helper for `test/perf`'s compiled-source
loading only. CI runs `scripts/build/check-binary-compat.mjs` with `BINARY_COMPAT_REQUIRED=1`
on every engine it builds (glibc/minos/static-CRT floors).

## 7. Tests

| Layer | Where | Runner |
|---|---|---|
| Unit (colocated) | `src/**/*.test.ts` | Vitest (`npx vitest run`), no build step |
| Integration | `test/integration/**` (reader contracts per adapter leg, webview jsdom journeys on `out.testbundle.js`, pipeline suites composing the real facade, host, views, gerrit, fuzz) | Vitest |
| Tooling | `test/tooling/**` (dist/VSIX/automation-packaging/binary-compat/coverage-matrix/icons contracts) | Vitest |
| Performance | `test/perf/**` — P2 (host pipeline, engine + CLI), P3 (real-Chromium rendering), P5 (sizes) with the `run.mjs` record/compare gate | Plain node (`npm run perf`) |
| E2E | `test/e2e/**` — real VS Code via @vscode/test-electron, smoke/affected/full tiers, scenario catalog + ScriptedUiPort + GitStateProbe | `npm run test:e2e` |
| Rust | `native/core` in-module + `tests/` (git parity is the authority) + criterion benches | `cargo test` / `cargo bench` |
| Compatibility | `test/compat/**` (artifact syntax, runtime smoke) + CI container/matrix jobs | Plain node + CI |

`npm test` runs Rust + Vitest. `npm run lint` = cargo clippy `-D warnings` + fmt + eslint +
stylelint + dependency-cruiser (against the ratchet baseline).

## 8. Dependency rules

The §3.6 target rules, enforced by dependency-cruiser: `shared/**` imports only `shared/**`;
`webview/**` never touches `node:*`/`vscode`; `extension/git/**` never touches
`vscode`/`graphView`/`platform`; handlers never import `panel.ts`; `platform/**` is the only
vscode entry point (with the documented exceptions for views/commands/panel); no cycles, no
test imports. The flat `src/*.ts` live files remain the last exemption pocket, shrinking as
their subtrees finish moving.

## 9. What is still transitional (the honest list)

- The flat live files of §2.4 (`types/`, `utils/`, `config.ts`, …) are production code that
  simply has not moved into `extension/` yet; nothing depends on their position but imports.
- `test/perf` still loads `out/` compiled sources (hence the standalone `build:ts`).
- The E2E full tier, the release-tier environment matrix and the C3–C6 container legs are CI
  machinery that runs only in GitHub Actions; their workflows mirror verified local commands
  and expect first-run iteration.
- Gerrit/PR row badges still ride the first-paint entry (moving them needs an async badge
  path); ADR-0005 records the recalibrated first-paint closure budget.
