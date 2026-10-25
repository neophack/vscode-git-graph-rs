# E2E Baseline (task 0.6 / 1.10 groundwork)

First real-VS Code smoke run of the automation catalog through the new
launcher (`npm run test:e2e -- --tier smoke`). Environment: VS Code
1.143.1 (stable), Windows dev machine, engine backend, English UI.

## Latest local run (2026-10-25, 25 scenarios, 138 s)

18 passed, 5 failed, 2 skipped. Full per-scenario output lives in
`test/e2e/results/<timestamp>-smoke/` after a local run; the stable
summary:

| Result | Scenarios |
|---|---|
| pass | S2 S3 S7 S8, control-bar/fetch refresh statistics, find/type-query, host/open-log-file, menu-branch/push, menu-remote-branch/fetch-into, and 8 more UI-driven catalog actions |
| fail | S1 (row render timeout), S4 (`local-ahead` selector), S5 (bilingual "Add Tag…" item missing from a 6-item menu), external/commit-appears (watcher-driven refresh), keyboard/key-find (`.findWidget.active` never appears) |
| skip | S6 (needs a credential-demanding HTTPS remote + answerable askpass via ScriptedUiPort), S9 (meaningful only under `--backend cli`; the CLI run covers S1-S4 by construction) |

The five failures are open work against the merged tree: they were
diagnosed against the pre-split webview and must be re-run now that
tasks 5.9/5.10 landed (module-script boot, lazy widgets, scheduler).
S1/S4/S5 read like selector/timing drift; external/commit-appears
depends on the file-watcher refresh path (task 4.8's impact refresh
changed the post-write flow).

## How to run

```
npm run build && npm run test:e2e -- --tier smoke
npm run test:e2e -- --tier smoke --headed --keep-open   # debug a failure
```

The launcher downloads and caches VS Code under `.vscode-test/`,
boots an isolated profile per run (`--user-data-dir`/
`--extensions-dir`/`--disable-extensions`, pinned `HOME`,
`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `TZ`, fixed author dates),
stages the automation build, runs the scenario executor inside the
extension host, and writes JUnit + JSON + HTML reports plus failure
evidence (webview DOM, console, host log, git-state diff) under
`test/e2e/results/`.

## CI

`.github/workflows/e2e.yml` runs the smoke tier on ubuntu + xvfb per
push; the affected tier selects scenario tags from the changed files
(`affected.ts`, directory-to-tag mapping; unmapped directories select
the full tier). Not yet executed in CI - the workflow mirrors the
verified local commands; expect first-run iteration.

## Coverage matrix status

Not wired yet: the matrix generator (scripts/dev/coverage-matrix.mjs)
and the scenario tags exist; the gate lands with task 6.4.
