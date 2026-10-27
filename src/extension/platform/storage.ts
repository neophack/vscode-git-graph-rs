import * as vscode from 'vscode';
import { Avatar } from '../integrations/avatars/avatarManager';
import { BooleanOverride, FileViewType, GitGraphViewGlobalState, GitGraphViewSnapshot, GitGraphViewWorkspaceState, RepoCommitOrdering } from '../../shared/model/webview';
import { GitRepoSet, GitRepoState } from '../../shared/model/repoState';
import { GitExecutable } from '../git/executable/findGit';
import { getPathFromStr } from './paths';
import { Disposable } from '../../shared/util/disposable';
import { GgEvent } from '../../shared/util/event';
import type { ConfigProvider } from './config';
import { isStateRecord, VersionedStateKv } from './storageVersioned';
import { AvatarStore } from './storageAvatars';
import { CodeReviewStore } from './storageCodeReviews';
import type { CodeReviews } from './storageCodeReviews';
import { ViewStateStore } from './storageViewState';

export { STORAGE_MIGRATIONS, STORAGE_STATE_VERSION } from './storageVersioned';
export type { CodeReviewData, CodeReviews } from './storageCodeReviews';
export { DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE } from './storageViewState';

/**
 * Platform storage adapter: the ONE storage module, unifying the
 * `Storage` seam (global- and workspace-state persistence behind one
 * lenient interface, with the dependency injected structurally) with the Git Graph
 * `ExtensionState` - the typed, key-by-key view over both mementos the live
 * extension host uses.
 *
 * The `Storage` seam's dependency is injected structurally (production wiring passes a
 * context's `globalState` / `workspaceState`, both `vscode.Memento`-shaped). Reads are
 * LENIENT: with no memento available (or a failing one) `get` answers the caller's default and
 * `undefined`, never throws. Writes report success as a boolean instead of rejecting, so state
 * bookkeeping can never take down a request path.
 *
 * The `ExtensionState` values are versioned user data: reads migrate
 * older versions leniently and preserve newer writers' unknown fields, while every write
 * stamps `STORAGE_STATE_VERSION`. All of it sits on ONE versioned KV (`VersionedStateKv`,
 * ./storageVersioned.ts); the per-store modules are ./storageAvatars.ts (the avatar cache and
 * storage folder), ./storageCodeReviews.ts (the code-review records) and ./storageViewState.ts
 * (the global/workspace view state and the view snapshot), with this class the facade that
 * holds the repository, Git-executable and author-identity keys and keeps the flat
 * `ExtensionState` API every consumer already uses.
 */

/** The `vscode.Memento` surface this adapter uses. */
export interface MementoLike {
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

export class Storage {
	private readonly memento: MementoLike | null;

	/**
	 * @param memento A memento-like object (`vscode.Memento` satisfies this structurally); NULL
	 * or undefined when no backing store is available.
	 */
	constructor(memento: MementoLike | null | undefined) {
		this.memento = memento ?? null;
	}

	/**
	 * Read a value (lenient read): the stored value when present, otherwise the given default
	 * (or undefined). An unavailable or throwing store answers like an empty one.
	 */
	public get<T>(key: string, defaultValue?: T): T | undefined {
		const memento = this.memento;
		if (memento === null) return defaultValue;
		const read = memento.get as unknown;
		if (typeof read !== 'function') return defaultValue;
		try {
			const get = (read as <V>(readKey: string, readDefault?: V) => V | undefined).bind(memento) as (key: string, defaultValue?: T) => T | undefined;
			return defaultValue === undefined ? get(key) : get(key, defaultValue);
		} catch {
			return defaultValue;
		}
	}

	/**
	 * Store a value.
	 * @returns TRUE when the value was persisted; FALSE when no store is available or the
	 * update rejected (never rejects).
	 */
	public set(key: string, value: unknown): Promise<boolean> {
		return this.update(key, value);
	}

