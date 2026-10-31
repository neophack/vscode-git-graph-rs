# Performance Budgets and Status

This document carries the **binding performance budgets** of the executed refactor plan
(its §3.8.1, reproduced verbatim below) together with a
**status column** recording, as of 2026-10-27, which numbers have actually been measured on
this repository and which await the measurement infrastructure. The plan's rule is absolute:
*no number is written here unless a command produced it*; every unmeasured item says
`pending — measured by <P-gate>` and names the gate that will produce it.

The measurement harness is the P1–P5 gate set (REFACTOR-PLAN §6.7), under construction at
[`test/perf/`](../test/perf/) (P2–P5) and [`native/core/benches/`](../native/core/) (P1).
Once it lands, this document gains per-scenario P50/P95 tables for the S/M/L reference
repositories and the budgets are calibrated once against real measurements — after which
they may only tighten ([ADR-0004](adr/adr-0004-performance-budgets.md)).

## Timing points (T0–T5)

Every timing scenario is expressed over the same six points (REFACTOR-PLAN §3.8.1, verbatim):

> T0 user triggers the command → T1 panel created → T2 webview script starts executing →
> T3 host first-paint data ready → T4 webview receives the data → T5 first commit rows painted
> (the next `requestAnimationFrame` after the data is rendered).

What each slice contains, and who controls it:

| Point | Meaning | Controlled by |
|---|---|---|
| T0 | The user runs the view command (`git-graph-rs.view`, a click, a restored tab) | — |
| T1 | `createWebviewPanel` returns; the panel object exists but no content has loaded | VS Code + host |
| T2 | The webview's first script begins executing (after HTML/CSP/script fetch) | VS Code (webview creation) + artifact sizes |
| T3 | The host's first-paint data (repo info + first commit page) is ready to send | **This project** (engine / CLI read path, prefetch) |
| T4 | The webview `message` handler receives that data | **This project** (protocol, postMessage) |
| T5 | The first commit rows are painted — the next `requestAnimationFrame` after rendering | **This project** (render path) |

T0 → T1 → T2 include VS Code's own webview creation cost, which this project does not
control; that is why §3.8.1 also budgets the **own time** T2 → T5 as the hard number this
project can influence. Both host and webview mark with `Date.now()` so the points are
directly comparable on one machine (§3.8.1).

## The marker mechanism (§3.8.7)

The plan's observability design:

- a unified `perf` marker: the host marks via `perf_hooks` (available since Node 8.5, so the
  Node 10.11 floor is safe), the webview via `performance.mark`;
