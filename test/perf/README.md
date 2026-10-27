# Performance gates (P2 / P3 / P5)

The performance half of the refactor's CI gates (REFACTOR-PLAN §6.7): P2 drives the real host
pipeline, P3 renders the real webview artifact in a real browser, P5 weighs the built payloads.
This directory is deliberately NOT under `vitest.config.ts` — the gates run with plain `node`,
spawn real `git` processes, the real engine addon and a real browser, which a test runner
cannot sandbox.

Prerequisites (all three gates):

```bash
node scripts/build-addon.mjs           # the engine addon (native/<platform>/git-graph.node)
npm run build:dist -- --production     # dist/ + media/ (what P5 measures)
node scripts/package-highlight.js   # media/vendor for P5
```

## Running

```bash
npm run perf                           # all gates, 21 samples each, JSON to test/perf/results/
npm run perf:record                    # ... and write test/perf/results/baseline.json (commit-stamped)
npm run perf -- --compare-to test/perf/results/baseline.json    # THE GATE: fail on U9 regressions
```

Or directly:

```bash
node test/perf/run.mjs --gate p2,p3,p5 [--samples 21] [--tier s|m|l] [--channel msedge|chrome|chromium]
node test/perf/p2-host.mjs --samples 21 --backend engine,cli      # one gate standalone
node test/perf/p3-webview.mjs --samples 21
node test/perf/p5-size.mjs [--artifacts-dir <another-tree>]
```

Every run writes `test/perf/results/perf-results.json` (per-gate files plus a
`perf-summary.md`); a failing gate exits 1.

## The fixture generator (`fixture.mjs`, REFACTOR-PLAN task 0.5)

The S/M/L reference repositories of §3.8.1 are generated, not committed: deterministic
fast-import histories from a fixed per-tier seed (12345), so every machine measures the same
repository.

```bash
node test/perf/fixture.mjs --tier s          # ~2 s:   1 K commits, 20 branches, 20 tags
node test/perf/fixture.mjs --tier m          # minutes: 100 K commits, 2 K branches, 10 K tags
node test/perf/fixture.mjs --tier l          # tens of minutes — generate AHEAD of the run
node test/perf/fixture.mjs --tier s --out <dir> --force   # anywhere, rebuilt from scratch
node test/perf/fixture.mjs --tier m --commits 50000       # ad-hoc sizes (seed stays the tier's)
```

Default output is `test/perf/fixtures/<tier>` (gitignored): `fixture/` (working clone),
`fixture-remote.git` (the bare remote), `fixture-b/` (a second clone for the rapid-switch
scenario). There is exactly ONE generator implementation — the automation fixture
(`src/extension/automation/fixture.ts`) — so a pre-generated fixture is identical in shape to
what a gate generates on the fly. The gates default to generating into the OS temp dir; point
them at a pre-generated tier instead:

```bash
node test/perf/run.mjs --gate p2 --tier m --work-dir test/perf/fixtures/m
```

Generation is idempotent (an existing tier directory is reused unless `--force`), which is what
makes the nightly's fixture cache hit safe.

## The E2E trace collector (`collect-e2e-traces.mjs`, OPTIMIZATION-PLAN §7 P4)

The E2E launcher runs this after every E2E run (its exit code is ignored — best effort). It
parses the session log's `Trace` lines (the P1 sink's output, aggregated with the same P50/P95
grammar `scripts/analyze-log.mjs` uses, via `lib/trace-log.mjs`), attributes every trace to the
scenario window the E2E entry recorded, and writes:

- `<e2e results dir>/traces.json` + `traces.md` — per-window and overall aggregates;
- `test/perf/results/e2e-traces.jsonl` — one appended line per run, the P4 history.

The engine → CLI fallback count rides along, so a calibration run can state which read path its
numbers exercised. Run it by hand against an old results dir with
`node test/perf/collect-e2e-traces.mjs --windows <dir>/perf-windows.json --out <dir> --profile <profile dir>`.

## What each gate measures

### P2 — host pipeline (`p2-host.mjs`)

Drives the REAL compiled pipeline — the `CommitLoader` over the `GitRepository` facade
composed exactly like `src/extension.ts` composes it — against the deterministic fast-import
fixture (`src/automation/fixture.ts`, S tier ~1K commits by default; M tier via `--tier m`,
slow). Each scenario runs on BOTH read paths the extension ships: the engine backend and the
pure CLI fallback (`--backend engine,cli`).

