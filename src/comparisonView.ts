/**
 * Compatibility re-export: the comparison view's host controller moved to
 * `src/extension/views/comparison/viewController.ts` (REFACTOR-PLAN task 6.1). This module keeps
 * the historical import path — `gitGraphView.ts` and the tests import the view from
 * `./comparisonView` — re-exporting the class unchanged.
 */

export { CommitComparisonView } from './extension/views/comparison/viewController';