	/**
	 * Remove a key from the store (the memento's undefined-value convention).
	 * @returns TRUE when the key was removed; FALSE when no store is available or the update
	 * rejected.
	 */
	public remove(key: string): Promise<boolean> {
		return this.update(key, undefined);
	}

	private update(key: string, value: unknown): Promise<boolean> {
		const update = this.memento?.update;
		if (typeof update !== 'function') return Promise.resolve(false);
		return Promise.resolve(update.call(this.memento, key, value) as Thenable<void>)
			.then(() => true, () => false);
	}
}

// --------------------------------------------------------------------------------------
// The Git Graph Extension State (absorbed verbatim from the former flat src/extensionState.ts)
// --------------------------------------------------------------------------------------

const GLOBAL_AUTHOR_WRITTEN = 'globalAuthorWritten';
const IGNORED_REPOS = 'ignoredRepos';
const LAST_ACTIVE_REPO = 'lastActiveRepo';
const LAST_KNOWN_GIT_PATH = 'lastKnownGitPath';
const LAST_KNOWN_GIT = 'lastKnownGit';
const REPO_STATES = 'repoStates';

/** The author identity of the global Git configuration that this extension wrote. */
export interface WrittenGlobalAuthor {
	name: string;
	email: string;
}

/**
 * The last good Git executable, persisted for the next activation: the path and version are used
 * immediately (before the background `git --version` revalidation answers), and the binary's
 * modification time is what lets that revalidation skip the spawn when the file is unchanged.
 */
export interface LastKnownGitRecord {
	readonly path: string;
	readonly version: string;
	readonly mtimeMs: number | null;
}

export const DEFAULT_REPO_STATE: GitRepoState = {
	pinnedBranches: [],
	pinnedCommits: [],
	cdvDivider: 0.5,
	cdvHeight: 250,
	columnWidths: null,
	commitOrdering: RepoCommitOrdering.Default,
	fileViewType: FileViewType.Default,
	gerritFetchRefs: false,
	gerritFetchLimit: null,
	gerritStatusFilter: { new: true, merged: false, abandoned: false, wip: false },
	hideRemotes: [],
	includeCommitsMentionedByReflogs: BooleanOverride.Default,
	issueLinkingConfig: null,
	lastImportAt: 0,
	name: null,
	onlyFollowFirstParent: BooleanOverride.Default,
	onRepoLoadShowCheckedOutBranch: BooleanOverride.Default,
	onRepoLoadShowSpecificBranches: null,
	pullRequestConfig: null,
	showRemoteBranches: true,
	showRemoteBranchesV2: BooleanOverride.Default,
	showStashes: BooleanOverride.Default,
	showTags: BooleanOverride.Default,
	workspaceFolderIndex: null
};

/**
 * Manages the Git Graph Extension State, which stores data in both the Visual Studio Code Global & Workspace State.
 */
export class ExtensionState extends Disposable {
	private readonly kv: VersionedStateKv;
	private readonly globalStoragePath: string;
	private readonly avatars: AvatarStore;
	private readonly codeReviews: CodeReviewStore;
	private readonly viewState: ViewStateStore;

	/**
	 * Creates the Git Graph Extension State.
	 * @param context The context of the extension.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 * @param config The configuration service (the latest settings snapshot).
	 */
	constructor(context: vscode.ExtensionContext, onDidChangeGitExecutable: GgEvent<GitExecutable | null>, private readonly config: ConfigProvider) {
		super();
		this.kv = new VersionedStateKv(context.globalState, context.workspaceState);
		this.globalStoragePath = getPathFromStr(context.globalStoragePath);
		this.avatars = new AvatarStore(this.kv, this.globalStoragePath);
		this.codeReviews = new CodeReviewStore(this.kv);
		this.viewState = new ViewStateStore(this.kv);

		this.registerDisposable(
			onDidChangeGitExecutable((gitExecutable) => {
				if (gitExecutable) {
					this.setLastKnownGitPath(gitExecutable.path);
				}
			})
		);
	}

