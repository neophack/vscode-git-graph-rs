// ESLint flat config — Phase 1.6 (docs/REFACTOR-PLAN.md §5, task 1.6; §3.7.2 compatibility layers).
//
// Scope: `npm run lint:js` → `eslint src scripts`.
//
// Layers:
//   (a) src/** host code (everything except src/webview) + scripts/**
//       — eslint-plugin-n built-in API floors. The ARTIFACT floor is Node >=10.11.0
//         (§3.7.1 runtime anchors, VS Code 1.38); §3.7.2 pins
//         n/no-unsupported-features/{es-builtins,node-builtins} to `>=10.11.0`.
//         Dev-only code (*.test.ts run by Vitest, scripts/** run by developers)
//         is relaxed to the dev floor `>=18.0.0` (§3.7.2 "Separating the dev
//         environment from the runtime environment": tooling uses Node >=20).
//   (b) src/webview/** — eslint-plugin-compat against browserslist `chrome 69`
//         (§3.7.2, Chromium 69 floor; see .browserslistrc), no-implicit-globals
//         at error (§5.1), and no Node builtins importable at all (§3.6).
//   (c) `(vscode.window as any)`-style API probes are forbidden outside
//         src/extension/platform/** (§3.7.2 "VS Code API" row: post-1.38 APIs go
//         through extension/platform/vscodeCompat.ts only; G7: zero `as any` API
//         probes). Expressed with no-restricted-syntax: any TS `as any` cast
//         whose expression mentions the `vscode` identifier.
//   (d) task 4.10: native-UI calls (vscode.window.show* dialogs and
//         createTerminal) are forbidden outside platform/** and views/** —
//         they must run through the platform adapters or the UiPort
//         (see src/extension/platform/INVENTORY.md). Three files that still
//         carry unabsorbed sites are relaxed to warn until their owners absorb
//         them (comments in place).
//
// Style (§4.2): tabs, single quotes, semicolons — kept via ESLint stylistic
// rules only. NO Prettier, no repo-wide formatting sweep. ESLint 10 still ships
// the core formatting rules and they parse TypeScript fine when the
// typescript-eslint parser is used (verified: interface/enum/namespace/generics).
//
// Ratchet-down plan (§5 task 1.6: "The dependency rules go live at warn level
// first with a violation list; at the end of each phase, the relevant
// directory's rules become error"):
//   - End of Phase 3 (host git layer): the n/* floors and no-explicit-any go to
//     error for src/extension/git/** once the legacy flat files have drained.
//   - End of Phase 4 (host split): the vscode-probe rule goes to error once
//     gitGraphView's remaining probe moved to platform/vscodeCompat.ts (task 1.8).
//   - End of Phase 5 (webview): compat/compat goes to error (task 5.8 zeroes the
//     existing violations); the §3.6 layer rules for src/webview tighten.
//   - Every warn rule below records the current count in the Phase 1.6 report;
//     counts may only go down. Rules that are error today must stay at 0.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nPlugin from 'eslint-plugin-n';
import compatPlugin from 'eslint-plugin-compat';
import globals from 'globals';

const HOST_TS = ['src/**/*.ts'];
const WEBVIEW_TS = ['src/webview/**/*.ts'];
const PLATFORM_TS = ['src/extension/platform/**/*.ts'];
const VIEWS_TS = ['src/extension/views/**/*.ts'];
const HOST_TS_NO_WEBVIEW = ['src/**/*.ts', '!src/webview/**'];
const HOST_TS_NO_WEBVIEW_NO_TESTS = ['src/**/*.ts', '!src/webview/**', '!src/**/*.test.ts'];
const SCRIPTS = ['scripts/**/*.{js,mjs,cjs}'];

// Task 4.10 (REFACTOR-PLAN): every native-UI dialog the host shows must run through the platform
// layer - the adapters (platform/notifications.ts, terminal.ts, clipboard.ts) or the UiPort
// (platform/uiPort.ts) - so the E2E build can inject a ScriptedUiPort and replay every branch.
// src/extension/platform/INVENTORY.md is the authoritative per-site survey this rule enforces.
// platform/** owns the seams, and the plan allows vscode UI types in views/**; the files that
// still carry unabsorbed sites (INVENTORY.md #6/#7, #8, #18) are temporarily relaxed to warn
// below and ratchet to error as their owners absorb them.
//
// Expressed with no-restricted-syntax (no-restricted-properties cannot match the nested
// `vscode.window` object path). `vscode.window['prop']`-style literal access is not matched;
// the host never writes member access that way.
const NATIVE_UI_SELECTOR = "MemberExpression[object.object.name='vscode'][object.property.name='window'][property.name=/^(showErrorMessage|showWarningMessage|showInformationMessage|showQuickPick|showInputBox|showSaveDialog|showOpenDialog|createTerminal)$/]";

