/**
 * Compatibility re-export: the Binary Compare tab's host controller moved to
 * `src/extension/views/binaryCompare/viewController.ts` (REFACTOR-PLAN task 6.1). This module
 * keeps the historical import path — `gitGraphView.ts` imports the view from
 * `./binaryCompareView` — re-exporting the class unchanged.
 */

export { BinaryCompareView } from './extension/views/binaryCompare/viewController';
