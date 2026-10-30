// Stylelint config — REFACTOR-PLAN §1.6 C6 / §3.7.2 CSS row, tasks 5.7/5.8.
//
// Scope: `npx stylelint "src/webview/styles/**/*.css" --config stylelint.config.mjs`
// (another agent wires this as `npm run lint:css`).
//
// Stylelint 17 note: array-style ("flat") configs were removed — the config
// must be a plain object using `extends`/`plugins`.
//
// The Chromium 69 floor comes from `.browserslistrc` (chrome 69, shared with
// eslint-plugin-compat — §3.7.2). The stylelint-no-unsupported-browser-features
// plugin reads it and errors on declarations no supported browser parses.
//
// Fallback discipline (see the stylesheets themselves): every declaration newer
// than Chromium 69 carries a Chromium-69-safe fallback immediately before it
// (same property, so the modern value wins where supported), every pseudo-class
// newer than 69 (`:focus-visible`) is preceded by a `:focus`-only duplicate rule
// (an unknown pseudo-class drops the whole rule on 69), and every flex `gap`
// site (Chrome 84) carries a margin fallback inside an
// `@supports not (appearance: none)` block (unprefixed `appearance` only parses
// from Chrome 84, so the probe is a Chrome-version fence: the margins apply
// only below it and never stack on a supported gap). The plugin's per-declaration
// check cannot see those pairings, so each such feature is ignored below with
// the pairing documented; anything without an established fallback keeps erroring.

export default {
	extends: ['stylelint-config-recommended'],
	plugins: ['stylelint-no-unsupported-browser-features'],
	rules: {
		// The plugin's registered ruleName is 'plugin/no-unsupported-browser-features'
		// (stylelint.createPlugin prefixes plugin rules with 'plugin/').
		'plugin/no-unsupported-browser-features': [true, {
			browsers: ['chrome 69'],
			// Features with an established Chromium-69 fallback pattern in the
			// stylesheets, which a per-declaration checker cannot see:
			//   - flexbox-gap: every site carries a margin fallback in an
			//     `@supports not (appearance: none)` block (Chrome 84 gained flex gap).
			//   - css-focus-visible: every site carries a `:focus`-only duplicate
			//     rule (an unknown pseudo-class drops the whole rule on 69).
			//   - prefers-reduced-motion (Chrome 74): the block simply never
			//     matches on 69 — pure progressive enhancement.
			//   - css-overflow: every flagged site uses auto/hidden/visible/scroll,
			//     all fully supported in 69; the "partial" flag tracks `overflow:
			//     clip` (Chrome 90), which no stylesheet uses.
			//   - css-sticky: `position: sticky` works on non-table elements since
			//     Chrome 56. The one table site (commitTable's column headers)
			//     degrades gracefully on 69 to scrolling headers.
			//   - css-math-functions: min()/max() need Chrome 79; every site
			//     carries a literal or calc() fallback declaration before it.
			//   - css-backdrop-filter (Chrome 76): the mobile app bar's frost is
			//     @supports-guarded over a solid background base.
			//   - css-masks: every unprefixed `mask` is preceded by `-webkit-mask`
			//     (supported since Chrome 1).
			//   - text-decoration: only `text-decoration-color` is used (supported
			//     since Chrome 57); the "partial" flag tracks the thickness/offset
			//     sub-features (Chrome 87), which no stylesheet uses.
			//   - css-scrollbar: `scrollbar-width: none` (Chrome 121) is paired
			//     with a `::-webkit-scrollbar { display: none }` fallback.
			//   - css-relative-colors (Chrome 119): the opaque-surface token
			//     redefinitions in tokens.css are @supports-guarded; the plain
			//     declarations before them are the Chromium 69 values.
			ignore: [
				'flexbox-gap',
				'css-focus-visible',
				'prefers-reduced-motion',
				'css-overflow',
				'css-sticky',
				'css-math-functions',
				'css-backdrop-filter',
				'css-masks',
				'text-decoration',
				'css-scrollbar',
				'css-relative-colors'
			]
		}],

		// Keyframe steps that intentionally hold nothing (`0% {}` — stay on the
		// element's own styles) carry a comment saying so; blocks with only a
		// comment are meaningful, truly empty ones still fail.
		// `word-break: break-word` (comparison.css, gerrit.css, reflogView.css)
		// is deprecated in favour of `overflow-wrap: anywhere`, but that value
		// needs Chrome 80 — on the Chromium 69 floor the legacy keyword is the
		// safe spelling (it parses in every Chromium). Ignore just that keyword;
		// every other deprecated keyword/value still errors.
		'declaration-property-value-keyword-no-deprecated': [true, { ignoreKeywords: ['break-word'] }],

		// Source-order lint, not a correctness or compatibility check: "fixing"
		// it reorders selectors, and when specificities differ the cascade winner
		// changes with the order — a real risk of changing what renders. The
		// sheets are ordered by feature flow, not by ascending specificity.
		// (stylelint disables a rule with null, not the ESLint-style "off".)
		'no-descending-specificity': null
	}
};
