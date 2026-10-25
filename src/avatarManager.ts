/**
 * Compatibility re-export: the avatar integration moved to
 * `src/extension/integrations/avatars/avatarManager.ts` (REFACTOR-PLAN task 6.2; the request
 * queue is split into `avatarQueue.ts` beside it). This module keeps the historical import path —
 * `extension.ts`, `gitGraphView.ts`, `extensionState.ts`, `extension/commands/**` and the tests
 * import it from `./avatarManager` — re-exporting the public surface unchanged.
 */

export * from './extension/integrations/avatars/avatarManager';
