/**
 * Compatibility re-export: the shared binary-comparison responders moved to
 * `src/extension/views/binaryCompare/binaryCompare.ts` (REFACTOR-PLAN task 6.1). This module
 * keeps the historical import path — the view controllers and the tests import them from
 * `./binaryCompare` — re-exporting the public surface unchanged.
 */

export * from './extension/views/binaryCompare/binaryCompare';
