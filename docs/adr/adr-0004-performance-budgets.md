# ADR 0004: Performance budgets stay as written until the P-gates calibrate them

Date: 2026-10-25
Status: Accepted

## Context

REFACTOR-PLAN §3.8.1 defines the performance budgets as acceptance criteria (goal G8) and
task 0.5 requires them to be **calibrated once** against real measurements — "confirmed
achievable by real measurement within a week, and recorded in an ADR" — after which they may
only tighten. The calibration inputs are the P50/P95 measurements of the P1–P5 gates
(§6.7), whose harness is under construction in `test/perf/` and `native/core/benches/`.

As of 2026-10-25 the measured evidence in the repository is partial:

- **Size (P5) is measurable today** and was measured: first-paint critical JS 578.7 KiB /
  critical CSS 101.2 KiB against budgets of 200 KB / 60 KB — over budget, as expected before
  tasks 1.9 (markdown-it off first paint) and 5.9 (first-paint splitting). Host bundle 446.6 KiB;
  universal VSIX 507 KiB. Generated and reproducible via `npm run baseline`
  (`docs/baseline-2026-10.md`).
- **One backend read measurement exists** from the v1.0 code: engine 12.6 ms vs git CLI
  205.3 ms for a 200-commit first page, median of 5 (`bench.mjs`, recorded in
  REFACTOR-PLAN §0.7). It is evidence the engine read path is fast, not a T0–T5 measurement.
- **No timing scenario has a measurement**: the T0–T5 markers (§3.8.7) do not exist in the
  code yet, and the S/M/L fixture generator is task 0.5 work.

The open question was whether to calibrate (i.e. change) the budget numbers now, keep them,
or abandon budgeting until the harness lands.

## Decision

The §3.8.1 budgets stay **binding as written**; no number is changed, relaxed, or deleted
today. Calibration is deferred to the moment the P-gate harness produces per-scenario P50/P95
on S/M/L — one calibration, recorded by superseding this ADR, and after that the budgets may
only **tighten** (the ratchet rule). Relaxing a budget requires a superseding ADR that shows
the measurement context and the cost of the alternative.

`docs/performance.md` is the tracking document: the §3.8.1 table verbatim plus a status
column in which every entry is either a measured number with its command or
`pending — measured by <P-gate>`. Numbers without commands are never written.

Commit: `b640de6` (the baseline generator that produced the size evidence; this change adds
the tracking document and this record).

## Consequences

- The over-budget size row is an explicit, tracked gap owned by tasks 1.9 and 5.9 and gated
  by P5 — not a reason to raise the 200 KB / 60 KB budgets.
- The P-gates inherit fixed targets to compare against from their first run; the calibration
  can only confirm or (with evidence) argue a change through a superseding ADR.
- Anything the current environment cannot measure says so with the reproduce command
  (engine-vs-CLI bench, coverage, platform VSIX sizes — see `docs/baseline-2026-10.md`),
  which keeps "not measured" distinguishable from "meets budget".
- When P4's end-to-end markers land, task 7.6 finalizes `docs/performance.md` with the
  measured P50/P95 tables and trend charts; this ADR is then superseded by the calibration
  record.
