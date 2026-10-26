import * as fs from 'fs';
import * as vscode from 'vscode';
import { Avatar, AvatarCache } from '../integrations/avatars/avatarManager';
import { t } from '../../i18n';
import { BooleanOverride, CodeReview, ErrorInfo, FileViewType, GitGraphViewGlobalState, GitGraphViewSnapshot, GitGraphViewWorkspaceState, GitRepoSet, GitRepoState, RepoCommitOrdering } from '../../types';
import { GitExecutable } from '../../utils/findGit';
import { getPathFromStr } from '../../utils/paths';
import { Disposable } from '../../utils/disposable';
import { GgEvent } from '../../utils/event';
import { getConfig } from './config';
import { isStateRecord, readVersionedState, encodeVersionedState } from './storageVersioned';

export { STORAGE_MIGRATIONS, STORAGE_STATE_VERSION } from './storageVersioned';

/**
 * Platform storage adapter (REFACTOR-PLAN 3.3): the ONE storage module, unifying the
 * `Storage` seam this module introduced (global- and workspace-state persistence behind one
 * lenient interface, with the dependency injected structurally) with the Git Graph
 * `ExtensionState` absorbed verbatim from the former flat src/extensionState.ts (now a
 * re-export shim of this module) - the typed, key-by-key view over both mementos the live
 * extension host uses.
 *
 * The `Storage` seam's dependency is injected structurally (production wiring passes a
 * context's `globalState` / `workspaceState`, both `vscode.Memento`-shaped). Reads are
 * LENIENT: with no memento available (or a failing one) `get` answers the caller's default and
 * `undefined`, never throws. Writes report success as a boolean instead of rejecting, so state
 * bookkeeping can never take down a request path.
 *
 * The `ExtensionState` values are versioned user data (REFACTOR-PLAN §3.7.2): reads migrate
 * older versions leniently and preserve newer writers' unknown fields, while every write
 * stamps `STORAGE_STATE_VERSION` - see ./storageVersioned.ts for the envelope and migrations.
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

const AVATAR_STORAGE_FOLDER = '/avatars';
const AVATAR_CACHE = 'avatarCache';
const CODE_REVIEWS = 'codeReviews';
const GLOBAL_AUTHOR_WRITTEN = 'globalAuthorWritten';
const GLOBAL_VIEW_STATE = 'globalViewState';
const IGNORED_REPOS = 'ignoredRepos';
const LAST_ACTIVE_REPO = 'lastActiveRepo';
const LAST_KNOWN_GIT_PATH = 'lastKnownGitPath';
const REPO_STATES = 'repoStates';
const VIEW_SNAPSHOT = 'viewSnapshot';
const WORKSPACE_VIEW_STATE = 'workspaceViewState';

/** The author identity of the global Git configuration that this extension wrote. */
export interface WrittenGlobalAuthor {
	name: string;
	email: string;
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

export const DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE: GitGraphViewGlobalState = {
	alwaysAcceptCheckoutCommit: false,
	issueLinkingConfig: null,
	pushTagSkipRemoteCheck: false
};

const DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE: GitGraphViewWorkspaceState = {
	findIsCaseSensitive: false,
	findIsRegex: false,
	findOpenCommitDetailsView: false
};

export interface CodeReviewData {
	lastActive: number;
	lastViewedFile: string | null;
	remainingFiles: string[];
}
export type CodeReviews = { [repo: string]: { [id: string]: CodeReviewData } };

/**
 * Manages the Git Graph Extension State, which stores data in both the Visual Studio Code Global & Workspace State.
 */
export class ExtensionState extends Disposable {
	private readonly globalState: vscode.Memento;
	private readonly workspaceState: vscode.Memento;
	private readonly globalStoragePath: string;
	private avatarStorageAvailable: boolean = false;

