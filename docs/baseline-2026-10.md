# Repository Baseline — 2026-10

| Item | Value |
|---|---|
| Generated | 2026-10-25 |
| HEAD | `3d2b5fe37` on branch `task/docs-baseline-performance` |
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
| Vitest (`src/**` colocated units + `test/integration`) | 79 with listed cases (80 matched by the include patterns) | 716 | `npx vitest list` — vitest prints one line per case as ``file > name``; the count is those lines (a plain grep would miss `test.each` expansion, which `list` resolves) |
| Legacy node:test (`tests/**`) | 49 | 499 (391 `it(` + 108 `test(`) | proxy count of `it(`/`test(` calls whose first argument is a string literal, over the same `tests/*.test.mjs` list `scripts/run-tests.mjs` discovers |
| Rust (`native/**`) | 17 files with tests | 163 | proxy count of `#[test]` attributes — the number of test functions in source, **not** a `cargo test` run (documented proxy; no `#[test_case]` or macro-generated cases exist today) |

Exact commands (the generator invokes the same tools through their node entry points):

```bash
npx vitest list                                  # one line per case, "file > name"; count the lines
grep -rhoE "\b(it|test)\(" tests --include="*.test.mjs" | wc -l
grep -rn "#\[test\]" native --include="*.rs" | wc -l
```

Files matched but listing no cases: test/integration/reader/fallback.contract.test.ts (5 engine-gated `it(` cases, listed only with a built engine).

Rust `#[test]` distribution:

| Area | `#[test]` |
|---|---|
| native/core/tests | 140 |
| native/core/src | 23 |

Notes:

- The legacy proxy under-counts nothing today (`it.skip`/`it.each`/`test.each` do not occur in `tests/`), but it resolves `describe` nesting only implicitly — the authoritative runner report is `npm run test:node` (needs the `out/` tree: `npm run compile-src` first).
- `test/compat/artifactSyntax.test.mjs` is a CI gate script, not part of either suite's count (CI runs it via `node test/compat/artifactSyntax.test.mjs` after the dist build).
- Case counts will **drop** as legacy coverage migrates into Vitest (REFACTOR-PLAN §2.3 rule 3); the mapping lives in each PR, and the totals here are the drift reference.

## Artifact sizes

Built fresh by the generator with `npm run build:dist -- --production` (the dist pipeline: esbuild
host bundle + webview bundles + ES2018 gates), then `npm run package` (which re-runs that build,
rebuilds the vendored webview assets, and runs vsce — no Rust toolchain involved: the universal
VSIX ships no native binaries).

| Artifact | Size |
|---|---|
| dist/extension.js | 457310 B (446.6 KiB) |
| dist/askpass/askpassMain.js | 1380 B (1.3 KiB) |
| dist/askpass/askpass.sh | 656 B (0.6 KiB) |
| dist/askpass/askpass-empty.sh | 17 B (0 KiB) |
| media/out.min.js | 488969 B (477.5 KiB) |
| media/out.min.css | 103644 B (101.2 KiB) |
| media/comparison.min.js | 51694 B (50.5 KiB) |
| media/comparison.min.css | 15389 B (15 KiB) |
| media/binaryCompare.min.js | 35869 B (35 KiB) |
| media/binaryCompare.min.css | 6952 B (6.8 KiB) |
| media/vendor/markdown-it.min.js | 103579 B (101.2 KiB) |
| media/vendor/highlight.min.js | 164741 B (160.9 KiB) |
| git-graph-rs-1.0.27.vsix (universal VSIX) | 519125 B (507 KiB) |

The generator deletes the VSIX after measuring it; `npm run package` recreates it at any time.

First-paint payload of the main view (what the §3.8.1 size budget governs — the plain `<script>`
entries in the webview HTML, `src/extension/graphView/html.ts`, plus its stylesheet):
`vendor/markdown-it.min.js` is still unconditional (Phase 1 task 1.9 moves it to on-demand);
`vendor/highlight.min.js` is loaded by the comparison page, not the main view.

| Quantity | Value | Budget (§3.8.1) |
|---|---|---|
| First-paint critical JS (minified, not gzipped) | 592548 B (578.7 KiB) | ≤ 200 KB |
| First-paint critical CSS (minified, not gzipped) | 103644 B (101.2 KiB) | ≤ 60 KB |

Both are over budget today — expected at this point in the plan; the slimming work is tasks 1.9
(markdown-it off first paint) and 5.9 (first-paint splitting), gated by P5.

## Bench first-paint

`bench.mjs` first-paint numbers: **not measured here** — no prebuilt engine binary exists in this
worktree (`native/<platform>/*.node` is gitignored and building one needs cargo), and `bench.mjs`
also requires the `out/` tree it imports. Reproduce with:

