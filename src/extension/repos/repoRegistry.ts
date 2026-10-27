import { GitRepoSet, GitRepoState } from '../../shared/model/repoState';
import { getPathFromStr, pathWithTrailingSlash } from '../platform/paths';
import { DEFAULT_REPO_STATE, ExtensionState } from '../platform/storage';
import { Logger } from '../platform/logger';
import { Disposable } from '../../shared/util/disposable';
import { EventEmitter } from '../../shared/util/event';
import { getWorkspaceFolderInfoForRepoInclusionMapping } from './repoDiscovery';

/**
 * The state-and-events half of the repository manager (OPTIMIZATION-PLAN A5): the known
 * repository set with its per-repository states, the ignored-repository list, and the
 * most-recently-opened list, together with the change event the rest of the extension
 * subscribes to. The RepoManager (./repoManager) composes this registry with discovery
 * (./repoDiscovery), the file watchers, and the external configuration file store
 * (./repoSettingsStore); the registry itself owns no vscode dependency, so its policies are
 * testable with plain fakes.
 */

export interface RepoChangeEvent {
	readonly repos: GitRepoSet;
	readonly numRepos: number;
	readonly loadRepo: string | null;
}

/** The maximum length of the most-recently-opened list RepoManager keeps (REFACTOR-PLAN 3.8.2 D11: prewarming covers at most 3 repositories). */
export const MAX_RECENT_REPOS = 3;

/**
 * Move `repo` to the front of a most-recently-opened list, dropping its previous entry and
 * capping the length. Pure, so the ordering policy is testable without a RepoManager.
 * @param recent The current most-recently-opened list (most recent first).
 * @param repo The repository that was just opened.
 * @param max The maximum list length to keep.
 * @returns The updated list (most recent first).
 */
export function bumpRecentRepos(recent: ReadonlyArray<string>, repo: string, max: number): string[] {
	return [repo, ...recent.filter((known) => known !== repo)].slice(0, Math.max(0, max));
}

/**
 * The recently-opened repositories a consumer (the PrewarmController) should see: the opens
 * recorded this session, filtered to repositories still known, with the previous session's
 * last-active repository appended until an open is recorded. Pure, so the merge policy is
 * testable without a RepoManager.
 * @param recorded The opens recorded this session (most recent first).
 * @param lastActive The last-active repository of the previous session, or NULL when there is none.
 * @param isKnown Answers whether a repository is still known (and may be prewarmed).
 * @returns The recently-opened repositories, most recent first.
 */
export function recentReposList(recorded: ReadonlyArray<string>, lastActive: string | null, isKnown: (repo: string) => boolean): string[] {
	const known = recorded.filter((repo) => isKnown(repo));
	// Recorded opens are strictly more recent than the persisted one, so it joins at the end
	if (lastActive !== null && isKnown(lastActive) && !known.includes(lastActive)) return [...known, lastActive];
	return known;
}

/** The repository-handle operations the registry performs as repositories come and go. */
export interface RepoHandlePort {
	/** Open a repository's engine handle (a failed open only logs; reads fall back to the CLI). */
	openRepository(repo: string): Promise<string | void>;
	/** Release a repository's engine handle (it would otherwise stay resident for the session). */
	closeRepository(repo: string): void;
}

/**
 * The collaborators the registry is constructed with: the persisted extension state it loads
 * from and saves to, the logger, and the backend whose repository handles it opens and closes.
 */
export interface RepoRegistryDeps {
	/** The Git Graph ExtensionState instance. */
	readonly state: ExtensionState;
	/** The Git Graph Logger instance. */
	readonly logger: Logger;
	/** The read face of the repository facade (only the handle operations are used). */
	readonly backend: RepoHandlePort;
}

/**
 * The known-repository set and its change event: which repositories Git Graph knows (and their
 * states), which are ignored, and which were opened most recently. Every mutation persists the
 * set through the ExtensionState; every change is announced by {@link sendRepos}.
 */
export class RepoRegistry extends Disposable {
	private readonly state: ExtensionState;
	private readonly logger: Logger;
	private readonly backend: RepoHandlePort;

	private repos: GitRepoSet;
	private ignoredRepos: string[];
	// The repositories opened in the Git Graph View this session, most recent first (the
	// PrewarmController's candidate order); the previous session's last-active repository is
	// merged in by getRecentRepos rather than stored here
	private recentRepos: string[] = [];

