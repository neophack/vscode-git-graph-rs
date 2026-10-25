import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandStep } from './catalog';
import { DiffSide, encodeDiffDocUri } from '../diffDocProvider';
import { GraphViewState, graphViewPort } from './graphViewPort';
import { GitFileStatus } from '../types/git';
import { RequestMessage, ResponseMessage } from '../types';
import { tabGroups } from '../extension/platform/vscodeCompat';

/**
 * The narrow seam the automation server drives. It touches the view ONLY through the injected
 * GraphViewPort (graphViewPort.ts) — the same entry point the webview's own messages take
 * (injectRequest) and the same exit (onHostMessage) — so a request-mode run exercises exactly the
 * path a button click does, no mocks in between. Command-mode runs additionally go through
 * `vscode.commands.executeCommand`, the same dispatch a contributed menu item's click takes.
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

/** Snapshot of the view and repository state (gg.status / gg.query repos) — the port's state shape. */
export type ViewState = GraphViewState;

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
	const groups = tabGroups();
	if (groups === null) return [];
	// No flatMap here: src/tsconfig.json targets the es6 lib (the extension's VS Code floor).
	const tabs: any[] = [];
	for (const group of groups.all) {
		if (Array.isArray(group.tabs)) tabs.push(...group.tabs);
	}
	return tabs;
}

/** What {@see installDialogAutoAnswer} captured while it was installed. */
export interface DialogAutoAnswer {
	/** One human-readable line per intercepted native dialog, in intercept order. */
	readonly autoAnswered: readonly string[];
	/** The full text of every intercepted notification (information / warning / error), in intercept order. */
	readonly messages: readonly string[];
	/** Restore the original window methods (idempotent). */
	readonly restore: () => void;
}

export class HostBridge {
	/** The listener currently installed as the host-message tap (a newer subscriber replaces an older one). */
	private hostMessageListener: ((msg: ResponseMessage) => void) | null = null;
	/** The listener currently installed for shim results. */
	private shimResultListener: ((result: unknown) => void) | null = null;

	/** Is a Git Graph view currently open? */
	public hasView(): boolean {
		return graphViewPort.hasView();
	}

	/** Snapshot of the view and repository state (gg.status / gg.query repos). */
	public viewState(): ViewState {
		return graphViewPort.viewState();
	}

	/**
	 * Inject a request into the extension host as if the webview had sent it. Fire-and-forget:
	 * the view's own handler reports its errors; the outcome is observed through the host-message
	 * tap.
	 */
	public inject(message: RequestMessage): void {
		graphViewPort.injectRequest(message);
	}

	/**
	 * Release the engine's warm handle of a repository (its memory-mapped pack reads keep the
	 * repository's files undeletable on Windows until the handle drops). A no-op with no view
	 * open — nothing holds the repository then.
	 */
	public closeRepository(repo: string): void {
		graphViewPort.closeRepository(repo);
	}

	/**
	 * Observe every message the host sends to the webview. Returns the unsubscribe function.
	 * The tap is held by the port: it stays installed across view recreations and works even
	 * when no view is open yet (messages simply don't flow until one opens).
	 */
	public onHostMessage(listener: (msg: ResponseMessage) => void): () => void {
		this.hostMessageListener = listener;
		graphViewPort.onHostMessage(listener);
		return () => {
			// Only clear the tap if it is still ours (a newer subscriber would have replaced it)
			if (this.hostMessageListener === listener) {
				this.hostMessageListener = null;
				graphViewPort.onHostMessage(null);
			}
		};
	}

	/** Observe shim results posted from the page. Returns the unsubscribe function. */
	public onShimResult(listener: (result: ShimResult) => void): () => void {
		const wrapped = (result: unknown) => listener(result as ShimResult);
		this.shimResultListener = wrapped;
		graphViewPort.onShimResult(wrapped);
		return () => {
			if (this.shimResultListener === wrapped) {
				this.shimResultListener = null;
				graphViewPort.onShimResult(null);
			}
		};
	}

	/** Send a message to the page shim (not a ResponseMessage — the bundle ignores it). */
	public postToWebview(message: unknown): void {
		graphViewPort.postToWebview(message);
	}

	/** Open (or reveal) the Git Graph view on the given repository, registering it if unknown. */
	public async openView(repo: string): Promise<void> {
		await vscode.commands.executeCommand('git-graph-rs.view', { rootUri: vscode.Uri.file(repo) });
	}

	/* ---------------- VS Code command execution (command mode) ---------------- */

	/**
	 * Execute the VS Code command a contributed menu item runs, building the argument that menu
	 * passes from the run's placeholder context (see CommandArgSpec for the shapes). The command
	 * wrapper in commands.ts FORWARDS its handler's promise (already caught, so it never rejects),
	 * so this resolves once the handler has completed — a caller holding the dialog auto-answer
	 * over the await covers every notification and modal the command raises.
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
		return tabGroups() === null ? null : automationOpenTabs().map(automationTabKey);
	}

	/**
	 * While a command-mode action runs, intercept the native dialogs and notifications the command
	 * may raise: a modal confirmation, an amend prompt or a quick pick is answered with its primary
	 * action — the counterpart of the runner auto-confirming the webview's data-loss warning: the
	 * run is not interactive, so an unanswered modal would stall the command forever. An error
	 * notification offers nothing to answer: it is captured (the run record shows what the command
	 * answered — e.g. a designed Gerrit refusal) and suppressed, so a non-interactive run does not
	 * spray deterministic error toasts at the user. Everything intercepted is recorded; the original
	 * window methods are restored by the returned handle.
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
		const messages: string[] = [];
		const originals: Record<string, any> = {};
		const wrap = (name: string, unanswered: string, answer: (args: any[]) => unknown) => {
			originals[name] = w[name];
			w[name] = (...args: any[]) => {
				if (typeof args[0] === 'string') messages.push(args[0]);
				const chosen = answer(args) as string | { title: string } | undefined;
				const chosenLabel = chosen === undefined ? unanswered
					: typeof chosen === 'string' ? chosen : chosen.title;
				autoAnswered.push(name + '(' + label(args) + ') -> ' + chosenLabel);
				return Promise.resolve(chosen);
			};
		};
		wrap('showWarningMessage', '(no button offered)', firstButtonItem);
		wrap('showInformationMessage', '(no button offered)', firstButtonItem);
		wrap('showErrorMessage', '(suppressed)', () => undefined);
		wrap('showQuickPick', '(no items)', (args) => Array.isArray(args[0]) && args[0].length > 0 ? args[0][0] : undefined);
		return {
			autoAnswered,
			messages,
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
