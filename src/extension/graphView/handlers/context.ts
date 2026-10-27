import type { ProductionGitRepository } from '../../git/gitRepository';
import type { Localize } from '../../git/write/argSafety';
import type { GitRunnerPort } from '../gitRunner';
import type { RepoConfigData } from '../repoReads';
import type { GraphViewRequests, RequestCommand } from '../../../shared/protocol/graphView';
import type { CodeReview, GitRepoSet, GitRepoState } from '../../../shared/model/repoState';
import type { ErrorInfo, LossWarning, RequestMessage, ResponseMessage } from '../../../shared/protocol/messages';
import type { GitConfigLocation, GitFileStatus } from '../../../shared/model/git';
import type { GitGraphViewGlobalState, GitGraphViewSnapshot, GitGraphViewWorkspaceState, SquashMessageFormat } from '../../../shared/model/webview';
import type { PullRequestConfig, PullRequestInfo } from '../../../shared/model/pullRequest';
import type { RequestLoadCommits, RequestLoadView, ResponseLoadCommits, ResponseLoadView } from '../../../shared/protocol/loading';

/**
 * The handler side of the graph view protocol: one Handler per
 * request command, assembled exhaustively in index.ts. Handlers may touch the outside world
 * only through the {@link HandlerContext} ports, so unit tests substitute every effect.
 */

/**
 * The host UI surface the handlers drive. The production implementation (panelContext.ts)
 * delegates to platform/actions.ts and the vscode API; routing through this port keeps both
 * 'vscode' and the actions out of the handler modules, which is what makes them unit-testable.
 */
export interface UiPort {
	showErrorMessage(message: string): void;
	/** Reveal the Source Control view (the util of the same name in platform/actions.ts). */
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
	/** Create a zip archive of a ref (the save dialog flow of platform/actions.ts's archive). */
	createArchive(repo: string, ref: string): Thenable<ErrorInfo>;
	/** Open the browser at a pull/merge request creation URL for the given source. */
	createPullRequest(config: PullRequestConfig, sourceOwner: string, sourceRepo: string, sourceBranch: string): Thenable<ErrorInfo>;
	/** Save git-graph-rs.interfaceLanguage to the Global User Settings (validated by the impl). */
	setInterfaceLanguage(language: 'auto' | 'en' | 'zh-cn'): Promise<ErrorInfo>;
	/**
	 * Open the Commit Comparison view of two commits (a separate webview panel; its host
	 * controller lives in extension/views/comparison, and the impl closes over it).
	 */
	openCompareTab(repo: string, fromHash: string, toHash: string, singleCommit: boolean): void;
	/**
	 * Open the standalone binary compare view for a binary/image file the native Diff view cannot
	 * show (the impl derives the comparison base the same way platform/actions.ts does).
	 */
	viewDiffBinary(repo: string, fromHash: string, toHash: string, oldFilePath: string, newFilePath: string, type: GitFileStatus): void;
	/**
	 * Open the integrated terminal at `repo`, optionally running a Git command (the "Open Terminal"
	 * button, and the interactive-rebase handoff of the rebase flow).
	 */
	openGitTerminal(repo: string, command: string | null, name: string): Thenable<ErrorInfo>;
	/** Shell-quote an object for the integrated terminal's shell (the rebase flow's argument), or NULL when it cannot be quoted safely. */
	quoteForTerminal(obj: string): string | null;
	/**
	 * Open the external diff tool over the directory diff of two revisions (a GUI tool blocks the
	 * handler until it exits, so the impl resolves after the tool LAUNCHED).
	 */
	openExternalDirDiff(repo: string, fromHash: string, toHash: string, isGui: boolean): Thenable<ErrorInfo>;
}

/**
 * The commit-loading machinery the handlers need. The production implementation is the
 * CommitLoader (src/extension/graphView/commitLoader.ts: staged loadCommits responses, the
 * commit-page cache, the Gerrit cache and staleness set), constructed by the panel
 * (panel.ts, through panelContext.ts).
 */