	/* Known Repositories */

	/**
	 * Get the known repositories in the current workspace.
	 * @returns The set of repositories.
	 */
	public getRepos() {
		const repoSet = this.kv.readWorkspace<GitRepoSet>(REPO_STATES, {});
		if (!isStateRecord(repoSet)) return {};
		const outputSet: GitRepoSet = {};
		let showRemoteBranchesDefaultValue: boolean | null = null;
		Object.keys(repoSet).forEach((repo) => {
			outputSet[repo] = Object.assign({}, DEFAULT_REPO_STATE, repoSet[repo]);
			if (typeof repoSet[repo].showRemoteBranchesV2 === 'undefined' && typeof repoSet[repo].showRemoteBranches !== 'undefined') {
				if (showRemoteBranchesDefaultValue === null) {
					showRemoteBranchesDefaultValue = this.config.current.repositoryShowRemoteBranches;
				}
				if (repoSet[repo].showRemoteBranches !== showRemoteBranchesDefaultValue) {
					outputSet[repo].showRemoteBranchesV2 = repoSet[repo].showRemoteBranches ? BooleanOverride.Enabled : BooleanOverride.Disabled;
				}
			}
		});
		return outputSet;
	}

	/**
	 * Set the known repositories in the current workspace.
	 * @param gitRepoSet The set of repositories.
	 */
	public saveRepos(gitRepoSet: GitRepoSet) {
		this.kv.writeWorkspace(REPO_STATES, gitRepoSet);
	}

	/**
	 * Transfer state references from one known repository to another.
	 * @param oldRepo The repository to transfer state from.
	 * @param newRepo The repository to transfer state to.
	 */
	public transferRepo(oldRepo: string, newRepo: string) {
		if (this.getLastActiveRepo() === oldRepo) {
			this.setLastActiveRepo(newRepo);
		}

		const reviews = this.getCodeReviews();
		if (typeof reviews[oldRepo] !== 'undefined') {
			reviews[newRepo] = reviews[oldRepo];
			delete reviews[oldRepo];
			this.setCodeReviews(reviews);
		}
	}


	/* Ignored Repos */

	/**
	 * Get the ignored repositories in the current workspace.
	 * @returns An array of the paths of ignored repositories.
	 */
	public getIgnoredRepos() {
		const ignoredRepos = this.kv.readWorkspace<unknown>(IGNORED_REPOS, []);
		return Array.isArray(ignoredRepos) ? ignoredRepos as string[] : [];
	}

	/**
	 * Set the ignored repositories in the current workspace.
	 * @param ignoredRepos An array of the paths of ignored repositories.
	 */
	public setIgnoredRepos(ignoredRepos: string[]) {
		return this.kv.writeWorkspace(IGNORED_REPOS, ignoredRepos);
	}


	/* Last Active Repo */

	/**
	 * Get the last active repository in the current workspace.
	 * @returns The path of the last active repository.
	 */
	public getLastActiveRepo() {
		const repo = this.kv.readWorkspace<unknown>(LAST_ACTIVE_REPO, null);
		return typeof repo === 'string' || repo === null ? repo : null;
	}

	/**
	 * Set the last active repository in the current workspace.
	 * @param repo The path of the last active repository.
	 */
	public setLastActiveRepo(repo: string | null) {
		this.kv.writeWorkspace(LAST_ACTIVE_REPO, repo);
	}


	/* Last Known Git Path */

	/**
	 * Get the last known path of the Git executable used by Git Graph.
	 * @returns The path of the Git executable.
	 */
	public getLastKnownGitPath() {
		const path = this.kv.readGlobal<unknown>(LAST_KNOWN_GIT_PATH, null);
		return typeof path === 'string' || path === null ? path : null;
	}