	private readonly repoEventEmitter: EventEmitter<RepoChangeEvent>;

	/**
	 * Loads the persisted repository set, the ignored repositories and the recently-opened seed.
	 * @param deps The registry's collaborators (see {@link RepoRegistryDeps}).
	 */
	constructor(deps: RepoRegistryDeps) {
		super();
		this.state = deps.state;
		this.logger = deps.logger;
		this.backend = deps.backend;
		// Repository paths used to be persisted in native-separator form on Windows when they came
		// from a backend (submodules in particular), which made them miss every forward-slash
		// comparison; migrate them to the normalised form
		this.repos = {};
		const savedRepos = this.state.getRepos();
		for (const repo of Object.keys(savedRepos)) {
			const normalised = getPathFromStr(repo);
			if (typeof this.repos[normalised] === 'undefined') this.repos[normalised] = savedRepos[repo];
		}
		this.ignoredRepos = this.state.getIgnoredRepos().map((repo) => getPathFromStr(repo)).filter((repo, i, repos) => repos.indexOf(repo) === i);
		// Seed the recently-opened list from the previous session, so prewarming (which reads it
		// 2 s after activation) has the most likely re-open as its first candidate
		const lastActiveRepo = this.state.getLastActiveRepo();
		if (lastActiveRepo !== null) this.recentRepos = bumpRecentRepos(this.recentRepos, lastActiveRepo, MAX_RECENT_REPOS);

		this.repoEventEmitter = new EventEmitter<RepoChangeEvent>();
		this.registerDisposable(this.repoEventEmitter);
	}

	/**
	 * Get the Event that can be used to subscribe to updates when the repositories available in Git Graph change.
	 */
	get onDidChangeRepos() {
		return this.repoEventEmitter.subscribe;
	}

	/**
	 * Get a set of all known repositories in the current workspace.
	 * @returns The set of repositories.
	 */
	public getRepos() {
		return Object.assign({}, this.repos);
	}

	/**
	 * Get the number of all known repositories in the current workspace.
	 * @returns The number of repositories.
	 */
	public getNumRepos() {
		return Object.keys(this.repos).length;
	}

	/**
	 * The paths of all known repositories (the live key set; callers must not mutate it).
	 * @returns The repository paths.
	 */
	public repoPaths() {
		return Object.keys(this.repos);
	}

	/**
	 * The state of a known repository (the live object; callers may mutate its fields, then
	 * persist through {@link persist}).
	 * @param repo The path of the repository.
	 * @returns The repository's state, or UNDEFINED when the repository is unknown.
	 */
	public getRepoState(repo: string): GitRepoState | undefined {
		return this.repos[repo];
	}

	/**
	 * Check to see if a repository exactly matches a known repository.
	 * @param repo The path of the repository to check.
	 * @returns TRUE => Known repository, FALSE => Unknown repository.
	 */
	public isKnownRepo(repo: string) {
		return typeof this.repos[repo] !== 'undefined';
	}

	/**
	 * Record that a repository was opened in the Git Graph View, making it the most-recently-opened
	 * one. The PrewarmController (REFACTOR-PLAN task 4.9) serves its candidates in this order.
	 * @param repo The path of the repository that was opened.
	 */
	public recordRepoOpened(repo: string) {
		if (!this.isKnownRepo(repo)) return;
		this.recentRepos = bumpRecentRepos(this.recentRepos, repo, MAX_RECENT_REPOS);
	}

	/**
	 * Get the recently-opened repositories, most recent first: the opens recorded this session,
	 * with the previous session's last-active repository filling in until one is recorded. Only
	 * repositories still known are listed. Pure data (no vscode), so the PrewarmController can
	 * consume it through an injected provider.
	 * @returns The recently-opened repository paths.
	 */
	public getRecentRepos(): readonly string[] {
		return recentReposList(this.recentRepos, this.state.getLastActiveRepo(), (repo) => this.isKnownRepo(repo));
	}

