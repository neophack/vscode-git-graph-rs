import type { DataSource } from '../../../dataSource';
import type { GraphViewRequests, RequestCommand } from '../../../shared/protocol/graphView';
import type {
	CodeReview, ErrorInfo, GitConfigLocation, GitFileStatus, GitGraphViewGlobalState, GitGraphViewSnapshot,
	GitGraphViewWorkspaceState, GitRepoSet, GitRepoState, LossWarning, PullRequestConfig,
	PullRequestInfo, RequestLoadCommits, RequestMessage, ResponseLoadCommits, ResponseMessage
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
	/**
	 * Open the Commit Comparison view of two commits (a separate webview panel; its host
	 * controller moves to extension/views in Phase 6, until then the impl closes over it).
	 */
	openCompareTab(repo: string, fromHash: string, toHash: string, singleCommit: boolean): void;
	/**
	 * Open the standalone binary compare view for a binary/image file the native Diff view cannot
	 * show (the impl derives the comparison base the same way src/utils/actions.ts does).
	 */
	viewDiffBinary(repo: string, fromHash: string, toHash: string, oldFilePath: string, newFilePath: string, type: GitFileStatus): void;
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
	/**
	 * Whether the view currently RENDERS a commit list: the loadRepoInfo handler reads it to
	 * decide the remote-refs deferral (a stripped, local-only branch list pays only on an empty
	 * view; on a populated one it would visibly blink the remote entries out and back).
	 */
	readonly viewHasCommits: boolean;
	/** The view switched to a different repository: reset the per-repo view state (the deferral and the uncommitted stabiliser). */
	viewRepoChanged(): void;
}

/**
 * The avatar service the handlers drive (the production instance is the AvatarManager; the port
 * keeps the vscode-dependent manager out of the handler modules).
 */
export interface AvatarPort {
	/** Fetch the avatar of an email address into storage (the completion event reaches the webview separately). */
	fetchAvatarImage(email: string, repo: string, remote: string | null, commits: string[]): void;
	/** The cached avatar image (a data URI) of an email address, or NULL when none is stored. */
	getAvatarImage(email: string): Promise<string | null>;
}

/**
 * The persisted-state surface the handlers need. The production instance is the ExtensionState
 * (src/extensionState.ts); the port exists until platform/storage (task 4.5/Phase 6) owns the
 * impl, so handler modules stay free of both 'vscode' and the concrete class.
 */
export interface StoragePort {
	/** The stored code review of a commit (or a fromHash-toHash pair), or NULL when there is none. */
	getCodeReview(repo: string, id: string): CodeReview | null;
	startCodeReview(repo: string, id: string, files: string[], lastViewedFile: string | null): Thenable<{ codeReview: CodeReview, error: ErrorInfo }>;
	updateCodeReview(repo: string, id: string, remainingFiles: string[], lastViewedFile: string | null): Thenable<ErrorInfo>;
	endCodeReview(repo: string, id: string): void;
	setGlobalViewState(state: GitGraphViewGlobalState): Thenable<ErrorInfo>;
	setWorkspaceViewState(state: GitGraphViewWorkspaceState): Thenable<ErrorInfo>;
	setViewSnapshot(snapshot: GitGraphViewSnapshot): void;
	/** The repository the view last had open (rides along every loadRepos response). */
	getLastActiveRepo(): string | null;
}

/**
 * The repository-registry surface the handlers need. The production instance is the RepoManager
 * (src/extension/repos/repoManager.ts); the port exists until extension/repos (Phase 6) owns the
 * impl, keeping the manager (and its vscode dependency) out of the handler modules.
 */
export interface ReposPort {
	/** The set of known repositories (the repo path is the key, the name the value). */
	getRepos(): GitRepoSet;
	/** Check every known repository still exists on disk; TRUE when the set changed. */
	checkReposExist(): Promise<boolean>;
	/** Persist the per-repository state (dropdown selection, branch filter, ...). */
	setRepoState(repo: string, state: GitRepoState): void;
	/** Write the repository's .vscode/git-graph-rs.json; the ErrorInfo of a failure (NULL => written). */
	exportRepoConfig(repo: string): Promise<ErrorInfo>;
	/**
	 * Search the workspace for repositories again. On a search that found nothing, the impl
	 * shows the localized notice itself (the string lives behind the vscode-dependent i18n
	 * lookup, which the port keeps out of the handler modules).
	 */
	rescanForRepos(): Promise<void>;
}