- every open or operation produces a trace (T0–T5, or an operation's phases), written to the
  session log when `git-graph-rs.enableLog` is on and attached to automation reports;
- `scripts/analyze-log.mjs` aggregates P50/P95 per scenario;
- a developer command ("Git Graph RS: Show Performance Trace") shows the last 20 traces;
- task 0.5 acceptance: markers cover T0–T5 **plus** the start/end of "load more",
  "expand details", "refs-only operations", "HEAD-changing operations", and "find", with
  overhead ≤ 1 ms when markers are off.

**What exists today (2026-10-27, after the P1/P2 waves):**

| Piece | Status | Evidence |
|---|---|---|
| T0–T5 `perf` markers (host + webview) | **present** — `src/shared/perf/trace.ts`, off by default, one boolean read when off; host marks T0/T1/T3 (+ the ACTIVATION mark), webview marks T2/T4/T5 posted once after T5 | `src/shared/perf/trace.ts`; wired in `src/extension/main.ts`, `commands/commandManager.ts`, `graphView/panel.ts`, `webview/graph/main.ts` |
| Operation spans (load-more / expand-details / refs+HEAD op) | **present** — `op:loadCommits`, `op:commitDetails`, `op:loadRepoInfo` spans around the dispatched request | `src/extension/graphView/panel.ts` (`OP_TRACE_COMMANDS`) |
| Host ring buffer ("Show Performance Trace" reads it) | **present** — last 20 traces (`traces()`); the V5 Diagnostics command is the follow-up | `src/shared/perf/trace.ts` |
| Trace lines in the log | **present** — the sink writes `Trace <name>: MARK +x.xms, ...` while `git-graph-rs.enableLog` is on | `src/extension/commands/commandManager.ts` |
| Log aggregation with trace P50/P95 | **present** — `scripts/analyze-log.mjs` aggregates per trace and per mark (per origin) | `node scripts/analyze-log.mjs <logfile>` |
| P4 collection in the E2E launcher | **present** — the launcher runs `test/perf/collect-e2e-traces.mjs` after every E2E run; the entry records per-scenario windows (`perf-windows.json`), the collector attributes the log's traces to them and writes `traces.json` / `traces.md` plus the `test/perf/results/e2e-traces.jsonl` history | `test/perf/collect-e2e-traces.mjs`, `test/perf/lib/trace-log.mjs`, `test/e2e/launcher.ts`, `test/e2e/entry.ts` |
| S/M/L fixture generator (task 0.5) | **present** — `test/perf/fixture.mjs`, deterministic per tier seed, gitignored output, idempotent | `node test/perf/fixture.mjs --tier s\|m\|l` |

Known gap (found by the P4 wave, described in [ADR-0007](adr/adr-0007-timing-budget-calibration.md)):
on this machine's VS Code 1.143 the session logger switches itself off shortly after activation
(a configuration event re-reads `enableLog` as false during startup and is never corrected), so
E2E runs on this machine record no Trace lines yet — the collector then says so explicitly. The
harness-side repair attempt (the entry re-asserts the setting after activation until the
extension reports the log file live) is in `test/e2e/entry.ts`; the product-side fix belongs in
`src/extension/main.ts`'s configuration listener / `src/extension/platform/logger.ts`'s
`setEnabled`.

## Reference repositories (S/M/L)

Reproduced verbatim from §3.8.1. The fixtures are generated by `git fast-import` from fixed
seeds (reusing the automation fixture, `src/extension/automation/fixture.ts`), so measurements
are reproducible without network access. The generator is `test/perf/fixture.mjs` (task 0.5):

```bash
node test/perf/fixture.mjs --tier s    # ~2 s — also the default the gates generate on the fly
node test/perf/run.mjs --gate p2 --tier m --work-dir test/perf/fixtures/m   # pre-generated tier
```

| Tier | Commits | Branches / tags | Worktree | Use |
|---|---|---|---|---|
| S | 1 K | 20 / 20 | 200 files | Every PR |
| M | 100 K | 2 K / 10 K | 20 K files | Every PR (P1, P2), nightly |
| L | 1 M | 20 K / 50 K | 100 K files | Nightly, before release |

Reference environments: CI's Linux runner (4 vCPU, SSD) plus one Windows dev machine
(process starts are slower on Windows; recorded separately). "Hot" means the engine handle is
open and the memory cache hits; "cold" means the first open after VS Code starts.

## Budgets and status (2026-10-27)

The budget columns are §3.8.1 **verbatim**; only the Status column is added. P50/P95 is the
reporting form (20 runs per scenario, per task 0.5). The size row is measured: see
[docs/baseline-2026-10.md](baseline-2026-10.md).

| Scenario | Metric | S | M | L | Status (2026-10-27, [ADR-0007](adr/adr-0007-timing-budget-calibration.md)) |
|---|---|---|---|---|---|
| Activation | Time `activate()` occupies the main thread synchronously | ≤ 20 ms | ≤ 20 ms | ≤ 20 ms | pending — the ACTIVATION mark exists; the budget names event-loop blocking, which no marker measures yet (P4 follow-up) |
| Open view (cold) | T0 → T5 | ≤ 400 ms | ≤ 600 ms | ≤ 1200 ms | pipeline half measured (P2, S, engine): **116.1 ms** median — confirmed achievable on the engine path; the whole-view number awaits the P4 in-editor traces |
| Open view (hot, prewarmed) | T0 → T5 | ≤ 200 ms | ≤ 250 ms | ≤ 500 ms | pipeline half measured (P2, S, engine): **95.0 ms** median — confirmed achievable; whole-view pending as above |
| Open view (snapshot first paint) | T0 → snapshot painted | ≤ 150 ms | ≤ 150 ms | ≤ 150 ms | pending — no marker exists for the snapshot paint (T5 marks the first commit rows); needs a snapshot marker |
| Open view: own time | T2 → T5 (excluding VS Code's own webview creation) | ≤ 80 ms | ≤ 120 ms | ≤ 300 ms | pending — measured by P3 (headless Chromium over the built artifact) |
| Load more (100 commits) | Click → painted | ≤ 50 ms | ≤ 80 ms | ≤ 150 ms | pipeline half measured (P2, S): engine **18.9 ms** ✓, git CLI 252.2 ms (the fallback is the degraded path; not the calibration basis) |
| Expand commit details | Click → painted | ≤ 60 ms | ≤ 100 ms | ≤ 200 ms | pipeline half measured (P2, S): engine **0.8 ms** ✓, CLI 161.7 ms |
| Refs-only operations (create/delete tag or branch, rename) | git process exit → UI updated | ≤ 60 ms | ≤ 100 ms | ≤ 200 ms | pipeline half measured (P2, S): engine **3.6 ms** ✓, CLI 146.9 ms |
| Operations changing HEAD or commits (checkout, commit, reset, merge) | git process exit → UI updated | ≤ 120 ms | ≤ 200 ms | ≤ 450 ms | pipeline half measured (P2, S): engine **16.4 ms** ✓, CLI 247.0 ms |
| Immediate feedback after a click | Click → pending state shown | ≤ 16 ms (1 frame) | same | same | pending — measured by P3 |
| Find | Typing → highlights updated (over the loaded commits) | ≤ 50 ms | ≤ 50 ms | ≤ 100 ms | pending — measured by P3 + P4 |
| Scrolling | Frame-time P99 with 10 K rows loaded; long tasks > 50 ms | ≤ 16 ms; 0 | same | same | pending — measured by P3 (`PerformanceObserver` + rAF intervals) |
| Memory | webview (10 K rows loaded) / host increment (opening one repo) | ≤ 150 MB / ≤ 40 MB | ≤ 150 MB / ≤ 60 MB | ≤ 250 MB / ≤ 120 MB | pending — measured by P3 (JS heap) + P4 (host increment) |
| Size | First-paint critical JS / critical CSS (minified, not gzipped) | ≤ 360 KB / ≤ 60 KB (JS per [ADR-0005](adr/adr-0005-critical-js-budget-recalibration.md); entry chunk ≤ 200 KB) | — | — | **measured 2026-10-28 after the Commit Details View joined the on-demand half: entry 160.4 KB, closure (entry + static chunks) 332.7 KB, critical CSS 58.9 KB — all inside budget** (gate P5). Commands below |

Rules (§3.8.1, verbatim):

> after Phase 0 measures the baselines, the budgets are **calibrated once** (confirmed
> achievable by real measurement within a week, and recorded in an ADR); afterwards the
> budgets may only **tighten**. T0 → T1 → T2 include VS Code's own webview creation cost,
> which this project does not control; hence the separate "own time" metric as the hard
> number this project can influence.

Calibration status: **partially calibrated (2026-10-27, [ADR-0007](adr/adr-0007-timing-budget-calibration.md))**.
The P2 host gate measured every operation row the P1 markers cover on the S tier (21 samples,
engine AND git-CLI backends, Windows dev machine): the engine path fits every pipeline-half
budget with wide margins (load-more 18.9 ms against 50, details 0.8 ms against 60, refs 3.6 ms
against 60, HEAD-change 16.4 ms against 120, open halves 116.1/95.0 ms against 400/200) — those
budgets stand **as written and may only tighten**. The git-CLI numbers are recorded as the
fallback's expected latencies, deliberately not the calibration basis. Still pending: the
whole-view T0→T5 sums, M/L tiers and the CI Linux environment (the nightly), the in-editor
traces (blocked by the session-logger defect ADR-0007 describes), and every P3-owned row. The
SIZE half is calibrated: the first-paint critical-JS budget was recalibrated once to the
code-split layout's measured floor (200 KB → 360 KB over the entry's static-import closure,
with the entry chunk keeping its own 200 KB target) — the decomposition evidence and the cost
of every alternative are in [ADR-0005](adr/adr-0005-critical-js-budget-recalibration.md); the
CSS budget needed no change (44.4 KB measured against 60 KB at the calibration; 58.9 KB today,
still inside, after the mobile stylesheets merged into the component sheets).

## Measured evidence today

Every number below was produced by the command next to it on this repository.

| Number | Value | Command / source |
|---|---|---|
| Engine first page (200 commits) | 12.6 ms (median of 5) | measured on the v1.0 code and recorded in REFACTOR-PLAN §0.7; the current-tree equivalent is the P2 host gate, re-measured 2026-10-27 (next row) |
| P2 S-tier pipeline, 21 samples (2026-10-27, [ADR-0007](adr/adr-0007-timing-budget-calibration.md)) | engine medians: open-hard 116.1 ms, open-cached 95.0, load-more 18.9, commit-details 0.8, refs-only-refresh 3.6, head-change-refresh 16.4; git-CLI medians: 392.6 / 196.7 / 252.2 / 161.7 / 146.9 / 247.0 | `node test/perf/p2-host.mjs --samples 21 --tier s --backend engine,cli --work-dir test/perf/fixtures/s` (full distribution in `test/perf/results/p2-s.json`) |
| D-2 hidden → visible restore (2026-10-27, [ADR-0007](adr/adr-0007-timing-budget-calibration.md)) | retained 52 ms; non-retained 227 ms (page disposed, full page boot) — **keep the `retainContextWhenHidden: true` default** | `npm run test:e2e -- --tier perf` (scenario `perf/D2-restore`; detail in the run's `report.json`) |
| Webview entry chunk | `media/out.min.js` 164206 B (160.4 KB), budget 200 KB | `npm run build:dist -- --production` then `node test/perf/p5-size.mjs` (item `webview-entry-js`); §3.8.2's slimming target for what the entry itself carries. Measured 2026-10-28, after the Commit Details View's module moved behind the lazy facade (`widgets/lazy.ts`) — the F2 load-machine wiring had pushed the entry to 212.9 KB and the closure to 368.4 KB, over both budgets |
| First-paint critical JS (closure) | 340712 B (332.7 KB) = the entry + the 12 chunks it imports statically, budget 360 KB ([ADR-0005](adr/adr-0005-critical-js-budget-recalibration.md)) | same build, same run (item `first-paint-js-total`); the string table, the inline icons and the data-URI assets are first paint by necessity — the ADR carries the decomposition |
| First-paint critical CSS | 60315 B (58.9 KB) = `media/out.min.css`, budget 60 KB | same build, same run (item `webview-entry-css`); the widget/dialog/details styles ride on-demand chunks (56.5 KB, item `webview-ondemand-js:onDemand`) |
| On-demand chunks (never first paint) | commitDetails 38.1 KB, findWidget 19.2 KB, settingsWidget 66.6 KB, markdown-it 101.2 KB, zh-cn 88.5 KB, reflog 11.8 KB, worktree 11.2 KB, statistics 11.4 KB, styles 56.5 KB | same run (items `webview-ondemand-js:*`); loaded at first use, idle-prefetched after the first paint |
| Host bundle | `dist/extension.js` 456148 B (445.5 KB) | same build, same run (item `host-extension-js`); P5 also gates host-bundle growth (≤ 2% per PR without justification) |
| Universal VSIX | 519125 B (507 KiB) | `npm run package` (no Rust toolchain needed) — pre-split measurement, re-measure when packaging next runs |

The pre-split size measurements (578.7 KiB JS / 101.2 KiB CSS, the evidence ADR-0004 recorded)
remain in [docs/baseline-2026-10.md](baseline-2026-10.md); `npm run baseline` regenerates that
file on the current tree. `media/vendor/` no longer exists: markdown-it rides the on-demand
chunk `media/chunks/markdown-it-*.js` since task 5.9, and `highlight.min.js` (164741 B) was
always the comparison page's, never the graph view's first paint.

## What could not be measured yet, and why

| Item | Blocker | Unblocks via |
|---|---|---|
| Whole-view T0–T5 / operation traces in the editor (P50/P95) | the P4 harness exists (the launcher collects, the entry records windows); on this machine the session logger switches itself off shortly after activation — the product defect [ADR-0007](adr/adr-0007-timing-budget-calibration.md) describes | the logger fix (`src/extension/platform/logger.ts` / `src/extension/main.ts`), then every E2E run's `traces.json` |
| M/L tier timings | the tiers are generatable (`test/perf/fixture.mjs --tier m\|l`); measuring them per-PR is too slow | the nightly P2 S/M job in `.github/workflows/perf.yml` |
| Serialization cost of "load all" (decides §3.8.4) | part of the P2 scenarios on the M/L tiers | the nightly |
| Activation synchronous main-thread time | needs an event-loop-lag probe, not just the ACTIVATION mark | a P4 follow-up |

## Related

- [ADR-0004: performance budgets — calibration status and the tighten-only ratchet](adr/adr-0004-performance-budgets.md)
- [ADR-0005: the first-paint critical-JS budget recalibrated to the split layout's measured floor](adr/adr-0005-critical-js-budget-recalibration.md)
- [docs/baseline-2026-10.md](baseline-2026-10.md) — the generated baseline this document's size numbers come from
- The retired refactor plan's §3.8 (performance architecture), §6.7 (P1–P5 gates), §7.6
  (finalization of this document) — the budgets here are that plan's §3.8.1, verbatim
