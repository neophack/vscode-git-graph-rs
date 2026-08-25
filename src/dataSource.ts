import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { AskpassEnvironment, AskpassManager } from './askpass/askpassManager';
import { GitBackend, createBackend } from './backend';
import { getConfig } from './config';
import { GerritDataSource } from './gerrit';
import { t } from './i18n';
import { Logger } from './logger';
import { ActionedUser, CommitOrdering, ErrorInfo, ErrorInfoExtensionPrefix, GitCommit, GitCommitDetails, GitCommitStash, GitConfigLocation, GitFileChange, GitLineCounts, GitPushBranchMode, GitRepoConfig, GitRepoConfigBranches, GitResetMode, GitStash, GitTagDetails, MergeActionOn, RebaseActionOn, SquashMessageFormat, TagType } from './types';
import { GitExecutable, GitVersionRequirement, UNCOMMITTED, abbrevCommit, constructIncompatibleGitVersionMessage, doesVersionMeetRequirement, getPathFromUri, isSafeRefName, isSafeStashSelector, isValidCommitHash, openGitTerminal, pathWithTrailingSlash, quoteShellArg, realpath, resolveSpawnOutput, showErrorMessage, unableToFindGitMsg } from './utils';
import { Disposable } from './utils/disposable';
import { GgEvent } from './utils/event';

const EOL_REGEX = /\r\n|\r|\n/g;
const INVALID_BRANCH_REGEXP = /^\(.* .*\)$/;
const DRIVE_LETTER_PATH_REGEX = /^[a-z]:\//;

export const enum GitConfigKey {
	DiffGuiTool = 'diff.guitool',
	DiffTool = 'diff.tool',
	RemotePushDefault = 'remote.pushdefault',
	UserEmail = 'user.email',
	UserName = 'user.name'
}

/**
 * Interfaces Git Graph with the Git executable to provide all Git integrations.
 */
export class DataSource extends Disposable {
	private readonly logger: Logger;
	private readonly askpassEnv: AskpassEnvironment;
	/** The engine-backed reader: the Rust engine when available, the `git` CLI otherwise. */
	private backend!: GitBackend;
	private gitExecutable!: GitExecutable | null;
	/** Cache of Git config data per repository, to avoid repeated Git spawns on every view load. */
	private readonly configCache = new Map<string, { remotesSignature: string, promise: Promise<GitRepoConfigData> }>();
	/** The Gerrit integration (change ref fetching + NoteDb meta parsing), run over this DataSource's Git runner. */
	public readonly gerrit: GerritDataSource = new GerritDataSource(this);

	/**
	 * Check that values received from an untrusted source (the webview) are safe to be passed to
	 * git, i.e. they cannot be misinterpreted as git options (argument injection).
	 * @param checks Tuples of [argument name, value, kind] to validate. Values that are null or
	 * undefined are skipped.
	 * @returns An error message if any value is unsafe, otherwise null.
	 */
	private static checkUnsafeGitArgs(...checks: [string, string | null | undefined, 'hash' | 'ref' | 'stash' | 'url'][]): ErrorInfo {
		for (const [name, value, kind] of checks) {
			if (value === null || value === undefined) continue;
			let valid: boolean;
			if (kind === 'hash') {
				valid = isValidCommitHash(value);
			} else if (kind === 'stash') {
				valid = isSafeStashSelector(value);
			} else if (kind === 'url') {
				// URLs (including the "" placeholder used when no URL is set) can't be validated as
				// strictly as a ref name, but a leading '-' would still let the value be misinterpreted
				// as a git option instead of a positional argument
				valid = value[0] !== '-';
			} else {
				valid = isSafeRefName(value);
			}
			if (!valid) {
				const key = kind === 'hash' ? 'invalidCommitHash' : (kind === 'stash' ? 'invalidStashSelector' : (kind === 'url' ? 'invalidUrl' : 'invalidRefName'));
				return t(key as 'invalidCommitHash', name);
			}
		}
		return null;
	}

