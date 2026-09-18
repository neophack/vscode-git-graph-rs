import * as vscode from 'vscode';
import { GitGraphView } from '../gitGraphView';
import { RequestMessage, ResponseMessage } from '../types';

/**
 * The narrow seam the automation server drives. It touches Git Graph only through the three
 * public automation hooks on GitGraphView — the same entry point the webview's own messages
 * take (respondToMessage) and the same exit (sendMessage) — so a request-mode run exercises
 * exactly the path a button click does, no mocks in between.
 */

/** The result of one shim step batch, as posted back by the in-page shim. */
export interface ShimResult {
	readonly runId: number;
	readonly ok: boolean;
	/** TRUE when a skipIfAbsent precondition ended the batch: the action is skipped, not failed. */
	readonly skipped?: boolean;
	/** Human-readable skip reason (which element was absent), when skipped is true. */
	readonly skipReason?: string;
	/** Per-step results in execution order (undefined for steps that produce no value). */
	readonly results: (unknown | undefined)[];
	/** Index of the step that failed, when ok is false. */
	readonly failedStep?: number;
	readonly error?: string;
}

export interface ViewState {
	readonly viewLoaded: boolean;
	readonly currentRepo: string | null;
	readonly repos: string[];
}

export class HostBridge {
	/** Is a Git Graph view currently open? */
	public hasView(): boolean {
		return GitGraphView.currentPanel !== undefined;
	}

	/** Snapshot of the view and repository state (gg.status / gg.query repos). */
	public viewState(): ViewState {
		const panel = GitGraphView.currentPanel;
		return panel === undefined
			? { viewLoaded: false, currentRepo: null, repos: [] }
			: panel.automationState();
	}

	/**
	 * Inject a request into the extension host as if the webview had sent it. Fire-and-forget:
	 * respondToMessage reports its own errors; the outcome is observed through the host-message
	 * tap.
	 */
	public inject(message: RequestMessage): void {
		const panel = GitGraphView.currentPanel;
		if (panel !== undefined) panel.runAutomationRequest(message);
	}

	/**
	 * Release the engine's warm handle of a repository (its memory-mapped pack reads keep the
	 * repository's files undeletable on Windows until the handle drops). A no-op with no view
	 * open — nothing holds the repository then.
	 */
	public closeRepository(repo: string): void {
		const panel = GitGraphView.currentPanel;
		if (panel !== undefined) panel.automationCloseRepository(repo);
	}

	/**
	 * Observe every message the host sends to the webview. Returns the unsubscribe function.
	 * The tap is a static hook: it stays installed across view recreations and works even when
	 * no view is open yet (messages simply don't flow until one opens).
	 */
	public onHostMessage(listener: (msg: ResponseMessage) => void): () => void {
		GitGraphView.setAutomationTap(listener);
		return () => {
			// Only clear the tap if it is still ours (a newer subscriber would have replaced it).
			GitGraphView.setAutomationTap(null);
		};
	}

	/** Observe shim results posted from the page. Returns the unsubscribe function. */
	public onShimResult(listener: (result: ShimResult) => void): () => void {
		GitGraphView.setAutomationShimListener((result) => listener(result as ShimResult));
		return () => {
			GitGraphView.setAutomationShimListener(null);
		};
	}

	/** Send a message to the page shim (not a ResponseMessage — the bundle ignores it). */
	public postToWebview(message: unknown): void {
		const panel = GitGraphView.currentPanel;
		if (panel !== undefined) panel.postAutomationMessage(message);
	}

	/** Open (or reveal) the Git Graph view on the given repository, registering it if unknown. */
	public async openView(repo: string): Promise<void> {
		await vscode.commands.executeCommand('git-graph-rs.view', { rootUri: vscode.Uri.file(repo) });
	}
}
