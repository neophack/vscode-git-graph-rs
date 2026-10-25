/**
 * Compatibility re-export: the diff document provider moved to
 * `src/extension/views/diffDocProvider.ts` (REFACTOR-PLAN task 6.1). This module keeps the
 * historical import path — `extension.ts`, `utils/actions.ts`, the automation host bridge and the
 * tests import it from `./diffDocProvider` — re-exporting the public surface unchanged.
 */

export * from './extension/views/diffDocProvider';
