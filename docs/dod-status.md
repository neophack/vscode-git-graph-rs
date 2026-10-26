# Definition of Done — status

REFACTOR-PLAN §11, item by item, as of 2026-10-26 (`task/m0-gates`). Every evidence command runs
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
| 3 | No non-generated file > 600 lines | **ratcheted** (15 TS + 2 Rust) | `static` job: ESLint `max-lines` (suppressed files listed in `eslint-suppressions.json`) and `npm run lint:size` (Rust `KNOWN` list). `commitTable.ts` crossed 600 after the plan was written; the gate now records it |
| 4 | `dataSource.ts`, `gitGraphView.ts`, `contract.test.mjs`, `check-i18n-parity.cjs`, `package-src.js`, `package-web.js` deleted | **held locally** | `git ls-files` lists none of them; no gate would stop one coming back, and none is needed |
| 5 | Handler table + engine enum compiler-complete; `src/shared/engine/` generated, drift-checked | **held** | `satisfies` table checked by `npm run typecheck`; `static` job → `npm run check:generated` regenerates and runs `git diff --exit-code -- src/shared/engine` |
| 6 | `child_process` only in `extension/git/process/`; argSafety 1 call site | **not held** | 6 production files outside `git/process/` import `child_process` (`git/read/cli/process.ts`, `git/read/cli/files.ts`, `views/binaryCompare/hexDiff.ts`, `hexDiffSources.ts`, `utils/childProcess.ts`, `utils/findGit.ts`), plus 2 automation files; `checkUnsafeGitArgs` has 19 call sites in 6 files. No rule enforces either (OPTIMIZATION-PLAN A3) |
| 7 | Tests layered L0–L4; no artifact imports; no `new Function`; coverage thresholds | **held** for coverage; layering **held locally** | `integration` job (ubuntu) → `npm run test:coverage` fails below the floors in `vitest.config.ts`. The test tree is now typechecked (`npm run typecheck`, root `tsconfig.json`) |
| 8 | L4 smoke in CI; automation suite green pre-release | **not held** | `.github/workflows/e2e.yml` exists and mirrors the local run (`docs/e2e-baseline.md`), but has not been executed by Actions |
| 9 | `engines.vscode` ^1.38.0; @types/vscode 1.38.0; C1–C6 pass in release pipeline | **held** for C1/C2; C3–C6 **not held** | es2018/es-check/stylelint/compat gates run in every `build:dist` (`integration` job) and in `npm run check`; `runtime-smoke` job runs Node 10.11/12.4/20; no workflow runs C3–C6 |
| 10 | Host artifacts pass Node 10.11 smoke; webview chrome69 checks | **held** | `runtime-smoke` job (Node 10.11.0); `compat.mjs` + es-check inside `build:dist`; ESLint `compat/compat` at error |
| 11 | glibc ≤2.17, musl/armhf binaries; every engine-unavailability class falls back visibly | **held** for glibc on the built targets; musl/armhf **not held** | `build` job runs `check-binary-compat.mjs` with `BINARY_COMPAT_REQUIRED=1`; the musl/armhf targets exist in `build-addon.mjs` but are in neither the CI nor the release matrix (OPTIMIZATION-PLAN R8) |

## Gates added with this ledger (OPTIMIZATION-PLAN M0)

- `npm run check`, run by the CI `static` job: four typechecks, ESLint, stylelint,
  dependency-cruiser, Rust file size, clippy + rustfmt, generated-type drift.
- ESLint: every rule at error over a bulk-suppression backlog (306 entries), plus
  `no-floating-promises`, `no-misused-promises`, `await-thenable` and
  `switch-exhaustiveness-check` on production sources, and unused disable directives as errors.
- Coverage floors per area (`vitest.config.ts`), enforced on ubuntu.
- `npm ci` without the `npm install` fallback, so lockfile drift fails CI.
- Third-party actions pinned by commit SHA (Dependabot keeps them current); no `curl | sh`.
