import type { DataSource } from '../../../dataSource';
import type { GraphViewRequests, RequestCommand } from '../../../shared/protocol/graphView';
import type {
	ErrorInfo, GitFileStatus, LossWarning, PullRequestConfig, RequestLoadCommits, RequestMessage, ResponseLoadCommits, ResponseMessage
} from '../../../types';

/**
 * The handler side of the graph view protocol (REFACTOR-PLAN 3.3 + task 4.2): one Handler per
 * request command, assembled exhaustively in index.ts. Handlers may touch the outside world
 * only through the {@link HandlerContext} ports, so unit tests substitute every effect.
 */

/**
 * The host UI surface the handlers drive. The production implementation (panel.ts, task 4.4)
 * delegates to src/utils/actions.ts and the vscode API; routing through this port keeps both
 * 'vscode' and the utils out of the handler modules, which is what makes them unit-testable.
 */
export interface UiPort {
	showErrorMessage(message: string): void;
	/** Reveal the Source Control view (the util of the same name in src/utils/actions.ts). */
	viewScm(): Thenable<ErrorInfo>;
	openExternalUrl(url: string): Thenable<ErrorInfo>;
	openExtensionSettings(): Thenable<ErrorInfo>;
	openLogFile(): Thenable<ErrorInfo>;
	copyToClipboard(text: string): Thenable<ErrorInfo>;
	copyFilePathToClipboard(repo: string, filePath: string, absolute: boolean): Thenable<ErrorInfo>;
	viewDiff(repo: string, fromHash: string, toHash: string, oldFilePath: string, newFilePath: string, type: GitFileStatus): Thenable<ErrorInfo>;
	viewDiffWithWorkingFile(repo: string, hash: string, filePath: string): Thenable<ErrorInfo>;
	viewFileAtRevision(repo: string, hash: string, filePath: string): Thenable<ErrorInfo>;
	openFile(repo: string, filePath: string, hash: string): Thenable<ErrorInfo>;
	/** Create a zip archive of a ref (the save dialog flow of src/utils/actions.ts's archive). */
	createArchive(repo: string, ref: string): Thenable<ErrorInfo>;
	/** Open the browser at a pull/merge request creation URL for the given source. */
	createPullRequest(config: PullRequestConfig, sourceOwner: string, sourceRepo: string, sourceBranch: string): Thenable<ErrorInfo>;
	/** Save git-graph-rs.interfaceLanguage to the Global User Settings (validated by the impl). */
	setInterfaceLanguage(language: 'auto' | 'en' | 'zh-cn'): Promise<ErrorInfo>;
}

/**
 * The commit-loading machinery the handlers need. The production implementation is the
 * CommitLoader extracted from GitGraphView in task 4.3 (src/extension/graphView/commitLoader.ts:
 * staged loadCommits responses, the commit-page cache, the Gerrit cache and staleness set); the
 * Panel cutover (task 4.4) is what constructs it in the live path, replacing the still-live
 * inline pipeline of src/gitGraphView.ts.
 */
export interface CommitLoaderPort {
	/**
	 * Serve a loadCommits request: send the initial response as soon as the branch graph is
	 * ready, then the follow-up responses (remote refs, Gerrit stages, the uncommitted-changes
	 * row) through the same send function as they complete.
	 */
	loadCommits(msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void): Promise<void>;
	/** Mark the repository's cached Gerrit data stale: a fetch may have updated its change refs. */
	markGerritStale(repo: string): void;
	/** Drop the stale flag (the repository's Gerrit change refs were just deleted). */
	unmarkGerritStale(repo: string): void;
	/** Drop every cached Gerrit datum of the repository (its change refs are gone). */
	clearGerritCache(repo: string): void;
	/** Drop the cached commit pages of every repository (a repo-mutating command finished). */
	invalidateCommitCache(): void;
}

/**
 * The slice of the extension configuration the request handlers read, taken once at the start
 * of the request (task 4.5 widens this into the full snapshot and moves the getConfig calls).
 */
export interface ConfigSnapshot {
	readonly gerrit: {
		/** The remote the Gerrit integration fetches change refs from. */
		readonly remote: string;
	};
}

/**
 * Everything a handler may touch: the repository (the live DataSource until the git layer is
 * split in Phase 3 - imported here as a type only, so handler modules stay vscode-free), the
 * configuration snapshot, the UI and commit-loading ports, and the send function back to the
 * webview.
 */
export interface HandlerContext {
	readonly repo: DataSource;
	readonly config: ConfigSnapshot;
	readonly ui: UiPort;
	readonly loader: CommitLoaderPort;
	send(msg: ResponseMessage): void;
}

/**
 * One request handler. `mutates` is the per-handler replacement of the hand-maintained
 * REPO_MUTATING_COMMANDS set (see shared/protocol/graphView.ts's MUTATING_COMMANDS, from which
 * every handler derives its flag): the dispatcher runs mutating handlers with the repo file
 * watcher muted and drops the commit cache afterwards.
 */
export interface Handler<K extends RequestCommand = RequestCommand> {
	readonly mutates: boolean;
	handle(msg: GraphViewRequests[K]['req'], ctx: HandlerContext): void | Promise<void>;
}

/**
 * Forward a data-loss warning an action returned to the view: its standard warning dialog
 * shows the message, and confirming re-sends the original request with its confirmed flag set.
 * @returns TRUE when a warning was forwarded and the action must not report a result.
 */
export function sendLossWarning(result: ErrorInfo | LossWarning | ReadonlyArray<ErrorInfo | LossWarning>, request: RequestMessage, ctx: HandlerContext): boolean {
	const warning = Array.isArray(result) ? result[0] : result;
	if (warning === null || typeof warning !== 'object' || !('message' in warning)) return false;
	ctx.send({ command: 'lossWarning', message: warning.message, retry: { ...request, confirmed: true } as RequestMessage });
	return true;
}

/**
 * The error a handler throws whose genuine implementation depends on GitGraphView internals
 * that do not exist as modules yet. Thrown only when the handler is actually invoked (the
 * handler table itself stays complete, so every command still routes); the dispatcher's caller
 * logs it like any other handler failure.
 */
export function notWired(what: string): never {
	throw new Error('not wired: ' + what);
}
