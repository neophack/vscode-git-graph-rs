import * as path from 'path';
import * as vscode from 'vscode';
import type { ProductionGitRepository } from '../git/gitRepository';
import type { GitRunnerPort } from '../graphView/gitRunner';
import { addRemoteTagsRefspec } from '../git/write/ops/config';
import { t } from '../platform/i18n';
import { ErrorInfo } from '../../shared/protocol/messages';
import { GitRepoSet, GitRepoState } from '../../shared/model/repoState';
import {
	getPathFromStr,
	getPathFromUri,
	getRepoName,
	pathWithTrailingSlash,
	realpath,
} from '../platform/paths';
import { showErrorMessage, showInformationMessage } from '../platform/actions';
import { BufferedQueue } from '../../shared/util/bufferedQueue';
import { evalPromises } from '../git/process/childProcess';
import { Disposable, toDisposable } from '../../shared/util/disposable';
import { EventEmitter, GgEvent } from '../../shared/util/event';
import { getConfig } from '../platform/config';
import { DEFAULT_REPO_STATE, ExtensionState } from '../platform/storage';
import { Logger } from '../platform/logger';
import {
	ExternalRepoConfig,
	applyExternalConfigFile,
	generateExternalConfigFile,
	pinsEqual,
	readExternalConfigFile,
	validateExternalConfigFile,
	writeExternalConfigFile
} from './repoConfigFile';
import {
	doesPathExist,
	getWorkspaceFolderInfoForRepoInclusionMapping,
	isDirectory,
	listSubmodules,
	resolveRepoRoot,
	searchDirectoryForRepos,
	searchRepoForSubmodules
} from './repoDiscovery';

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

/**
 * The collaborators the RepoManager is constructed with: the service's explicit dependency
 * list (OPTIMIZATION-PLAN A2). The manager is a member of the composition root's frozen
 * services bag, so it is built before the freeze with this record instead of the bag itself.
 */
export interface RepoManagerDeps {
	/** The repository facade: repository roots and submodules are read through it, the tag-tracking refspecs are written through it. */
	readonly repo: ProductionGitRepository;
	/** The raw runner the tag-tracking preflight reads through. */
	readonly git: GitRunnerPort;
	/** The Git Graph ExtensionState instance. */
	readonly state: ExtensionState;
	/** The configuration-change event the max-repo-search-depth setting is re-read on. */
	readonly onDidChangeConfiguration: GgEvent<vscode.ConfigurationChangeEvent>;
	/** The Git Graph Logger instance. */
	readonly logger: Logger;
}

/**
 * Detects and manages repositories in Git Graph.
 */
export class RepoManager extends Disposable {
	private readonly repo: ProductionGitRepository;
	private readonly git: GitRunnerPort;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;

	private repos: GitRepoSet;
	private ignoredRepos: string[];
	private maxDepthOfRepoSearch: number;
	// The repositories opened in the Git Graph View this session, most recent first (the
	// PrewarmController's candidate order); the previous session's last-active repository is
	// merged in by getRecentRepos rather than stored here
	private recentRepos: string[] = [];
	private readonly pinsWriteInFlight: Set<string> = new Set(); // repos whose pinned branches/commits are currently being persisted to the External Configuration File

	private readonly folderWatchers: { [workspace: string]: vscode.FileSystemWatcher } = {};
	private readonly configWatcher: vscode.FileSystemWatcher;

	private readonly repoEventEmitter: EventEmitter<RepoChangeEvent>;

	private readonly onWatcherCreateQueue: BufferedQueue<string>;
	private readonly onWatcherChangeQueue: BufferedQueue<string>;
	private readonly checkRepoConfigQueue: BufferedQueue<string>;

