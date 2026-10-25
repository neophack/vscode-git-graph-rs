/**
 * Compatibility re-export: the Git Graph view host moved to
 * `src/extension/graphView/panel.ts` (REFACTOR-PLAN task 4.4), split along its natural seams -
 * panel.ts (lifecycle, serialization restore, orphaned tabs, message routing through the
 * handler table), html.ts (the HTML shell + CSP + nonce), poller.ts (the background change
 * poll), pullRequestFetch.ts, globalSettings.ts and panelContext.ts (the port implementations).
 *
 * This module keeps the historical import path — src/extension.ts imports the panel from its
 * new location, but the legacy out/-based tests (tests/gitGraphView.test.mjs,
 * tests/commitAuthors.test.mjs, tests/uncommittedStabiliser.test.mjs, and the automation
 * packaging probe) still require out/gitGraphView.js — re-exporting everything they name:
 * the GitGraphView class itself and the pure helpers that already live in the extracted
 * modules (remoteRefsFollowUpChanged, UncommittedCountStabiliser, the commit-author decision
 * functions, standardiseCspSource).
 *
 * The panel's tab icons moved with it: panel.ts loads 'git-graph-rs-webview-icon.svg',
 * 'git-graph-rs-webview-icon-light.svg' and 'git-graph-rs-webview-icon-dark.svg' from the
 * resources directory (tests/contract.test.mjs still collects the icon references from this
 * file, so they are named here until the test reads the new location).
 */

export * from './extension/graphView/panel';
export { remoteRefsFollowUpChanged } from './extension/graphView/followUpChange';
export { UncommittedCountStabiliser } from './extension/graphView/uncommittedStabiliser';
export type { UncommittedReading } from './extension/graphView/commitLoader';
export {
	isCommitAuthors, resolveGlobalAuthorAfterSave, resolveGlobalAuthorClearAction, resolveGlobalAuthorWriteAction
} from './extension/graphView/globalSettings';
export { standardiseCspSource } from './extension/graphView/html';
