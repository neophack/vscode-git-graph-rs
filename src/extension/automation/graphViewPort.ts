/**
 * The GraphViewPort — the seam the automation subsystem reads and taps a live Git Graph view
 * through (REFACTOR-PLAN task 6.2). Automation used to reach the view through its statics
 * (the singleton panel reference plus the static message taps), which made the view class a
 * service locator every automation module could pull. The port inverts that: the view PUBLISHES
 * itself
 * here (setLiveGraphView) at every point the singleton panel changes — creation, serializer
 * revival, orphaned-tab replacement, disposal — and automation consumes the single
 * {@link graphViewPort} instance, with no static access of its own.
 *
 * The two cross-view observation taps (onHostMessage / onShimResult) live in this module rather
 * than on the view class on purpose: a server that starts before any view exists, and survives
 * the view being disposed and recreated, must keep its subscription without re-subscribing —
 * exactly the lifetime the view's former static hooks had, moved to the seam that owns them.
 *
 * The view side of the seam stays deliberately thin: GitGraphView keeps its per-instance hook
 * methods (automationState, runAutomationRequest, automationCloseRepository, postAutomationMessage
 * — the same entry and exit points the webview's own messages take) and forwards the two tap
 * events here (deliverAutomationHostMessage / deliverAutomationShimResult). Nothing else in the
 * view knows about automation.
 */

import type { GitGraphView } from '../graphView/panel';
import type { RequestMessage, ResponseMessage } from '../../shared/protocol/messages';

/** Snapshot of the view and repository state (the gg.status / gg.query repos surface). */
export interface GraphViewState {
	readonly viewLoaded: boolean;
	readonly currentRepo: string | null;
	readonly repos: string[];
}

/**
 * The injected view surface. Every member is safe to call at any time: with no live view,
 * hasView() is false, viewState() reports an unloaded view and the message senders are no-ops —
 * the same semantics the former static panel reads used to give.
 */
export interface GraphViewPort {
	/** Is a Git Graph view currently open? */
	hasView(): boolean;
	/** Snapshot of the view and repository state. */
	viewState(): GraphViewState;
	/** Inject a request into the extension host as if the webview had sent it (request-mode runs). */
	injectRequest(message: RequestMessage): void;
	/** Release the engine's warm handle of a repository (see GitGraphView.automationCloseRepository). */
	closeRepository(repo: string): void;
	/** Send a page-level message to the automation shim (never a ResponseMessage). */
	postToWebview(message: unknown): void;
	/** Observe every ResponseMessage leaving for the webview. NULL clears the tap. */
	onHostMessage(tap: ((msg: ResponseMessage) => void) | null): void;
	/** Observe automation shim results posted from the page. NULL clears the listener. */
	onShimResult(listener: ((result: unknown) => void) | null): void;
}

/** The published live view (NULL while no Git Graph view exists). */
let live: GitGraphView | null = null;
/** The installed host-message tap (survives view disposal and recreation). */
let hostMessageTap: ((msg: ResponseMessage) => void) | null = null;
/** The installed shim-result listener (same lifetime as the tap). */
let shimResultListener: ((result: unknown) => void) | null = null;

/**
 * Publish the live view — GitGraphView calls this at every point its singleton panel reference
 * changes, keeping the port and the panel in lockstep. NULL when no view is live.
 */
export function setLiveGraphView(view: GitGraphView | null): void {
	live = view;
}

/** Fire the host-message tap for one outgoing ResponseMessage (the view's single exit point calls this). */
export function deliverAutomationHostMessage(msg: ResponseMessage): void {
	if (hostMessageTap !== null) {
		try {
			hostMessageTap(msg);
		} catch (_) { /* a tap must never break message delivery */ }
	}
}

/** Fire the shim-result listener for one result the page posted (the view's receive path calls this). */
export function deliverAutomationShimResult(result: unknown): void {
	if (shimResultListener !== null) {
		try {
			shimResultListener(result);
		} catch (_) { /* the listener must never break message handling */ }
	}
}

/** The view state reported while no view is live. */
const NO_VIEW_STATE: GraphViewState = { viewLoaded: false, currentRepo: null, repos: [] };

/** The injected port: the only handle the automation subsystem has on the view. */
export const graphViewPort: GraphViewPort = {
	hasView: () => live !== null,
	viewState: () => live !== null ? live.automationState() : NO_VIEW_STATE,
	injectRequest: (message) => {
		if (live !== null) live.runAutomationRequest(message);
	},
	closeRepository: (repo) => {
		if (live !== null) live.automationCloseRepository(repo);
	},
	postToWebview: (message) => {
		if (live !== null) live.postAutomationMessage(message);
	},
	onHostMessage: (tap) => {
		hostMessageTap = tap;
	},
	onShimResult: (listener) => {
		shimResultListener = listener;
	}
};
