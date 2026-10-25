import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the new source trees (REFACTOR-PLAN task 1.5): `*.test.ts` files colocated
 * with their sources under src/extension and src/shared run directly against TypeScript
 * sources - no build step. The L3 Reader contract suite under test/integration runs the same
 * way; its files set their own longer timeouts with `vi.setConfig`, because building and
 * reading real git fixture repositories is slow (especially on Windows).
 */
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts', 'test/integration/**/*.test.ts', 'test/e2e/*.test.ts'],
		environment: 'node'
	}
});
