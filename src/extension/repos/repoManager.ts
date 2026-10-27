import * as vscode from 'vscode';
import type { ProductionGitRepository } from '../git/gitRepository';
import type { GitRunnerPort } from '../graphView/gitRunner';
import { addRemoteTagsRefspec } from '../git/write/ops/config';
import { ErrorInfo } from '../../shared/protocol/messages';
import { GitRepoState } from '../../shared/model/repoState';
import { getPathFromUri, realpath } from '../platform/paths';
import { BufferedQueue } from '../../shared/util/bufferedQueue';
import { evalPromises } from '../git/process/childProcess';
import { Disposable, toDisposable } from '../../shared/util/disposable';
import { GgEvent } from '../../shared/util/event';
import { takeSnapshot } from '../platform/config';
import type { ConfigSnapshot, WorkspaceConfigurationLike, WorkspaceLike } from '../platform/config';
import { ExtensionState } from '../platform/storage';
import { Logger } from '../platform/logger';
import { pinsEqual } from './repoConfigFile';
import { RepoRegistry } from './repoRegistry';
import { RepoSettingsStore } from './repoSettingsStore';
import {
	doesPathExist,
	isDirectory,
	listSubmodules,
	resolveRepoRoot,
	searchDirectoryForRepos,
	searchRepoForSubmodules
} from './repoDiscovery';

// The pure policy helpers and the state-and-events half this facade composes:
// re-exported here so the repository manager's importers keep their single import path.
export type { RepoChangeEvent } from './repoRegistry';
export { MAX_RECENT_REPOS, bumpRecentRepos, recentReposList } from './repoRegistry';

/**
 * One snapshot of the extension's settings, resolved against the given repository's folder when
 * one is given (the exact scope the per-repository read needs; the settings the manager reads
 * are window-scoped, so the scoped and unscoped values agree). Defaults come from the
 * configuration schema table through the snapshot — nothing here defines one.
 * @param repo An optional path of a repository (for workspace-folder-scoped resolution).
 * @returns The configuration snapshot.
 */
function configSnapshotOf(repo?: string): ConfigSnapshot {
	let workspace: WorkspaceLike = vscode.workspace;
	if (repo !== undefined) {
		workspace = {
			getConfiguration: (section?: string): WorkspaceConfigurationLike => vscode.workspace.getConfiguration(section, vscode.Uri.file(repo))
		};
	}
	return takeSnapshot(workspace);
}

/**
 * The collaborators the RepoManager is constructed with: the service's explicit dependency
 * list. The manager is a member of the composition root's frozen
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
 * Detects and manages repositories in Git Graph: the facade composing the repository registry
 * (./repoRegistry), the external configuration file store (./repoSettingsStore), repository
 * discovery (./repoDiscovery) and the workspace folder watchers.
 */
export class RepoManager extends Disposable {
	private readonly repo: ProductionGitRepository;
	private readonly git: GitRunnerPort;
	private readonly logger: Logger;
	private readonly registry: RepoRegistry;
	private readonly settings: RepoSettingsStore;

	private maxDepthOfRepoSearch: number;

	private readonly folderWatchers: { [workspace: string]: vscode.FileSystemWatcher } = {};
	private readonly configWatcher: vscode.FileSystemWatcher;

	private readonly onWatcherCreateQueue: BufferedQueue<string>;
	private readonly onWatcherChangeQueue: BufferedQueue<string>;