	/**
	 * Creates the Git Graph Repository Manager, and runs startup tasks.
	 * @param deps The service's collaborators (see {@link RepoManagerDeps}).
	 */
	constructor(deps: RepoManagerDeps) {
		super();
		this.repo = deps.repo;
		this.git = deps.git;
		this.extensionState = deps.state;
		this.logger = deps.logger;
		// Repository paths used to be persisted in native-separator form on Windows when they came
		// from a backend (submodules in particular), which made them miss every forward-slash
		// comparison; migrate them to the normalised form
		this.repos = {};
		const savedRepos = this.extensionState.getRepos();
		for (const repo of Object.keys(savedRepos)) {
			const normalised = getPathFromStr(repo);
			if (typeof this.repos[normalised] === 'undefined') this.repos[normalised] = savedRepos[repo];
		}
		this.ignoredRepos = this.extensionState.getIgnoredRepos().map((repo) => getPathFromStr(repo)).filter((repo, i, repos) => repos.indexOf(repo) === i);
		this.maxDepthOfRepoSearch = getConfig().maxDepthOfRepoSearch;
		// Seed the recently-opened list from the previous session, so prewarming (which reads it
		// 2 s after activation) has the most likely re-open as its first candidate
		const lastActiveRepo = this.extensionState.getLastActiveRepo();
		if (lastActiveRepo !== null) this.recentRepos = bumpRecentRepos(this.recentRepos, lastActiveRepo, MAX_RECENT_REPOS);

		this.configWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/git-graph-rs.json');
		this.configWatcher.onDidCreate(this.onConfigWatcherCreateOrChange.bind(this));
		this.configWatcher.onDidChange(this.onConfigWatcherCreateOrChange.bind(this));

		this.repoEventEmitter = new EventEmitter<RepoChangeEvent>();

		this.onWatcherCreateQueue = new BufferedQueue<string>(this.processOnWatcherCreateEvent.bind(this), this.sendRepos.bind(this));
		this.onWatcherChangeQueue = new BufferedQueue<string>(this.processOnWatcherChangeEvent.bind(this), this.sendRepos.bind(this));
		this.checkRepoConfigQueue = new BufferedQueue<string>(this.checkRepoForNewConfig.bind(this), this.sendRepos.bind(this));

		this.startupTasks();

		this.registerDisposables(
			// Monitor changes to the workspace folders to:
			// - search added folders for repositories
			// - remove repositories within deleted folders
			// - apply changes to the order of workspace folders
			vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
				let changes = false, path;
				if (e.added.length > 0) {
					for (let i = 0; i < e.added.length; i++) {
						path = getPathFromUri(e.added[i].uri);
						if (await this.searchDirectoryForRepos(path, this.maxDepthOfRepoSearch)) changes = true;
						this.startWatchingFolder(path);
					}
				}
				if (e.removed.length > 0) {
					for (let i = 0; i < e.removed.length; i++) {
						path = getPathFromUri(e.removed[i].uri);
						if (this.removeReposWithinFolder(path)) changes = true;
						this.stopWatchingFolder(path);
					}
				}
				if (this.updateReposWorkspaceFolderIndex()) {
					this.extensionState.saveRepos(this.repos);
					changes = true;
				}

				if (changes) {
					this.sendRepos();
				}
			}),