| item | scenario |
|---|---|
| `open-hard` | the merged open path (`loadView`) with the commit cache bypassed — a first open |
| `open-cached` | the same read on a warm cache — the hot open |
| `load-more` | `loadCommits` widening the window 300 -> 400 (the view's Load More) |
| `commit-details` | `getCommitDetails` of the head commit |
| `refs-only-refresh` | after a real (untimed) tag create: the `getRefs` refresh a refs-only operation pays |
| `head-change-refresh` | after a real (untimed) checkout: the first-page reload it triggers |
| `rapid-switch` | repo A's open read fired and superseded by repo B's page — the cancellation path (also asserts the superseded read resolves to nothing) |
| `background-load` | a page load while a real background read (50 commit bodies) is in flight |

Timing = the initial-response latency of each request (the moment the webview could paint);
every request is drained to quiescence so one sample's follow-ups never bleed into the next.

### P3 — webview rendering (`p3-webview.mjs`)

Loads the BUILT `media/out.min.js` (the exact bytes a VSIX ships) in headless Chromium via
`playwright-core`, on a page with the real view skeleton, a fake `acquireVsCodeApi` bridge,
and the real merged `loadView` response of the S-tier fixture produced by the real P2 pipeline
(the 10K case is a deterministic synthetic history — the scroll-stress population).

| item | scenario |
|---|---|
| `t2t5-s`, `t2t5-10k` | T2 -> T5: script start -> the first rAF after rows are painted (§3.8.1 "own time") |
| `scroll-p99-10k` | frame-time P99 while rAF-scrolling the 10K-row list (§3.8.5 budget: <= 16 ms) |
| `longtasks-10k` | long tasks (> 50 ms) per scroll pass (§3.8.5 budget: 0) |
| `muts-refs-only` | DOM mutations under the commit table for one refs-only update (pills moved) |
| `heap-10k` | JS heap with 10K rows loaded (§3.8.1 memory budget; single sample, informational) |

Browser: the locally installed Edge/Chrome is used by default (no download); `--channel
chromium` (plus `npx playwright install chromium` via the full `playwright` package) where
none is installed — that is what CI does.

### P5 — size (`p5-size.mjs`)

Weighs the build outputs (`--production` build): the webview entry (`media/out.min.{js,css}`
— the first-paint critical payload; the webview is NOT yet split, so the whole entry is the
critical chunk, recorded as `splitting: false`), the two auxiliary webview pages (comparison /
binaryCompare — today's on-demand surface), the vendored libraries, and the host bundle
(`dist/extension.js`). `first-paint-js-total` reports entry + the markdown-it vendor script
the HTML loads at boot — the honest number the §3.8.2 slimming has to bring under the budget.

The §3.8.1 budgets (critical JS <= 200 KB, critical CSS <= 60 KB, minified, not gzipped) are
recorded on every run; failing ON them requires `--enforce-budgets` (today's un-split entry
exceeds them by design — enable the flag in CI once the slimming lands).

## The baseline / comparison flow (U9)

```bash
# on a quiet machine, on the BASE commit:
node test/perf/run.mjs --record
git checkout the-pr
node test/perf/run.mjs --compare-to <path-to-baseline.json>   # exit 1 = regression
```

The gate fails an item when:

- **timing/count items (P2, P3)**: the median regresses more than **5%** AND the one-sided
  Mann-Whitney U test (over the raw >= 20 samples) confirms the shift at p < 0.05. A > 5%
  delta that is not significant is machine noise and passes. Count items additionally need an
  absolute shift of >= 2 (1 vs 2 long tasks is scheduler jitter, not a regression).
- **size items (P5)**: +2% (deterministic single samples; no significance test possible).
- **budgets**: only with `--enforce-budgets` (see above).

New items (no baseline entry) are reported but never fail. Items whose baseline median is 0
are skipped (a percentage of zero is meaningless).

### Same-machine comparison — the only honest timing comparison

Timing numbers are only comparable when produced **on the same machine, back to back**.
Process starts, disk cache state and background load differ between machines far more than
the regressions this gate hunts. That is why `.github/workflows/perf.yml` checks out the base
ref and the PR into ONE job, records the base run, and gates the PR run against it
immediately after. For a second pre-built tree, P5 accepts `--artifacts-dir <dir>` and
measures that tree's `dist/` + `media/` instead of the workspace's.

### Noise — read before trusting a red gate

Measured on a loaded dev machine (Windows, other builds running), two back-to-back identical
runs can still differ by 20-60% per item: the distributions genuinely shift, so even the
significance test confirms them. Mitigations, in order of effectiveness:

1. run on a quiet machine / fixed-spec runner (the plan's §8 note: move to self-hosted
   runners if GitHub-hosted noise exceeds 3%);
2. the same-job base-vs-PR comparison the workflow implements;
3. >= 21 samples + medians + the Mann-Whitney confirmation (eliminates small-sample flukes);
4. for a confirmed-but-implausible regression, re-run once before believing it — a real
   regression reproduces, load spikes do not;
5. the plan's escape hatch (§9): a per-PR exemption label with reviewer approval.

P5 (size) is deterministic and needs none of this.

## Files

| path | role |
|---|---|
| `run.mjs` | the runner: `--record` / `--compare-to` / `--enforce-budgets`, the comparison + markdown summary, exit code |
| `p2-host.mjs` | the P2 scenarios |
| `p3-webview.mjs` | the P3 page, fake host bridge and measurements |
| `p5-size.mjs` | the P5 artifact weighing |
| `fixture.mjs` | the S/M/L fixture generator CLI (task 0.5; deterministic per tier seed) |
| `collect-e2e-traces.mjs` | the P4 collector: an E2E run's session log → per-scenario trace summaries |
| `lib/stats.mjs` | median / P95 / Mann-Whitney U (verified against scipy references) |
| `lib/env.mjs` | paths, on-the-fly src loading (esbuild), results IO, CLI parsing, fixture tiers |
| `lib/host-pipeline.mjs` | the fixture pair, backend pair, facade + CommitLoader wiring |
| `lib/trace-log.mjs` | the `Trace` line parser + window attribution the collector shares |
| `results/` | output (gitignored): per-gate JSON, `baseline.json`, `perf-summary.md`, `e2e-traces.jsonl` |