	/**
	 * Get the repository that contains the specified file.
	 * @param path The path of the file.
	 * @returns The path of the repository containing the file, or NULL if no known repository contains the file.
	 */
	public getRepoContainingFile(path: string) {
		const repoPaths = Object.keys(this.repos);
		let repo = null;
		for (let i = 0; i < repoPaths.length; i++) {
			if (path.startsWith(pathWithTrailingSlash(repoPaths[i])) && (repo === null || repo.length < repoPaths[i].length)) repo = repoPaths[i];
		}
		return repo;
	}

	/**
	 * Get all known repositories that are contained in the specified folder.
	 * @param path The path of the folder.
	 * @returns An array of the paths of all known repositories contained in the specified folder.
	 */
	private getReposInFolder(path: string) {
		const pathFolder = pathWithTrailingSlash(path), repoPaths = Object.keys(this.repos), reposInFolder: string[] = [];
		for (let i = 0; i < repoPaths.length; i++) {
			if (repoPaths[i] === path || repoPaths[i].startsWith(pathFolder)) reposInFolder.push(repoPaths[i]);
		}
		return reposInFolder;
	}

	/**
	 * Checks if the specified path is within a known repository.
	 * @param path The path to check.
	 * @returns TRUE => Path is within a known repository, FALSE => Path isn't within a known repository.
	 */
	public isDirectoryWithinRepos(path: string) {
		const repoPaths = Object.keys(this.repos);
		for (let i = 0; i < repoPaths.length; i++) {
			if (path === repoPaths[i] || path.startsWith(pathWithTrailingSlash(repoPaths[i]))) return true;
		}
		return false;
	}

	/**
	 * Add a new repository's state to the registry: the default state, the backend handle, the
	 * workspace-folder index and the persistence (the state half of adding a repository; the
	 * configuration check and the submodule search that follow are composed by the RepoManager).
	 * @param repo The path of the repository.
	 * @returns TRUE => The repository was added, FALSE => The repository is ignored and couldn't be added.
	 */
	public addRepo(repo: string) {
		if (this.ignoredRepos.includes(repo)) {
			return false;
		} else {
			this.repos[repo] = Object.assign({}, DEFAULT_REPO_STATE);
			// Open a repository handle in the Git backend (fire-and-forget: a failure just means the
			// backend reads this repository through the `git` CLI instead)
			void this.backend.openRepository(repo).catch((error) => {
				this.logger.log('The Git backend could not open the repository ' + repo + ': ' + (error instanceof Error ? error.message : String(error)));
			});
			this.updateWorkspaceFolderIndex(repo);
			this.persist();
			this.logger.log('Added new repo: ' + repo);
			return true;
		}
	}

	/**
	 * Remove a known repository from Git Graph.
	 * @param repo The path of the repository.
	 */
	public removeRepo(repo: string) {
		delete this.repos[repo];
		this.recentRepos = this.recentRepos.filter((known) => known !== repo);
		// Release the engine's handle of the removed repository: it would otherwise stay resident
		// (with its pack indexes and caches) for the rest of the editor session
		this.backend.closeRepository(repo);
		this.persist();
		this.logger.log('Removed repo: ' + repo);
	}

	/**
	 * Remove all repositories that are contained within the specified folder.
	 * @param path The path of the folder.
	 * @returns TRUE => At least one repository was removed, FALSE => No repositories were removed.
	 */
	public removeReposWithinFolder(path: string) {
		const reposInFolder = this.getReposInFolder(path);
		for (let i = 0; i < reposInFolder.length; i++) {
			this.removeRepo(reposInFolder[i]);
		}
		return reposInFolder.length > 0;
	}

	/**
	 * Remove any repositories that are no longer in the current workspace.
	 */
	public removeReposNotInWorkspace() {
		const workspaceFolderInfo = getWorkspaceFolderInfoForRepoInclusionMapping();
		const rootsExact = workspaceFolderInfo.rootsExact, rootsFolder = workspaceFolderInfo.rootsFolder, repoPaths = Object.keys(this.repos);
		for (let i = 0; i < repoPaths.length; i++) {
			const repoPathFolder = pathWithTrailingSlash(repoPaths[i]);
			if (rootsExact.indexOf(repoPaths[i]) === -1 && !rootsFolder.find(root => repoPaths[i].startsWith(root)) && !rootsExact.find(root => root.startsWith(repoPathFolder))) {
				this.removeRepo(repoPaths[i]);
			}
		}
	}

