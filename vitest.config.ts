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
		environment: 'node'
	}
});

