# Repository Baseline — 2026-10

| Item | Value |
|---|---|
| Generated | 2026-10-26 |
| HEAD | `f0f456d8e` on branch `task/m0-gates` |
| Machine | Windows dev machine (process starts are slower than CI's Linux runner; REFACTOR-PLAN §3.8.1 records the two reference environments separately) |
| Node | v24.14.0 |
| Reproduce | `npm run baseline` — regenerates this file end to end and prints it to stdout |
| Stability | every number below is an exact count or an exact byte size: a rerun on the same tree reproduces them **exactly**; the ~5–10% tolerance of task 0.2 only applies across machines and checkouts |

This is the REFACTOR-PLAN task 0.2 baseline ("Fix the baseline"), taken on the mid-refactor tree
after the wave-1 foundation (dist pipeline, typed protocol, handler table, Vitest for colocated
unit tests). It is the fixed starting point the refactor's ratchets move against: case counts,
artifact sizes, lint-gate counts and file sizes may not regress past these numbers without a
deliberate decision. The header table above is hand-maintained prose inside
`scripts/dev/baseline.mjs`; regenerating rewrites the whole file.

<!-- Everything below the marker is generated. -->

## Test case counts

| Suite | Files | Cases | Method |
|---|---|---|---|
| Vitest (`src/**` colocated units + `test/integration`) | 149 with listed cases (138 matched by the include patterns) | 1617 | `npx vitest list` — vitest prints one line per case as ``file > name``; the count is those lines (a plain grep would miss `test.each` expansion, which `list` resolves) |
| Rust (`native/**`) | 20 files with tests | 174 | proxy count of `#[test]` attributes — the number of test functions in source, **not** a `cargo test` run (documented proxy; no `#[test_case]` or macro-generated cases exist today) |

Exact commands (the generator invokes the same tools through their node entry points):

```bash
npx vitest list                                  # one line per case, "file > name"; count the lines
grep -rn "#\[test\]" native --include="*.rs" | wc -l
```

Every matched Vitest file contributes listed cases at this HEAD.

Rust `#[test]` distribution:

| Area | `#[test]` |
|---|---|
| native/core/tests | 143 |
| native/core/src | 29 |
| native/node/src | 2 |

Notes:

- `test/compat/artifactSyntax.test.mjs` is a CI gate script, not part of either suite's count (CI runs it via `node test/compat/artifactSyntax.test.mjs` after the dist build).
- The legacy node:test suite was drained in REFACTOR-PLAN task 7.1 (the old-to-new mapping lives in that commit); every case count above is Vitest.

## Artifact sizes

Built fresh by the generator with `npm run build:dist -- --production` (the dist pipeline: esbuild
host bundle + webview bundles + ES2018 gates), then `npm run package` (which re-runs that build,
rebuilds the vendored webview assets, and runs vsce — no Rust toolchain involved: the universal
VSIX ships no native binaries).

| Artifact | Size |
|---|---|
| dist/extension.js | 449891 B (439.3 KiB) |
| dist/askpass/askpassMain.js | 1380 B (1.3 KiB) |
| dist/askpass/askpass.sh | 656 B (0.6 KiB) |
| dist/askpass/askpass-empty.sh | 17 B (0 KiB) |
| media/out.min.js | 220638 B (215.5 KiB) |
| media/out.min.css | 65233 B (63.7 KiB) |
| media/comparison.min.js | 75853 B (74.1 KiB) |
| media/comparison.min.css | 15389 B (15 KiB) |
| media/binaryCompare.min.js | 60031 B (58.6 KiB) |
| media/binaryCompare.min.css | 6952 B (6.8 KiB) |
| media/vendor/highlight.min.js | 136226 B (133 KiB) |
| git-graph-rs-1.1.0.vsix (universal VSIX) | 3017206 B (2946.5 KiB) |

The generator deletes the VSIX after measuring it; `npm run package` recreates it at any time.

First-paint payload of the main view (what the §3.8.1 size budget governs — the plain `<script>`
entries in the webview HTML, `src/extension/graphView/html.ts`, plus its stylesheet): the Markdown
renderer loads on demand (`media/chunks/markdown-it-*.js`), and `vendor/highlight.min.js` is
loaded by the comparison page, not the main view.

| Quantity | Value | Budget (§3.8.1) |
|---|---|---|
| First-paint critical JS (minified, not gzipped) | 220638 B (215.5 KiB) | ≤ 200 KB |
| First-paint critical CSS (minified, not gzipped) | 65233 B (63.7 KiB) | ≤ 60 KB |

First-paint JS is over its 200 KB budget;
first-paint CSS is over its 60 KB budget.
The side over budget is what the first-paint splitting work (task 5.9), gated by P5, holds the line on.

## P5 size budget (2% growth rule)

The P5 ratchet (optimization plan §5 V4/R6): a shipped size below may grow at most **2%** over
this baseline without a deliberate decision recorded next to the regeneration. The addon is the
largest file in the VSIX by an order of magnitude, so its per-platform size is budgeted
separately from the VSIX total; CI's `cargo bloat --release --crates` report (native-build.yml,
non-blocking) is the evidence source when a budget is breached. A row here appears for every
platform the tree being measured carries a build for — worktrees normally hold only the host
platform (`npm run build:native:release`); CI's matrix covers the rest.