	/**
	 * Record a repository as ignored, so it will not be automatically detected and re-added the
	 * next time Visual Studio Code is started, and persist the ignored list.
	 * @param repo The path of the repository.
	 */
	public markRepoIgnored(repo: string) {
		if (!this.ignoredRepos.includes(repo)) this.ignoredRepos.push(repo);
		this.state.setIgnoredRepos(this.ignoredRepos);
	}

	/**
	 * Remove a repository from the ignored list (registering it explicitly un-ignores it) and
	 * persist the ignored list.
	 * @param repo The path of the repository.
	 */
	public forgetIgnoredRepo(repo: string) {
		if (this.ignoredRepos.includes(repo)) {
			this.ignoredRepos.splice(this.ignoredRepos.indexOf(repo), 1);
			this.state.setIgnoredRepos(this.ignoredRepos);
		}
	}

	/**
	 * Transfer the repository state from one known repository to another.
	 * @param oldRepo The repository to transfer the state from.
	 * @param newRepo The repository to transfer the state to.
	 */
	public transferRepoState(oldRepo: string, newRepo: string) {
		this.repos[newRepo] = this.repos[oldRepo];
		delete this.repos[oldRepo];
		// The old path no longer names the repository, so its engine handle must not stay resident
		this.backend.closeRepository(oldRepo);
		this.recentRepos = this.recentRepos.map((repo) => repo === oldRepo ? newRepo : repo);
		this.updateWorkspaceFolderIndex(newRepo);
		this.persist();
		this.state.transferRepo(oldRepo, newRepo);

		this.logger.log('Transferred repo state: ' + oldRepo + ' -> ' + newRepo);
	}

	/**
	 * Assign a new state object to a repository and persist the registry.
	 * @param repo The repository the state belongs to.
	 * @param state The state.
	 */
	public assignRepoState(repo: string, state: GitRepoState) {
		this.repos[repo] = state;
		this.persist();
	}

	/**
	 * Persist the repository states.
	 */
	public persist() {
		this.state.saveRepos(this.repos);
	}

	/**
	 * Update each repositories workspaceFolderIndex based on the current workspace.
	 * @param repo If provided, only update this specific repository.
	 * @returns TRUE => At least one repository was changed, FALSE => No repositories were changed.
	 */
	public updateWorkspaceFolderIndex(repo: string | null = null) {
		const workspaceFolderInfo = getWorkspaceFolderInfoForRepoInclusionMapping();
		const rootsExact = workspaceFolderInfo.rootsExact, rootsFolder = workspaceFolderInfo.rootsFolder, workspaceFolders = workspaceFolderInfo.workspaceFolders;
		const repoPaths = repo !== null && this.isKnownRepo(repo) ? [repo] : Object.keys(this.repos);
		let changes = false, rootIndex: number, workspaceFolderIndex: number | null;
		for (let i = 0; i < repoPaths.length; i++) {
			rootIndex = rootsExact.indexOf(repoPaths[i]);
			if (rootIndex === -1) {
				// Find a workspace folder that contains the repository
				rootIndex = rootsFolder.findIndex((root) => repoPaths[i].startsWith(root));
			}
			if (rootIndex === -1) {
				// Find a workspace folder that is contained within the repository
				const repoPathFolder = pathWithTrailingSlash(repoPaths[i]);
				rootIndex = rootsExact.findIndex((root) => root.startsWith(repoPathFolder));
			}
			workspaceFolderIndex = rootIndex > -1 ? workspaceFolders[rootIndex].index : null;
			if (this.repos[repoPaths[i]].workspaceFolderIndex !== workspaceFolderIndex) {
				this.repos[repoPaths[i]].workspaceFolderIndex = workspaceFolderIndex;
				changes = true;
			}
		}
		return changes;
	}

	/**
	 * Send the latest set of known repositories to subscribers as they have changed.
	 * @param loadRepo The optional path of a repository to load in the Git Graph View.
	 */
	public sendRepos(loadRepo: string | null = null) {
		// A repo handed to the view is an open: it heads the recently-opened list
		if (loadRepo !== null) this.recordRepoOpened(loadRepo);
		this.repoEventEmitter.emit({
			repos: this.getRepos(),
			numRepos: this.getNumRepos(),
			loadRepo: loadRepo
		});
	}
}