export interface CommitLoaderPort {
	/**
	 * Serve a loadCommits request: send the initial response as soon as the branch graph is
	 * ready, then the follow-up responses (remote refs, Gerrit stages, the uncommitted-changes
	 * row) through the same send function as they complete.
	 */
	loadCommits(msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void): Promise<void>;
	/**
	 * Serve a loadView request (the merged open path): one response carrying the repo info and
	 * the first commit page, then the same staged follow-ups.
	 */
	loadView(msg: RequestLoadView, send: (response: ResponseLoadView | ResponseLoadCommits) => void): Promise<void>;
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
 * (platform/storage.ts); the port keeps the handler modules free of both 'vscode' and the
 * concrete class.
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
 * (src/extension/repos/repoManager.ts); the port keeps the manager (and its vscode dependency)
 * out of the handler modules.
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
 * The git identity-config writes of the Settings widget's User Details rows. The keys are the
 * write-op table's `GitConfigKey` (write/ops/config.ts); the port carries plain key names so the
 * handler modules never import the (vscode-typed) configuration module at runtime.
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
 * (graphView/globalSettings.ts implements them; platform/config owns the read side).
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
	/** Whether the view currently renders a commit list (see {@link viewHasCommits}). */
	readonly viewHasCommits: boolean;
	/** Record the latest refresh id of a staged request (embedded into the regenerated page). */
	noteRefreshId(kind: RefreshIdKind, id: number): void;
	/**
	 * A loadRepoInfo response was sent for a repository: when it differs from the repository the
	 * view currently shows, the impl records the last-active repository, restarts the repo file
	 * watcher and the background poll baseline, and resets the loader's per-repo view state.
	 */
	repoSwitched(repo: string): void;
	/**
	 * The webview reported `ready`: the impl pushes the merged loadView result the panel began
	 * reading at creation (the open path) and records the repository it pushed for.
	 */
	viewReady(): void;
}

/**
 * Everything a handler may touch: the repository facade (the `GitRepository` the composition root
 * composed from the read backend and the GitWriter), the raw Git runner, the composed config
 * cache and the Gerrit write, the
 * configuration snapshot, the UI and commit-loading ports, the panel-collaborator ports (avatars,
 * persisted state, the repository registry, the settings writes, pull requests and the view
 * state), the localizer, and the send function back to the webview.
 */
export interface HandlerContext {
	/** The repository: reads via `repo.read.<method>`, writes via `repo.write(repo, op)`. */
	readonly repo: ProductionGitRepository;
	/** The raw Git runner (the Gerrit integration's data reads, the non-op flows). */
	readonly git: GitPort;
	/** The composed, cached repository configuration (the loadConfig handler's source). */
	readonly repoConfig: RepoConfigPort;
	/** The Gerrit write of the integration's disable flow. */
	readonly gerrit: GerritWritesPort;
	/** The localizer for handler-produced messages (injected, so this module stays vscode-free). */
	readonly t: Localize;
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
 * The context the write flows run against: the slice of the handler context they consume. The
 * panel's HandlerContext satisfies this structurally (its `ui` port carries the two flow members
 * among its own, and `repoConfig.invalidate` is the invalidation hook), so handlers pass `ctx`
 * straight through to the flows.
 */
export type WriteFlowHost = import('../writeFlows').WriteFlowContext;

/**
 * The slice of the extension configuration the request handlers read, taken once at the start of
 * the request. The Settings-related and merge/pull formats ride along so the handler modules stay
 * free of the vscode-dependent configuration module.
 */
export interface ConfigSnapshot {
	readonly gerrit: {
		/** The remote the Gerrit integration fetches change refs from. */
		readonly remote: string;
	};
	/** Whether remote HEADs are shown in the branch list (the loadRepoInfo / loadView ref read). */
	readonly showRemoteHeads: boolean;
	/** The squash-commit message formats of the squash pull and squash merge flows. */
	readonly squashPullMessageFormat: SquashMessageFormat;
	readonly squashMergeMessageFormat: SquashMessageFormat;
}

/**
 * The raw Git runner of the view (see gitRunner.ts): the spawn seam behind the Gerrit
 * integration's data reads and the couple of flows that are not pure ops.
 */
export type GitPort = GitRunnerPort;

/**
 * The composed, cached repository configuration of the Settings widget: the loadConfig handler
 * serves identical requests from the cache, and a config-affecting write drops it.
 */
export interface RepoConfigPort {
	/** The repository's composed configuration (the GitRepoConfig the response carries). */
	load(repo: string, remotes: ReadonlyArray<string>): Promise<RepoConfigData>;
	/** Drop the cached configuration of one repository (or every repository for NULL). */
	invalidate(repo: string | null): void;
}

/**
 * The one Gerrit write the view performs directly: deleting ALL locally fetched change refs with
 * a single batched `update-ref --stdin` (a command fed on stdin, which no pure write op models
 * yet — the runner carries it until the op table grows an input-feeding step).
 */
export interface GerritWritesPort {
	clearLocalChanges(repo: string, remote: string): Promise<{ error: ErrorInfo; cleared: number }>;
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
