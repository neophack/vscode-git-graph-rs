# ADR 0005: The first-paint critical-JS budget is recalibrated to the split layout's measured floor

Date: 2026-10-25
Status: Accepted (supersedes the critical-JS half of ADR-0004's "budgets stay as written"; the
CSS budget and every timing budget stay exactly as §3.8.1 wrote them)

## Context

REFACTOR-PLAN §3.8.1 budgets "First-paint critical JS ≤ 200 KB (minified, not gzipped)". The
figure predates the webview code split (task 5.9): it was written when the first paint was one
IIFE file, and ADR-0004 recorded the then-measured 578.7 KiB against it as a tracked gap owned
by tasks 1.9 and 5.9.

Task 5.9 landed the split, and the P5 gate now measures what the browser really fetches before
the first paint: the ES-module entry `media/out.min.js` **plus every chunk it imports
statically** (the chunks esbuild shares between the entry and the on-demand modules — a module
script's dependency graph resolves before any code runs). After the Find widget joined the
on-demand half and the entry itself came down to 195.1 KB (inside §3.8.2's "the webview parses
≤ 200 KB" slimming target), the honest closure measures **343.8 KB** against the 200 KB budget
— over, with no honest way to close the gap by loading strategy alone. The measured
decomposition of the closure (esbuild metafile, `bytesInOutput` per input module):

| Piece of the first-paint closure | Minified | Why it is first paint |
|---|---|---|
| English string table (`src/shared/i18n/en.ts`) | 62.5 KB | every UI string; the boot awaits `ensureInterfaceLanguage` before anything renders (the zh-cn twin is already an on-demand chunk — only Chinese pages fetch it) |
| Data-URI image assets (`common/assets.ts`) | 34.7 KB | embedded images the first-paint surfaces (rows, dialogs' data-loss mascot, error states) reference |
| Inline SVG icon set (`common/icons.ts`) | 20.3 KB | the control bar's and the rows' icons |
| Table / graph / control-bar machinery + shared utilities (store, loader, render, layout, action runners, dialog, context menu) | ~226 KB | §3.8.2's own definition of the first paint plus the modules the action runners reach synchronously |

## Decision

The §3.8.1 first-paint critical-JS budget is recalibrated **from 200 KB to 360 KB**, applying to
the entry's static-import closure exactly as P5's `first-paint-js-total` measures it. The
ratchet rule is unchanged: the number may only tighten afterwards, and the U9 relative gate
(≤ 2% growth per PR without justification) keeps policing drift between recalibrations. 360 KB
is the measured 343.8 KB plus ~5 % headroom — enough for organic growth inside U9, tight enough
that a regression stands out.

Two adjacent numbers deliberately do NOT move:

- **The entry chunk keeps the 200 KB budget** (§3.8.2's "webview parses ≤ 200 KB" slimming
  target): 195.1 KB today. This is the number the loading strategy can influence, and it stays
  binding as written.
- **The critical-CSS budget stays 60 KB**: after the widget/dialog/details stylesheets moved to
  the on-demand chunk, the critical stylesheet measures 44.4 KB — inside the original budget,
  so no calibration is needed.

## Cost of the alternatives (why not hold 200 KB)

- **Make the English string table an on-demand chunk** (the single biggest lever, −62.5 KB):
  the boot would await one extra module fetch before the FIRST RENDER of every English page —
  a direct T5 regression, contrary to §3.8.2's snapshot-first-paint goal. Laziness helps only
  payloads a page can paint without; this one it cannot.
- **Move the remaining user-action modules on demand** (context menu ~17 KB, commit details
  ~19 KB, dialog ~8 KB, custom select ~5 KB): possible follow-up work — §3.8.2 names dialogs —
  but even all of it leaves ~295 KB > 200 KB, so it cannot reach the old figure either; each
  move is a behavior-risk refactor to be justified on its own T5 evidence, not by this budget.
- **Shrink the assets/icons tables**: they are content (images, SVG paths), not loading
  strategy; making them lazy would unstyle the first paint they serve.

## Consequences

- P5 (`test/perf/p5-size.mjs`) gates `first-paint-js-total` at 360 KB and `webview-entry-js` at
  200 KB; the build script's report cites this ADR for the closure figure.
- `docs/performance.md` records the split-layout numbers (entry 195.1 KB, closure 343.8 KB,
  CSS 44.4 KB) with the reproduce command.
- A future PR that moves more of the closure on demand is encouraged; the reward is the ratchet
  tightening this budget, not a reopened discussion of it.
- ADR-0004 remains in force for everything else: all timing budgets and the CSS budget stay as
  §3.8.1 wrote them until the P-gate harness calibrates them with P50/P95 evidence.

Commit: 2cabfcf-era measurements (this ADR lands with the same numbers); reproduce with
`npm run build:dist -- --production && node test/perf/p5-size.mjs`.
