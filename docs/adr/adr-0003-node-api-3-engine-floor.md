# ADR 0003: The engine targets Node-API 3 (VS Code 1.38 can load it); loader preflight deferred

Date: 2026-10-25
Status: Accepted

## Context

REFACTOR-PLAN task 2.7 (§3.7.4) spiked whether the unified `request` entry could drop the
`napi4`/`async` crate features and run on Node-API 3 — the version VS Code 1.38/1.39 ship — so
the oldest supported editor could use the engine instead of silently falling back to the CLI.
The plan recorded the fallback shape if the spike failed: keep N-API 4 and have `addonLoader`
compare `process.versions.napi` before attempting `require`, going straight to the CLI.

## Decision

The spike succeeded, and its result is the shipped state rather than a deferred item: the
binding crate builds against Node-API 3 with runtime symbol resolution
(`napi = { default-features = false, features = ["napi3", "dyn-symbols"] }` in
`native/node/Cargo.toml`), and the asynchronous entry points are `AsyncTask`s
(`napi_create_async_work`, Node-API 1) instead of the N-API 4 promise APIs — so VS Code 1.38's
Node 10.11 can load the engine, and nothing in `native/node` may require a newer Node-API.

The loader half of §3.7.4 remains future work, unchanged from the plan's fallback shape:
`addonLoader` still needs the N-API/`process.versions` preflight and the five failure classes
(no binary for the platform / N-API too low / libc mismatch / load exception / runtime panic),
each falling back to the CLI with exactly one log line and a reason on the settings page;
compatibility test C2 (loading the engine on Node 10.11 in CI) verifies it once implemented.

## Consequences

- VS Code 1.38–1.39 get engine acceleration; there is no N-API-version fallback tier today
  because the engine no longer needs one. A regression that pushes the crate above napi3 must
  be caught in review of `native/node/Cargo.toml`.
- The preflight and failure-classification work moves to the host-side backlog (the
  `src/extension/git/read/addonLoader.ts` seam, Phase 3); nothing in this wave claims it.
- Binaries remain loadable from Electron 4 (Node 10.11, N-API 3) through current Node; a CI
  load check on Node 10.11 (C2) is still pending.

Commits: `3251806` (one typed request protocol replaces the per-method N-API exports — where
the `napi3`/`AsyncTask` shape landed, per its message "on N-API 3 so VS Code 1.38-1.39 can load
it"), `35043b4` / `78794a9` (cancellation through the same AsyncTask seam).
