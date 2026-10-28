/**
 * dependency-cruiser rules — the dependency rules of docs/REFACTOR-PLAN.md §3.6,
 * one rule per line of that table, plus the two "any directory" rules.
 *
 * §3.6 (verbatim):
 *
 *   shared/**           → may import only shared/**
 *   webview/**          → webview/**, shared/**; node:*, vscode forbidden
 *   extension/git/**    → extension/git/**, shared/**, node:*; vscode, graphView/**, platform/** forbidden
 *   extension/graphView/handlers/** → must not import graphView/panel.ts (only via HandlerContext)
 *   extension/platform/** → the only vscode entry point (views/, commands/, and graphView/panel.ts may use vscode UI types directly)
 *   any directory       → circular dependencies forbidden; importing test/** forbidden
 *
 * Ratchet (§5 task 1.6: "The dependency rules go live at warn level first with
 * a violation list; at the end of each phase, the relevant directory's rules
 * become error"): the rules below are at error severity, but every violation
 * listed in docs/depcruise-baseline.json is neutralized via
 * options.knownViolations (softened severity "ignore") — for those entries the
 * rule effectively runs at "warn and below". Anything NOT in the baseline is a
 * NEW violation and fails `npm run lint:deps` with exit 1. The baseline may
 * only shrink: fixed violations are removed when the baseline is regenerated
 * (`--baseline-mode shrink-only`), and adding code to the baseline requires a
 * deliberate regeneration with `--baseline-mode full`.
 *
 * Baseline at Phase 1.6: 17 violations, all "new tree still imports legacy
 * type modules" transition debt. The flat root drained at A1
 * (OPTIMIZATION-PLAN §3 A1): the type-import entries drained to 0 (the git
 * layer and the webview now import src/shared/model + src/shared/protocol,
 * fully inside the rules) and the flat-root exemption pocket is gone —
 * vscode-only-via-platform covers all of src/extension/** (main.ts, the
 * composition root, joins views/ and commands/ as a granted exception). The
 * move itself carried files INTO stricter scopes with their old imports, so
 * the regeneration recorded 14 new transition-debt entries (findGit,
 * childProcess, askpassManager reaching platform/i18n/config/format/vscode
 * from the git layer; the four automation modules' direct vscode imports) —
 * the seams OPTIMIZATION-PLAN A3 (one process adapter) and the automation
 * cleanup drain next.
 *
 * Ratchet-down order (earliest first):
 *   1. End of Phase 1 (types migration, task 1.1): the git-layer and webview
 *      type-import violations drain to 0 — regenerate with shrink-only and the
 *      shared-only / webview-only / git-layer rules are fully live. (Done at A1.)
 *   2. A3 (one process adapter): findGit/childProcess/askpassManager fold into
 *      the process seam and their git-layer-isolation entries drain.
 *   3. The automation cleanup: the four vscode-importing automation modules
 *      leave the baseline by a deliberate carve-out of this rule (see the
 *      vscode-only-via-platform comment) rather than by routing their vscode
 *      usage through platform adapters — automation/** is dev-only tooling that
 *      drives whole VS Code instances and never ships in production VSIX builds.
 *   4. Ongoing: no-circular and not-to-test are live from day one (empty
 *      baseline) — new cycles or test imports fail immediately.
 *
 * Baseline drained to [] (the wave-6 dependency-hygiene pass): the git layer
 * takes localizers and helper surfaces as parameters (findGit's message, the
 * terminal adapter, the askpass nonce/input port), the repos layer and the
 * status bar reach the workspace/watcher/status-bar surfaces through platform
 * adapters (platform/workspace.ts, platform/statusBar.ts), the graphView
 * modules route their vscode touches through platform/actions / config /
 * vscodeCompat, and the automation directory is the rule carve-out above. The
 * ratchet is now fully tightened: every rule is live with no known violations.
 *
 * Regenerate after fixes:
 *   npx depcruise src --config .dependency-cruiser.cjs --baseline docs/depcruise-baseline.json --baseline-mode shrink-only
 *
 * Unit tests (`*.test.ts`) sit next to their sources and run under Vitest on
 * the dev Node, so they are exempt from the layering rules (they legitimately
 * import vitest/node builtins); the no-circular rule covers them.
 *
 * npm run lint:deps = depcruise src --config .dependency-cruiser.cjs
 */

/** The ratchet: violations accepted at Phase 1.6, to be drained phase by phase. */
const knownViolations = require('./docs/depcruise-baseline.json');