// The files that still carry unabsorbed native-UI sites: their rule stays at warn until their
// owners absorb the sites, then they join the error block. commands/context.ts (#18), graphView/
// globalSettings.ts (#6/#7) and repos/repoManager.ts (#8) are INVENTORY.md-registered.
// graphView/panelContext.ts's archive save-dialog site was absorbed onto the UiPort by task
// 4.10's ScriptedUiPort wave (scenarios answer it), so it left the carriers and is at error.
const NATIVE_UI_CARRIERS = [
	'src/extension/commands/context.ts',
	'src/extension/graphView/globalSettings.ts',
	'src/extension/repos/repoManager.ts'
];

const NATIVE_UI_MESSAGE = "Native UI goes through the platform layer (REFACTOR-PLAN task 4.10): route 'vscode.window' dialogs through the platform adapters (notifications.ts / terminal.ts) or the UiPort - see src/extension/platform/INVENTORY.md.";

// The `as any` vscode probe selector of layer (c), lifted to a constant so layer (d)'s
// re-declaration of no-restricted-syntax (a later flat-config block replaces the whole
// rule value per file set) keeps the probe entry byte-identical.
const VSCODE_PROBE_SELECTOR = {
	selector: 'TSAsExpression[typeAnnotation.type=\'TSAnyKeyword\'] Identifier[name=\'vscode\']',
	message: 'Do not probe the vscode API with `as any` casts (REFACTOR-PLAN §3.7.2/§3.7.3): route post-1.38 APIs through extension/platform/vscodeCompat.ts.'
};
const NATIVE_UI_SELECTOR_ENTRY = {
	selector: NATIVE_UI_SELECTOR,
	message: NATIVE_UI_MESSAGE
};

// Node core modules the webview must never import (§3.6: "webview/** → webview/**, shared/**; node:*, vscode forbidden").
// One anchored regex (not `group`: gitignore-style group patterns would also match
// relative specifiers like '../../common/util').
const NODE_BUILTIN_REGEX = '^(node:)?(assert|buffer|child_process|cluster|console|constants|crypto|dgram|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|smalloc|stream|string_decoder|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(/|$)';