	/**
	 * Creates the Git Graph Repository Manager, and runs startup tasks.
	 * @param deps The service's collaborators (see {@link RepoManagerDeps}).
	 */
	constructor(deps: RepoManagerDeps) {
		super();
		this.repo = deps.repo;
		this.git = deps.git;
		this.logger = deps.logger;
		this.registry = new RepoRegistry({ state: deps.state, logger: deps.logger, backend: deps.repo.read });
		this.maxDepthOfRepoSearch = configSnapshotOf().maxDepthOfRepoSearch;
		// Wrapped (not passed as the method itself), so the vscode.window read is deferred to prompt time
		this.settings = new RepoSettingsStore(this.registry, (message, ...items) => vscode.window.showInformationMessage(message, ...items));

		this.configWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/git-graph-rs.json');
		this.configWatcher.onDidCreate(this.onConfigWatcherCreateOrChange.bind(this));
		this.configWatcher.onDidChange(this.onConfigWatcherCreateOrChange.bind(this));

		this.onWatcherCreateQueue = new BufferedQueue<string>(this.processOnWatcherCreateEvent.bind(this), this.sendRepos.bind(this));
		this.onWatcherChangeQueue = new BufferedQueue<string>(this.processOnWatcherChangeEvent.bind(this), this.sendRepos.bind(this));

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
						if (this.registry.removeReposWithinFolder(path)) changes = true;
						this.stopWatchingFolder(path);
					}
				}
				if (this.registry.updateWorkspaceFolderIndex()) {
					this.registry.persist();
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

			// Dispose the registry (its event emitter) and the settings store (its config check queue)
			this.registry,
			this.settings,

			// Dispose the configWatcher
			this.configWatcher,

			// Dispose the onWatcherCreateQueue
			this.onWatcherCreateQueue,

			// Dispose the onWatcherChangeQueue
			this.onWatcherChangeQueue,

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
		return this.registry.onDidChangeRepos;
	}

	/**
	 * Apply the new value of `git-graph-rs.maxDepthOfRepoSearch` to the RepoManager.
	 */
	private maxDepthOfRepoSearchChanged() {
		const newDepth = configSnapshotOf().maxDepthOfRepoSearch;
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
		this.registry.removeReposNotInWorkspace();
		if (this.registry.updateWorkspaceFolderIndex()) {
			this.registry.persist();
		}
		if (!await this.checkReposExist()) {
			// On startup, ensure that sendRepo is called (even if no changes were made)
			this.sendRepos();
		}
		this.settings.checkReposForNewConfig();
		await this.checkReposForNewSubmodules();
		await Promise.all(this.registry.repoPaths().map(repo => {
			if (configSnapshotOf(repo).repositoryTrackRemoteTags) {
				return this.trackRemoteTags(repo);
			}
			return Promise.resolve();
		}));
		await this.searchWorkspaceForRepos();
		this.startWatchingFolders();
	}

	/**
	 * Add the tag-tracking fetch refspec (`+refs/tags/*:refs/remotes/<remote>/tags/*`) to every
	 * remote of the repository that does not already carry it: the refspec is only added when
	 * the remote's fetch
	 * configuration does not yet include it, and any failure is swallowed (a repository whose
	 * remotes cannot be read or configured simply keeps its current fetch behaviour).
	 * @param repo The path of the repository.
	 */
	private async trackRemoteTags(repo: string): Promise<void> {
		try {
			const remotes = await this.repo.read.getRemotes(repo);
			await Promise.all(remotes.map(async (remote) => {
				// `git config --get-all` exits non-zero when the key holds no value at all — read as
				// "no tag refspec present" rather than a failure (the empty answer is the correct one)
				const fetchConfigs = await this.git.gitOutput(['config', '--get-all', 'remote.' + remote + '.fetch'], repo, (stdout) => stdout).catch(() => '');
				if (!fetchConfigs.includes('refs/remotes/' + remote + '/tags/*')) {
					await this.repo.write.run(repo, addRemoteTagsRefspec({ remote: remote }));
				}
			}));
		} catch (_) { }
	}

	/* Repo Management */

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
			} else if (this.registry.isKnownRepo(root)) {
				resolve({ root: null, error: 'The folder "' + path + '" is contained within the known repository "' + root + '".' });
			} else {
				this.registry.forgetIgnoredRepo(root);
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
		if (this.registry.isKnownRepo(repo)) {
			this.registry.markRepoIgnored(repo);
			this.registry.removeRepo(repo);
			this.sendRepos();
			return true;
		} else {
			return false;
		}
	}

	/**
	 * Get a set of all known repositories in the current workspace.
	 * @returns The set of repositories.
	 */
	public getRepos() {
		return this.registry.getRepos();
	}

	/**
	 * Get the number of all known repositories in the current workspace.
	 * @returns The number of repositories.
	 */
	public getNumRepos() {
		return this.registry.getNumRepos();
	}

	/**
	 * Record that a repository was opened in the Git Graph View (heads the recently-opened list;
	 * the PrewarmController's candidate order).
	 * @param repo The path of the repository that was opened.
	 */
	public recordRepoOpened(repo: string) {
		this.registry.recordRepoOpened(repo);
	}

	/**
	 * Get the recently-opened repositories, most recent first (the registry merges this
	 * session's opens with the previous session's last-active repository).
	 * @returns The recently-opened repository paths.
	 */
	public getRecentRepos(): readonly string[] {
		return this.registry.getRecentRepos();
	}

	/**
	 * Get the repository that contains the specified file.
	 * @param path The path of the file.
	 * @returns The path of the repository containing the file, or NULL if no known repository contains the file.
	 */
	public getRepoContainingFile(path: string) {
		return this.registry.getRepoContainingFile(path);
	}

	/**
	 * Get the path of the known repository matching the specified repository path (checking symbolic links if necessary).
	 * @param repo The path of the repository.
	 * @returns The path of the known repository, or NULL if the specified repository is unknown.
	 */
	public async getKnownRepo(repo: string) {
		if (this.registry.isKnownRepo(repo)) {
			// The path is already known as a repo
			return repo;
		}

		// Check to see if a known repository contains a symlink that resolves the repo
		const canonicalRepo = await realpath(repo);
		const repoPaths = this.registry.repoPaths();
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
		return this.registry.isKnownRepo(repo);
	}

	/**
	 * Add a new repository to Git Graph.
	 * @param repo The path of the repository.
	 * @returns TRUE => The repository was added, FALSE => The repository is ignored and couldn't be added.
	 */
	private async addRepo(repo: string) {
		if (!this.registry.addRepo(repo)) {
			return false;
		}
		await this.settings.checkRepoForNewConfig(repo, true);
		await this.searchRepoForSubmodules(repo);
		return true;
	}

	/**
	 * Send the latest set of known repositories to subscribers as they have changed.
	 * @param loadRepo The optional path of a repository to load in the Git Graph View.
	 */
	private sendRepos(loadRepo: string | null = null) {
		this.registry.sendRepos(loadRepo);
	}

	/**
	 * Check that all known repositories still exist. If they don't, remove them.
	 * @returns TRUE => At least one repository was removed or transferred, FALSE => No repositories were removed.
	 */
	public checkReposExist() {
		const repoPaths = this.registry.repoPaths();
		let changes = false;
		return evalPromises(repoPaths, 3, (path) => resolveRepoRoot(this.repo.read, path)).then((results) => {
			for (let i = 0; i < repoPaths.length; i++) {
				if (results[i] === null) {
					this.registry.removeRepo(repoPaths[i]);
					changes = true;
				} else if (repoPaths[i] !== results[i]) {
					this.registry.transferRepoState(repoPaths[i], results[i]!);
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
	 * Set the state of a known repository.
	 * @param repo The repository the state belongs to.
	 * @param state The state.
	 */
	public setRepoState(repo: string, state: GitRepoState) {
		// The message can arrive for a repository this host no longer knows (removed from disk or
		// the workspace, or ignored, while the webview still had it loaded): assigning would
		// silently re-add it — persisted, resurrecting an ignored/deleted repo, and writing a
		// pin file into a path that may not exist. State for an unknown repo is dropped.
		if (!this.registry.isKnownRepo(repo)) return;
		// The state (and its pinned arrays) arrive deserialized over postMessage, so compare by value
		const pinsChanged = !pinsEqual(this.registry.getRepoState(repo)!, state);
		this.registry.assignRepoState(repo, state);
		if (pinsChanged) {
			this.settings.writeRepoPins(repo);
		}
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
			isWithinKnownRepo: (dir) => this.registry.isDirectoryWithinRepos(dir),
			addRepo: (repo) => this.addRepo(repo)
		});
	}

	/**
	 * Check the know repositories for any new submodules (and add them).
	 */
	private async checkReposForNewSubmodules() {
		const repoPaths = this.registry.repoPaths();
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
			isKnownRepo: (r) => this.registry.isKnownRepo(r),
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
		if (this.registry.removeReposWithinFolder(path)) this.sendRepos();
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
			if (this.registry.removeReposWithinFolder(path)) {
				return true;
			}
		}
		return false;
	}

	/* Repository Configuration Management */

	/**
	 * Handle a file system create or change event for a configuration file.
	 * @param uri The URI of the create or change event.
	 */
	private onConfigWatcherCreateOrChange(uri: vscode.Uri) {
		this.settings.onConfigWatcherCreateOrChange(getPathFromUri(uri));
	}

	/**
	 * Export a repositories configuration.
	 * @param repo The path of the repository to export.
	 * @returns The ErrorInfo produced when performing this action.
	 */
	public exportRepoConfig(repo: string): Promise<ErrorInfo> {
		return this.settings.exportRepoConfig(repo);
	}
}