	/**
	 * Creates the Git Graph Data Source.
	 * @param gitExecutable The Git executable available to Git Graph at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 * @param logger The Git Graph Logger instance.
	 */
	constructor(gitExecutable: GitExecutable | null, onDidChangeConfiguration: GgEvent<vscode.ConfigurationChangeEvent>, onDidChangeGitExecutable: GgEvent<GitExecutable | null>, logger: Logger) {
		super();
		this.logger = logger;
		this.setGitExecutable(gitExecutable);
		this.rebuildBackend(gitExecutable);

		const askpassManager = new AskpassManager();
		this.askpassEnv = askpassManager.getEnv();

		this.registerDisposables(
			onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('git-graph-rs.date.type') ||
					event.affectsConfiguration('git-graph-rs.repository.commits.showSignatureStatus') ||
					event.affectsConfiguration('git-graph-rs.repository.useMailmap')
				) {
					this.generateGitCommandFormats();
				}
			}),
			onDidChangeGitExecutable((gitExecutable) => {
				this.setGitExecutable(gitExecutable);
				this.rebuildBackend(gitExecutable);
			}),
			askpassManager
		);
	}

	/**
	 * Check if the Git executable is unknown.
	 * @returns TRUE => Git executable is unknown, FALSE => Git executable is known.
	 */
	public isGitExecutableUnknown() {
		return this.gitExecutable === null;
	}

	/**
	 * Set the Git executable used by the DataSource.
	 * @param gitExecutable The Git executable.
	 */
	private setGitExecutable(gitExecutable: GitExecutable | null) {
		this.gitExecutable = gitExecutable;
		this.generateGitCommandFormats();
	}

	/**
	 * (Re)build the backend for the current Git situation: the engine with CLI fallback when both
	 * exist, the engine alone when no Git executable was found (the read path is fully
	 * engine-served, so the view works on a machine without Git at all), the CLI alone otherwise.
	 */
	private rebuildBackend(gitExecutable: GitExecutable | null) {
		this.backend = createBackend({
			gitPath: gitExecutable !== null ? gitExecutable.path : null,
			onFallback: (method, error) => {
				this.logger.log('The Rust engine could not answer ' + method + ' (' + error.message + '); falling back to the git CLI.');
			}
		});
		this.logger.log('Using the ' + this.backend.name + ' backend.');
	}

	/**
	 * Generate the format strings used by various Git commands.
	 */
	private generateGitCommandFormats() {
		// Only the subject is fetched for the commit list: full bodies dominate the git log output
		// size on large repositories (and with it the parse and IPC cost). Bodies are fetched on
		// demand via getCommitBodies (e.g. when "Show Commit Body Inline" is enabled).

	}


	/**
	 * Open a repository handle in the Git backend (the Rust engine keeps the pack indexes and the
	 * object cache resident, which is where its speed comes from). Fire-and-forget: a failure only
	 * means the backend falls back to the `git` CLI for this repository.
	 * @param repo The path of the repository.
	 */
	public openRepository(repo: string) {
		this.backend.openRepository(repo).catch((error) => {
			this.logger.log('The Git backend could not open the repository ' + repo + ': ' + (error instanceof Error ? error.message : String(error)));
		});
	}

	/* Get Data Methods - Core */

	/**
	 * Get the high-level information of a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showStashes Are stashes shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The repositories information.
	 */
	public async trackRemoteTags(repo: string): Promise<void> {
		try {
			const remotes = await this.getRemotes(repo);
			await Promise.all(remotes.map(async (remote) => {
				const fetchConfigs = await this._spawnGit(['config', '--get-all', 'remote.' + remote + '.fetch'], repo, stdout => stdout, true);
				if (!fetchConfigs.includes('refs/remotes/' + remote + '/tags/*')) {
					await this._spawnGit(['config', '--add', 'remote.' + remote + '.fetch', '+refs/tags/*:refs/remotes/' + remote + '/tags/*'], repo, () => {}, true);
				}
			}));
		} catch (e) {}
	}

	public searchHistory(repo: string, query: string): Promise<{hash: string, author: string, date: number, message: string}[]> {
		return this.backend.searchHistory(repo, query).then((matches) => matches.map((match) => ({
			hash: match.hash,
			author: match.author,
			date: match.date,
			message: match.message
		})));
	}

	public getRepoInfo(repo: string, showRemoteBranches: boolean, showStashes: boolean, hideRemotes: ReadonlyArray<string>): Promise<GitRepoInfo> {
		return this.backend.getRepoInfo(repo, {
			showRemoteBranches: showRemoteBranches,
			showRemoteHeads: getConfig().showRemoteHeads,
			hideRemotes: hideRemotes,
			showChangeRefs: false,
			showStashes: showStashes
		}).then((info) => <GitRepoInfo>{
			branches: info.branches,
			head: info.head,
			remotes: info.remotes,
			stashes: info.stashes,
			tags: info.tags,
			error: info.error
		}, (errorMessage) => <GitRepoInfo>{ branches: [], head: null, remotes: [], stashes: [], tags: [], error: errorMessage });
	}

	/**
	 * Get the commits in a repository.
	 */
	public getCommits(repo: string, branches: ReadonlyArray<string> | null, authors: ReadonlyArray<string> | null, maxCommits: number, showTags: boolean, showRemoteBranches: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, commitOrdering: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, _stashes: ReadonlyArray<GitStash>, gerritRefs: ReadonlyArray<string> | null = null, gerritShowChangeRefs: boolean = false, filterPath: string | null = null, deferUncommittedChanges: boolean = false): Promise<GitCommitData> {
		const config = getConfig();
		// Branch names are received from the webview and passed to git log as bare arguments, so
		// drop any that could be misinterpreted as git options (argument injection). Custom Branch
		// Glob Patterns are the one legitimate exception: they are always of the form `--glob=<pattern>`
		// (see Config.customBranchGlobPatterns), a single argv token that git can't reinterpret as a
		// different option, so they're allowed through even though they start with `-`.
		const refs = branches === null ? null : branches.filter((branch) => isSafeRefName(branch) || isValidCommitHash(branch) || branch.startsWith('--glob='));
		return this.backend.getCommits(repo, {
			branches: refs !== null ? refs : undefined,
			authors: authors,
			maxCommits: maxCommits,
			showTags: showTags,
			showRemoteBranches: showRemoteBranches,
			showRemoteHeads: config.showRemoteHeads,
			includeCommitsMentionedByReflogs: includeCommitsMentionedByReflogs,
			onlyFollowFirstParent: onlyFollowFirstParent,
			commitOrdering: commitOrdering,
			remotes: remotes,
			hideRemotes: hideRemotes,
			gerritRefs: gerritRefs,
			gerritShowChangeRefs: gerritShowChangeRefs,
			filterPaths: filterPath !== null ? [filterPath] : undefined,
			deferUncommittedChanges: deferUncommittedChanges,
			showUncommittedChanges: config.showUncommittedChanges,
			showUntrackedFiles: config.showUntrackedFiles,
			showCommitsOnlyReferencedByTags: config.showCommitsOnlyReferencedByTags
		}).then((data) => data as unknown as GitCommitData, (errorMessage) => <GitCommitData>{ commits: [], head: null, tags: [], moreCommitsAvailable: false, error: errorMessage });
	}

	/**
	 * Get various Git config variables for a repository that are consumed by the Git Graph View.
	 * The result is cached per repository (and invalidated when the set of remotes changes, the
	 * repository's `.git/config` is modified, or `invalidateConfigCache` is called), because it
	 * requires several Git spawns that would otherwise be repeated on every view load.
	 * @param repo The path of the repository.
	 * @param remotes An array of known remotes.
	 * @returns The config data.
	 */
	public getConfig(repo: string, remotes: ReadonlyArray<string>): Promise<GitRepoConfigData> {
		const remotesSignature = remotes.join('\n');
		const cached = this.configCache.get(repo);
		if (cached !== undefined && cached.remotesSignature === remotesSignature) {
			return cached.promise;
		}
		const promise = this.loadConfig(repo).then((data) => {
			if (data.error !== null) {
				// Don't cache error results (they may be transient): allow the next call to retry
				if (this.configCache.get(repo)?.promise === promise) this.configCache.delete(repo);
			}
			return data;
		});
		this.configCache.set(repo, { remotesSignature: remotesSignature, promise: promise });
		return promise;
	}

	/**
	 * Invalidate the cached refs of a repository. The ref reads are served by the Git backend
	 * (which caches repository state itself), so this is now a no-op kept for its callers.
	 * @param repo The path of the repository (unused).
	 */
	public invalidateRefCache(_repo: string | null) {
		/* The backend owns the ref cache. */
	}

	/**
	 * Invalidate the cached Git config data for a repository (e.g. because its `.git/config` file
	 * was modified), so that the next `getConfig` call reloads it from Git.
	 * @param repo The path of the repository (or NULL to clear the cache of all repositories).
	 */
	public invalidateConfigCache(repo: string | null) {
		if (repo === null) {
			this.configCache.clear();
		} else {
			this.configCache.delete(repo);
		}
	}

	private loadConfig(repo: string): Promise<GitRepoConfigData> {
		// The engine (or, failing it, the `git` CLI backend) provides the remotes with their URLs,
		// the push default and the diff tools; the branch and user configuration and the author
		// list still come from the CLI, whose output shape the settings widget expects.
		return Promise.all([
			this.backend.getConfig(repo),
			this.getConfigList(repo, GitConfigLocation.Local),
			this.getConfigList(repo, GitConfigLocation.Global),
			this.getAuthorList(repo)
		]).then((results) => {
			const snapshot = results[0], localConfigs = results[1], globalConfigs = results[2], authors = results[3];

			const branches: GitRepoConfigBranches = {};
			Object.keys(localConfigs).forEach((key) => {
				if (key.startsWith('branch.')) {
					if (key.endsWith('.remote')) {
						const branchName = key.substring(7, key.length - 7);
						branches[branchName] = {
							pushRemote: typeof branches[branchName] !== 'undefined' ? branches[branchName].pushRemote : null,
							remote: localConfigs[key]
						};
					} else if (key.endsWith('.pushremote')) {
						const branchName = key.substring(7, key.length - 11);
						branches[branchName] = {
							pushRemote: localConfigs[key],
							remote: typeof branches[branchName] !== 'undefined' ? branches[branchName].remote : null
						};
					}
				}
			});
			return {
				config: {
					branches: branches,
					authors: authors,
					diffTool: snapshot.diffTool,
					guiDiffTool: snapshot.diffGuiTool,
					pushDefault: snapshot.pushDefault,
					remotes: snapshot.remotes.map((remote) => ({
						name: remote.name,
						url: remote.url,
						pushUrl: remote.pushUrl
					})),
					user: {
						name: {
							local: getConfigValue(localConfigs, GitConfigKey.UserName),
							global: getConfigValue(globalConfigs, GitConfigKey.UserName)
						},
						email: {
							local: getConfigValue(localConfigs, GitConfigKey.UserEmail),
							global: getConfigValue(globalConfigs, GitConfigKey.UserEmail)
						}
					}
				},
				error: null
			};
		}).catch((errorMessage) => {
			return { config: null, error: errorMessage };
		});
	}

	private getAuthorList(repo: string): Promise<ActionedUser[]> {
		// The backend aggregates `git shortlog` exactly as this DataSource always parsed it
		// (per-name de-duplication keeping the most-prolific spelling, sorted by name).
		return this.backend.getAuthors(repo).then((authors) => authors.map((author) => ({
			name: author.name,
			email: author.email
		})), () => []);
	}
	/* Get Data Methods - Commit Details View */

	/**
	 * Get the commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @param hasParents Does the commit have parents
	 * @returns The commit details.
	 */
	public getCommitDetails(repo: string, commitHash: string, _hasParents: boolean): Promise<GitCommitDetailsData> {
		return this.backend.getCommitDetails(repo, commitHash).then((details) => {
			return { commitDetails: details as unknown as GitCommitDetails, error: null };
		}, (errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the stash details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the stash commit open in the Commit Details View.
	 * @param stash The stash.
	 * @returns The stash details.
	 */
	public getStashDetails(repo: string, commitHash: string, stash: GitCommitStash): Promise<GitCommitDetailsData> {
		return this.backend.getStashDetails(repo, commitHash, { selector: stash.selector, baseHash: stash.baseHash, untrackedFilesHash: stash.untrackedFilesHash }).then((details) => {
			return { commitDetails: details as unknown as GitCommitDetails, error: null };
		}, (errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the uncommitted details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @returns The uncommitted details.
	 */
	public getUncommittedDetails(repo: string): Promise<GitCommitDetailsData> {
		return this.backend.getUncommittedDetails(repo).then((details) => {
			return { commitDetails: details as unknown as GitCommitDetails, error: null };
		}, (errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the comparison details for the Commit Comparison View.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the comparison is from.
	 * @param toHash The commit hash the comparison is to.
	 * @returns The comparison details.
	 */
	public getCommitComparison(repo: string, fromHash: string, toHash: string): Promise<GitCommitComparisonData> {
		return this.backend.compareCommits(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash).then((fileChanges) => {
			return { fileChanges: fileChanges as unknown as GitFileChange[], error: null };
		}, (errorMessage) => {
			return { fileChanges: [], error: errorMessage };
		});
	}

	/**
	 * Get the +/- line counts of specific files of the open Commit Details / Commit Comparison view.
	 *
	 * The details themselves arrive without counts (each one costs two blob reads, which dominates
	 * the load of a many-file commit); the view settles them progressively through this method —
	 * the visible files first, then the rest in the background.
	 * @param repo The path of the repository.
	 * @param from The diff's left side, or null to diff `to` against its first parent (a plain commit).
	 * @param to The diff's right side.
	 * @param paths The paths to count, keyed by the file's new path.
	 * @returns The counts, keyed by path; a binary file reports null counts.
	 */
	public getCommitFileCounts(repo: string, from: string | null, to: string, paths: ReadonlyArray<string>): Promise<GitCommitFileCountsData> {
		return this.backend.getLineCounts(repo, from, to, paths).then((counts) => {
			return { counts: counts as { [path: string]: GitLineCounts }, error: null };
		}, (errorMessage) => {
			return { counts: {}, error: errorMessage };
		});
	}

	/**
	 * Get the contents of a file at a specific revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash specifying the revision of the file.
	 * @param filePath The path of the file relative to the repositories root.
	 * @returns The file contents (empty for binary files).
	 */
	public getCommitFile(repo: string, commitHash: string, filePath: string): Promise<string> {
		return this.backend.getCommitFile(repo, commitHash, filePath).then((file) => file.contents !== null ? file.contents : '');
	}

	/**
	 * Get the unified diff of a single file between two revisions (used by the Commit Comparison View).
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to ('' compares against the working tree).
	 * @param oldFilePath The relative path of the file on the from-side.
	 * @param newFilePath The relative path of the file on the to-side (differs when renamed).
	 * @returns The unified diff output.
	 */
	public getCommitFileDiff(repo: string, fromHash: string, toHash: string, oldFilePath: string, newFilePath: string): Promise<string> {
		if (toHash === UNCOMMITTED) toHash = '';
		if (oldFilePath === newFilePath && toHash !== '' && isValidCommitHash(toHash) && fromHash === toHash + '^') {
			// The diff of a single file in a single commit: the engine answers this directly
			return this.backend.getCommitFileDiff(repo, toHash, newFilePath);
		}
		const args = ['diff', '--no-color', '--find-renames', fromHash];
		if (toHash !== '') args.push(toHash);
		args.push('--');
		if (oldFilePath !== newFilePath) args.push(oldFilePath);
		args.push(newFilePath);
		return this.spawnGit(args, repo, stdout => stdout);
	}

	/* Get Data Methods - General */

	/**
	 * Get a lightweight summary (hash, author, date, full message) of each of the given commits,
	 * used by the Commit Comparison View to describe the two commits being compared.
	 * @param repo The path of the repository.
	 * @param commitHashes The hashes of the commits to summarise.
	 * @returns A map of commit hash to summary, or NULL if an error occurred.
	 */
	public getCommitSummaries(repo: string, commitHashes: string[]): Promise<{ [hash: string]: { hash: string, author: string, email: string, date: number, message: string } } | null> {
		return this.backend.getCommitSummaries(repo, commitHashes).then((summaries) => summaries as {
			[hash: string]: { hash: string, author: string, email: string, date: number, message: string }
		}, () => null);
	}

	/**
	 * Get the subject of a commit.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash.
	 * @returns The subject string, or NULL if an error occurred.
	 */
	public getCommitSubject(repo: string, commitHash: string): Promise<string | null> {
		return this.backend.getCommitSubject(repo, commitHash).catch(() => null);
	}

	/**
	 * Get the URL of a repositories remote.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote.
	 * @returns The URL, or NULL if an error occurred.
	 */
	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return this.backend.getRemoteUrl(repo, remote).catch(() => null);
	}

	/**
	 * Check to see if a file has been renamed between a commit and the working tree, and return the new file path.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash where `oldFilePath` is known to have existed.
	 * @param oldFilePath The file path that may have been renamed.
	 * @returns The new renamed file path, or NULL if either: the file wasn't renamed or the Git command failed to execute.
	 */
	public getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string) {
		return this.backend.getNewPathOfRenamedFile(repo, commitHash, oldFilePath).catch(() => null);
	}

	/**
	 * Get the details of a tag.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @returns The tag details.
	 */
	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetailsData> {
		if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.TagDetails)) {
			return Promise.resolve({ details: null, error: constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.TagDetails, 'retrieving Tag Details') });
		}

		return this.backend.getTagDetails(repo, tagName).then((details) => ({
			details: details as unknown as GitTagDetails,
			error: null
		}), (errorMessage) => ({
			details: null,
			error: errorMessage
		}));
	}

	/**
	 * Get the submodules of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of the paths of the submodules.
	 */
	public getSubmodules(repo: string) {
		return this.backend.getSubmodules(repo).then((submodules) => [...submodules], () => []);
	}


	/* Repository Info Methods */

	/**
	 * Check if there are any staged changes in the repository.
	 * @param repo The path of the repository.
	 * @returns TRUE => Staged Changes, FALSE => No Staged Changes.
	 */
	private areStagedChanges(repo: string) {
		return this.spawnGit(['diff-index', 'HEAD'], repo, (stdout) => stdout !== '').then(changes => changes, () => false);
	}

	/**
	 * Get the root of the repository containing the specified path.
	 * @param pathOfPotentialRepo The path that is potentially a repository (or is contained within a repository).
	 * @returns STRING => The root of the repository, NULL => `pathOfPotentialRepo` is not in a repository.
	 */
	public repoRoot(pathOfPotentialRepo: string) {
		return this.backend.repoRoot(pathOfPotentialRepo).then((root) => getPathFromUri(vscode.Uri.file(path.normalize(root)))).then(async (pathReturnedByGit) => {
			if (process.platform === 'win32') {
				// On Windows Mapped Network Drives with Git >= 2.25.0, `git rev-parse --show-toplevel` returns the UNC Path for the Mapped Network Drive, instead of the Drive Letter.
				// Attempt to replace the UNC Path with the Drive Letter.
				let driveLetterPathMatch: RegExpMatchArray | null;
				if ((driveLetterPathMatch = pathOfPotentialRepo.match(DRIVE_LETTER_PATH_REGEX)) && !pathReturnedByGit.match(DRIVE_LETTER_PATH_REGEX)) {
					const realPathForDriveLetter = pathWithTrailingSlash(await realpath(driveLetterPathMatch[0], true));
					if (realPathForDriveLetter !== driveLetterPathMatch[0] && pathReturnedByGit.startsWith(realPathForDriveLetter)) {
						pathReturnedByGit = driveLetterPathMatch[0] + pathReturnedByGit.substring(realPathForDriveLetter.length);
					}
				}
			}
			let path = pathOfPotentialRepo;
			let first = path.indexOf('/');
			while (true) {
				if (pathReturnedByGit === path || pathReturnedByGit === await realpath(path)) return path;
				let next = path.lastIndexOf('/');
				if (first !== next && next > -1) {
					path = path.substring(0, next);
				} else {
					return pathReturnedByGit;
				}
			}
		}).catch(() => null); // null => path is not in a repo
	}


	/* Git Action Methods - Remotes */

	/**
	 * Add a new remote to a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @param url The URL of the remote.
	 * @param pushUrl The Push URL of the remote.
	 * @param fetch Fetch the remote after it is added.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['name', name, 'ref'], ['url', url, 'url'], ['pushUrl', pushUrl, 'url']);
		if (unsafeArgs !== null) return unsafeArgs;

		let status = await this.runGitCommand(['remote', 'add', name, url], repo);
		if (status !== null) return status;

		if (pushUrl !== null) {
			status = await this.runGitCommand(['remote', 'set-url', name, '--push', pushUrl], repo);
			if (status !== null) return status;
		}

		return fetch ? this.fetch(repo, name, false, false) : null;
	}

	/**
	 * Delete an existing remote from a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteRemote(repo: string, name: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['name', name, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['remote', 'remove', name], repo);
	}

	/**
	 * Edit an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param nameOld The old name of the remote.
	 * @param nameNew The new name of the remote.
	 * @param urlOld The old URL of the remote.
	 * @param urlNew The new URL of the remote.
	 * @param pushUrlOld The old Push URL of the remote.
	 * @param pushUrlNew The new Push URL of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editRemote(repo: string, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(
			['nameOld', nameOld, 'ref'], ['nameNew', nameNew, 'ref'],
			['urlOld', urlOld, 'url'], ['urlNew', urlNew, 'url'],
			['pushUrlOld', pushUrlOld, 'url'], ['pushUrlNew', pushUrlNew, 'url']
		);
		if (unsafeArgs !== null) return unsafeArgs;

		if (nameOld !== nameNew) {
			let status = await this.runGitCommand(['remote', 'rename', nameOld, nameNew], repo);
			if (status !== null) return status;
		}

		if (urlOld !== urlNew) {
			let args = ['remote', 'set-url', nameNew];
			if (urlNew === null) args.push('--delete', urlOld!);
			else if (urlOld === null) args.push('--add', urlNew);
			else args.push(urlNew, urlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		if (pushUrlOld !== pushUrlNew) {
			let args = ['remote', 'set-url', '--push', nameNew];
			if (pushUrlNew === null) args.push('--delete', pushUrlOld!);
			else if (pushUrlOld === null) args.push('--add', pushUrlNew);
			else args.push(pushUrlNew, pushUrlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		return null;
	}

	/**
	 * Prune an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pruneRemote(repo: string, name: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['name', name, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['remote', 'prune', name], repo);
	}


	/* Git Action Methods - Tags */

	/**
	 * Add a new tag to a commit.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param commitHash The hash of the commit the tag should be added to.
	 * @param type Is the tag annotated or lightweight.
	 * @param message The message of the tag (if it is an annotated tag).
	 * @param force Force add the tag, replacing an existing tag with the same name (if it exists).
	 * @returns The ErrorInfo from the executed command.
	 */
	public addTag(repo: string, tagName: string, commitHash: string, type: TagType, message: string, force: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['tagName', tagName, 'ref'], ['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['tag'];
		if (force) {
			args.push('-f');
		}
		if (type === TagType.Lightweight) {
			args.push(tagName);
		} else {
			args.push(getConfig().signTags ? '-s' : '-a', tagName, '-m', message);
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Delete an existing tag from a repository.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param deleteOnRemote The name of the remote to delete the tag on, or NULL.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteTag(repo: string, tagName: string, deleteOnRemote: string | null) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['tagName', tagName, 'ref'], ['deleteOnRemote', deleteOnRemote, 'ref']);
		if (unsafeArgs !== null) return unsafeArgs;

		if (deleteOnRemote !== null) {
			let status = await this.runGitCommand(['push', deleteOnRemote, '--delete', tagName], repo);
			if (status !== null && !status.includes('remote ref does not exist')) return status;
			await this._spawnGit(['update-ref', '-d', 'refs/remotes/' + deleteOnRemote + '/tags/' + tagName], repo, () => {}, true);
		}
		let status = await this.runGitCommand(['tag', '-d', tagName], repo);

		const remotes = await this.getRemotes(repo);
		for (const remote of remotes) {
			if (remote !== deleteOnRemote) {
				await this._spawnGit(['update-ref', '-d', 'refs/remotes/' + remote + '/tags/' + tagName], repo, () => {}, true);
			}
		}

		if (status !== null && status.includes('not found')) return null;
		return status;
	}


	/* Git Action Methods - Remote Sync */

	/**
	 * Fetch from the repositories remote(s).
	 * @param repo The path of the repository.
	 * @param remote The remote to fetch, or NULL (fetch all remotes).
	 * @param prune Is pruning enabled.
	 * @param pruneTags Should tags be pruned.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetch(repo: string, remote: string | null, prune: boolean, pruneTags: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['remote', remote, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['fetch', remote === null ? '--all' : remote];

		if (prune) {
			args.push('--prune');
		}
		if (pruneTags) {
			if (!prune) {
				return Promise.resolve(t('pruneTagsRequiresPrune'));
			} else if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.FetchAndPruneTags)) {
				return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.FetchAndPruneTags, t('featurePruningTagsWhenFetching')));
			}
			args.push('--prune-tags');
		}

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to a remote.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remote The remote to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushBranch(repo: string, branchName: string, remote: string, setUpstream: boolean, mode: GitPushBranchMode) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['remote', remote, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['push'];
		args.push(remote, branchName);
		if (setUpstream) args.push('--set-upstream');
		if (mode !== GitPushBranchMode.Normal) args.push('--' + mode);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to multiple remotes.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remotes The remotes to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushBranchToMultipleRemotes(repo: string, branchName: string, remotes: string[], setUpstream: boolean, mode: GitPushBranchMode): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the branch ' + branchName + ' to.'];
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.pushBranch(repo, branchName, remotes[i], setUpstream, mode);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}

	/**
	 * Push a tag to remote(s).
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag to push.
	 * @param remotes The remote(s) to push the tag to.
	 * @param commitHash The commit hash the tag is on.
	 * @param skipRemoteCheck Skip checking that the tag is on each of the `remotes`.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushTag(repo: string, tagName: string, remotes: string[], commitHash: string, skipRemoteCheck: boolean): Promise<ErrorInfo[]> {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['tagName', tagName, 'ref'], ['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return [unsafeArgs];

		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the tag ' + tagName + ' to.'];
		}

		const unsafeRemotes = remotes.filter((remote) => !isSafeRefName(remote));
		if (unsafeRemotes.length > 0) {
			return ['Invalid reference name was provided for "remotes"'];
		}

		if (!skipRemoteCheck) {
			const remotesContainingCommit = await this.getRemotesContainingCommit(repo, commitHash, remotes).catch(() => remotes);
			const remotesNotContainingCommit = remotes.filter((remote) => !remotesContainingCommit.includes(remote));
			if (remotesNotContainingCommit.length > 0) {
				return [ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote + JSON.stringify(remotesNotContainingCommit)];
			}
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.runGitCommand(['push', remotes[i], tagName], repo);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}


	/* Git Action Methods - Branches */

	/**
	 * Checkout a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to checkout.
	 * @param remoteBranch The name of the remote branch to check out (if not NULL).
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutBranch(repo: string, branchName: string, remoteBranch: string | null) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['remoteBranch', remoteBranch, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['checkout'];
		if (remoteBranch === null) args.push(branchName);
		else args.push('-b', branchName, remoteBranch);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch at a commit.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param commitHash The hash of the commit the branch should be created at.
	 * @param checkout Check out the branch after it is created.
	 * @param force Force create the branch, replacing an existing branch with the same name (if it exists).
	 * @returns The ErrorInfo's from the executed command(s).
	 */
	public async createBranch(repo: string, branchName: string, commitHash: string, checkout: boolean, force: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return [unsafeArgs];

		const args = [];
		if (checkout && !force) {
			args.push('checkout', '-b');
		} else {
			args.push('branch');
			if (force) {
				args.push('-f');
			}
		}
		args.push(branchName, commitHash);

		const statuses = [await this.runGitCommand(args, repo)];
		if (statuses[0] === null && checkout && force) {
			statuses.push(await this.checkoutBranch(repo, branchName, null));
		}
		return statuses;
	}

	/**
	 * Delete a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param force Should force the branch to be deleted (even if not merged).
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteBranch(repo: string, branchName: string, force: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['branch', force ? '-D' : '-d', branchName], repo);
	}

	/**
	 * Delete a remote branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param remote The name of the remote to delete the branch on.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteRemoteBranch(repo: string, branchName: string, remote: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['remote', remote, 'ref']);
		if (unsafeArgs !== null) return unsafeArgs;

		let remoteStatus = await this.runGitCommand(['push', remote, '--delete', branchName], repo);
		if (remoteStatus !== null && (new RegExp('remote ref does not exist', 'i')).test(remoteStatus)) {
			let trackingBranchStatus = await this.runGitCommand(['branch', '-d', '-r', remote + '/' + branchName], repo);
			return trackingBranchStatus === null ? null : 'Branch does not exist on the remote, deleting the remote tracking branch ' + remote + '/' + branchName + '.\n' + trackingBranchStatus;
		}
		return remoteStatus;
	}

	/**
	 * Fetch a remote branch into a local branch.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote containing the remote branch.
	 * @param remoteBranch The name of the remote branch.
	 * @param localBranch The name of the local branch.
	 * @param force Force fetch the remote branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async fetchIntoLocalBranch(repo: string, remote: string, remoteBranch: string, localBranch: string, force: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['remote', remote, 'ref'], ['remoteBranch', remoteBranch, 'ref'], ['localBranch', localBranch, 'ref']);
		if (unsafeArgs !== null) return unsafeArgs;

		const currentBranch = await this.backend.currentBranchName(repo);

		if (currentBranch === localBranch) {
			if (!force) {
				return this.runGitCommand(['pull', remote, remoteBranch], repo);
			}

			const fetchArgs = ['fetch', remote, remoteBranch];
			const fetchResult = await this.runGitCommand(fetchArgs, repo);
			if (fetchResult !== null) {
				return fetchResult;
			}
			return this.runGitCommand(['reset', '--hard', remote + '/' + remoteBranch], repo);
		}

		// If the branch is not checked out, we can use fetch
		const args = ['fetch'];
		if (force) {
			args.push('-f');
		}
		args.push(remote, remoteBranch + ':' + localBranch);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Pull a remote branch into the current branch.
	 * @param repo The path of the repository.
	 * @param branchName The name of the remote branch.
	 * @param remote The name of the remote containing the remote branch.
	 * @param createNewCommit Is `--no-ff` enabled if a merge is required.
	 * @param squash Is `--squash` enabled if a merge is required.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pullBranch(repo: string, branchName: string, remote: string, createNewCommit: boolean, squash: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['branchName', branchName, 'ref'], ['remote', remote, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['pull', remote, branchName], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((pullStatus) => {
			return pullStatus === null && squash
				? this.commitSquashIfStagedChangesExist(repo, remote + '/' + branchName, MergeActionOn.Branch, config.squashPullMessageFormat, config.signCommits)
				: pullStatus;
		});
	}

	/**
	 * Rename a branch in a repository.
	 * @param repo The path of the repository.
	 * @param oldName The old name of the branch.
	 * @param newName The new name of the branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public renameBranch(repo: string, oldName: string, newName: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['oldName', oldName, 'ref'], ['newName', newName, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['branch', '-m', oldName, newName], repo);
	}


	/* Git Action Methods - Branches & Commits */

	/**
	 * Merge a branch or commit into the current branch.
	 * @param repo The path of the repository.
	 * @param obj The object to be merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param createNewCommit Is `--no-ff` enabled.
	 * @param squash Is `--squash` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public merge(repo: string, obj: string, actionOn: MergeActionOn, createNewCommit: boolean, squash: boolean, noCommit: boolean) {
		const unsafeArgs = actionOn === MergeActionOn.Commit
			? DataSource.checkUnsafeGitArgs(['obj', obj, 'hash'])
			: DataSource.checkUnsafeGitArgs(['obj', obj, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['merge', obj], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (noCommit) {
			args.push('--no-commit');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((mergeStatus) => {
			return mergeStatus === null && squash && !noCommit
				? this.commitSquashIfStagedChangesExist(repo, obj, actionOn, config.squashMergeMessageFormat, config.signCommits)
				: mergeStatus;
		});
	}

	/**
	 * Rebase the current branch on a branch or commit.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param actionOn Is the rebase on a branch or commit.
	 * @param ignoreDate Is `--ignore-date` enabled.
	 * @param interactive Should the rebase be performed interactively.
	 * @returns The ErrorInfo from the executed command.
	 */
	public rebase(repo: string, obj: string, actionOn: RebaseActionOn, ignoreDate: boolean, interactive: boolean) {
		const unsafeArgs = actionOn === RebaseActionOn.Branch
			? DataSource.checkUnsafeGitArgs(['obj', obj, 'ref'])
			: DataSource.checkUnsafeGitArgs(['obj', obj, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		if (interactive) {
			// The object is safely quoted so that it cannot escape the argument in the shell
			// command that is sent to the integrated terminal.
			return this.openGitTerminal(
				repo,
				'rebase --interactive ' + (getConfig().signCommits ? '-S ' : '') + (actionOn === RebaseActionOn.Branch ? quoteShellArg(obj) : obj),
				'Rebase on "' + (actionOn === RebaseActionOn.Branch ? obj : abbrevCommit(obj)) + '"'
			);
		} else {
			const args = ['rebase', obj];
			if (ignoreDate) {
				args.push('--ignore-date');
			}
			if (getConfig().signCommits) {
				args.push('-S');
			}
			return this.runGitCommand(args, repo);
		}
	}


	/* Git Action Methods - Branches & Tags */

	/**
	 * Create an archive of a repository at a specific reference, and save to disk.
	 * @param repo The path of the repository.
	 * @param ref The reference of the revision to archive.
	 * @param outputFilePath The file path that the archive should be saved to.
	 * @param type The type of archive.
	 * @returns The ErrorInfo from the executed command.
	 */
	public archive(repo: string, ref: string, outputFilePath: string, type: 'tar' | 'zip') {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['ref', ref, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['archive', '--format=' + type, '-o', outputFilePath, ref], repo);
	}


	/* Git Action Methods - Commits */

	/**
	 * Checkout a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to check out.
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutCommit(repo: string, commitHash: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['checkout', commitHash], repo);
	}

	/**
	 * Cherrypick a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to be cherry picked.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @param recordOrigin Is `-x` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cherrypickCommit(repo: string, commitHash: string, parentIndex: number, recordOrigin: boolean, noCommit: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['cherry-pick'];
		if (noCommit) {
			args.push('--no-commit');
		}
		if (recordOrigin) {
			args.push('-x');
		}
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Drop a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to drop.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropCommit(repo: string, commitHash: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['rebase'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push('--onto', commitHash + '^', commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Reset the current branch to a specified commit.
	 * @param repo The path of the repository.
	 * @param commit The hash of the commit that the current branch should be reset to.
	 * @param resetMode The mode of the reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetToCommit(repo: string, commit: string, resetMode: GitResetMode) {
		if (commit !== 'HEAD') {
			// 'HEAD' is the sentinel used to reset uncommitted changes, and isn't a commit hash
			const unsafeArgs = DataSource.checkUnsafeGitArgs(['commit', commit, 'hash']);
			if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);
		}

		return this.runGitCommand(['reset', '--' + resetMode, commit], repo);
	}

	/**
	 * Revert a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to revert.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @returns The ErrorInfo from the executed command.
	 */
	public revertCommit(repo: string, commitHash: string, parentIndex: number) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		const args = ['revert', '--no-edit'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Undo the last commit in a repository (soft reset to HEAD^).
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo from the executed command.
	 */
	public undoLastCommit(repo: string) {
		return this.runGitCommand(['reset', '--soft', 'HEAD^'], repo);
	}

	/**
	 * Amend the last commit in a repository, keeping the existing commit message and staged changes.
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo from the executed command.
	 */
	public amendLastCommit(repo: string): Promise<ErrorInfo> {
		const args = ['commit', '--amend', '--no-edit'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo);
	}

	/**
	 * Reset the current branch to its upstream (remote tracking) branch, keeping all changes staged (soft reset).
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetCurrentBranchToRemote(repo: string): Promise<ErrorInfo> {
		return this.runGitCommand(['reset', '--soft', '@{upstream}'], repo);
	}

	/**
	 * Get the name of the upstream (remote tracking) branch of the current branch, or NULL if it has none.
	 * @param repo The path of the repository.
	 */
	public async getCurrentBranchUpstream(repo: string): Promise<string | null> {
		return this.backend.getCurrentBranchUpstream(repo).catch(() => null);
	}

	/**
	 * Edit a commit message using git commit --amend.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash to edit.
	 * @param message The new commit message.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editCommitMessage(repo: string, commitHash: string, message: string): Promise<ErrorInfo> {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return unsafeArgs;

		try {
			const headCommit = await this.spawnGit(['rev-parse', 'HEAD'], repo, (stdout) => stdout.trim());

			if (headCommit === commitHash) {
				const args = ['commit', '--amend', '-m', message];
				if (getConfig().signCommits) {
					args.push('-S');
				}
				return this.runGitCommand(args, repo);
			} else {
				return t('editMessageNonHead');
			}
		} catch (error) {
			return error as ErrorInfo;
		}
	}


	/* Git Action Methods - Config */

	/**
	 * Set a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be set.
	 * @param value The value to be set.
	 * @param location The location where the configuration value should be set.
	 * @returns The ErrorInfo from the executed command.
	 */
	public setConfigValue(repo: string, key: GitConfigKey, value: string, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, key, value], repo);
	}

	/**
	 * Unset a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be unset.
	 * @param location The location where the configuration value should be unset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public unsetConfigValue(repo: string, key: GitConfigKey, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, '--unset-all', key], repo);
	}


	/* Git Action Methods - Uncommitted */

	/**
	 * Clean the untracked files in a repository.
	 * @param repo The path of the repository.
	 * @param directories Is `-d` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cleanUntrackedFiles(repo: string, directories: boolean) {
		return this.runGitCommand(['clean', '-f' + (directories ? 'd' : '')], repo);
	}


	/* Git Action Methods - File */

	/**
	 * Reset a file to the specified revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit to reset the file to.
	 * @param filePath The file to reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetFileToRevision(repo: string, commitHash: string, filePath: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['commitHash', commitHash, 'hash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['checkout', commitHash, '--', filePath], repo);
	}


	/* Git Action Methods - Stash */

	/**
	 * Apply a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public applyStash(repo: string, selector: string, reinstateIndex: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['selector', selector, 'stash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['stash', 'apply'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch from a stash.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param branchName The name of the branch to be created.
	 * @returns The ErrorInfo from the executed command.
	 */
	public branchFromStash(repo: string, selector: string, branchName: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['selector', selector, 'stash'], ['branchName', branchName, 'ref']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['stash', 'branch', branchName, selector], repo);
	}

	/**
	 * Drop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropStash(repo: string, selector: string) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['selector', selector, 'stash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return this.runGitCommand(['stash', 'drop', selector], repo);
	}

	/**
	 * Pop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public popStash(repo: string, selector: string, reinstateIndex: boolean) {
		const unsafeArgs = DataSource.checkUnsafeGitArgs(['selector', selector, 'stash']);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		let args = ['stash', 'pop'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push the uncommitted changes to a stash.
	 * @param repo The path of the repository.
	 * @param message The message of the stash.
	 * @param includeUntracked Is `--include-untracked` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushStash(repo: string, message: string, includeUntracked: boolean): Promise<ErrorInfo> {
		if (this.gitExecutable === null) {
			return Promise.resolve(unableToFindGitMsg());
		} else if (!doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.PushStash)) {
			return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.PushStash));
		}

		let args = ['stash', 'push'];
		if (includeUntracked) args.push('--include-untracked');
		if (message !== '') args.push('--message', message);
		return this.runGitCommand(args, repo);
	}


	/* Public Utils */

	/**
	 * Opens an external directory diff for the specified commits.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the diff is from.
	 * @param toHash The commit hash the diff is to.
	 * @param isGui Is the external diff tool GUI based.
	 * @returns The ErrorInfo from the executed command.
	 */
	public openExternalDirDiff(repo: string, fromHash: string, toHash: string, isGui: boolean) {
		// The hashes are interpolated into a shell command sent to the integrated terminal when the
		// external diff tool is not GUI based, so they must be validated to prevent command injection.
		const unsafeArgs = DataSource.checkUnsafeGitArgs(
			['fromHash', fromHash === UNCOMMITTED ? null : fromHash, 'hash'],
			['toHash', toHash === UNCOMMITTED ? null : toHash, 'hash']
		);
		if (unsafeArgs !== null) return Promise.resolve(unsafeArgs);

		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(unableToFindGitMsg());
			} else {
				const args = ['difftool', '--dir-diff'];
				const config = getConfig(repo);
				if (config.extDiffToolArgs && config.extDiffToolArgs.length > 0) {
					args.push(...config.extDiffToolArgs);
				}
				if (isGui) {
					args.push('-g');
				}
				if (fromHash === toHash) {
					if (toHash === UNCOMMITTED) {
						args.push('HEAD');
					} else {
						args.push(toHash + '^..' + toHash);
					}
				} else {
					if (toHash === UNCOMMITTED) {
						args.push(fromHash);
					} else {
						args.push(fromHash + '..' + toHash);
					}
				}
				if (isGui) {
					this.logger.log('External diff tool is being opened (' + args[args.length - 1] + ')');
					this.runGitCommand(args, repo).then((errorInfo) => {
						this.logger.log('External diff tool has exited (' + args[args.length - 1] + ')');
						if (errorInfo !== null) {
							const errorMessage = errorInfo.replace(EOL_REGEX, ' ');
							this.logger.logError(errorMessage);
							showErrorMessage(errorMessage);
						}
					});
				} else {
					openGitTerminal(repo, this.gitExecutable.path, args.join(' '), t('openExternalDirDiffTerminalName'));
				}
				setTimeout(() => resolve(null), 1500);
			}
		});
	}

	/**
	 * Open a new terminal, set up the Git executable, and optionally run a command.
	 * @param repo The path of the repository.
	 * @param command The command to run.
	 * @param name The name for the terminal.
	 * @returns The ErrorInfo from opening the terminal.
	 */
	public openGitTerminal(repo: string, command: string | null, name: string) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(unableToFindGitMsg());
			} else {
				openGitTerminal(repo, this.gitExecutable.path, command, name);
				setTimeout(() => resolve(null), 1000);
			}
		});
	}


	/* Private Data Providers */

	/**
	 * Get the full commit message bodies of a batch of commits, on demand (the commit list only
	 * carries subjects, so bodies are only fetched when they are actually displayed).
	 * @param repo The path of the repository.
	 * @param commitHashes The hashes of the commits (validated, as they arrive from the webview).
	 * @returns A hash -> full message body mapping.
	 */
	public getCommitBodies(repo: string, commitHashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }> {
		const hashes = commitHashes.filter((hash) => isValidCommitHash(hash));
		if (hashes.length === 0) return Promise.resolve({});
		return this.backend.getCommitBodies(repo, hashes);
	}


	/**
	 * Get the configuration list of a repository.
	 * @param repo The path of the repository.
	 * @param location The location of the configuration to be listed.
	 * @returns A set of key-value pairs of Git configuration records.
	 */
	private getConfigList(repo: string, location?: GitConfigLocation): Promise<GitConfigSet> {
		return this.backend.getConfigList(repo, location === GitConfigLocation.Global ? 'global' : 'local');
	}

	/**
	 * Count the commits reachable from the currently shown refs but NOT from the given hash, i.e.
	 * the number of commits newer than it. Used by the webview to jump directly to a pinned commit
	 * with a single loadCommits request instead of paging through the history. The count
	 * deliberately ignores the author / path filters, so it is an upper bound of the commit's
	 * position in the view — loading this many commits is always sufficient to include it.
	 * @param repo The path of the repository.
	 * @param branches The currently shown branches, or NULL (show all).
	 * @param hash The full hash of the commit to jump to.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param includeCommitsMentionedByReflogs Are commits mentioned by reflogs shown.
	 * @returns The number of commits before the hash, or NULL if the hash is unknown to Git.
	 */
	public countCommitsBefore(repo: string, branches: ReadonlyArray<string> | null, hash: string, showRemoteBranches: boolean, includeCommitsMentionedByReflogs: boolean): Promise<number | null> {
		const refs = branches === null ? null : branches.filter((branch) => isSafeRefName(branch) || isValidCommitHash(branch) || branch.startsWith('--glob='));
		return this.backend.countCommitsBefore(repo, refs, hash, showRemoteBranches, includeCommitsMentionedByReflogs).catch(() => <number | null>null);
	}






	/**
	 * Get all of the remotes that contain the specified commit hash.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash to test.
	 * @param knownRemotes The list of known remotes to check for.
	 * @returns A promise resolving to a list of remote names.
	 */
	private getRemotesContainingCommit(repo: string, commitHash: string, knownRemotes: string[]) {
		return this.spawnGit(['branch', '-r', '--no-color', '--contains=' + commitHash], repo, (stdout) => {
			// Get the names of all known remote branches that contain commitHash
			const branchNames = stdout.split(EOL_REGEX)
				.filter((line) => line.length > 2)
				.map((line) => line.substring(2).split(' -> ')[0])
				.filter((branchName) => !INVALID_BRANCH_REGEXP.test(branchName));

			// Get all the remotes that are the prefix of at least one remote branch name
			return knownRemotes.filter((knownRemote) => {
				const knownRemotePrefix = knownRemote + '/';
				return branchNames.some((branchName) => branchName.startsWith(knownRemotePrefix));
			});
		});
	}


	/**
	 * Get the names of the remotes of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of remote names.
	 */
	private getRemotes(repo: string) {
		return this.backend.getRemotes(repo).then((remotes) => [...remotes]);
	}

	/**
	 * Get the number of uncommitted changes in a repository.
	 * @param repo The path of the repository.
	 * @returns The number of uncommitted changes.
	 */
	public getUncommittedChanges(repo: string) {
		return this.backend.getUncommittedChangeCount(repo, getConfig().showUntrackedFiles);
	}



	/* Private Utils */

	/**
	 * Check if there are staged changes that resulted from a squash merge, and if so, commit them.
	 * @param repo The path of the repository.
	 * @param obj The object being squash merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param squashMessageFormat The format to be used in the commit message of the squash.
	 * @returns The ErrorInfo from the executed command.
	 */
	private commitSquashIfStagedChangesExist(repo: string, obj: string, actionOn: MergeActionOn, squashMessageFormat: SquashMessageFormat, signCommits: boolean): Promise<ErrorInfo> {
		return this.areStagedChanges(repo).then((changes) => {
			if (changes) {
				const args = ['commit'];
				if (signCommits) {
					args.push('-S');
				}
				if (squashMessageFormat === SquashMessageFormat.Default) {
					args.push('-m', 'Merge ' + actionOn.toLowerCase() + ' \'' + obj + '\'');
				} else {
					args.push('--no-edit');
				}
				return this.runGitCommand(args, repo);
			} else {
				return null;
			}
		});
	}

	/**
	 * Run a Git command (typically for a Git Graph View action).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @returns The returned ErrorInfo (suitable for being sent to the Git Graph View).
	 */
	public runGitCommand(args: string[], repo: string): Promise<ErrorInfo> {
		// Any of these commands may change the repository's refs, so the cached ref read is dropped
		this.invalidateRefCache(repo);
		return this._spawnGit(args, repo, () => null).catch((errorMessage: string) => errorMessage);
	}

	/**
	 * Run a Git command that reads a command stream from its standard input (e.g.
	 * `git update-ref --stdin`, used to batch many ref updates into a single Git process).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param input The command stream to write to the standard input of the Git process.
	 * @returns The returned ErrorInfo (suitable for being sent to the Git Graph View).
	 */
	public runGitCommandWithInput(args: string[], repo: string, input: string): Promise<ErrorInfo> {
		// Any of these commands may change the repository's refs, so the cached ref read is dropped
		this.invalidateRefCache(repo);
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				return resolve(unableToFindGitMsg());
			}

			const cmd = cp.spawn(this.gitExecutable.path, args, {
				cwd: repo,
				env: Object.assign({}, process.env, this.askpassEnv)
			});
			let stderr = '';
			cmd.stderr.on('data', (d: Buffer) => { stderr += d; });
			cmd.on('error', (error) => resolve(error.message));
			cmd.on('close', (code) => resolve(code === 0 ? null : getErrorMessage(null, Buffer.alloc(0), stderr)));
			cmd.stdin.on('error', () => { /* ignore EPIPE: the command already failed */ });
			cmd.stdin.end(input);

			this.logger.logCmd('git', args);
		});
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a string (public wrapper used by the Git Graph View).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout`.
	 */
	public gitOutput<T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) {
		return this._spawnGit(args, repo, (stdout) => resolveValue(stdout.toString()));
	}

	/**
	 * Spawn Git for a streaming read: unlike the buffered helpers, the caller consumes the
	 * child's `stdout` directly and destroys the process when done. Used by the hex comparison
	 * view to read byte ranges of large blobs without ever buffering a whole blob.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @returns The spawned Git child process.
	 */
	public spawnGitStream(args: string[], repo: string): cp.ChildProcess {
		if (this.gitExecutable === null) {
			throw new Error(unableToFindGitMsg());
		}
		const child = cp.spawn(this.gitExecutable.path, args, {
			cwd: repo,
			env: Object.assign({}, process.env, this.askpassEnv)
		});
		this.logger.logCmd('git', args);
		return child;
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a string.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout`.
	 */
	private spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) {
		return this.gitOutput(args, repo, resolveValue);
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a buffer.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout` and `stderr`.
	 * @param ignoreExitCode Ignore the exit code returned by Git (default: `FALSE`).
	 */
	private _spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: Buffer, stderr: string): T }, ignoreExitCode: boolean = false) {
		return new Promise<T>((resolve, reject) => {
			if (this.gitExecutable === null) {
				return reject(unableToFindGitMsg());
			}

			// The command is logged with how long it took, once it has finished: that duration is
			// what makes the opt-in session log analysable for performance (scripts/analyze-log.mjs).
			const started = Date.now();
			resolveSpawnOutput(cp.spawn(this.gitExecutable.path, args, {
				cwd: repo,
				env: Object.assign({}, process.env, this.askpassEnv)
			})).then((values) => {
				this.logger.logCmd('git', args, Date.now() - started);
				const status = values[0], stdout = values[1], stderr = values[2];
				if (status.code === 0 || ignoreExitCode) {
					resolve(resolveValue(stdout, stderr));
				} else {
					reject(getErrorMessage(status.error, stdout, stderr));
				}
			});
		});
	}
}


/**
 * Get the specified config value from a set of key-value config pairs.
 * @param configs A set key-value pairs of Git configuration records.
 * @param key The key of the desired config.
 * @returns The value for `key` if it exists, otherwise NULL.
 */
function getConfigValue(configs: GitConfigSet, key: string) {
	return typeof configs[key] !== 'undefined' ? configs[key] : null;
}

/**
 * Produce a suitable error message from a spawned Git command that terminated with an erroneous status code.
 * @param error An error generated by JavaScript (optional).
 * @param stdoutBuffer A buffer containing the data outputted to `stdout`.
 * @param stderr A string containing the data outputted to `stderr`.
 * @returns A suitable error message.
 */
function getErrorMessage(error: Error | null, stdoutBuffer: Buffer, stderr: string) {
	let stdout = stdoutBuffer.toString(), lines: string[];
	if (stdout !== '' || stderr !== '') {
		lines = (stderr + stdout).split(EOL_REGEX);
		lines.pop();
	} else if (error) {
		lines = error.message.split(EOL_REGEX);
	} else {
		lines = [];
	}
	return lines.join('\n');
}


/* Types */

interface GitBranchData {
	branches: string[];
	head: string | null;
	error: ErrorInfo;
}

export interface GitCommitData {
	commits: GitCommit[];
	head: string | null;
	tags: string[];
	moreCommitsAvailable: boolean;
	error: ErrorInfo;
}

export interface GitCommitDetailsData {
	commitDetails: GitCommitDetails | null;
	error: ErrorInfo;
}

interface GitCommitComparisonData {
	fileChanges: GitFileChange[];
	error: ErrorInfo;
}

export interface GitCommitFileCountsData {
	counts: { [path: string]: GitLineCounts };
	error: ErrorInfo;
}

type GitConfigSet = { [key: string]: string };

interface GitRepoInfo extends GitBranchData {
	remotes: string[];
	stashes: GitStash[];
	tags: string[];
}

interface GitRepoConfigData {
	config: GitRepoConfig | null;
	error: ErrorInfo;
}

interface GitTagDetailsData {
	details: GitTagDetails | null;
	error: ErrorInfo;
}
