// ESLint flat config (docs/REFACTOR-PLAN.md §3.7.2 compatibility layers).
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
//         (§5.1), and no Node builtins importable at all (§3.6).
//   (c) `(vscode.window as any)`-style API probes are forbidden outside
//         src/extension/platform/** (§3.7.2 "VS Code API" row: post-1.38 APIs go
//         through extension/platform/vscodeCompat.ts only). Expressed with
//         no-restricted-syntax: any TS `as any` cast whose expression mentions the
//         `vscode` identifier.
//   (d) native-UI calls (vscode.window.show* dialogs and createTerminal) are
//         forbidden outside platform/** and views/** — they must run through the
//         platform adapters or the UiPort (see src/extension/platform/INVENTORY.md).
//   (e) production sources: at most 600 lines per file, and the type-aware rules
//         that catch dropped promises and non-exhaustive switches.
//
// Style (§4.2): tabs, single quotes, semicolons — kept via ESLint stylistic
// rules only. NO Prettier, no repo-wide formatting sweep. ESLint 10 still ships
// the core formatting rules and they parse TypeScript fine when the
// typescript-eslint parser is used.
//
// The ratchet: every rule is at error. The violations that predate a rule live in
// eslint-suppressions.json (ESLint bulk suppressions), so they do not fail the run
// while any NEW violation does. The file may only shrink: ESLint fails when an
// entry no longer matches anything, and `npx eslint src scripts --prune-suppressions`
// removes the fixed ones. Adding entries (`--suppress-rule <rule>`) is a deliberate,
// reviewed act, reserved for introducing a new rule over an existing backlog.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const TESTS_TS = ['src/**/*.test.ts'];
const SCRIPTS = ['scripts/**/*.{js,mjs,cjs}'];

// Every native-UI dialog the host shows must run through the platform layer - the adapters
// (platform/notifications.ts, terminal.ts, clipboard.ts) or the UiPort (platform/uiPort.ts) - so
// the E2E build can inject a ScriptedUiPort and replay every branch.
// src/extension/platform/INVENTORY.md is the authoritative per-site survey this rule enforces.
// platform/** owns the seams, and the plan allows vscode UI types in views/**.
//
// Expressed with no-restricted-syntax (no-restricted-properties cannot match the nested
// `vscode.window` object path). `vscode.window['prop']`-style literal access is not matched;
// the host never writes member access that way.
const NATIVE_UI_SELECTOR = "MemberExpression[object.object.name='vscode'][object.property.name='window'][property.name=/^(showErrorMessage|showWarningMessage|showInformationMessage|showQuickPick|showInputBox|showSaveDialog|showOpenDialog|createTerminal)$/]";

const NATIVE_UI_MESSAGE = "Native UI goes through the platform layer: route 'vscode.window' dialogs through the platform adapters (notifications.ts / terminal.ts) or the UiPort - see src/extension/platform/INVENTORY.md.";

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
			'src/webview/common/i18n/subset.generated.ts',
			'src/**/*.d.ts',
			'**/*.d.ts',
			'.probe/**'
		]
	},
	// A disable directive that suppresses nothing hides the next real violation on that line.
	{
		linterOptions: {
			reportUnusedDisableDirectives: 'error'
		}
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
			'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
			'prefer-const': 'error'
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
			// Repo style (§4.2): tabs, single quotes, semicolons.
			quotes: ['error', 'single', { avoidEscape: true }],
			semi: ['error', 'always'],
			'no-mixed-spaces-and-tabs': 'error',
			indent: ['error', 'tab', { SwitchCase: 1 }],
			// Unused `_`-prefixed args and ignored catch bindings are idiomatic
			// in this repo; tsc's noUnusedLocals/noUnusedParameters remains the
			// real gate for compiled code.
			'@typescript-eslint/no-unused-vars': ['error', {
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
			'n/no-unsupported-features/es-builtins': ['error', { version: '>=10.11.0' }],
			'n/no-unsupported-features/node-builtins': ['error', { version: '>=10.11.0' }]
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
			'compat/compat': 'error',
			// §5.1: modules do not communicate via globals.
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

	// ---- (c) vscode `as any` API probes (§3.7.2 VS Code API row) ----------------
	// Applies everywhere in src except the platform compat module, which is the
	// single sanctioned place for runtime feature detection (§3.7.3).
	{
		files: HOST_TS,
		ignores: PLATFORM_TS,
		rules: {
			'no-restricted-syntax': ['error', VSCODE_PROBE_SELECTOR]
		}
	},
	{
		files: PLATFORM_TS,
		rules: {
			'no-restricted-syntax': 'off'
		}
	},

	// ---- (d) native UI through the platform layer (INVENTORY.md) ----------------
	// After (c) deliberately: a later block replaces the whole rule value per file
	// set, so this block re-declares the `as any` probe selector to keep it in force.
	// The native-UI selector applies everywhere except the platform layer (which owns
	// the seams) and views/ (the plan allows vscode UI types there).
	{
		files: HOST_TS,
		ignores: [...PLATFORM_TS, ...VIEWS_TS],
		rules: {
			'no-restricted-syntax': ['error', VSCODE_PROBE_SELECTOR, NATIVE_UI_SELECTOR_ENTRY]
		}
	},

	// ---- (e) production sources: size and type-aware rules -----------------------
	// Type information comes from the nearest tsconfig.json (src/tsconfig.json for the host,
	// src/webview/tsconfig.json for the webview). Tests are left out: they are not shipped, and
	// their deliberately loose doubles would drown the signal.
	{
		files: HOST_TS,
		ignores: TESTS_TS,
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: path.dirname(fileURLToPath(import.meta.url))
			}
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }]
		}
	},
	// The string dictionaries are data tables, not modules to split. Rust sources get the same
	// limit from scripts/dev/check-file-size.mjs.
	{
		files: HOST_TS,
		ignores: [...TESTS_TS, 'src/shared/i18n/**'],
		rules: {
			'max-lines': ['error', { max: 600 }]
		}
	}
);
