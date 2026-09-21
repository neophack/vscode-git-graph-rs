import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandStep } from './catalog';
import { DiffSide, encodeDiffDocUri } from '../diffDocProvider';
import { GitGraphView } from '../gitGraphView';
import { GitFileStatus } from '../types/git';
import { RequestMessage, ResponseMessage } from '../types';

/**
 * The narrow seam the automation server drives. It touches Git Graph only through the three
 * public automation hooks on GitGraphView — the same entry point the webview's own messages
 * take (respondToMessage) and the same exit (sendMessage) — so a request-mode run exercises
 * exactly the path a button click does, no mocks in between. Command-mode runs additionally go
 * through `vscode.commands.executeCommand`, the same dispatch a contributed menu item's click
 * takes.
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

/**
 * Identify a tab by its content (view type and/or document URIs) so a before/after snapshot can
 * diff it. Uses only `any` accesses: the Tab API is younger than the extension's supported VS
 * Code range, and every consumer is feature-detected and skipped where unavailable.
 */
export function automationTabKey(tab: any): string {
	const input = tab.input;
	if (input === undefined) return 'label:' + tab.label;
	const parts = [input.viewType, input.uri?.toString(), input.original?.toString(), input.modified?.toString()]
		.filter((part) => part !== undefined && part !== '');
	return parts.length > 0 ? parts.join('|') : 'label:' + tab.label;
}

/** Every open editor tab across all tab groups ([] where the Tab API is unavailable). */
export function automationOpenTabs(): any[] {
	const tabGroups = (vscode.window as any).tabGroups;
	if (tabGroups === undefined || !Array.isArray(tabGroups.all)) return [];
	// No flatMap here: src/tsconfig.json targets the es6 lib (the extension's VS Code floor).
	const tabs: any[] = [];
	for (const group of tabGroups.all as any[]) {
		if (Array.isArray(group.tabs)) tabs.push(...group.tabs);
	}
	return tabs;
}

/** What {@see installDialogAutoAnswer} answered while it was installed. */
export interface DialogAutoAnswer {
	/** One human-readable line per answered dialog, in answer order. */
	readonly autoAnswered: readonly string[];
	/** Restore the original window methods (idempotent). */
	readonly restore: () => void;
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

	/* ---------------- VS Code command execution (command mode) ---------------- */

	/**
	 * Execute the VS Code command a contributed menu item runs, building the argument that menu
	 * passes from the run's placeholder context (see CommandArgSpec for the shapes). The command
	 * wrapper in commands.ts swallows its own errors (registerCommand), so this resolves once
	 * the command was dispatched; the run's outcome is observed through the host-message tap and
	 * the post-run page steps like any other action.
	 */
	public async executeVscodeCommand(step: CommandStep, context: Record<string, string>): Promise<void> {
		const arg = step.arg;
		if (arg === undefined) {
			await vscode.commands.executeCommand(step.command);
		} else if (arg.kind === 'rootUri') {
			await vscode.commands.executeCommand(step.command, { rootUri: vscode.Uri.file(context.repo) });
		} else if (arg.kind === 'resourceStates') {
			await vscode.commands.executeCommand(step.command, [{ resourceUri: vscode.Uri.file(path.join(context.repo, context.file)) }]);
		} else if (arg.kind === 'diffUri') {
			await vscode.commands.executeCommand(step.command, encodeDiffDocUri(context.repo, context.file, context.commit, GitFileStatus.Modified, DiffSide.New));
		} else {
			const target = arg.of === 'repo' ? context.repo : path.join(context.repo, context.file);
			await vscode.commands.executeCommand(step.command, vscode.Uri.file(target));
		}
	}

	/**
	 * Snapshot of the open editor tabs' keys, or NULL where the Tab API is unavailable (a VS Code
	 * older than the API, or a test stub without tabGroups) — callers treat NULL as "cannot
	 * verify", never as "no tabs".
	 */
	public tabKeys(): string[] | null {
		const tabGroups = (vscode.window as any).tabGroups;
		if (tabGroups === undefined || !Array.isArray(tabGroups.all)) return null;
		return automationOpenTabs().map(automationTabKey);
	}

	/**
	 * While a command-mode action runs, answer the native dialogs the command may raise (a modal
	 * confirmation, an amend prompt, a quick pick) with its primary action — the counterpart of
	 * the runner auto-confirming the webview's data-loss warning: the run is not interactive, so
	 * an unanswered modal would stall the command forever. Everything answered is recorded; the
	 * original window methods are restored by the returned handle.
	 */
	public installDialogAutoAnswer(): DialogAutoAnswer {
		const w = vscode.window as unknown as Record<string, any>;
		// The first button-like argument after the message (skipping the options object a modal
		// confirmation passes) is the command's primary action.
		const firstButtonItem = (args: any[]) => {
			for (const arg of args.slice(1)) {
				if (typeof arg === 'string') return arg;
				if (arg !== null && typeof arg === 'object' && typeof arg.title === 'string') return arg;
			}
			return undefined;
		};
		const label = (args: any[]) => typeof args[0] === 'string' ? '"' + args[0].slice(0, 60) + '"' : '';
		const autoAnswered: string[] = [];
		const originals: Record<string, any> = {};
		const wrap = (name: string, answer: (args: any[]) => unknown) => {
			originals[name] = w[name];
			w[name] = (...args: any[]) => {
				const chosen = answer(args) as string | { title: string } | undefined;
				const chosenLabel = chosen === undefined ? '(no button offered)'
					: typeof chosen === 'string' ? chosen : chosen.title;
				autoAnswered.push(name + '(' + label(args) + ') -> ' + chosenLabel);
				return Promise.resolve(chosen);
			};
		};
		wrap('showWarningMessage', firstButtonItem);
		wrap('showInformationMessage', firstButtonItem);
		wrap('showQuickPick', (args) => Array.isArray(args[0]) && args[0].length > 0 ? args[0][0] : undefined);
		return {
			autoAnswered,
			restore: () => {
				for (const name of Object.keys(originals)) w[name] = originals[name];
			}
		};
	}

	/** Does the context file exist in the working tree? (The `openFile` command opens the working file.) */
	public workingTreeFileExists(context: Record<string, string>): boolean {
		try {
			return typeof context.file === 'string' && context.file !== '' && fs.existsSync(path.join(context.repo, context.file));
		} catch (_) {
			return false;
		}
	}
}
