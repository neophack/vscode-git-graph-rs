import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the new source trees (REFACTOR-PLAN task 1.5): `*.test.ts` files colocated
 * with their sources under src/extension and src/shared run directly against TypeScript
 * sources - no build step. The legacy `*.test.mjs` suite in tests/ keeps running through
 * `npm run test:node` until it is drained in Phase 7.
 */
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