	/**
	 * Creates the Git Graph Extension State.
	 * @param context The context of the extension.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 */
	constructor(context: vscode.ExtensionContext, onDidChangeGitExecutable: GgEvent<GitExecutable | null>) {
		super();
		this.globalState = context.globalState;
		this.workspaceState = context.workspaceState;

		this.globalStoragePath = getPathFromStr(context.globalStoragePath);
		fs.stat(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err) => {
			if (!err) {
				this.avatarStorageAvailable = true;
			} else {
				fs.mkdir(this.globalStoragePath, () => {
					fs.mkdir(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err) => {
						if (!err || err.code === 'EEXIST') {
							// The directory was created, or it already exists
							this.avatarStorageAvailable = true;
						}
					});
				});
			}
		});

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
		const repoSet = this.getWorkspaceState<GitRepoSet>(REPO_STATES, {});
		if (!isStateRecord(repoSet)) return {};
		const outputSet: GitRepoSet = {};
		let showRemoteBranchesDefaultValue: boolean | null = null;
		Object.keys(repoSet).forEach((repo) => {
			outputSet[repo] = Object.assign({}, DEFAULT_REPO_STATE, repoSet[repo]);
			if (typeof repoSet[repo].showRemoteBranchesV2 === 'undefined' && typeof repoSet[repo].showRemoteBranches !== 'undefined') {
				if (showRemoteBranchesDefaultValue === null) {
					showRemoteBranchesDefaultValue = getConfig().showRemoteBranches;
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
		this.updateWorkspaceState(REPO_STATES, gitRepoSet);
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

		let reviews = this.getCodeReviews();
		if (typeof reviews[oldRepo] !== 'undefined') {
			reviews[newRepo] = reviews[oldRepo];
			delete reviews[oldRepo];
			this.setCodeReviews(reviews);
		}
	}


	/* Global View State */

	/**
	 * Get the global state of the Git Graph View.
	 * @returns The global state.
	 */
	public getGlobalViewState() {
		const globalViewState = this.getGlobalState<GitGraphViewGlobalState>(GLOBAL_VIEW_STATE, DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE);
		return Object.assign({}, DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE, isStateRecord(globalViewState) ? globalViewState : {});
	}

	/**
	 * Set the global state of the Git Graph View.
	 * @param state The global state.
	 */
	public setGlobalViewState(state: GitGraphViewGlobalState) {
		return this.updateGlobalState(GLOBAL_VIEW_STATE, state);
	}


	/* Workspace View State */

	/**
	 * Get the workspace state of the Git Graph View.
	 * @returns The workspace state.
	 */
	public getWorkspaceViewState() {
		const workspaceViewState = this.getWorkspaceState<GitGraphViewWorkspaceState>(WORKSPACE_VIEW_STATE, DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE);
		return Object.assign({}, DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE, isStateRecord(workspaceViewState) ? workspaceViewState : {});
	}

	/**
	 * Set the workspace state of the Git Graph View.
	 * @param state The workspace state.
	 */
	public setWorkspaceViewState(state: GitGraphViewWorkspaceState) {
		return this.updateWorkspaceState(WORKSPACE_VIEW_STATE, state);
	}


	/* View Snapshot */

	/**
	 * Get the last view state the Git Graph View's page reported in the current workspace.
	 * @returns The snapshot, or NULL if none was reported yet.
	 */
	public getViewSnapshot() {
		return this.getWorkspaceState<GitGraphViewSnapshot | null>(VIEW_SNAPSHOT, null);
	}

	/**
	 * Set the last view state the Git Graph View's page reported in the current workspace.
	 * @param snapshot The snapshot.
	 */
	public setViewSnapshot(snapshot: GitGraphViewSnapshot) {
		this.updateWorkspaceState(VIEW_SNAPSHOT, snapshot);
	}


	/* Ignored Repos */

	/**
	 * Get the ignored repositories in the current workspace.
	 * @returns An array of the paths of ignored repositories.
	 */
	public getIgnoredRepos() {
		const ignoredRepos = this.getWorkspaceState<unknown>(IGNORED_REPOS, []);
		return Array.isArray(ignoredRepos) ? ignoredRepos as string[] : [];
	}

	/**
	 * Set the ignored repositories in the current workspace.
	 * @param ignoredRepos An array of the paths of ignored repositories.
	 */
	public setIgnoredRepos(ignoredRepos: string[]) {
		return this.updateWorkspaceState(IGNORED_REPOS, ignoredRepos);
	}


	/* Last Active Repo */

	/**
	 * Get the last active repository in the current workspace.
	 * @returns The path of the last active repository.
	 */
	public getLastActiveRepo() {
		const repo = this.getWorkspaceState<unknown>(LAST_ACTIVE_REPO, null);
		return typeof repo === 'string' || repo === null ? repo : null;
	}

	/**
	 * Set the last active repository in the current workspace.
	 * @param repo The path of the last active repository.
	 */
	public setLastActiveRepo(repo: string | null) {
		this.updateWorkspaceState(LAST_ACTIVE_REPO, repo);
	}


	/* Last Known Git Path */

	/**
	 * Get the last known path of the Git executable used by Git Graph.
	 * @returns The path of the Git executable.
	 */
	public getLastKnownGitPath() {
		const path = this.getGlobalState<unknown>(LAST_KNOWN_GIT_PATH, null);
		return typeof path === 'string' || path === null ? path : null;
	}

	/**
	 * Set the last known path of the Git executable used by Git Graph.
	 * @param path The path of the Git executable.
	 */
	private setLastKnownGitPath(path: string) {
		this.updateGlobalState(LAST_KNOWN_GIT_PATH, path);
	}


	/* Written Global Author */

	/**
	 * Get the author identity of the global Git configuration that Git Graph last wrote itself
	 * (NULL when Git Graph never wrote it, or the one it wrote was since cleared). The machine's
	 * global Git configuration is machine-wide, so the record lives in the global state.
	 * @returns The identity Git Graph wrote, or NULL.
	 */
	public getGlobalAuthorWritten(): WrittenGlobalAuthor | null {
		const written = this.getGlobalState<WrittenGlobalAuthor | null>(GLOBAL_AUTHOR_WRITTEN, null);
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
		return this.updateGlobalState(GLOBAL_AUTHOR_WRITTEN, identity);
	}


	/* Avatars */

	/**
	 * Checks whether the Avatar Storage Folder is available to store avatars.
	 * @returns TRUE => Avatar Storage Folder is available, FALSE => Avatar Storage Folder isn't available.
	 */
	public isAvatarStorageAvailable() {
		return this.avatarStorageAvailable;
	}

	/**
	 * Gets the path that is used to store avatars globally in Git Graph.
	 * @returns The folder path.
	 */
	public getAvatarStoragePath() {
		return this.globalStoragePath + AVATAR_STORAGE_FOLDER;
	}

	/**
	 * Gets the cache of avatars known to Git Graph.
	 * @returns The avatar cache.
	 */
	public getAvatarCache() {
		const avatars = this.getGlobalState<AvatarCache>(AVATAR_CACHE, {});
		return isStateRecord(avatars) ? avatars : {};
	}

	/**
	 * Add a new avatar to the cache of avatars known to Git Graph.
	 * @param email The email address that the avatar is for.
	 * @param avatar The details of the avatar.
	 */
	public saveAvatar(email: string, avatar: Avatar) {
		let avatars = this.getAvatarCache();
		avatars[email] = avatar;
		this.updateGlobalState(AVATAR_CACHE, avatars);
	}

	/**
	 * Removes an avatar from the cache of avatars known to Git Graph.
	 * @param email The email address of the avatar to remove.
	 */
	public removeAvatarFromCache(email: string) {
		let avatars = this.getAvatarCache();
		delete avatars[email];
		this.updateGlobalState(AVATAR_CACHE, avatars);
	}

	/**
	 * Removes multiple avatars from the cache of avatars known to Git Graph, in one state write.
	 * @param emails The email addresses of the avatars to remove.
	 */
	public removeAvatarsFromCache(emails: string[]) {
		if (emails.length === 0) return;
		let avatars = this.getAvatarCache();
		for (let i = 0; i < emails.length; i++) {
			delete avatars[emails[i]];
		}
		this.updateGlobalState(AVATAR_CACHE, avatars);
	}

	/**
	 * Clear all avatars from the cache of avatars known to Git Graph.
	 * @returns A Thenable resolving to the ErrorInfo that resulted from executing this method.
	 */
	public clearAvatarCache() {
		return this.updateGlobalState(AVATAR_CACHE, {}).then((errorInfo) => {
			if (errorInfo === null) {
				fs.readdir(this.globalStoragePath + AVATAR_STORAGE_FOLDER, (err, files) => {
					if (err) return;
					for (let i = 0; i < files.length; i++) {
						fs.unlink(this.globalStoragePath + AVATAR_STORAGE_FOLDER + '/' + files[i], () => { });
					}
				});
			}
			return errorInfo;
		});
	}


	/* Code Review */

	// Note: id => the commit arguments to 'git diff' (either <commit hash> or <commit hash>-<commit hash>)

	/**
	 * Start a new Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @param files An array of files that must be reviewed.
	 * @param lastViewedFile The last file the user reviewed before starting the Code Review.
	 * @returns The Code Review that was started.
	 */
	public startCodeReview(repo: string, id: string, files: string[], lastViewedFile: string | null) {
		let reviews = this.getCodeReviews();
		if (typeof reviews[repo] === 'undefined') reviews[repo] = {};
		reviews[repo][id] = { lastActive: (new Date()).getTime(), lastViewedFile: lastViewedFile, remainingFiles: files };
		return this.setCodeReviews(reviews).then((err) => ({
			codeReview: <CodeReview>Object.assign({ id: id }, reviews[repo][id]),
			error: err
		}));
	}

	/**
	 * End an existing Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 */
	public endCodeReview(repo: string, id: string) {
		let reviews = this.getCodeReviews();
		removeCodeReview(reviews, repo, id);
		return this.setCodeReviews(reviews);
	}

	/**
	 * Get an existing Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @returns The Code Review.
	 */
	public getCodeReview(repo: string, id: string) {
		let reviews = this.getCodeReviews();
		if (typeof reviews[repo] !== 'undefined' && typeof reviews[repo][id] !== 'undefined') {
			reviews[repo][id].lastActive = (new Date()).getTime();
			this.setCodeReviews(reviews);
			return <CodeReview>Object.assign({ id: id }, reviews[repo][id]);
		} else {
			return null;
		}
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
		const reviews = this.getCodeReviews();

		if (typeof reviews[repo] === 'undefined' || typeof reviews[repo][id] === 'undefined') {
			return Promise.resolve(t('codeReviewNotFound'));
		}

		if (remainingFiles.length > 0) {
			reviews[repo][id].remainingFiles = remainingFiles;
			reviews[repo][id].lastActive = (new Date()).getTime();
			if (lastViewedFile !== null) {
				reviews[repo][id].lastViewedFile = lastViewedFile;
			}
		} else {
			removeCodeReview(reviews, repo, id);
		}

		return this.setCodeReviews(reviews);
	}

	/**
	 * Delete any Code Reviews that haven't been active during the last 90 days.
	 */
	public expireOldCodeReviews() {
		let reviews = this.getCodeReviews(), change = false, expireReviewsBefore = (new Date()).getTime() - 7776000000; // 90 days x 24 hours x 60 minutes x 60 seconds x 1000 milliseconds
		Object.keys(reviews).forEach((repo) => {
			Object.keys(reviews[repo]).forEach((id) => {
				if (reviews[repo][id].lastActive < expireReviewsBefore) {
					delete reviews[repo][id];
					change = true;
				}
			});
			removeCodeReviewRepoIfEmpty(reviews, repo);
		});
		if (change) this.setCodeReviews(reviews);
	}

	/**
	 * End all Code Reviews in the current workspace.
	 */
	public endAllWorkspaceCodeReviews() {
		this.setCodeReviews({});
	}

	/**
	 * Get all Code Reviews in the current workspace.
	 * @returns The set of Code Reviews.
	 */
	public getCodeReviews() {
		const reviews = this.getWorkspaceState<CodeReviews>(CODE_REVIEWS, {});
		return isStateRecord(reviews) ? reviews : {};
	}

	/**
	 * Set the Code Reviews in the current workspace.
	 * @param reviews The set of Code Reviews.
	 */
	public setCodeReviews(reviews: CodeReviews) {
		return this.updateWorkspaceState(CODE_REVIEWS, reviews);
	}


	/* Update State Memento's */

	/**
	 * Read a versioned value from the Git Graph Global State (lenient): the stored value migrated
	 * to the current schema, or the fallback when absent, corrupt or unreadable.
	 * @param key The key.
	 * @param fallback The value to answer when the key holds nothing readable.
	 * @returns The decoded value.
	 */
	private getGlobalState<T>(key: string, fallback: T): T {
		return readVersionedState<T>(this.globalState, key, fallback);
	}

	/**
	 * Read a versioned value from the Git Graph Workspace State (lenient, as getGlobalState).
	 * @param key The key.
	 * @param fallback The value to answer when the key holds nothing readable.
	 * @returns The decoded value.
	 */
	private getWorkspaceState<T>(key: string, fallback: T): T {
		return readVersionedState<T>(this.workspaceState, key, fallback);
	}

	/**
	 * Update the Git Graph Global State with a new <key, value> pair. Values are stored in the
	 * versioned envelope (strict write, §3.7.2); undefined removes the key.
	 * @param key The key.
	 * @param value The value.
	 * @returns A Thenable resolving to the ErrorInfo that resulted from updating the Global State.
	 */
	private updateGlobalState(key: string, value: unknown): Thenable<ErrorInfo> {
		return this.globalState.update(key, encodeVersionedState(value)).then(
			() => null,
			() => 'Visual Studio Code was unable to save the Git Graph Global State Memento.'
		);
	}

	/**
	 * Update the Git Graph Workspace State with a new <key, value> pair, versioned as the
	 * Global State writes are.
	 * @param key The key.
	 * @param value The value.
	 * @returns A Thenable resolving to the ErrorInfo that resulted from updating the Workspace State.
	 */
	private updateWorkspaceState(key: string, value: unknown): Thenable<ErrorInfo> {
		return this.workspaceState.update(key, encodeVersionedState(value)).then(
			() => null,
			() => 'Visual Studio Code was unable to save the Git Graph Workspace State Memento.'
		);
	}
}


/* Helper Methods */

/**
 * Remove a Code Review from a set of Code Reviews.
 * @param reviews The set of Code Reviews.
 * @param repo The repository the Code Review is in.
 * @param id The ID of the Code Review.
 */
function removeCodeReview(reviews: CodeReviews, repo: string, id: string) {
	if (typeof reviews[repo] !== 'undefined' && typeof reviews[repo][id] !== 'undefined') {
		delete reviews[repo][id];
		removeCodeReviewRepoIfEmpty(reviews, repo);
	}
}

/**
 * Remove a repository from a set of Code Reviews if the repository doesn't contain any Code Reviews.
 * @param reviews The set of Code Reviews.
 * @param repo The repository to perform this action on.
 */
function removeCodeReviewRepoIfEmpty(reviews: CodeReviews, repo: string) {
	if (typeof reviews[repo] !== 'undefined' && Object.keys(reviews[repo]).length === 0) {
		delete reviews[repo];
	}
}
