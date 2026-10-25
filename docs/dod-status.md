# Definition of Done — status

REFACTOR-PLAN §11, item by item, as of 2026-10-26 (dev-refactor after the drain). Evidence
commands are runnable on a clean checkout; anything not yet held says so plainly.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | One `npm run build`; `dist/` the only artifact; VSIX manifest test green | **held** | `npm run build` = native + dist(--production); `npm run package` green; `test/tooling/distBuild` (allowlist contract) green |
| 2 | Dependency rules at `error`, no cycles | **held with one pocket** | `npm run lint:deps` clean vs the ratchet baseline; the flat live `src/*.ts` files are the last exempt pocket (ARCHITECTURE §8) |
| 3 | No non-generated file > 600 lines | **held** | spot-check: `commitTable.ts` exactly 600; dictionaries/generated excluded |
| 4 | `dataSource.ts`, `gitGraphView.ts`, `contract.test.mjs`, `check-i18n-parity.cjs`, `package-src.js`, `package-web.js` deleted | **held** | `git ls-files` — none exist; deleted with the 7.1 drain and the 3.6 close-out |
| 5 | Handler table + engine enum compiler-complete; `src/shared/engine/` generated, drift-checked | **held** | `satisfies` table; `cargo test` regenerates and CI checks `git diff --exit-code src/shared/engine` |
| 6 | `child_process` only in `extension/git/process/`; argSafety 1 call site | **held** | grep + depcruise rule |
| 7 | Tests layered L0–L4; no artifact imports; no `new Function`; coverage thresholds | **mostly held** | the legacy suite is gone (drain commit carries the 40-row mapping); coverage thresholds remain a CI-side setting (§6.5 ratchet to configure in the coverage job) |
| 8 | L4 smoke in CI; automation suite green pre-release | **machinery ready, CI pending** | `npm run test:e2e` verified locally (docs/e2e-baseline.md); `.github/workflows/e2e.yml` not yet executed by Actions |
| 9 | `engines.vscode` ^1.38.0; @types/vscode 1.38.0; C1–C6 pass in release pipeline | **floors held; matrix CI-side** | es2018/es-check/stylelint/compat gates in every build; C2 runtime smoke script exists; C3–C6 run only in Actions |
| 10 | Host artifacts pass Node 10.11 smoke; webview chrome69 checks | **gates in build** | compat.mjs + es-check run per build; the Node 10.11 runtime job is CI-side |
| 11 | glibc ≤2.17, musl/armhf binaries; every engine-unavailability class falls back visibly | **floors by construction; measured in CI** | adr-0002; `check-binary-compat.mjs` with `BINARY_COMPAT_REQUIRED=1` |

## The plan's task ledger (what "complete" meant here)

Done and landed on dev-refactor: 0.2/0.5/0.6, 1.4/1.10, 2.6/2.9/2.10/2.11 groundwork, 3.6
close-out, 4.7/4.8/4.9/4.10, 5.7/5.8/5.9/5.10, P2/P3/P5 gates, the coverage-matrix extractor
(6.4 groundwork), 7.1 (drain), 7.4-partial (ARCHITECTURE, ADRs 1–6, README requirements),
7.5-partial (README/System requirements; compatibility.md holds the promise with
"measured, pending" markers for CI).

Not claimable from a developer machine, by nature: anything whose truth is a CI run
(the e2e/perf workflow first executions, C3–C6 matrices, coverage thresholds, the release
tier). Those workflows exist, mirror verified local commands, and are the next gate.