			// Monitor changes to the maxDepthOfRepoSearch Extension Setting, and trigger a new search if needed
			deps.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-graph-rs.maxDepthOfRepoSearch')) {
					this.maxDepthOfRepoSearchChanged();
				}
			}),

			// Dispose the Repository Event Emitter when disposed
			this.repoEventEmitter,

			// Dispose the configWatcher
			this.configWatcher,

			// Dispose the onWatcherCreateQueue
			this.onWatcherCreateQueue,

			// Dispose the onWatcherChangeQueue
			this.onWatcherChangeQueue,

			// Dispose the checkRepoConfigQueue,
			this.checkRepoConfigQueue,

			// Stop watching folders when disposed
			toDisposable(() => {
				const folders = Object.keys(this.folderWatchers);
				for (let i = 0; i < folders.length; i++) {
					this.stopWatchingFolder(folders[i]);
				}
			})
		);
	}

	/**
	 * Get the Event that can be used to subscribe to updates when the repositories available in Git Graph change.
	 */
	get onDidChangeRepos() {
		return this.repoEventEmitter.subscribe;
	}

	/**
	 * Apply the new value of `git-graph-rs.maxDepthOfRepoSearch` to the RepoManager.
	 */
	private maxDepthOfRepoSearchChanged() {
		const newDepth = getConfig().maxDepthOfRepoSearch;
		if (newDepth > this.maxDepthOfRepoSearch) {
			this.maxDepthOfRepoSearch = newDepth;
			this.searchWorkspaceForRepos();
		} else {
			this.maxDepthOfRepoSearch = newDepth;
		}
	}

	/**
	 * Run various startup tasks when Git Graph is activated.
	 */
	private async startupTasks() {
		this.removeReposNotInWorkspace();
		if (this.updateReposWorkspaceFolderIndex()) {
			this.extensionState.saveRepos(this.repos);
		}
		if (!await this.checkReposExist()) {
			// On startup, ensure that sendRepo is called (even if no changes were made)
			this.sendRepos();
		}
		this.checkReposForNewConfig();
		await this.checkReposForNewSubmodules();
		await Promise.all(Object.keys(this.repos).map(repo => {
			if (getConfig(repo).trackRemoteTags) {
				return this.trackRemoteTags(repo);
			}
			return Promise.resolve();
		}));
		await this.searchWorkspaceForRepos();
		this.startWatchingFolders();
	}

	/**
	 * Add the tag-tracking fetch refspec (`+refs/tags/*:refs/remotes/<remote>/tags/*`) to every
	 * remote of the repository that does not already carry it (the port of the legacy
	 * `DataSource.trackRemoteTags`): the refspec is only added when the remote's fetch
	 * configuration does not yet include it, and any failure is swallowed (a repository whose
	 * remotes cannot be read or configured simply keeps its current fetch behaviour).
	 * @param repo The path of the repository.
	 */
	private async trackRemoteTags(repo: string): Promise<void> {
		try {
			const remotes = await this.repo.read.getRemotes(repo);
			await Promise.all(remotes.map(async (remote) => {
				// `git config --get-all` exits non-zero when the key holds no value at all — read as
				// "no tag refspec present" rather than a failure (the legacy read ignored the exit code)
				const fetchConfigs = await this.git.gitOutput(['config', '--get-all', 'remote.' + remote + '.fetch'], repo, (stdout) => stdout).catch(() => '');
				if (!fetchConfigs.includes('refs/remotes/' + remote + '/tags/*')) {
					await this.repo.write.run(repo, addRemoteTagsRefspec({ remote: remote }));
				}
			}));
		} catch (_) { }
	}

	/**
	 * Remove any repositories that are no longer in the current workspace.
	 */
	private removeReposNotInWorkspace() {
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
	 * Register a new repository with Git Graph.
	 * @param path The path of the repository.
	 * @param loadRepo If TRUE and the Git Graph View is visible, load the Git Graph View with the repository being registered.
	 */
	public registerRepo(path: string, loadRepo: boolean) {
		return new Promise<{ root: string | null, error: string | null }>(async resolve => {
			const root = await resolveRepoRoot(this.repo.read, path);
			if (root === null) {
				resolve({ root: null, error: 'The folder "' + path + '" is not a Git repository.' });
			} else if (typeof this.repos[root] !== 'undefined') {
				resolve({ root: null, error: 'The folder "' + path + '" is contained within the known repository "' + root + '".' });
			} else {
				if (this.ignoredRepos.includes(root)) {
					this.ignoredRepos.splice(this.ignoredRepos.indexOf(root), 1);
					this.extensionState.setIgnoredRepos(this.ignoredRepos);
				}
				await this.addRepo(root);
				this.sendRepos(loadRepo ? root : null);
				resolve({ root: root, error: null });
			}
		});
	}

	/**
	 * Ignore a repository known to Git Graph. Unlike `removeRepo`, ignoring the repository will prevent it from being automatically detected and re-added the next time Visual Studio Code is started.
	 * @param repo The path of the repository.
	 * @returns TRUE => Repository was ignored, FALSE => Repository is not know to Git Graph.
	 */
	public ignoreRepo(repo: string) {
		if (this.isKnownRepo(repo)) {
			if (!this.ignoredRepos.includes(repo)) this.ignoredRepos.push(repo);
			this.extensionState.setIgnoredRepos(this.ignoredRepos);
			this.removeRepo(repo);
			this.sendRepos();
			return true;
		} else {
			return false;
		}
	}


	/* Repo Management */

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
		return recentReposList(this.recentRepos, this.extensionState.getLastActiveRepo(), (repo) => this.isKnownRepo(repo));
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
	 * Get the path of the known repository matching the specified repository path (checking symbolic links if necessary).
	 * @param repo The path of the repository.
	 * @returns The path of the known repository, or NULL if the specified repository is unknown.
	 */
	public async getKnownRepo(repo: string) {
		if (this.isKnownRepo(repo)) {
			// The path is already known as a repo
			return repo;
		}

		// Check to see if a known repository contains a symlink that resolves the repo
		const canonicalRepo = await realpath(repo);
		const repoPaths = Object.keys(this.repos);
		for (let i = 0; i < repoPaths.length; i++) {
			if (canonicalRepo === (await realpath(repoPaths[i]))) {
				return repoPaths[i];
			}
		}

		// Repo is unknown
		return null;
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
	 * Add a new repository to Git Graph.
	 * @param repo The path of the repository.
	 * @returns TRUE => The repository was added, FALSE => The repository is ignored and couldn't be added.
	 */
	private async addRepo(repo: string) {
		if (this.ignoredRepos.includes(repo)) {
			return false;
		} else {
			this.repos[repo] = Object.assign({}, DEFAULT_REPO_STATE);
			// Open a repository handle in the Git backend (fire-and-forget: a failure just means the
			// backend reads this repository through the `git` CLI instead)
			void this.repo.read.openRepository(repo).catch((error) => {
				this.logger.log('The Git backend could not open the repository ' + repo + ': ' + (error instanceof Error ? error.message : String(error)));
			});
			this.updateReposWorkspaceFolderIndex(repo);
			this.extensionState.saveRepos(this.repos);
			this.logger.log('Added new repo: ' + repo);
			await this.checkRepoForNewConfig(repo, true);
			await this.searchRepoForSubmodules(repo);
			return true;
		}
	}

	/**
	 * Remove a known repository from Git Graph.
	 * @param repo The path of the repository.
	 */
	private removeRepo(repo: string) {
		delete this.repos[repo];
		this.recentRepos = this.recentRepos.filter((known) => known !== repo);
		// Release the engine's handle of the removed repository: it would otherwise stay resident
		// (with its pack indexes and caches) for the rest of the editor session
		this.repo.read.closeRepository(repo);
		this.extensionState.saveRepos(this.repos);
		this.logger.log('Removed repo: ' + repo);
	}

	/**
	 * Remove all repositories that are contained within the specified folder.
	 * @param path The path of the folder.
	 * @returns TRUE => At least one repository was removed, FALSE => No repositories were removed.
	 */
	private removeReposWithinFolder(path: string) {
		const reposInFolder = this.getReposInFolder(path);
		for (let i = 0; i < reposInFolder.length; i++) {
			this.removeRepo(reposInFolder[i]);
		}
		return reposInFolder.length > 0;
	}

	/**
	 * Checks if the specified path is within a known repository.
	 * @param path The path to check.
	 * @returns TRUE => Path is within a known repository, FALSE => Path isn't within a known repository.
	 */
	private isDirectoryWithinRepos(path: string) {
		const repoPaths = Object.keys(this.repos);
		for (let i = 0; i < repoPaths.length; i++) {
			if (path === repoPaths[i] || path.startsWith(pathWithTrailingSlash(repoPaths[i]))) return true;
		}
		return false;
	}

	/**
	 * Send the latest set of known repositories to subscribers as they have changed.
	 * @param loadRepo The optional path of a repository to load in the Git Graph View.
	 */
	private sendRepos(loadRepo: string | null = null) {
		// A repo handed to the view is an open: it heads the recently-opened list
		if (loadRepo !== null) this.recordRepoOpened(loadRepo);
		this.repoEventEmitter.emit({
			repos: this.getRepos(),
			numRepos: this.getNumRepos(),
			loadRepo: loadRepo
		});
	}

	/**
	 * Check that all known repositories still exist. If they don't, remove them.
	 * @returns TRUE => At least one repository was removed or transferred, FALSE => No repositories were removed.
	 */
	public checkReposExist() {
		const repoPaths = Object.keys(this.repos);
		let changes = false;
		return evalPromises(repoPaths, 3, (path) => resolveRepoRoot(this.repo.read, path)).then((results) => {
			for (let i = 0; i < repoPaths.length; i++) {
				if (results[i] === null) {
					this.removeRepo(repoPaths[i]);
					changes = true;
				} else if (repoPaths[i] !== results[i]) {
					this.transferRepoState(repoPaths[i], results[i]!);
					changes = true;
				}
			}
		}).catch(() => { }).then(() => {
			if (changes) {
				this.sendRepos();
			}
			return changes;
		});
	}

	/**
	 * Update each repositories workspaceFolderIndex based on the current workspace.
	 * @param repo If provided, only update this specific repository.
	 * @returns TRUE => At least one repository was changed, FALSE => No repositories were changed.
	 */
	private updateReposWorkspaceFolderIndex(repo: string | null = null) {
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
	 * Set the state of a known repository.
	 * @param repo The repository the state belongs to.
	 * @param state The state.
	 */
	public setRepoState(repo: string, state: GitRepoState) {
		// The message can arrive for a repository this host no longer knows (removed from disk or
		// the workspace, or ignored, while the webview still had it loaded): assigning would
		// silently re-add it — persisted, resurrecting an ignored/deleted repo, and writing a
		// pin file into a path that may not exist. State for an unknown repo is dropped.
		if (!this.isKnownRepo(repo)) return;
		// The state (and its pinned arrays) arrive deserialized over postMessage, so compare by value
		const pinsChanged = !pinsEqual(this.repos[repo], state);
		this.repos[repo] = state;
		this.extensionState.saveRepos(this.repos);
		if (pinsChanged) {
			this.writeRepoPins(repo);
		}
	}

	/**
	 * Persist the pinned commits and branches of a repository to its External Configuration File (`.vscode/git-graph-rs.json`).
	 * @param repo The path of the repository.
	 */
	private writeRepoPins(repo: string) {
		const state = this.repos[repo];
		if (state === undefined) {
			return;
		}
		this.pinsWriteInFlight.add(repo);
		readExternalConfigFile(repo).then((file) => {
			if (!this.isKnownRepo(repo) || this.repos[repo] !== state) {
				this.pinsWriteInFlight.delete(repo);
				return;
			}
			const contents: ExternalRepoConfig.File = file !== null ? Object.assign({}, file) : {};
			contents.pinnedBranches = state.pinnedBranches;
			contents.pinnedCommits = state.pinnedCommits;
			writeExternalConfigFile(repo, contents).catch(showErrorMessage).then(() => this.pinsWriteInFlight.delete(repo));
		});
	}

	/**
	 * Transfer the repository state from one known repository to another.
	 * @param oldRepo The repository to transfer the state from.
	 * @param newRepo The repository to transfer the state to.
	 */
	private transferRepoState(oldRepo: string, newRepo: string) {
		this.repos[newRepo] = this.repos[oldRepo];
		delete this.repos[oldRepo];
		// The old path no longer names the repository, so its engine handle must not stay resident
		this.repo.read.closeRepository(oldRepo);
		this.recentRepos = this.recentRepos.map((repo) => repo === oldRepo ? newRepo : repo);
		this.updateReposWorkspaceFolderIndex(newRepo);
		this.extensionState.saveRepos(this.repos);
		this.extensionState.transferRepo(oldRepo, newRepo);

		this.logger.log('Transferred repo state: ' + oldRepo + ' -> ' + newRepo);
	}


	/* Repo Searching */

	/**
	 * Search all of the current workspace folders for new repositories (and add them).
	 * @returns TRUE => At least one repository was added, FALSE => No repositories were added.
	 */
	public async searchWorkspaceForRepos() {
		this.logger.log('Searching workspace for new repos ...');
		const rootFolders = vscode.workspace.workspaceFolders;
		let changes = false;
		if (typeof rootFolders !== 'undefined') {
			for (let i = 0; i < rootFolders.length; i++) {
				if (await this.searchDirectoryForRepos(getPathFromUri(rootFolders[i].uri), this.maxDepthOfRepoSearch)) changes = true;
			}
		}
		this.logger.log('Completed searching workspace for new repos');
		if (changes) this.sendRepos();
		return changes;
	}

	/**
	 * Search the specified directory for new repositories (and add them).
	 * @param directory The path of the directory to search.
	 * @param maxDepth The maximum depth to recursively search.
	 * @returns TRUE => At least one repository was added, FALSE => No repositories were added.
	 */
	private searchDirectoryForRepos(directory: string, maxDepth: number) {
		return searchDirectoryForRepos(directory, maxDepth, {
			repoRoot: (dir) => resolveRepoRoot(this.repo.read, dir),
			isWithinKnownRepo: (dir) => this.isDirectoryWithinRepos(dir),
			addRepo: (repo) => this.addRepo(repo)
		});
	}

	/**
	 * Check the know repositories for any new submodules (and add them).
	 */
	private async checkReposForNewSubmodules() {
		const repoPaths = Object.keys(this.repos);
		let changes = false;
		for (let i = 0; i < repoPaths.length; i++) {
			if (await this.searchRepoForSubmodules(repoPaths[i])) changes = true;
		}
		if (changes) this.sendRepos();
	}

	/**
	 * Search a repository for any new submodules (and add them).
	 * @param repo The path of the repository to search.
	 * @returns TRUE => At least one submodule was added, FALSE => No submodules were added.
	 */
	private searchRepoForSubmodules(repo: string) {
		return searchRepoForSubmodules(repo, {
			getSubmodules: (r) => listSubmodules(this.repo.read, r),
			isKnownRepo: (r) => this.isKnownRepo(r),
			addRepo: (r) => this.addRepo(r)
		});
	}


	/* Workspace Folder Watching */

	/**
	 * Start watching each of the folders in the current workspace for changes.
	 */
	private startWatchingFolders() {
		const rootFolders = vscode.workspace.workspaceFolders;
		if (typeof rootFolders !== 'undefined') {
			for (let i = 0; i < rootFolders.length; i++) {
				this.startWatchingFolder(getPathFromUri(rootFolders[i].uri));
			}
		}
	}

	/**
	 * Start watching the specified directory for file system events.
	 * @param path The path of the directory.
	 */
	private startWatchingFolder(path: string) {
		// A watcher for this folder may already exist (e.g. the folder was added while the
		// startup scan that ends in startWatchingFolders was still running): replacing the map
		// entry would orphan the previous watcher, whose handlers keep firing for the rest of
		// the session — every event in the folder processed twice.
		if (this.folderWatchers[path] !== undefined) return;
		const watcher = vscode.workspace.createFileSystemWatcher(path + '/**');
		watcher.onDidCreate(this.onWatcherCreate.bind(this));
		watcher.onDidChange(this.onWatcherChange.bind(this));
		watcher.onDidDelete(this.onWatcherDelete.bind(this));
		this.folderWatchers[path] = watcher;
	}

	/**
	 * Stop watching the specified directory for file system events.
	 * @param path The path of the directory.
	 */
	private stopWatchingFolder(path: string) {
		if (this.folderWatchers[path] !== undefined) {
			this.folderWatchers[path].dispose();
			delete this.folderWatchers[path];
		}
	}

	/**
	 * Handle a file system creation event.
	 * @param uri The URI of the creation event.
	 */
	private onWatcherCreate(uri: vscode.Uri) {
		let path = getPathFromUri(uri);
		if (path.indexOf('/.git/') > -1) return;
		if (path.endsWith('/.git')) path = path.slice(0, -5);
		this.onWatcherCreateQueue.enqueue(path);
	}

	/**
	 * Handle a file system change event.
	 * @param uri The URI of the change event.
	 */
	private onWatcherChange(uri: vscode.Uri) {
		let path = getPathFromUri(uri);
		if (path.indexOf('/.git/') > -1) return;
		if (path.endsWith('/.git')) path = path.slice(0, -5);
		this.onWatcherChangeQueue.enqueue(path);
	}

	/**
	 * Handle a file system deletion event.
	 * @param uri The URI of the deletion event.
	 */
	private onWatcherDelete(uri: vscode.Uri) {
		let path = getPathFromUri(uri);
		if (path.indexOf('/.git/') > -1) return;
		if (path.endsWith('/.git')) path = path.slice(0, -5);
		if (this.removeReposWithinFolder(path)) this.sendRepos();
	}

	/**
	 * Process a file system creation event.
	 * @param path The path of the file that was created.
	 * @returns TRUE => Change was made. FALSE => No change was made.
	 */
	private async processOnWatcherCreateEvent(path: string) {
		if (await isDirectory(path)) {
			if (await this.searchDirectoryForRepos(path, this.maxDepthOfRepoSearch)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Process a file system change event.
	 * @param path The path of the file that was changed.
	 * @returns TRUE => Change was made. FALSE => No change was made.
	 */
	private async processOnWatcherChangeEvent(path: string) {
		if (!await doesPathExist(path)) {
			if (this.removeReposWithinFolder(path)) {
				return true;
			}
		}
		return false;
	}


	/* Repository Configuration Management */

	/**
	 * Check the known repositories for new configuration files.
	 */
	private checkReposForNewConfig() {
		Object.keys(this.repos).forEach((repo) => this.checkRepoConfigQueue.enqueue(repo));
	}

	/**
	 * Check to see if the repository has a new configuration file.
	 * @param repo The repository to check.
	 * @param isRepoNew Is the repository new (was it just added)
	 */
	private async checkRepoForNewConfig(repo: string, isRepoNew: boolean = false) {
		let changes = false;
		try {
			const file = await readExternalConfigFile(repo);
			const state = this.repos[repo];
			if (state && file !== null && !this.pinsWriteInFlight.has(repo)) {
				// Skip importing pins while a write is in flight: the watcher event that triggered
				// this check may be our own write, and importing the file's (older) pins would
				// silently revert the user's pins in memory before they are written back
				const pinnedBranches = Array.isArray(file.pinnedBranches) ? file.pinnedBranches : [];
				const pinnedCommits = Array.isArray(file.pinnedCommits) ? file.pinnedCommits : [];
				if (!pinsEqual(state, { pinnedBranches, pinnedCommits })) {
					state.pinnedBranches = pinnedBranches;
					state.pinnedCommits = pinnedCommits;
					this.extensionState.saveRepos(this.repos);
					changes = true;
				}
			}
			if (state && file !== null && typeof file.exportedAt === 'number' && file.exportedAt > state.lastImportAt) {
				const validationError = validateExternalConfigFile(file);
				if (validationError === null) {
					const yes = t('yesButton');
					const action = isRepoNew ? yes : await vscode.window.showInformationMessage(t('newerRepoConfigDetected', state.name || getRepoName(repo)), yes, t('noButton'));
					if (this.isKnownRepo(repo) && action) {
						const state = this.repos[repo];
						if (action === yes) {
							applyExternalConfigFile(file, state);
						}
						state.lastImportAt = file.exportedAt;
						this.extensionState.saveRepos(this.repos);
						if (!isRepoNew && action === yes) {
							showInformationMessage(t('repoConfigImported', state.name || getRepoName(repo)));
						}
						changes = true;
					}
				} else {
					showErrorMessage(t('repoConfigInvalidValue', validationError, getPathFromStr(path.join(repo, '.vscode', 'git-graph-rs.json'))));
				}
			}
		} catch (_) { }
		return changes;
	}

	/**
	 * Handle a file system create or change event for a configuration file.
	 * @param uri The URI of the create or change event.
	 */
	private onConfigWatcherCreateOrChange(uri: vscode.Uri) {
		const path = getPathFromUri(uri);
		const repo = this.getRepoContainingFile(path);
		if (repo !== null) {
			this.checkRepoConfigQueue.enqueue(repo);
		}
	}

	/**
	 * Export a repositories configuration.
	 * @param repo The path of the repository to export.
	 * @returns The ErrorInfo produced when performing this action.
	 */
	public exportRepoConfig(repo: string): Promise<ErrorInfo> {
		const file = generateExternalConfigFile(this.repos[repo]);
		return writeExternalConfigFile(repo, file).then((message) => {
			showInformationMessage(message);
			if (this.isKnownRepo(repo)) {
				this.repos[repo].lastImportAt = file.exportedAt!;
				this.extensionState.saveRepos(this.repos);
			}
			return null;
		}, (error) => error);
	}
}
