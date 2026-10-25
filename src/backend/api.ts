/**
 * Compatibility re-export: the Git backend interface and the native implementation moved to
 * `src/extension/git/read/gitReader.ts` (REFACTOR-PLAN task 3.3). This module keeps the historical
 * import path — `dataSource.ts` and the read-layer modules import the contract from
 * `./backend/api` / `../backend/api` — re-exporting the public surface unchanged.
 */

export * from '../extension/git/read/gitReader';
