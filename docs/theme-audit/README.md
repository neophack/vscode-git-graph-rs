# Theme Audit

Visual QA harness for the webview stylesheets (REFACTOR-PLAN Phase 5, tasks 5.5 / 5.7): it
renders representative markup of every page-kind under the four VS Code theme kinds using the
**real built stylesheets**, screenshots each combination headlessly, and gates the current
rendering against a committed reference set with a pixel-diff tolerance. This is the
"screenshot comparison report" the plan's acceptance blocks ask for, and a usable check for
CSS work: a change that visibly moves a component fails the gate.

## What it covers

Eight page-kinds × four theme kinds (Dark+, Light+, High Contrast dark, High Contrast Light) =
32 images per run:

| Page-kind | Stylesheet | Components exercised |
| --- | --- | --- |
| `view` | `media/out.min.css` | conflict banner, control bar (all toolbar buttons, fetch variant), pinned row, commit table (auto layout, all row states: current / mute / details-open / find-match), commit graph SVG + hover tooltip, footer, loading header + skeleton rows, help tooltip |
| `details` | `media/out.min.css` | docked commit details view: summary with markdown body and signature states, controls column (list/tree/external diff/code review/close), file tree (all change types, pending counts, hover actions) |
| `overlays` | `media/out.min.css` | find widget (active, error, modifiers, inline match), context menu (plain + checked), dropdown (filter, hints, multi-select, info buttons, no-results), Gerrit dialog, pull-request dialog, form/message dialogs, custom select |
| `panels` | `media/out.min.css` | settings widget, reflog widget (all dot kinds), statistics widget (author bars, heatmap), worktree widget (all badge kinds) |
| `mobile-view` | `media/out.min.css` (`body.mobileMode`, 390×844) | mobile app bar (capsule dropdowns, icon buttons), pinned chips, two-line commit rows, fast scroller + bubble, overflow sheet with switches, mobile find bar, mobile dropdown card |
| `mobile-details` | `media/out.min.css` (`body.mobileMode`) | mobile commit-details sheet (title bar, summary card with avatar/facts/note, segmented file view, tinted file rows), mobile dialog |
| `comparison` | `media/comparison.min.css` | commit cards + divider, sidebar tree, diff table (hunk/add/del/mod rows, `<mark>` highlights, highlight.js tokens) |
| `binary-compare` | `media/binaryCompare.min.css` | hex compare (ruler, differing/selected bytes, toolbar, context menu), image compare (panes, controls) |

The markup samples reuse the class names and DOM shapes `src/webview` renders, so every
component stylesheet under `src/webview/styles/` is represented. Harness CSS neutralises only
overlay *positioning* (so full-page screenshots capture fixed elements in document flow); it
never touches colours, spacing or typography.

## How to run

```bash
npm run build:dist                # esbuild only (no cargo): produces media/*.css
node scripts/dev/theme-audit.mjs   # capture into .theme-audit/<run>/ (HTML + PNG)
node scripts/dev/theme-audit.mjs --check             # capture + pixel-diff gate; exit 1 on failure
node scripts/dev/theme-audit.mjs --update-reference  # regenerate docs/theme-audit/reference/
```

Options: `--pages=a,b` and `--themes=dark` restrict a run; `--keep=N` (default 3) bounds how
many run directories survive under `.theme-audit/` (gitignored).

Screenshots use the system Edge browser through playwright's `channel: 'msedge'` (no download).
Without Edge the harness falls back to the bundled Chromium — install it once with
`npx playwright install chromium`.

**The reference set is machine-specific.** Font rasterisation differs across fonts, browser
versions and OSes, so on a new machine (or after an Edge upgrade) regenerate the reference with
`--update-reference` before gating. The gate is meant for before/after comparisons on one
machine — exactly the "before and after the split" check task 5.5 asks for.

## Updating the reference set

Any intentional visual change (a deliberate CSS edit) updates the reference in the same commit
as the change that caused it:

```bash
# ...edit src/webview/styles/** ...
npm run build:dist
node scripts/dev/theme-audit.mjs --update-reference
git add docs/theme-audit/reference
```

The commit message should note that the reference set was regenerated and why the change is
expected — the diff of the PNGs is the reviewable evidence.

## What the diff tolerance means

A pixel counts as **differing** when any of its RGB channels moves by more than 8 (of 255).
That floor absorbs palette-quantisation noise and single-level antialiasing shimmer; anything
a person would call a visual change moves channels far more. The **gate** fails an image when
more than **0.1%** of its pixels differ, and fails outright on any size mismatch. A whole-image
brightness shift (the failure-path smoke test) measures ~15% differing pixels; an untouched
rebuild measures 0.0000%.

Reference images are compressed with sharp: palette-quantised PNG **only when the quantisation
error stays within the channel tolerance** (measured, not assumed), lossless PNG otherwise. In
practice every image so far falls back to lossless (~41 KB average) — the shadows and
gradients in the UI quantise beyond the tolerance, and the guard refuses to hide that.

## Current findings (2026-10-25, first reference commit)

- **No component renders unstyled, empty or broken** in any of the 32 combinations: every
  stylesheet resolves its theme variables through the same `var()` fallback chains production
  uses, and the four theme kinds each re-colour the full surface (verified per page-kind in
  the initial run; see the reference set).
- **Chromium 69 fallbacks are not exercised by these screenshots.** The harness screenshots
  with a modern Edge, so the `@supports not (appearance: none)` margin fallbacks, the
  `rgba()`/`break-word` twins and the `:focus` duplicates introduced for VS Code 1.38
  (commit `d8e7941`) render as their modern equivalents — by design, since the audit renders
  the same cascade the current VS Code host sees. The degraded 1.38 rendering remains covered
  by the plan's separate on-1.38 acceptance check for 5.7; expect small spacing deltas there
  (e.g. the conflict banner ~8px taller, flex-`gap` layouts margin-composed), which are the
  documented cost of the fallbacks, not regressions.
- **Ref-chip rows clip at the description width** in `view` (the long sample row's last badge
  is cut): expected — the same `overflow: hidden` clipping the production table applies to
  oversized ref rows.
- **The find input renders in the UA font** (Arial on Windows) rather than the UI font:
  `#findInput` sets no `font-family`, and webview inputs do not inherit the body font — a
  cosmetic nit carried over from v1.0, visible in the `overlays` page-kind, not a regression.
- **`docs/theme-audit/` is outside the packaging allowlist** (`.vscodeignore` ignores `**` and
  re-includes only the shipped files), so the reference set never enters the VSIX; the runs
  under `.theme-audit/` are gitignored.

## Layout

- `scripts/dev/theme-audit.mjs` — runner: HTML composition, playwright capture, sharp
  compression, pixel-diff gate.
- `scripts/dev/theme-audit/themes.mjs` — the four theme kinds and their `--vscode-*` variable
  sets (plus the pinned `--git-graph-*` lane colours / find tints).
- `scripts/dev/theme-audit/icons.mjs` — icon stand-ins and row/ref-chip builders.
- `scripts/dev/theme-audit/pages-main.mjs`, `pages-mobile.mjs`, `pages-compare.mjs` — the
  page-kind markup samples.
- `docs/theme-audit/reference/` — the committed reference set (32 PNGs).