export default tseslint.config(
	// Generated code (ts-rs output) and ambient declarations are never linted.
	{
		ignores: [
			'src/shared/engine/**',
			'src/**/*.d.ts',
			'**/*.d.ts',
			'.probe/**'
		]
	},

	// ---- scripts/** (.js/.mjs/.cjs dev tooling) --------------------------------
	// Dev scripts run on the developer's Node (engines.node >=18), NOT on the
	// 10.11 artifact floor — hence the relaxed n/* version here (§3.7.2).
	{
		files: SCRIPTS,
		...js.configs.recommended,
		languageOptions: {
			globals: {
				...globals.node
			}
		},
		plugins: { n: nPlugin },
		rules: {
			'n/no-unsupported-features/es-builtins': ['error', { version: '>=18.0.0' }],
			'n/no-unsupported-features/node-builtins': ['error', { version: '>=18.0.0' }],
			'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
			'prefer-const': 'warn'
		}
	},

	// ---- src/**/*.ts common base (host + webview) ------------------------------
	{
		files: HOST_TS,
		extends: [tseslint.configs.eslintRecommended, tseslint.configs.recommended],
		rules: {
			// no-undef is the TypeScript compiler's job (types, ambient modules,
			// DOM globals); ESLint core no-undef misfires on TS sources.
			'no-undef': 'off',
			// Repo style (§4.2): tabs, single quotes, semicolons. quotes/semi/
			// no-mixed-spaces-and-tabs are error — the tree already conforms.
			// indent starts at warn: 68 hits today, concentrated in the legacy
			// flat files and src/automation/catalog.ts (claimed by other waves);
			// ratchets to error as those drain.
			quotes: ['error', 'single', { avoidEscape: true }],
			semi: ['error', 'always'],
			'no-mixed-spaces-and-tabs': 'error',
			indent: ['warn', 'tab', { SwitchCase: 1 }],
			// Realistic starting bar (§5 task 1.6): rules that fire on the legacy
			// flat files start at warn and ratchet to error per phase. Phase 1.6
			// starting counts (drift with in-flight migration work — the binding
			// constraint is zero errors): prefer-const ~98, indent ~68 (mostly the
			// legacy flat files and the automation catalog), no-explicit-any ~48,
			// no-require-imports 3, no-unused-expressions 3 (src/hexDiff.ts),
			// no-namespace 1 (src/repoManager.ts), no-this-alias 1
			// (src/webview/binaryCompare/hexView.ts, in-flight migration).
			'prefer-const': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-require-imports': 'warn',
			'@typescript-eslint/no-unused-expressions': 'warn',
			'@typescript-eslint/no-namespace': 'warn',
			'@typescript-eslint/no-this-alias': 'warn',
			// Unused `_`-prefixed args and ignored catch bindings are idiomatic
			// in this repo; tsc's noUnusedLocals/noUnusedParameters remains the
			// real gate for compiled code.
			'@typescript-eslint/no-unused-vars': ['warn', {
				args: 'all',
				argsIgnorePattern: '^_',
				caughtErrors: 'none',
				varsIgnorePattern: '^_'
			}]
		}
	},

	// ---- (a) src/** host code (Node artifact floor >=10.11.0) ------------------
	// Production host code ships in the VSIX and runs on VS Code 1.38's Node
	// 10.11 (§3.7.1/§3.7.2). Unit tests next to sources run under Vitest on the
	// dev Node, so they get the relaxed floor.
	{
		files: HOST_TS_NO_WEBVIEW,
		plugins: { n: nPlugin },
		rules: {
			'n/no-unsupported-features/es-builtins': ['warn', { version: '>=10.11.0' }],
			'n/no-unsupported-features/node-builtins': ['warn', { version: '>=10.11.0' }]
		}
	},
	{
		files: ['src/**/*.test.ts', '!src/webview/**/*.test.ts'],
		plugins: { n: nPlugin },
		rules: {
			'n/no-unsupported-features/es-builtins': 'off',
			'n/no-unsupported-features/node-builtins': 'off'
		}
	},

	// ---- (b) src/webview/** (Chromium 69 floor) ---------------------------------
	{
		files: WEBVIEW_TS,
		...compatPlugin.configs['flat/recommended'],
		rules: {
			// §5.8: existing compat violations are listed now and zeroed in Phase 5.
			'compat/compat': 'warn',
			// §5.1 acceptance: modules do not communicate via globals.
			'no-implicit-globals': 'error',
			// §3.6: webview may import webview/** and shared/** only.
			'no-restricted-imports': ['error', {
				paths: [
					{
						name: 'vscode',
						message: 'The webview must not import the vscode module (REFACTOR-PLAN §3.6); talk to the host through the bridge.'
					}
				],
				patterns: [
					{
						regex: NODE_BUILTIN_REGEX,
						message: 'The webview runs in Chromium 69, not Node: node builtins are not available (REFACTOR-PLAN §3.6).'
					},
					{
						regex: '^node:',
						message: 'The webview runs in Chromium 69, not Node: node builtins are not available (REFACTOR-PLAN §3.6).'
					}
				]
			}],
			// Webview code is DOM code; the n/* Node floors do not apply.
			'n/no-unsupported-features/es-builtins': 'off',
			'n/no-unsupported-features/node-builtins': 'off'
		}
	},

	// ---- (c) vscode `as any` API probes (§3.7.2 VS Code API row, G7) ------------
	// Applies everywhere in src except the platform compat module, which is the
	// single sanctioned place for runtime feature detection (§3.7.3).
	{
		files: HOST_TS,
		ignores: PLATFORM_TS,
		rules: {
			'no-restricted-syntax': ['warn', {
				selector: 'TSAsExpression[typeAnnotation.type=\'TSAnyKeyword\'] Identifier[name=\'vscode\']',
				message: 'Do not probe the vscode API with `as any` casts (REFACTOR-PLAN §3.7.2/§3.7.3): route post-1.38 APIs through extension/platform/vscodeCompat.ts.'
			}]
		}
	},
	{
		files: PLATFORM_TS,
		rules: {
			'no-restricted-syntax': 'off'
		}
	},

	// ---- (d) native UI through the platform layer (task 4.10, INVENTORY.md) -----
	// After (c) deliberately: a later block replaces the whole rule value per file
	// set, so this block re-declares the `as any` probe selector to keep it in force
	// at its ratcheted level (error - it is at zero today, G7 forbids the probes).
	// The native-UI selector applies everywhere except the platform layer (which owns
	// the seams) and views/ (the plan allows vscode UI types there); the three files
	// that still carry unabsorbed sites are relaxed to warn in the block that follows.
	{
		files: HOST_TS,
		ignores: [...PLATFORM_TS, ...VIEWS_TS, ...NATIVE_UI_CARRIERS],
		rules: {
			'no-restricted-syntax': ['error', VSCODE_PROBE_SELECTOR, NATIVE_UI_SELECTOR_ENTRY]
		}
	},
	{
		// Temporary relaxations (ratchet to error when absorbed - see INVENTORY.md): the files
		// listed in NATIVE_UI_CARRIERS. Their owners absorb the sites onto the UiPort; the probe
		// rule of layer (c) keeps its current warn level for these files.
		files: NATIVE_UI_CARRIERS,
		rules: {
			'no-restricted-syntax': ['warn', VSCODE_PROBE_SELECTOR, NATIVE_UI_SELECTOR_ENTRY]
		}
	}
);
