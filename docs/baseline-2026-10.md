# Repository Baseline — 2026-10

| Item | Value |
|---|---|
| Generated | 2026-10-25 |
| HEAD | `66a0707fe` on branch `task/legacy-drain-purge` |
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
| Vitest (`src/**` colocated units + `test/integration`) | 136 with listed cases (127 matched by the include patterns) | 1392 | `npx vitest list` — vitest prints one line per case as ``file > name``; the count is those lines (a plain grep would miss `test.each` expansion, which `list` resolves) |
| Rust (`native/**`) | 17 files with tests | 163 | proxy count of `#[test]` attributes — the number of test functions in source, **not** a `cargo test` run (documented proxy; no `#[test_case]` or macro-generated cases exist today) |

Exact commands (the generator invokes the same tools through their node entry points):

```bash
npx vitest list                                  # one line per case, "file > name"; count the lines
grep -rn "#\[test\]" native --include="*.rs" | wc -l
```

Every matched Vitest file contributes listed cases at this HEAD.

Rust `#[test]` distribution:

| Area | `#[test]` |
|---|---|
| native/core/tests | 140 |
| native/core/src | 23 |

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
| dist/extension.js | 442437 B (432.1 KiB) |
| dist/askpass/askpassMain.js | 1380 B (1.3 KiB) |
| dist/askpass/askpass.sh | 656 B (0.6 KiB) |
| dist/askpass/askpass-empty.sh | 17 B (0 KiB) |
| media/out.min.js | 209465 B (204.6 KiB) |
| media/out.min.css | 84632 B (82.6 KiB) |
| media/comparison.min.js | 51707 B (50.5 KiB) |
| media/comparison.min.css | 15389 B (15 KiB) |
| media/binaryCompare.min.js | 35882 B (35 KiB) |
| media/binaryCompare.min.css | 6952 B (6.8 KiB) |
| media/vendor/markdown-it.min.js | 103579 B (101.2 KiB) |
| media/vendor/highlight.min.js | 164741 B (160.9 KiB) |
| git-graph-rs-1.0.27.vsix (universal VSIX) | 6944887 B (6782.1 KiB) |

The generator deletes the VSIX after measuring it; `npm run package` recreates it at any time.

First-paint payload of the main view (what the §3.8.1 size budget governs — the plain `<script>`
entries in the webview HTML, `src/extension/graphView/html.ts`, plus its stylesheet):
`vendor/markdown-it.min.js` is still unconditional (Phase 1 task 1.9 moves it to on-demand);
`vendor/highlight.min.js` is loaded by the comparison page, not the main view.

| Quantity | Value | Budget (§3.8.1) |
|---|---|---|
| First-paint critical JS (minified, not gzipped) | 313044 B (305.7 KiB) | ≤ 200 KB |
| First-paint critical CSS (minified, not gzipped) | 84632 B (82.6 KiB) | ≤ 60 KB |

Both are over budget today — expected at this point in the plan; the slimming work is tasks 1.9
(markdown-it off first paint) and 5.9 (first-paint splitting), gated by P5.

## Bench first-paint

A prebuilt engine binary exists (native/win32-x64-msvc/git-graph.node); `npm run bench` was not run by the generator — run `npm run build:ts && node scripts/bench.mjs <repo-path> --commits 200 --runs 5` and record the medians here.

## Lint gates

| Gate | Result | Command |
|---|---|---|
| dependency-cruiser | null new violations (null modules, null dependencies cruised); 8 known violations ignored (baseline file: 24 entries, 16 already stale — shrink-only regeneration pending) | `npm run lint:deps` |
| ESLint (`src` + `scripts`) | 221 problems (0 errors, 221 warnings), exit 0 | `npx eslint src scripts` |

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
| 1246 | src/types/messages.ts |
| 1204 | src/extension/platform/config.ts |
| 1111 | src/webview/graph/loading/repoLoader.ts |
| 988 | src/webview/graph/widgets/settings/settingsWidget.ts |
| 955 | src/automation/server.ts |
| 894 | src/extension/graphView/commitLoader.ts |
| 872 | native/core/src/read/log.rs |
| 872 | src/extension/repos/repoManager.ts |
| 858 | native/core/tests/graph_and_diff.rs |
| 850 | src/webview/graph/commitDetails/commitDetails.ts |

Goal G2 ratchets non-generated files down to ≤ 600 lines; `src/dataSource.ts` (the v1.0 god
module still carrying the shipped view until Phase 4 deletes it) tops the table as expected.

## Repository shape

Tracked files per top-level directory (`git ls-files | cut -d/ -f1 | sort | uniq -c | sort -rn`):

| Directory | Tracked files |
|---|---|
| src/ | 403 |
| test/ | 54 |
| docs/ | 49 |
| native/ | 47 |
| scripts/ | 28 |
| resources/ | 21 |
| licenses/ | 8 |
| .github/ | 4 |
| (repository root) | 21 |
| **Total** | **635** |

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

<!-- baseline-summary: {"vitestCases":1392,"vitestFiles":136,"vitestMatchedFiles":127,"rustTests":163,"extensionJs":442437,"firstPaintJs":313044,"firstPaintCss":84632,"vsix":6944887,"depcruiseViolations":null,"eslintProblems":221,"largestFile":{"file":"src/types/messages.ts","lines":1246}} -->
