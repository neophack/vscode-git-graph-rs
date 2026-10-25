# ADR 0005: The plan's open decisions D1–D15 are ratified as built

- Status: accepted
- Date: 2026-10-26
- Deciders: the refactor working sessions (this repository's dev-refactor line)

## Context

REFACTOR-PLAN §10 listed fifteen decisions (D1–D15) with recommendations. The waves that
landed since (Phases 1–6, tasks 0.6/1.10 through 6.x) implemented each recommendation; this
ADR records the ratification so §10 stops reading as "to be made".

## Decision

| # | Decision | Ratified as |
|---|---|---|
| D1 | `engines.vscode` | Stays `^1.38.0`, held by the artifact baselines (`node10.11`/`chrome69`) and the es-check/stylelint/compat gates (C1/C2) |
| D2 | Test framework | Vitest for L0–L3; plain node scripts for artifact/compat checks; no `node --test` in the end state |
| D3 | Unit test location | Colocated `*.test.ts` next to sources; cross-module suites in `test/` |
| D4 | Prettier | Not introduced; ESLint stylistic freezes the existing style |
| D5 | N-API surface | Converged: `open/close/closeAll/openCount/engineVersion/request/requestBytes/cancel` over one typed protocol (adr-0003) |
| D6 | Web framework | None; store + components on Chromium 69-safe DOM |
| D7 | Minimum Git | 2.0 for reads; writes tiered by `git/executable/capabilities.ts` |
| D8 | Linux glibc floor | 2.17 via `cargo-zigbuild` (adr-0002) |
| D9 | Windows 7/8.1 | Extension supports them over the CLI; the engine needs Windows 10 |
| D10 | Snapshot first paint | On by default (disable via `git-graph-rs.snapshotFirstPaint`); landed with task 5.9 |
| D11 | Background prewarming | On by default, ≤ 3 repositories, after 2 s idle; landed with task 4.9 |
| D12 | Optimistic writes | No data-level optimism; same-frame pending feedback only |
| D13 | Native-UI driving | ScriptedUiPort primary (landed, task 4.10); Playwright+Electron remains the release-tier supplement |
| D14 | E2E executor | The AutomationEngine + scenario catalog as libraries; no Mocha (landed, tasks 0.6/1.10) |
| D15 | PR-gate E2E scope | smoke + affected tiers per PR, full tier nightly; the tier machinery landed with task 1.10 |

## Consequences

- REFACTOR-PLAN §10 is historical; disagreements now go through new ADRs, not §10 edits.
- The DoD checklist (§11) is tracked in `docs/dod-status.md` with per-item evidence.