```bash
npm run build            # cargo addon + production dist + the out/ tree bench imports
node scripts/bench.mjs <repo-path> --commits 200 --runs 5
```

The one first-paint measurement recorded in the repository today (v1.0 code, this repository's
first page of 200 commits, median of 5): engine **12.6 ms** vs git CLI **205.3 ms** — measured
with `bench.mjs` and recorded in `docs/REFACTOR-PLAN.md` §0.7. Re-measuring it on the current
tree is part of the P2 harness (`test/perf/`).

## Lint gates

| Gate | Result | Command |
|---|---|---|
| dependency-cruiser | 0 new violations (353 modules, 1119 dependencies cruised); 17 known violations ignored (baseline file: 24 entries, 7 already stale — shrink-only regeneration pending) | `npm run lint:deps` |
| ESLint (`src` + `scripts`) | 232 problems (0 errors, 232 warnings), exit 0 | `npx eslint src scripts` |

Both gates exit 0 at this HEAD: the depcruise ratchet means any violation **not** in
`docs/depcruise-baseline.json` fails `npm run lint:deps`, and ESLint reports warnings only.

## Ten largest non-generated source files

`git ls-files` filtered to source extensions (.ts .mts .cts .mjs .cjs .rs .css), excluding:

- `legacy/*` — frozen v1.0 reference copy
- `src/shared/engine/*` — ts-rs generated types (regenerated, never hand-edited)
- `src/shared/i18n/en.ts` — string-table dictionary
- `src/shared/i18n/zh-cn.ts` — string-table dictionary

Line counts are `wc -l` semantics. Command shape: `git ls-files '*.ts' '*.mjs' '*.rs' '*.css' | grep -v … | xargs wc -l | sort -rn | head`.

| Lines | File |
|---|---|
| 2617 | src/dataSource.ts |
| 1246 | src/types/messages.ts |
| 1195 | src/extension/platform/config.ts |
| 1051 | src/webview/graph/loading/repoLoader.ts |
| 979 | src/webview/graph/widgets/settings/settingsWidget.ts |
| 942 | src/automation/server.ts |
| 884 | native/core/src/read/log.rs |
| 852 | native/core/tests/graph_and_diff.rs |
| 840 | src/extension/repos/repoManager.ts |
| 831 | src/webview/graph/commitDetails/commitDetails.ts |

Goal G2 ratchets non-generated files down to ≤ 600 lines; `src/dataSource.ts` (the v1.0 god
module still carrying the shipped view until Phase 4 deletes it) tops the table as expected.

## Repository shape

Tracked files per top-level directory (`git ls-files | cut -d/ -f1 | sort | uniq -c | sort -rn`):

| Directory | Tracked files |
|---|---|
| src/ | 382 |
| tests/ | 55 |
| native/ | 47 |
| scripts/ | 28 |
| test/ | 25 |
| resources/ | 21 |
| docs/ | 13 |
| licenses/ | 8 |
| .github/ | 2 |
| (repository root) | 21 |
| **Total** | **602** |

`legacy/` no longer exists in this tree (it has been drained by the refactor's phases);
`dist/`, `media/`, `out/`, `native/<platform>/` and `*.vsix` are gitignored build outputs.

## Not measured here

| Item | Why | Reproduce with |
|---|---|---|
| `bench.mjs` first-paint on the current tree | no prebuilt engine binary in this worktree; bench also needs the `out/` tree | `npm run build && node scripts/bench.mjs <repo> --commits 200 --runs 5` |
| Rust line/branch coverage | needs `cargo llvm-cov` (the full workspace build) | `cargo llvm-cov --workspace --lcov --output-path lcov.info` |
| Node line/branch coverage | needs the legacy `out/` tree and the full suite | `npm run compile-src && npm run test:node:cov` |
| Platform VSIX sizes | each needs its cross-compiled addon from CI's cargo matrix | `node scripts/package-platforms.mjs` (in CI: `.github/workflows/native-build.yml`) |
| All §3.8.1 timing scenarios (T0–T5, P50/P95) | the marker infrastructure and P1–P5 harness do not exist yet | `test/perf/` (P2–P5) and `native/core/benches/` (P1) — status tracked in `docs/performance.md` |

<!-- baseline-summary: {"vitestCases":716,"vitestFiles":79,"vitestMatchedFiles":80,"legacyFiles":49,"legacyCases":499,"rustTests":163,"extensionJs":457310,"firstPaintJs":592548,"firstPaintCss":103644,"vsix":519125,"depcruiseViolations":0,"eslintProblems":232,"largestFile":{"file":"src/dataSource.ts","lines":2617}} -->
