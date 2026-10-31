# AGENTS.md

Guidance for AI coding agents working in this repository.

## Language Policy

**All written artifacts are in English.** This applies to:

- **Markdown documents** — README, docs/, ADRs, wiki pages.
- **Code comments** — in Rust, TypeScript, JavaScript, CSS, and scripts.
- **Commit messages** — subjects and bodies, following Conventional Commits (`refactor(host): …`, `fix(tests): …`).
- **PR descriptions, issues, and code-review feedback.**

Legitimate exceptions (do **not** translate these):

- User-facing translated strings: the zh-cn dictionaries (`package.nls.zh-cn.json`, the zh-cn entries in the i18n string tables) and Chinese UI text embedded in code that renders or matches UI labels (e.g. `bi('Show All', '显示全部')`, the `.zhCn` command titles in `package.json`).
- Test fixtures and assertions that verify the Chinese interface.
- Quoting actual Chinese UI text inside examples (e.g. a menu-item selector in an E2E scenario).

When in doubt, write English. Never introduce new Chinese comments, documents, or commit messages.

## Repository Layout

- `src/` — the three-layer TypeScript tree: `src/extension/` (extension host), `src/webview/` (DOM; no `vscode` or Node imports), `src/shared/` (isomorphic protocol, models, i18n). `src/shared/engine/` holds TS types **generated from Rust via ts-rs**; never hand-edit — regenerate with `cargo test` in `native/core`.
- `native/` — Rust engine (`native/core` = pure engine, `native/node` = N-API binding).
- `test/` — integration, tooling, E2E and perf suites; unit tests are colocated (`src/**/*.test.ts`).
- `scripts/` — build, packaging, bench, and automation tooling.
- `docs/` — architecture and reference documents (`ARCHITECTURE.md`, the DoD ledger, the baselines) and the ADRs in `docs/adr/`.

## Common Commands

```bash
npm run build          # build the native addon, then the production dist bundle
npm test               # cargo test --workspace, then the Vitest suite
npm run test:rust      # Rust engine tests only (also regenerates src/shared/engine/)
npm run test:unit      # the Vitest suite only
npm run lint           # cargo clippy (deny warnings) + cargo fmt --check
npm run package        # produce a VSIX
cargo test --workspace # regenerates src/shared/engine/ TS types (ts-rs)
```

## Conventions

- Commit style: Conventional Commits, English only, one feature per commit (a change, its tests, and its doc updates land together).
- Code style: tabs for indentation, single quotes, semicolons (matches existing code).
- Rust: no `unsafe` in the engine; keep `cargo clippy --workspace --all-targets -- -D warnings` clean.
- Non-generated source files stay ≤ 600 lines — split a module that outgrows the limit (CONTRIBUTING.md has the details).
- If a change alters structure or reverses a recorded decision, update `docs/ARCHITECTURE.md` in the same commit and record the decision in `docs/adr/`.
