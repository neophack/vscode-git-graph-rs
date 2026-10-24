# AGENTS.md

Guidance for AI coding agents working in this repository.

## Language Policy

**All written artifacts are in English.** This applies to:

- **Markdown documents** — README, docs/, plans, ADRs, wiki pages.
- **Code comments** — in Rust, TypeScript, JavaScript, CSS, and scripts.
- **Commit messages** — subjects and bodies, following Conventional Commits (`refactor(host): …`, `fix(tests): …`).
- **PR descriptions, issues, and code-review feedback.**

Legitimate exceptions (do **not** translate these):

- User-facing translated strings: the zh-cn dictionaries (`package.nls.zh-cn.json`, the zh-cn entries in the i18n string tables) and Chinese UI text embedded in code that renders or matches UI labels (e.g. `bi('Show All', '显示全部')`, the `.zhCn` command titles in `package.json`).
- Test fixtures and assertions that verify the Chinese interface.
- Quoting actual Chinese UI text inside examples (e.g. menu-item selectors in the E2E scenario samples in `docs/REFACTOR-PLAN.md`).
- `legacy/` — a frozen, pure-`git mv` copy of the v1.0 sources kept only as a migration reference; it is drained and deleted over the course of the refactor. Do not edit files there, including their comments.

When in doubt, write English. Never introduce new Chinese comments, documents, or commit messages.

## Repository Layout

This repository is mid-refactor (see `docs/REFACTOR-PLAN.md` for the target architecture and phase plan):

- `src/` — new tree. Currently `src/shared/engine/` (TS types **generated from Rust via ts-rs**; never hand-edit — regenerate with `cargo test` in `native/core`).
- `native/` — Rust engine (`native/core` = pure engine, `native/node` = N-API binding).
- `legacy/` — frozen v1.0 sources (old `src/`, `web/`, `tests/`, build scripts). Read-only reference; code migrates out of here phase by phase.
- `scripts/` — build, packaging, bench, and automation tooling.
- `docs/` — plans and reference documents.

## Common Commands

```bash
npm run build          # build the native addon, then TypeScript
npm test               # cargo test --workspace, then the Node test suite
npm run test:rust      # Rust engine tests only
npm run test:node      # Node-side tests only
npm run lint           # cargo clippy (deny warnings) + cargo fmt --check
npm run package        # produce a VSIX
cargo test --workspace # regenerates src/shared/engine/ TS types (ts-rs)
```

## Conventions

- Commit style: Conventional Commits, English only.
- Code style: tabs for indentation, single quotes, semicolons (matches existing code).
- Rust: no `unsafe` in the engine; keep `cargo clippy --workspace --all-targets -- -D warnings` clean.
- Refactoring rules (PR size, pure-move PRs, test replacement mapping) are defined in `docs/REFACTOR-PLAN.md` §2.3 — follow them for refactor work.
