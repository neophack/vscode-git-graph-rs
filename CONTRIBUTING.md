# Contributing to Git Graph (Rust)

Thanks for helping. This file covers the day-to-day commands and the conventions a change is
reviewed against; the shape of the tree and how the pieces connect are described in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and the why behind the ongoing refactor lives in
[`docs/REFACTOR-PLAN.md`](docs/REFACTOR-PLAN.md).

## Build

```bash
npm install            # once (node_modules is gitignored)
npm run build          # native addon (debug) + the production dist bundle (dist/ + media/)
npm run build:dist     # the dist pipeline alone: one esbuild bundle → dist/ + the webview + compat gate
node scripts/dev/install.mjs   # the full dev chain: deps → native → compile → tests → VSIX →
                               # install into VS Code (see --help; --dry-run prints the steps)
```

An `npm run dev:install` alias for the install script is planned; until it exists, invoke it
with Node as above.

The Rust engine is a cargo workspace: `cargo build` / `cargo test` in the repo root act on
`native/core` (the pure engine) and `native/node` (the N-API binding). Cross-platform engine
binaries are built with `node scripts/dev/install.mjs --full` (or `--only <triple>`), which
replaces the former root `build-*.bat`/`.sh` wrappers.

## Test

```bash
npm test               # cargo test --workspace, then the Vitest suite
npm run test:rust      # the engine (also regenerates src/shared/engine/protocol.ts via ts-rs)
npm run test:unit      # the whole Vitest suite (what CI runs after cargo)
npx vitest run         # the same, directly
```

- **Unit and integration tests are Vitest**: `src/**/*.test.ts` colocated with the module under
  test, plus `test/integration/**` (real-git reader/writer contracts, the webview journeys
  against the compiled bundle, the real-pipeline automation suites), `test/tooling/**` (build
  and artifact contracts), `test/e2e/**` (real VS Code) and `test/perf/**` (the P gates). The
  source-based suites need no build; the webview journeys and the tooling suites need
  `npm run build:dist` first and self-skip without it.
- `cargo test` is also the generator for the cross-language types: never hand-edit
  `src/shared/engine/protocol.ts`; change the Rust `protocol.rs` and regenerate.

## Drain record (Phase 7, task 7.1)

The legacy `node --test` suite (`tests/*.test.mjs` with its `vscodeStub`/harness modules, and
the `npm run test:node` / `test:node:cov` / `test:automation:full` scripts) is deleted; every
scenario was either migrated into the Vitest layers above with its assertions preserved, or
deleted together with its owning machinery (the `out/` build, the packaging substitution, the
full-test script). The complete old→new mapping is recorded in the drain commit's message. The
test layout is now exactly the L0–L4 structure of `docs/REFACTOR-PLAN.md` §6.1; there is no
separate legacy runner.

## Lint

```bash
npm run lint           # cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check
```

Warnings are errors. The Rust engine takes no `unsafe`. The TypeScript lint toolchain
(ESLint, dependency-cruiser, compat rules) is being brought up alongside the refactor; its
rules tighten per the plan's §3.6 dependency rules as each directory's migration completes.

## Repository layout and where code goes

The short version (the long one is `docs/ARCHITECTURE.md`):

- `src/extension/`, `src/webview/`, `src/shared/` — the layered tree. Host code goes in
  `extension/`, webview code in `webview/` (no `vscode`, no Node imports), anything shared
  (protocols, models, i18n) in `shared/`. The remaining `src/*.ts` flat files
  (`extension.ts`, `config.ts`, `i18n.ts`, `commands.ts`, ...) are the composition root and
  the not-yet-absorbed seams — do not add new modules there.
- `native/core`, `native/node` — the Rust engine and its Node binding.
- `test/` — integration, tooling, e2e and perf suites; unit tests are colocated
  (`src/**/*.test.ts`).
- `scripts/build/`, `scripts/dev/`, `scripts/` — build pipeline, developer entry points, and
  the not-yet-consolidated packaging/audit tooling.
- `docs/` — this file, ARCHITECTURE.md, the REFACTOR-PLAN, and `docs/adr/`.

## Conventions

- **Language.** Everything written — comments, docs, commit messages, review feedback — is in
  English. The only Chinese text in the repo is translated UI strings and the tests that
  verify them (see `AGENTS.md`).
- **Commits.** [Conventional Commits](https://www.conventionalcommits.org/) (`feat(host): …`,
  `fix(webview): …`, `docs: …`, `chore: …`), English only, and **one feature per commit**:
  a change, its tests, and its doc updates land together; unrelated cleanups ride in their own
  commit.
- **File size.** Non-generated source files stay **≤ 600 lines** (string tables and generated
  code excepted). When a module outgrows it, split it — the plan's §2.3 covers the pure-move
  PR discipline for exactly this.
- **Docs stay true (goal U8).** If your change alters structure or reverses a recorded
  decision, update `docs/ARCHITECTURE.md` or `CONTRIBUTING.md` in the same commit, and record
  the decision in `docs/adr/` if it is one worth keeping.

## Architecture decision records

Decisions that outlive the PR that made them (build pipeline choices, protocol strategy, test
strategy) are recorded in [`docs/adr/`](docs/adr/README.md). To add one, copy the format from
`docs/adr/README.md`, take the next free number, and set the status to `Accepted` (or
`Superseded by adr-NNNN` when a later ADR replaces yours).