	/**
	 * Set the last known path of the Git executable used by Git Graph.
	 * @param path The path of the Git executable.
	 */
	private setLastKnownGitPath(path: string) {
		this.kv.writeGlobal(LAST_KNOWN_GIT_PATH, path);
	}


	/* Last Known Git Executable */

	/**
	 * Get the last good Git executable record (path, version and the binary's modification time),
	 * used optimistically at the next activation while the background revalidation runs.
	 * @returns The record, or NULL when none was persisted (or the persisted shape is unreadable).
	 */
	public getLastKnownGit(): LastKnownGitRecord | null {
		const record = this.kv.readGlobal<unknown>(LAST_KNOWN_GIT, null);
		if (record === null || typeof record !== 'object') return null;
		const candidate = record as { path?: unknown, version?: unknown, mtimeMs?: unknown };
		if (typeof candidate.path !== 'string' || typeof candidate.version !== 'string') return null;
		return {
			path: candidate.path,
			version: candidate.version,
			mtimeMs: typeof candidate.mtimeMs === 'number' ? candidate.mtimeMs : null
		};
	}

	/**
	 * Persist the last good Git executable record for the next activation.
	 * @param record The record to persist.
	 */
	public setLastKnownGit(record: LastKnownGitRecord) {
		this.kv.writeGlobal(LAST_KNOWN_GIT, record);
	}


	/* Written Global Author */

	/**
	 * Get the author identity of the global Git configuration that Git Graph last wrote itself
	 * (NULL when Git Graph never wrote it, or the one it wrote was since cleared). The machine's
	 * global Git configuration is machine-wide, so the record lives in the global state.
	 * @returns The identity Git Graph wrote, or NULL.
	 */
	public getGlobalAuthorWritten(): WrittenGlobalAuthor | null {
		const written = this.kv.readGlobal<WrittenGlobalAuthor | null>(GLOBAL_AUTHOR_WRITTEN, null);
		return written !== null && typeof written.name === 'string' && typeof written.email === 'string' ? written : null;
	}

	/**
	 * Record the author identity Git Graph wrote to the global Git configuration (or NULL, when
	 * the identity it wrote was removed again). This is what lets the Author Identities feature
	 * undo its own writes while never silently rewriting or deleting an identity the user
	 * configured outside of Git Graph.
	 * @param identity The identity Git Graph wrote, or NULL.
	 */
	public setGlobalAuthorWritten(identity: WrittenGlobalAuthor | null) {
		return this.kv.writeGlobal(GLOBAL_AUTHOR_WRITTEN, identity);
	}


	/* View State (global, workspace and the view snapshot) - ./storageViewState.ts */

	/**
	 * Get the global state of the Git Graph View.
	 * @returns The global state.
	 */
	public getGlobalViewState() {
		return this.viewState.getGlobalViewState();
	}

	/**
	 * Set the global state of the Git Graph View.
	 * @param state The global state.
	 */
	public setGlobalViewState(state: GitGraphViewGlobalState) {
		return this.viewState.setGlobalViewState(state);
	}

	/**
	 * Get the workspace state of the Git Graph View.
	 * @returns The workspace state.
	 */
	public getWorkspaceViewState() {
		return this.viewState.getWorkspaceViewState();
	}

	/**
	 * Set the workspace state of the Git Graph View.
	 * @param state The workspace state.
	 */
	public setWorkspaceViewState(state: GitGraphViewWorkspaceState) {
		return this.viewState.setWorkspaceViewState(state);
	}

	/**
	 * Get the last view state the Git Graph View's page reported in the current workspace.
	 * @returns The snapshot, or NULL if none was reported yet.
	 */
	public getViewSnapshot() {
		return this.viewState.getViewSnapshot();
	}

	/**
	 * Set the last view state the Git Graph View's page reported in the current workspace.
	 * @param snapshot The snapshot.
	 */
	public setViewSnapshot(snapshot: GitGraphViewSnapshot) {
		this.viewState.setViewSnapshot(snapshot);
	}