/**
 * The git identity-config writes of the Settings widget's User Details rows. GitConfigKey lives
 * in dataSource.ts until the Phase 3 git-layer split; the port carries plain key names so the
 * handler modules never import the enum's (vscode-typed) module at runtime.
 */
export interface UserConfigPort {
	setUserName(repo: string, name: string, location: GitConfigLocation): Promise<ErrorInfo>;
	setUserEmail(repo: string, email: string, location: GitConfigLocation): Promise<ErrorInfo>;
	unsetUserName(repo: string, location: GitConfigLocation): Promise<ErrorInfo>;
	unsetUserEmail(repo: string, location: GitConfigLocation): Promise<ErrorInfo>;
	/**
	 * Drop the cached configuration data of the repository: a Global-location write never
	 * touches the repository's .git/config, so the watcher-based invalidation cannot fire for it.
	 */
	invalidateConfig(repo: string): void;
}

/**
 * The global (user) settings the Settings widget may write. The validators, the global-author
 * side effects of 'commitAuthors' and the registered-configuration quirk live behind this port
 * (graphView/globalSettings.ts implements them) until platform/config owns them (task 4.5).
 */
export interface GlobalSettingsPort {
	/**
	 * Save a global setting on behalf of the Settings Widget. The impl validates the key and
	 * value, applies the commitAuthors global-Git-configuration side effects, and answers the
	 * ErrorInfo of the failure (NULL => saved successfully).
	 */
	setGlobalSetting(setting: string, value: unknown, previousValue?: unknown): Promise<ErrorInfo>;
}

/** A remote whose pull requests were loaded (see PullRequestsPort.fetchPullRequests). */
export interface PullRequestRemote {
	readonly name: string;
	readonly url: string;
	readonly prs: PullRequestInfo[];
	/** FALSE when the list is a truncated best-effort (a failed request), which must prune nothing. */
	readonly complete: boolean;
}

/**
 * The pull-request integration the fetchPullRequest handler drives (the production instance is
 * the fetch orchestration of graphView/pullRequestFetch.ts over the shared PullRequestDataSource).
 */
export interface PullRequestsPort {
	/**
	 * Load the pull/merge requests of the repository's GitHub/GitLab remote: the remote and its
	 * requests, or NULL whenever the integration is disabled or no remote is hosted on GitHub
	 * or GitLab (the impl logs the reason).
	 */
	fetchPullRequests(repo: string): Promise<PullRequestRemote | null>;
	/**
	 * Fetch the head commits of the still-open pull requests into the repository and prune the
	 * refs of pull requests that closed since (the fetched refs trip the repo file watcher).
	 */
	fetchPullRequestHeadRefs(repo: string, remote: PullRequestRemote): Promise<void>;
}

/** Which staged request a refresh id belongs to (the regenerated HTML's initialState carries them). */
export type RefreshIdKind = 'loadRepoInfo' | 'loadCommits' | 'loadConfig';

/**
 * The live view state only the Panel owns: the loadRepoInfo handler reads the rendered-commits
 * flag for the remote-refs deferral, records the refresh ids the next regenerated page embeds,
 * and reports a repository switch so the Panel restarts watching and resets its per-repo state.
 */
export interface ViewPort {
	/** Whether the view currently renders a commit list (see CommitLoaderPort.viewHasCommits). */
	readonly viewHasCommits: boolean;
	/** Record the latest refresh id of a staged request (embedded into the regenerated page). */
	noteRefreshId(kind: RefreshIdKind, id: number): void;
	/**
	 * A loadRepoInfo response was sent for a repository: when it differs from the repository the
	 * view currently shows, the impl records the last-active repository, restarts the repo file
	 * watcher and the background poll baseline, and resets the loader's per-repo view state.
	 */
	repoSwitched(repo: string): void;
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
 * configuration snapshot, the UI and commit-loading ports, the panel-collaborator ports
 * (avatars, persisted state, the repository registry, the settings writes, pull requests and
 * the view state - each a port until its future module in the plan owns the impl), and the
 * send function back to the webview.
 */
export interface HandlerContext {
	readonly repo: DataSource;
	readonly config: ConfigSnapshot;
	readonly ui: UiPort;
	readonly loader: CommitLoaderPort;
	readonly avatars: AvatarPort;
	readonly storage: StoragePort;
	readonly repos: ReposPort;
	readonly userConfig: UserConfigPort;
	readonly settings: GlobalSettingsPort;
	readonly pullRequests: PullRequestsPort;
	readonly view: ViewPort;
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