| Quantity | Baseline | Growth budget (+2%) | Measured by |
|---|---|---|---|
| Universal VSIX (`git-graph-rs-1.1.0.vsix`) | 3017206 B (2946.5 KiB) | ≤ 3077551 B (3005.4 KiB) | `npm run package` |
| Addon, `win32-x64-msvc` (`native/win32-x64-msvc/git-graph.node`) | 5683200 B (5550 KiB) | ≤ 5796864 B (5661 KiB) | `npm run build:native:release` (CI matrix for the rest) |

## Bench first-paint

A prebuilt engine binary exists (native/win32-x64-msvc/git-graph.node); the first-paint gates were not run by the generator — run `npm run perf` (`test/perf/`) and record the medians here.

## Lint gates

| Gate | Result | Command |
|---|---|---|
| dependency-cruiser | 0 new violations (424 modules, 1323 dependencies cruised); 21 known violations ignored (baseline file: 21 entries, null already stale — shrink-only regeneration pending) | `npm run lint:deps` |
| ESLint (`src` + `scripts`) | null problems (null errors, null warnings), exit 0 | `npx eslint src scripts` |

Both gates exit 0 as the generator runs them (the two tools invoked directly): the depcruise
ratchet means any violation **not** in `docs/depcruise-baseline.json` fails `npm run lint:deps`,
and ESLint reports warnings only. Note that `npm run lint:deps` itself also fails while the
baseline file carries stale entries (null at this HEAD) — its shrink-only
regeneration is owed by whoever removed the last of those violations.

## Ten largest non-generated source files

`git ls-files` filtered to source extensions (.ts .mts .cts .mjs .cjs .rs .css), excluding:

- `legacy/*` — frozen v1.0 reference copy
- `src/shared/engine/*` — ts-rs generated types (regenerated, never hand-edited)
- `src/shared/i18n/en.ts` — string-table dictionary
- `src/shared/i18n/zh-cn.ts` — string-table dictionary

Line counts are `wc -l` semantics. Command shape: `git ls-files '*.ts' '*.mjs' '*.rs' '*.css' | grep -v … | xargs wc -l | sort -rn | head`.

| Lines | File |
|---|---|
| 1189 | src/extension/platform/config.ts |
| 988 | src/webview/graph/widgets/settings/settingsWidget.ts |
| 955 | src/extension/automation/server.ts |
| 896 | src/extension/graphView/commitLoader.ts |
| 895 | src/webview/graph/commitDetails/commitDetails.ts |
| 873 | src/extension/repos/repoManager.ts |
| 858 | native/core/tests/graph_and_diff.rs |
| 845 | src/extension/automation/suiteRunner.ts |
| 826 | native/core/tests/queries.rs |
| 826 | src/extension/automation/fixture.ts |

Goal G2 ratchets non-generated files down to ≤ 600 lines; `src/dataSource.ts` (the v1.0 god
module still carrying the shipped view until Phase 4 deletes it) tops the table as expected.

## Repository shape

Tracked files per top-level directory (`git ls-files | cut -d/ -f1 | sort | uniq -c | sort -rn`):

| Directory | Tracked files |
|---|---|
| src/ | 437 |
| test/ | 97 |
| native/ | 67 |
| docs/ | 53 |
| scripts/ | 29 |
| resources/ | 21 |
| licenses/ | 8 |
| .github/ | 7 |
| (repository root) | 26 |
| **Total** | **745** |

`legacy/` no longer exists in this tree (it has been drained by the refactor's phases);
`dist/`, `media/`, `out/`, `native/<platform>/` and `*.vsix` are gitignored build outputs.

## Not measured here

| Item | Why | Reproduce with |
|---|---|---|
| `bench.mjs` first-paint on the current tree | no prebuilt engine binary in this worktree; bench also needs the `out/` tree | `npm run build && node scripts/bench.mjs <repo> --commits 200 --runs 5` |
| Rust line/branch coverage | needs `cargo llvm-cov` (the full workspace build) | `cargo llvm-cov --workspace --lcov --output-path lcov.info` |
| Node line/branch coverage | the Vitest coverage provider is not wired yet (REFACTOR-PLAN task 7.3) | `npx vitest run --coverage` once configured |
| Platform VSIX sizes | each needs its cross-compiled addon from CI's cargo matrix | `node scripts/package-platforms.mjs` (in CI: `.github/workflows/native-build.yml`) |
| All §3.8.1 timing scenarios (T0–T5, P50/P95) | the marker infrastructure and P1–P5 harness do not exist yet | `test/perf/` (P2–P5) and `native/core/benches/` (P1) — status tracked in `docs/performance.md` |

<!-- baseline-summary: {"vitestCases":1617,"vitestFiles":149,"vitestMatchedFiles":138,"rustTests":174,"extensionJs":449891,"firstPaintJs":220638,"firstPaintCss":65233,"vsix":3017206,"addonNodes":{"win32-x64-msvc":5683200},"depcruiseViolations":0,"eslintProblems":null,"largestFile":{"file":"src/extension/platform/config.ts","lines":1189}} -->