	/* Avatars - ./storageAvatars.ts */

	/**
	 * Checks whether the Avatar Storage Folder is available to store avatars.
	 * @returns TRUE => Avatar Storage Folder is available, FALSE => Avatar Storage Folder isn't available.
	 */
	public isAvatarStorageAvailable() {
		return this.avatars.isAvatarStorageAvailable();
	}

	/**
	 * Gets the path that is used to store avatars globally in Git Graph.
	 * @returns The folder path.
	 */
	public getAvatarStoragePath() {
		return this.avatars.getAvatarStoragePath();
	}

	/**
	 * Gets the cache of avatars known to Git Graph.
	 * @returns The avatar cache.
	 */
	public getAvatarCache() {
		return this.avatars.getAvatarCache();
	}

	/**
	 * Add a new avatar to the cache of avatars known to Git Graph.
	 * @param email The email address that the avatar is for.
	 * @param avatar The details of the avatar.
	 */
	public saveAvatar(email: string, avatar: Avatar) {
		this.avatars.saveAvatar(email, avatar);
	}

	/**
	 * Removes an avatar from the cache of avatars known to Git Graph.
	 * @param email The email address of the avatar to remove.
	 */
	public removeAvatarFromCache(email: string) {
		this.avatars.removeAvatarFromCache(email);
	}

	/**
	 * Removes multiple avatars from the cache of avatars known to Git Graph, in one state write.
	 * @param emails The email addresses of the avatars to remove.
	 */
	public removeAvatarsFromCache(emails: string[]) {
		this.avatars.removeAvatarsFromCache(emails);
	}

	/**
	 * Clear all avatars from the cache of avatars known to Git Graph.
	 * @returns A Thenable resolving to the ErrorInfo that resulted from executing this method.
	 */
	public clearAvatarCache() {
		return this.avatars.clearAvatarCache();
	}


	/* Code Review - ./storageCodeReviews.ts */

	/**
	 * Start a new Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @param files An array of files that must be reviewed.
	 * @param lastViewedFile The last file the user reviewed before starting the Code Review.
	 * @returns The Code Review that was started.
	 */
	public startCodeReview(repo: string, id: string, files: string[], lastViewedFile: string | null) {
		return this.codeReviews.startCodeReview(repo, id, files, lastViewedFile);
	}

	/**
	 * End an existing Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 */
	public endCodeReview(repo: string, id: string) {
		return this.codeReviews.endCodeReview(repo, id);
	}

	/**
	 * Get an existing Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @returns The Code Review.
	 */
	public getCodeReview(repo: string, id: string) {
		return this.codeReviews.getCodeReview(repo, id);
	}

	/**
	 * Update information for a specific Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @param remainingFiles The files remaining for review.
	 * @param lastViewedFile The last viewed file. If null, don't change the last viewed file.
	 * @returns An error message if request can't be completed.
	 */
	public updateCodeReview(repo: string, id: string, remainingFiles: string[], lastViewedFile: string | null) {
		return this.codeReviews.updateCodeReview(repo, id, remainingFiles, lastViewedFile);
	}

	/**
	 * Delete any Code Reviews that haven't been active during the last 90 days.
	 */
	public expireOldCodeReviews() {
		this.codeReviews.expireOldCodeReviews();
	}

	/**
	 * End all Code Reviews in the current workspace.
	 */
	public endAllWorkspaceCodeReviews() {
		this.codeReviews.endAllWorkspaceCodeReviews();
	}

	/**
	 * Get all Code Reviews in the current workspace.
	 * @returns The set of Code Reviews.
	 */
	public getCodeReviews() {
		return this.codeReviews.getCodeReviews();
	}

	/**
	 * Set the Code Reviews in the current workspace.
	 * @param reviews The set of Code Reviews.
	 */
	public setCodeReviews(reviews: CodeReviews) {
		return this.codeReviews.setCodeReviews(reviews);
	}
}
