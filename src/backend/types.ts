/**
 * Compatibility re-export: the backend data contract moved to
 * `src/extension/git/read/types.ts` (REFACTOR-PLAN task 3.3). This module keeps the historical
 * import path — the read-layer modules under `src/extension/git/read/cli/` import the generated
 * types and the option bags from `../../backend/types` — re-exporting the public surface
 * unchanged.
 */

export * from '../extension/git/read/types';
