/**
 * Compatibility re-export: the native addon loader moved to
 * `src/extension/git/read/addonLoader.ts` (REFACTOR-PLAN task 3.3). This module keeps the
 * historical import path — `extension.ts`, `dataSource.ts`, `gitGraphView.ts` and the tests
 * import it from `./backend/addon` — re-exporting the public surface unchanged.
 */

export * from '../extension/git/read/addonLoader';
