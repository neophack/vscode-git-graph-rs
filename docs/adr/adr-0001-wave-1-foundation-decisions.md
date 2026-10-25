# ADR 0001: The wave-1 foundation decisions

Date: 2026-10-25
Status: Accepted

## Context

The first refactor wave (REFACTOR-PLAN Phase 0 + Phase 1 foundation, and the early Phase 3/4
extractions) had to pick the mechanisms everything after it builds on: how the host is built
and kept on the VS Code 1.38 floor, how TypeScript and Rust share wire types, how the webview's
requests reach the host without a 92-branch switch, and where new tests go. Each choice was
made once, deliberately, and the rest of the plan depends on all four.

## Decision

Four decisions, taken as a set:

1. **One esbuild dist pipeline with an ES2018 gate.** The host bundles into a single
   `dist/extension.js` on the `node10.11` target; the webview still emits to `media/`; a
   compatibility scan fails the build on any post-ES2018 syntax in the artifacts. The old
   `out/` per-file tsc pipeline keeps shipping until the dist pipeline proves itself, then is
   deleted.
   Commits: `c2e2322` (one esbuild pipeline bundles host and webview into dist), `01e2a4c`
   (es2018 compatibility gate over dist and media artifacts), `68079cb` (dist-aware packaging
   manifest and build regression test).

2. **One typed protocol, generated from Rust via ts-rs.** The engine defines the request
   protocol once; `cargo test` regenerates `src/shared/engine/protocol.ts`, and the N-API
   surface shrank from ~40 per-method exports to one typed request seam. The TS side derives
   its view protocols (`shared/protocol/graphView.ts` etc.) from the same generated types, so
   drift is a compile error, not a runtime surprise.
   Commits: `3251806` (one typed request protocol replaces the per-method N-API exports),
   `80ef76b` (the TS adapter speaks the generated protocol, one request seam), `5354043`
   (typed request map for the graph view protocol), `335868f` (typed protocols for the
   comparison and binary compare views).

3. **The exhaustive handler table.** Each `RequestCommand` of the graph view protocol gets
   exactly one `Handler`, assembled in `src/extension/graphView/handlers/index.ts` where a
   `satisfies` check makes exhaustiveness a compile-time property. Handlers reach the outside
   world only through `HandlerContext` ports, which is what keeps them unit-testable while the
   legacy message switch still runs the shipped view.
   Commits: `80e85a1` (exhaustive request handler table for the graph view), `d908ebe` (wire
   the commit loader into the handler table).

4. **Vitest for source-colocated unit tests.** New tests are `src/**/*.test.ts` run by Vitest
   straight against TypeScript, no build step; the legacy `tests/*.test.mjs` suite (node:test
   against build outputs) is frozen coverage that drains as scenarios migrate and disappears
   in Phase 7.
   Commit: `580f1cb` (introduce vitest for source-colocated unit tests).

## Consequences

- Contributors regenerate engine types with `cargo test`, never hand-edit
  `src/shared/engine/` (enforced by the generated header).
- Adding a request command is a compiler-guided walk: protocol type → handler entry (the
  `satisfies` check points at the missing one) → response branch.
- Two host pipelines coexist (`out/` shipping, `dist/` gating) until the switchover; the
  compat gate means the dist pipeline cannot silently regress the 1.38 floor.
- Test placement is now mechanical: new unit coverage goes next to its source under `src/`,
  and only harness-level or cross-module scenarios justify touching `tests/`.