module.exports = {
	forbidden: [
		{
			// §3.6 row 1: shared/** may import only shared/** — shared is
			// isomorphic (§3.2: no vscode, no DOM, no Node), so Node builtins,
			// node_modules and every src-internal path outside shared/** are
			// forbidden.
			name: 'shared-only',
			comment: '§3.6: shared/** → only shared/**',
			severity: 'error',
			from: {
				path: '^src/shared/',
				pathNot: '\\.test\\.ts$'
			},
			to: {
				path: '^(?!src/shared/)'
			}
		},
		{
			// §3.6 row 2: webview/** → webview/**, shared/**; node:*, vscode
			// forbidden. Anything not under src/webview/ or src/shared/ is a
			// violation (Node builtins and 'vscode' resolve to bare names that
			// do not start with src/, so they match).
			//
			// Documented exception (task 5.9): src/webview/graph/text/markdown.ts
			// statically imports markdown-it so the bundler can emit it as the
			// on-demand chunk the details view loads via dynamic import(). The
			// rule's intent is "no Node/vscode in the browser", not "no npm" —
			// the vendored browser library rides the chunk, never the entry.
			name: 'webview-only-webview-shared',
			comment: '§3.6: webview/** → webview/**, shared/**; node:*, vscode forbidden (markdown-it on-demand chunk excepted)',
			severity: 'error',
			from: {
				path: '^src/webview/',
				pathNot: '\\.test\\.ts$'
			},
			to: {
				path: '^(?!src/(webview|shared)/)',
				pathNot: 'node_modules/markdown-it/'
			}
		},
		{
			// §3.6 row 3: extension/git/** → extension/git/**, shared/**,
			// node:*. Forbidden: vscode, graphView/**, platform/** — expressed
			// as "any src-internal import outside git/shared, plus vscode".
			// Node core modules resolve to their bare name ("fs") and npm
			// leaves (e.g. iconv-lite) to node_modules/… — neither starts
			// with src/, so both stay allowed. 'vscode' resolves to the
			// ambient @types/vscode package.
			name: 'git-layer-isolation',
			comment: '§3.6: extension/git/** → git/**, shared/**, node:*; vscode, graphView/**, platform/** forbidden',
			severity: 'error',
			from: {
				path: '^src/extension/git/',
				pathNot: '\\.test\\.ts$'
			},
			to: {
				path: '^node_modules/@types/vscode|^src/(?!extension/git/|shared/)'
			}
		},
		{
			// §3.6 row 4: handlers reach the panel only through HandlerContext,
			// never by importing graphView/panel.ts. The path does not exist
			// yet (Phase 4 creates it); the rule targets it regardless.
			name: 'handlers-not-to-panel',
			comment: '§3.6: extension/graphView/handlers/** must not import graphView/panel.ts',
			severity: 'error',
			from: {
				path: '^src/extension/graphView/handlers/'
			},
			to: {
				path: '^src/extension/graphView/panel\\.ts$'
			}
		},
		{
			// OPTIMIZATION-PLAN §3 A3: child_process is started in exactly one
			// place — src/extension/git/process/** (the GitProcess verbs in
			// gitProcess.ts and the generic non-Git spawn in spawn.ts) — so
			// windowsHide, the askpass environment, cancellation, output caps
			// and the error shape are decided once. The automation tooling keeps
			// its own spawns (it is dev-only and drives whole VS Code
			// instances). Colocated unit tests are exempt like the other rules
			// (they mock child_process to fake the seam).
			name: 'child-process-only-in-process',
			comment: 'A3: child_process only in src/extension/git/process/** and src/extension/automation/**',
			severity: 'error',
			from: {
				path: '^src/',
				pathNot: [
					'^src/extension/git/process/',
					'^src/extension/automation/',
					'\\.test\\.ts$'
				]
			},
			// Node core modules resolve to their bare name ("child_process";
			// the node: prefixed form is covered for callers that use it).
			to: {
				path: '^(node:)?child_process$'
			}
		},
		{
			// §3.6 row 5: extension/platform/** is the only vscode entry point.
			// Exceptions the plan grants: views/, commands/, and
			// graphView/panel.ts may use vscode UI types directly — and since A1
			// drained the flat root, the composition root (extension/main.ts)
			// joins them (activate() receives the ExtensionContext; A2 rebuilds
			// it as the single wiring point).
			// Documented carve-out: src/extension/automation/** is dev-only
			// tooling that drives whole VS Code instances (it is define-gated
			// and absent from production VSIX builds) — the same rationale the
			// child-process-only-in-process rule grants it. Inverting its vscode
			// usage through platform adapters would add production seams for
			// code that never ships, so the rule exempts the directory instead.
			// ('vscode' resolves to the ambient @types/vscode package.)
			name: 'vscode-only-via-platform',
			comment: '§3.6: extension/platform/** is the only vscode entry (views/, commands/, main.ts, graphView/panel.ts, dev-only automation/** excepted)',
			severity: 'error',
			from: {
				path: '^src/extension/',
				pathNot: [
					'^src/extension/platform/',
					'^src/extension/views/',
					'^src/extension/commands/',
					'^src/extension/main\\.ts$',
					'^src/extension/graphView/panel\\.ts$',
					// Dev-only automation tooling (see the comment above); absent from
					// production VSIX builds.
					'^src/extension/automation/'
				]
			},
			to: {
				path: '^node_modules/@types/vscode'
			}
		},
		{
			// §3.6 row 6a: circular dependencies forbidden, anywhere.
			name: 'no-circular',
			comment: '§3.6: any directory → circular dependencies forbidden',
			severity: 'error',
			from: {},
			to: {
				circular: true
			}
		},
		{
			// §3.6 row 6b: importing test/** forbidden (the legacy tests/
			// directory today, test/ in the target layout).
			name: 'not-to-test',
			comment: '§3.6: any directory → importing test/** forbidden',
			severity: 'error',
			from: {
				path: '^src/'
			},
			to: {
				path: '(^|/)tests?/'
			}
		}
	],
	options: {
		doNotFollow: {
			path: 'node_modules'
		},
		// Resolve symlinked modules at their stated path, not their realpath. Worktree checkouts
		// (git worktree add) reach the shared node_modules through a junction; without this the
		// resolved 'vscode' path escapes the checkout ('../../<repo>/node_modules/@types/vscode')
		// and the ratchet baseline's rules stop matching, silently voiding the vscode gate.
		preserveSymlinks: true,
		// The ratchet (see header): baselined violations are softened, new ones
		// fail the check.
		knownViolations: knownViolations,
		ignoreKnown: true,
		// Progress bars are noise in CI; the reporter summary suffices.
		progress: {
			type: 'none'
		}
	}
};
