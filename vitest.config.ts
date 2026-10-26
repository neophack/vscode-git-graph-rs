import * as path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * Unit and integration tests of the new source trees (REFACTOR-PLAN task 1.5 / task 7.1):
 * `*.test.ts` files colocated with their sources under src/ run directly against TypeScript
 * sources - no build step. The L3 suites under test/integration run the same way (the reader
 * contracts against real git fixture repositories, the webview journeys against the compiled
 * bundle of `npm run build:dist`, the tooling/artifact suites under test/tooling); their files
 * set their own longer timeouts with `vi.setConfig`, because building and reading real git
 * fixture repositories is slow (especially on Windows).
 *
 * The `vscode` alias routes the specifier to a recording default-answering singleton
 * (test/support/vscodeAlias.ts) for the suites that boot the extension host without installing
 * their own vi.mock - the Vitest form of the legacy runner's Module._load hook.
 */
export default defineConfig({
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, 'test/support/vscodeAlias.ts')
		}
	},
	test: {
		include: ['src/**/*.test.ts', 'test/integration/**/*.test.ts', 'test/tooling/**/*.test.ts', 'test/e2e/*.test.ts'],
		environment: 'node',
		// The 5 s default is shorter than CPU-bound unit tests take while every file runs in
		// parallel, more so under coverage instrumentation. Slow integration files set their own.
		testTimeout: 20000,
		// `npm run test:coverage`. The webview journeys drive the compiled bundle inside jsdom, which
		// v8 cannot map back to src/webview, so the webview figures count its unit tests only.
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/shared/engine/**'],
			reporter: ['text-summary', 'json-summary', 'lcov'],
			// Floors, not targets: each is the measured figure rounded down, minus one point (so a
			// platform difference does not trip it). Raise them by hand in the PR that raises
			// coverage; never lower one to make a PR pass.
			thresholds: {
				statements: 68, branches: 79, functions: 74, lines: 68,
				'src/extension/git/**': { statements: 88, branches: 88, functions: 92, lines: 88 },
				'src/extension/**': { statements: 82, branches: 83, functions: 84, lines: 82 },
				'src/webview/**': { statements: 35, branches: 70, functions: 57, lines: 35 },
				'src/shared/**': { statements: 99, branches: 99, functions: 99, lines: 99 },
				// The automation subsystem (A1 moved it under the extension layer); listed after
				// the broader 'src/extension/**' so the specific glob keeps governing its files.
				'src/extension/automation/**': { statements: 92, branches: 75, functions: 93, lines: 92 }
			}
		}
	}
});

