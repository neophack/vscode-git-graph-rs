# Definition of Done — status

REFACTOR-PLAN §11, item by item, as of 2026-10-27 (`task/m0-gates`). Every evidence command runs
on a clean checkout.

**The rule.** A row is **held** only if a CI job fails when it regresses. A property that is true
today but that nothing would catch breaking is **held locally**. Anything else is **not held**.
Where a gate exists but tolerates a recorded backlog, the row says **ratcheted**: new violations
fail CI, and the backlog may only shrink (CONTRIBUTING.md, "Static checks").

The CI jobs named here are defined in `.github/workflows/native-build.yml`. The `static` job and
the coverage step were added with this ledger and have not yet run on GitHub Actions; until their
first green run, read "held" as "held by a job that is defined but not yet observed".

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | One `npm run build`; `dist/` the only artifact; VSIX manifest test green | **held** | `integration` job builds dist and runs `test/tooling/distBuild.test.ts` (allowlist contract); `package` job assembles the artifact |
| 2 | Dependency rules at `error`, no cycles | **ratcheted** (15 baselined) | `static` job → `npm run lint:deps` fails on a new violation and on a stale baseline entry. Baseline: 7 git-layer imports of `src/types/*`, 7 vscode imports outside `platform/`, 1 webview import of `src/types` (the flat-root pocket, OPTIMIZATION-PLAN A1) |
| 3 | No non-generated file > 600 lines | **held** | `static` job: `npm run lint:size` holds both languages. Its `KNOWN` list is empty since the A5 splits — no production file is over the limit, and the list may only shrink (ESLint `max-lines` was dropped: a bulk suppression counts violations, not lines, so suppressed files grew unchecked). Rust has no entries since the R8a splits and the incremental-store split (31 production `.rs` files, none over 600) |
| 4 | `dataSource.ts`, `gitGraphView.ts`, `contract.test.mjs`, `check-i18n-parity.cjs`, `package-src.js`, `package-web.js` deleted | **held locally** | `git ls-files` lists none of them; no gate would stop one coming back, and none is needed |
| 5 | Handler table + engine enum compiler-complete; `src/shared/engine/` generated, drift-checked | **held** | `satisfies` table checked by `npm run typecheck`; `static` job → `npm run check:generated` regenerates and runs `git diff --exit-code -- src/shared/engine` |
| 6 | `child_process` only in `extension/git/process/`; argSafety 1 call site | **held** (child_process) / **ratcheted** (argSafety) | A3 landed (wave 3): the `n/no-restricted-imports` rule enforces `child_process` to `git/process/**` and `automation/**` with zero exceptions; the CLI read path, hex-diff streams and findGit's probes all went through the process adapter. `checkUnsafeGitArgs` has 2 call sites (`gitWriter.ts`, `graphView/writeFlows.ts` — the write flows assemble their own ref checks before the writer runs), down from 19 in 6 files |
| 7 | Tests layered L0–L4; no artifact imports; no `new Function`; coverage thresholds | **held** for coverage; layering **held locally** | `integration` job (ubuntu) → `npm run test:coverage` fails below the floors in `vitest.config.ts`. The test tree is now typechecked (`npm run typecheck`, root `tsconfig.json`) |
| 8 | L4 smoke in CI; automation suite green pre-release | **not held** | `.github/workflows/e2e.yml` exists and mirrors the local run (`docs/e2e-baseline.md`), but has not been executed by Actions |
| 9 | `engines.vscode` ^1.38.0; @types/vscode 1.38.0; C1–C6 pass in release pipeline | **held** for C1/C2; C3–C6 **not held** | es2018/es-check/stylelint/compat gates run in every `build:dist` (`integration` job) and in `npm run check`; `runtime-smoke` job runs Node 10.11/12.4/20; no workflow runs C3–C6 |
| 10 | Host artifacts pass Node 10.11 smoke; webview chrome69 checks | **held** | `runtime-smoke` job (Node 10.11.0); `compat.mjs` + es-check inside `build:dist`; ESLint `compat/compat` at error |
| 11 | glibc ≤2.17, musl/armhf binaries; every engine-unavailability class falls back visibly | **held** for glibc on the built targets; musl/armhf **ratcheted** (matrix defined, first Actions run pending) | `build` job runs `check-binary-compat.mjs` with `BINARY_COMPAT_REQUIRED=1`; the musl x64/arm64 and armhf targets are in the build and release matrices since R8b (zigbuild install added to the job — a pre-existing gap that also affected the linux-gnu legs). Still open: the loader cannot select the new binaries (libc/armv7 detection), the C3 container smoke, and `package-platforms.mjs`'s three new vsce targets are unexercised |

## Gates added with this ledger (OPTIMIZATION-PLAN M0)

- `npm run check`, run by the CI `static` job: four typechecks, ESLint, stylelint,
  dependency-cruiser, Rust file size, clippy + rustfmt, generated-type drift.
- ESLint: every rule at error over a bulk-suppression backlog (306 entries), plus
  `no-floating-promises`, `no-misused-promises`, `await-thenable` and
  `switch-exhaustiveness-check` on production sources, and unused disable directives as errors.
- Coverage floors per area (`vitest.config.ts`), enforced on ubuntu.
- `npm ci` without the `npm install` fallback, so lockfile drift fails CI.
- Third-party actions pinned by commit SHA (Dependabot keeps them current); no `curl | sh`.

## Gates added with the wave-1 workstreams (OPTIMIZATION-PLAN §12)

- `rust-gates.yml`: MSRV (`cargo +1.88 check --workspace --locked`, the honest dependency floor —
  67 of 194 locked crates declare above the old 1.82) and cargo-deny (licenses, advisories,
  duplicates, wildcards, unknown sources) on every push and PR.
- `[workspace.lints]`: `unsafe_code = "forbid"` in the engine (the N-API binding keeps a scoped
  allow — napi-derive emits attribute-level allows that a forbid turns into a hard E0453) plus a
  pedantic clippy subset; `rust-toolchain.toml` pins the dev toolchain.
- Shipped-artifact size baselines (`check-file-size.mjs`): total VSIX and every present `.node`
  binary, 2% growth rule, unbudgeted artifacts fail. First catch: the F7 dictionary unification
  tripped it at +2.56% (both single-file pages embedded the full bilingual dictionaries); the
  generated i18n subset brought the VSIX back to +0.42%.
- `npm run check:generated` additionally regenerates and diffs the webview i18n subset, so the
  single-file pages' string table cannot drift from the shared dictionaries.
