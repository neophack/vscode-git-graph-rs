/**
 * Compatibility re-export: the hex comparison model moved to
 * `src/extension/views/binaryCompare/hexDiff.ts` (with its chunked byte-source layer split into
 * `hexDiffSources.ts`; REFACTOR-PLAN task 6.1). This module keeps the historical import path —
 * `binaryCompare.ts` and the tests import the session from `./hexDiff` — re-exporting the public
 * surface unchanged.
 */

export * from './extension/views/binaryCompare/hexDiff';
