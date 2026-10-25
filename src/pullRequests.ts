/**
 * Compatibility re-export: the pull request integration moved to
 * `src/extension/integrations/pullRequests.ts` (REFACTOR-PLAN task 6.2). This module keeps the
 * historical import path — `gitGraphView.ts` and the tests import it from `./pullRequests` —
 * re-exporting the public surface unchanged.
 */

export * from './extension/integrations/pullRequests';
