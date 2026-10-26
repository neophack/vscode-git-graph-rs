import * as vscode from 'vscode';
import type { AvatarManager } from '../integrations/avatars/avatarManager';
import type { ExtensionState } from '../platform/storage';
import { getConfig } from '../platform/config';
import { t } from '../platform/i18n';
import type { Logger } from '../platform/logger';
import { unableToFindGitMsg } from '../git/executable/findGit';
import { detectTerminalShellKind, openGitTerminal, quoteForShell } from '../git/process/childProcess';
import {
	copyFilePathToClipboard, copyToClipboard, createPullRequest, openExtensionSettings,
	openExternalUrl, resolveDiffFromHash, showErrorMessage, uiPort, viewDiff, viewFileAtRevision, viewScm
} from '../platform/actions';
import { doesFileExist } from '../platform/paths';
import type { RepoManager } from '../repos/repoManager';
import type { ProductionGitRepository } from '../git/gitRepository';
import { GitConfigKey, setConfigValue, unsetConfigValue } from '../git/write/ops/config';
import { archive as archiveOp } from '../git/write/ops/commits';
import { isSafeRefName, isValidCommitHash } from '../git/write/argSafety';
import type { LogOptions, RefReadOptions } from '../git/read/types';
import { UNCOMMITTED } from '../git/read/types';
import type { CommitDataPort, CommitLoadQuery } from './commitLoader';
import type { RepoInfoHalf } from './commitLoader';
import { CommitLoader } from './commitLoader';
import { hostScheduler } from './scheduler';
import type { HostScheduler } from './scheduler';
import { GerritDataSource } from '../integrations/gerrit/gerrit';
import type { GerritChangeState } from '../../shared/model/gerrit';
import type { ErrorInfo } from '../../shared/protocol/messages';
import type { GitStash } from '../../shared/model/git';
import type { PullRequestInfo } from '../../shared/model/pullRequest';
import { GitFileStatus } from '../../shared/model/git';
import type { LegacyViewPort } from './gitRunner';
import type { GitRunnerPort } from './gitRunner';
import { saveGlobalSetting } from './globalSettings';
import type {
	AvatarPort, GerritWritesPort, GlobalSettingsPort, PullRequestsPort, RefreshIdKind, ReposPort, StoragePort, UiPort,
	UserConfigPort, ViewPort
} from './handlers/context';
import type { PullRequestRemote } from './handlers/context';
import { fetchPullRequestHeadRefs, fetchPullRequests } from './pullRequestFetch';
import type { PullRequestFetchDeps } from './pullRequestFetch';
import { UncommittedCountStabiliser } from './uncommittedStabiliser';
import { RepoConfigCache } from './repoReads';

/**
 * The production implementations of the HandlerContext's ports (REFACTOR-PLAN task 4.4 + 3.6):
 * thin adapters over the collaborators the Panel already owns — the `GitRepository` facade and
 * its raw runner (the git layer the composition root composed), the ExtensionState, the
 * AvatarManager, the RepoManager, the utils/actions helpers and the auxiliary view controllers —
 * so the handler table runs against the real thing while staying substitutable in tests. Each
 * port moves to its future module (platform/storage, extension/repos, integrations/*,
 * platform/config) as those land.
 */

/** The Panel collaborators the ports adapt. */
export interface PanelPortDeps {
	/** The repository facade: the read backend + the GitWriter (task 3.6). */
	readonly repo: ProductionGitRepository;
	/** The raw Git runner over the same GitProcess the writer runs on. */
	readonly git: GitRunnerPort;
	/** The two auxiliary webviews, still on the legacy DataSource (composed in extension.ts). */
	readonly legacyViews: LegacyViewPort;
	readonly extensionState: ExtensionState;
	readonly avatarManager: AvatarManager;
	readonly repoManager: RepoManager;
	readonly logger: Logger;
	readonly extensionPath: string;
	/** The shared pull-request data source (HTTP + parsing; owned by the Panel). */
	readonly pullRequests: { getPullRequests(url: string): Promise<{ prs: PullRequestInfo[], complete: boolean } | null> };
	/** The repository the view currently shows (the working directory of the Git invocations). */
	currentRepo(): string | null;
}

/** The port implementations the Panel assembles its HandlerContext from. */
export interface PanelPorts {
	readonly ui: UiPort;
	readonly avatars: AvatarPort;
	readonly storage: StoragePort;
	readonly repos: ReposPort;
	readonly userConfig: UserConfigPort;
	readonly settings: GlobalSettingsPort;
	readonly pullRequests: PullRequestsPort;
	/** The composed, cached repository configuration the loadConfig handler reads. */
	readonly repoConfig: RepoConfigCache;
	/** The Gerrit write of the integration's disable flow (the batched `update-ref --stdin`). */
	readonly gerrit: GerritWritesPort;
}

/**
 * Build the production ports over the Panel's collaborators. Pure wiring: every member is a
 * closure over {@link deps}; the only constructed objects are the configuration cache and the
 * Gerrit integration over the shared runner.
 */
export function createPanelPorts(deps: PanelPortDeps): PanelPorts {
	const repoConfig = new RepoConfigCache(() => deps.repo.read);
	const prDeps: PullRequestFetchDeps = {
		gitOutput: (args, repo, resolveValue) => deps.git.gitOutput(args, repo, resolveValue),
		loadPullRequests: (url) => deps.pullRequests.getPullRequests(url),
		isEnabled: () => getConfig().pullRequests.enabled,
		logger: deps.logger
	};
	// The Gerrit integration over the shared runner. Its `GitRunner` seam predates the engine fast
	// paths' array shapes, so the engine results are adapted to the Maps it consumes; with no
	// engine loaded the members are absent and its own Git CLI fallbacks serve those reads.
	const engineMetas = deps.git.parseGerritMetas;
	const engineChangeRefs = deps.git.listChangeRefs;
	const gerrit = new GerritDataSource({
		gitOutput: deps.git.gitOutput,
		runGitCommand: deps.git.runGitCommand,
		runGitCommandWithInput: deps.git.runGitCommandWithInput,
		parseGerritMetas: engineMetas === null ? undefined : async (repo, remote, changes, urlBase) => {
			const states = await engineMetas(repo, remote, changes, urlBase);
			const parsed = new Map<number, GerritChangeState | null>();
			states.forEach((state, index) => parsed.set(changes[index], state));
			return parsed;
		},
		listChangeRefHashes: engineChangeRefs === null ? undefined : async (repo, remote) => {
			const refs = await engineChangeRefs(repo, remote);
			const hashes = new Map<string, string>();
			for (const [ref, hash] of refs) hashes.set(ref, hash);
			return hashes;
		}
	});

	return {
		ui: {
			showErrorMessage: (message) => showErrorMessage(message),
			viewScm: () => viewScm(),
			openExternalUrl: (url) => openExternalUrl(url),
			openExtensionSettings: () => openExtensionSettings(),
			openLogFile: () => openLogFile(deps.logger),
			copyToClipboard: (text) => copyToClipboard(text),
			copyFilePathToClipboard: (repo, filePath, absolute) => copyFilePathToClipboard(repo, filePath, absolute),
			viewDiff: (repo, fromHash, toHash, oldFilePath, newFilePath, type) => viewDiff(repo, fromHash, toHash, oldFilePath, newFilePath, type),
			viewDiffWithWorkingFile: async (repo, hash, filePath) => {
				let newFilePath = filePath;
				let fileExists = await doesFileExist(repo + '/' + newFilePath);
				if (!fileExists) {
					const renamedFilePath = await deps.repo.read.getNewPathOfRenamedFile(repo, hash, filePath).catch(() => null);
					if (renamedFilePath !== null && await doesFileExist(repo + '/' + renamedFilePath)) {
						newFilePath = renamedFilePath;
						fileExists = true;
					}
				}
				const type = fileExists
					? (filePath === newFilePath ? GitFileStatus.Modified : GitFileStatus.Renamed)
					: GitFileStatus.Deleted;
				return viewDiff(repo, hash, UNCOMMITTED, filePath, newFilePath, type);
			},
			viewFileAtRevision: (repo, hash, filePath) => viewFileAtRevision(repo, hash, filePath),
			openFile: (repo, filePath, hash) => openFileResolvingRenames(deps.repo, repo, filePath, hash),
			createArchive: (repo, ref) => createArchive(deps.repo, repo, ref),
			createPullRequest: (config, sourceOwner, sourceRepo, sourceBranch) => createPullRequest(config, sourceOwner, sourceRepo, sourceBranch),
			setInterfaceLanguage: (language) => setInterfaceLanguage(deps.logger, language),
			openCompareTab: (repo, fromHash, toHash, singleCommit) => {
				deps.legacyViews.openCompareTab(deps.extensionPath, repo, fromHash, toHash, singleCommit);
			},
			viewDiffBinary: (repo, fromHash, toHash, oldFilePath, newFilePath, type) => {
				// The native Diff View can't show a binary/image file (both panes would be empty):
				// the same standalone tab the Commit Comparison View opens for one does
				deps.legacyViews.openBinaryCompare(deps.extensionPath, repo, resolveDiffFromHash(fromHash, toHash), toHash, {
					oldFilePath: oldFilePath, newFilePath: newFilePath, type: type, additions: null, deletions: null
				});
			},
			openGitTerminal: (repo, command, name) => openTerminalAt(deps.git, repo, command, name),
			openExternalDirDiff: (repo, fromHash, toHash, isGui) => openExternalDirDiff(deps.git, deps.logger, repo, fromHash, toHash, isGui),
			quoteForTerminal: (obj) => quoteForShell(obj, detectTerminalShellKind())
		},
		avatars: {
			fetchAvatarImage: (email, repo, remote, commits) => deps.avatarManager.fetchAvatarImage(email, repo, remote, commits),
			getAvatarImage: (email) => deps.avatarManager.getAvatarImage(email)
		},
		storage: {
			getCodeReview: (repo, id) => deps.extensionState.getCodeReview(repo, id),
			startCodeReview: (repo, id, files, lastViewedFile) => deps.extensionState.startCodeReview(repo, id, files, lastViewedFile),
			updateCodeReview: (repo, id, remainingFiles, lastViewedFile) => deps.extensionState.updateCodeReview(repo, id, remainingFiles, lastViewedFile),
			endCodeReview: (repo, id) => deps.extensionState.endCodeReview(repo, id),
			setGlobalViewState: (state) => deps.extensionState.setGlobalViewState(state),
			setWorkspaceViewState: (state) => deps.extensionState.setWorkspaceViewState(state),
			setViewSnapshot: (snapshot) => deps.extensionState.setViewSnapshot(snapshot),
			getLastActiveRepo: () => deps.extensionState.getLastActiveRepo()
		},
		repos: {
			getRepos: () => deps.repoManager.getRepos(),
			checkReposExist: () => deps.repoManager.checkReposExist(),
			setRepoState: (repo, state) => deps.repoManager.setRepoState(repo, state),
			exportRepoConfig: (repo) => deps.repoManager.exportRepoConfig(repo),
			rescanForRepos: async () => {
				if (!(await deps.repoManager.searchWorkspaceForRepos())) {
					showErrorMessage(t('noReposInWorkspace'));
				}
			}
		},
		userConfig: {
			setUserName: (repo, name, location) => deps.repo.write.run(repo, setConfigValue({ key: GitConfigKey.UserName, value: name, location: location })),
			setUserEmail: (repo, email, location) => deps.repo.write.run(repo, setConfigValue({ key: GitConfigKey.UserEmail, value: email, location: location })),
			unsetUserName: (repo, location) => deps.repo.write.run(repo, unsetConfigValue({ key: GitConfigKey.UserName, location: location })),
			unsetUserEmail: (repo, location) => deps.repo.write.run(repo, unsetConfigValue({ key: GitConfigKey.UserEmail, location: location })),
			invalidateConfig: (repo) => repoConfig.invalidate(repo)
		},
		settings: {
			setGlobalSetting: (setting, value, previousValue) => saveGlobalSetting({
				repo: deps.repo,
				repoConfig: repoConfig,
				state: deps.extensionState,
				currentRepo: deps.currentRepo,
				logger: deps.logger
			}, setting, value, previousValue)
		},
		pullRequests: {
			// Background jobs of the host scheduler (task 4.8): one at a time, yielded by any
			// interactive request. The head-ref fetch runs Git writes; an abandonment severs the
			// DELIVERY only, so a fetch already talking to Git still completes.
			fetchPullRequests: (repo) => hostScheduler.run('pr:' + repo, 'background', () => fetchPullRequests(prDeps, repo)),
			fetchPullRequestHeadRefs: (repo: string, remote: PullRequestRemote) => hostScheduler.run('prRefs:' + repo, 'background', () => fetchPullRequestHeadRefs(prDeps, repo, remote))
		},
		repoConfig: repoConfig,
		gerrit: {
			clearLocalChanges: (repo, remote) => gerrit.clearLocalChanges(repo, remote)
		}
	};
}

/* ---------- The staged commit loader's production reads (tasks 4.3 / 4.7 / 4.8) ---------- */

/**
 * The CommitDataPort over the repository facade — the one port both the staged loader and the
 * write-path impact refresh (task 4.8) read through: page walks, the uncommitted count, the
 * repo-info half, the operation state, and the refs-only reads (`getRefSnapshot` / `annotate`)
 * whose engine requests answer a refs-only refresh without any traversal.
 */
export function createLoaderReads(repo: ProductionGitRepository): CommitDataPort {
	return {
		getCommits: (repoPath, query, signal) => repo.read.getCommits(repoPath, logOptionsOf(query), signal),
		getUncommittedChanges: (repoPath) => repo.read.getUncommittedChangeCount(repoPath, getConfig().showUntrackedFiles),
		getRepoInfo: (repoPath, options) => loadRepoInfoHalf(repo, repoPath, options),
		getOperationState: (repoPath) => repo.getOperationState(repoPath),
		getRefSnapshot: (repoPath, options) => repo.read.getRefSnapshot(repoPath, options),
		annotate: (repoPath, commits, options) => repo.read.annotate(repoPath, commits, options)
	};
}

/**
 * The staged commit loader over the repository facade: the commit-page cache, the Gerrit pipeline
 * and the uncommitted-changes stabiliser, reading through `repo.read` (the log options the legacy
 * getCommits assembled by hand are the read layer's `LogOptions` now) and the configuration at
 * load time exactly as the live inline pipeline did. The uncommitted row's message arrives
 * injected (`t` would drag the vscode-dependent config module into the loader), as do the clock
 * and the sleep the confirm loop re-checks under. The reads port is injectable so the panel can
 * share ONE port with the impact refresh; the scheduler (task 4.8) routes the page reads as
 * interactive jobs and the follow-ups as background ones.
 */
export function createCommitLoader(repo: ProductionGitRepository, git: GitRunnerPort, logger: Logger, reads: CommitDataPort = createLoaderReads(repo), scheduler: HostScheduler = hostScheduler): CommitLoader {
	const gerrit = gerritDataSourceFor(git);
	return new CommitLoader({
		reads: reads,
		gerrit: {
			listRemoteChanges: (repoPath, remote) => gerrit.listRemoteChanges(repoPath, remote),
			fetchChanges: (repoPath, remote, refspecs) => gerrit.fetchChanges(repoPath, remote, refspecs.slice()),
			listLocalChangeRefs: (repoPath, remote) => gerrit.listLocalChangeRefs(repoPath, remote),
			pruneLocalChanges: (repoPath, remote, keepChanges) => gerrit.pruneLocalChanges(repoPath, remote, keepChanges),
			parseMetas: (repoPath, remote, changes, urlBase) => gerrit.parseMetas(repoPath, remote, changes, urlBase),
			getChangeUrlBase: (repoPath, remote) => gerrit.getChangeUrlBase(repoPath, remote)
		},
		getConfig: () => {
			const config = getConfig();
			return {
				showUncommittedChanges: config.showUncommittedChanges,
				showRemoteHeads: config.showRemoteHeads,
				gerrit: { remote: config.gerrit.remote, fetchLimit: config.gerrit.fetchLimit }
			};
		},
		logger: logger,
		formatUncommittedRow: (count) => t('uncommittedChangesRow', count),
		stabiliser: new UncommittedCountStabiliser(PANEL_UNCOMMITTED_ZERO_CONFIRM_MS, PANEL_UNCOMMITTED_RECHECK_MS),
		now: () => Date.now(),
		sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		scheduler: scheduler
	});
}

/** The Gerrit data source the loader's pipeline runs over (adapted onto the facade's runner). */
function gerritDataSourceFor(git: GitRunnerPort): GerritDataSource {
	const engineMetas = git.parseGerritMetas;
	const engineChangeRefs = git.listChangeRefs;
	return new GerritDataSource({
		gitOutput: git.gitOutput,
		runGitCommand: git.runGitCommand,
		runGitCommandWithInput: git.runGitCommandWithInput,
		parseGerritMetas: engineMetas === null ? undefined : async (repo, remote, changes, urlBase) => {
			const states = await engineMetas(repo, remote, changes, urlBase);
			const parsed = new Map<number, GerritChangeState | null>();
			states.forEach((state, index) => parsed.set(changes[index], state));
			return parsed;
		},
		listChangeRefHashes: engineChangeRefs === null ? undefined : async (repo, remote) => {
			const refs = await engineChangeRefs(repo, remote);
			const hashes = new Map<string, string>();
			for (const [ref, hash] of refs) hashes.set(ref, hash);
			return hashes;
		}
	});
}

/** The open-path merged read of one repository: the repo-info half with its existence check and operation state. */
async function loadRepoInfoHalf(repo: ProductionGitRepository, repoPath: string, options: RefReadOptions): Promise<RepoInfoHalf> {
	const [info, operationState] = await Promise.all([
		repo.read.getRepoInfo(repoPath, options).then(
			(i) => ({ branches: i.branches, head: i.head, remotes: i.remotes, stashes: i.stashes, tags: i.tags, error: i.error }),
			(errorMessage: unknown) => ({
				branches: [] as ReadonlyArray<string>, head: null as string | null, remotes: [] as ReadonlyArray<string>,
				stashes: [] as ReadonlyArray<GitStash>, tags: [] as ReadonlyArray<string>,
				error: errorMessage instanceof Error ? errorMessage.message : String(errorMessage)
			})
		),
		repo.getOperationState(repoPath)
	]);
	let isRepo = true;
	if (info.error !== null) {
		isRepo = await repo.read.repoRoot(repoPath).then(() => true, () => false);
		if (!isRepo) info.error = null;
	}
	return { ...info, isRepo: isRepo, operationState: operationState };
}

/** Map the loader's commit-page query onto the read layer's `LogOptions` (the legacy branch filtering included). */
function logOptionsOf(query: CommitLoadQuery): LogOptions {
	// Branch names arrive from the webview: drop any that Git could misread as an option. Custom
	// Branch Glob Patterns are the one legitimate exception (a single `--glob=<pattern>` token).
	const branches = query.branches === null
		? null
		: query.branches.filter((branch) => isSafeRefName(branch) || isValidCommitHash(branch) || branch.startsWith('--glob='));
	const config = getConfig();
	return {
		branches: branches !== null ? [...branches] : null,
		authors: query.authors,
		maxCommits: query.maxCommits,
		showTags: query.showTags,
		showRemoteBranches: query.showRemoteBranches,
		showRemoteHeads: config.showRemoteHeads,
		includeCommitsMentionedByReflogs: query.includeCommitsMentionedByReflogs,
		onlyFollowFirstParent: query.onlyFollowFirstParent,
		commitOrdering: query.commitOrdering,
		remotes: query.remotes,
		hideRemotes: query.hideRemotes,
		gerritRefs: query.gerritRefs,
		gerritShowChangeRefs: false,
		// The filter arrives as one comma-separated string: split it, so filtering by several
		// files asks about several paths (paths containing commas are unsupported by the syntax).
		filterPaths: query.filterPath !== null ? query.filterPath.split(',').filter((p) => p !== '') : undefined,
		deferUncommittedChanges: query.deferUncommittedChanges,
		deferRemoteRefs: query.deferRemoteRefs,
		showUncommittedChanges: config.showUncommittedChanges,
		showUntrackedFiles: config.showUntrackedFiles,
		showCommitsOnlyReferencedByTags: config.showCommitsOnlyReferencedByTags,
		useMailmap: config.useMailmap
	};
}

/* ---------- The ui port's platform flows ---------- */

/** Open a file of the repository, resolving a rename through the backend when the file is gone. */
async function openFileResolvingRenames(repo: ProductionGitRepository, repoPath: string, filePath: string, hash: string): Promise<ErrorInfo> {
	let newFilePath = filePath;
	let fileExists = await doesFileExist(repoPath + '/' + newFilePath);
	if (!fileExists) {
		const renamedFilePath = await repo.read.getNewPathOfRenamedFile(repoPath, hash, filePath).catch(() => null);
		if (renamedFilePath !== null && await doesFileExist(repoPath + '/' + renamedFilePath)) {
			newFilePath = renamedFilePath;
			fileExists = true;
		}
	}
	if (fileExists) {
		return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(repoPath + '/' + newFilePath), {
			preview: true,
			viewColumn: getConfig().openNewTabEditorGroup
		}).then(
			() => null,
			() => t('openFileFailed', newFilePath)
		);
	}
	return t('fileNotInRepo', newFilePath);
}

/** Open the integrated terminal at `repo` (the legacy DataSource.openGitTerminal). */
async function openTerminalAt(git: GitRunnerPort, repo: string, command: string | null, name: string): Promise<ErrorInfo> {
	const gitPath = git.gitPath();
	if (gitPath === null) return unableToFindGitMsg();
	openGitTerminal(repo, gitPath, command, name);
	return new Promise<ErrorInfo>((resolve) => setTimeout(() => resolve(null), 1000));
}

/** Open the external diff tool over the directory diff of two revisions (the legacy DataSource.openExternalDirDiff). */
function openExternalDirDiff(git: GitRunnerPort, logger: Logger, repo: string, fromHash: string, toHash: string, isGui: boolean): Promise<ErrorInfo> {
	return new Promise<ErrorInfo>((resolve) => {
		const gitPath = git.gitPath();
		if (gitPath === null) {
			resolve(unableToFindGitMsg());
			return;
		}
		const args = ['difftool', '--dir-diff'];
		const config = getConfig(repo);
		if (config.extDiffToolArgs && config.extDiffToolArgs.length > 0) {
			args.push(...config.extDiffToolArgs);
		}
		if (isGui) args.push('-g');
		if (fromHash === toHash) {
			if (toHash === UNCOMMITTED) args.push('HEAD');
			else args.push(toHash + '^..' + toHash);
		} else {
			if (toHash === UNCOMMITTED) args.push(fromHash);
			else args.push(fromHash + '..' + toHash);
		}
		if (isGui) {
			logger.log('External diff tool is being opened (' + args[args.length - 1] + ')');
			git.runGitCommand(args, repo).then((errorInfo) => {
				logger.log('External diff tool has exited (' + args[args.length - 1] + ')');
				if (errorInfo !== null) {
					const errorMessage = errorInfo.replace(/\r\n|\r|\n/g, ' ');
					logger.logError(errorMessage);
					showErrorMessage(errorMessage);
				}
			});
		} else {
			openGitTerminal(repo, gitPath, args.join(' '), t('openExternalDirDiffTerminalName'));
		}
		// The tool may block until the user closes it: resolve once it has launched.
		setTimeout(() => resolve(null), 1500);
	});
}

/**
 * The save-dialog + `git archive` flow of utils/actions.archive, over the pure op. The dialog
 * goes through the host's UiPort (utils/actions.ts's uiPort), so the automation/E2E build's
 * ScriptedUiPort answers it from the scenario script — this flow is the exact site the former
 * `nativeSaveDialog` catalog skip existed for (REFACTOR-PLAN task 4.10's acceptance).
 */
async function createArchive(repo: ProductionGitRepository, repoPath: string, ref: string): Promise<ErrorInfo> {
	try {
		const uri = await uiPort.showSaveDialog({
			defaultUri: vscode.Uri.file(repoPath),
			saveLabel: t('archiveSaveLabel'),
			filters: { [t('archiveTarFilter')]: ['tar'], [t('archiveZipFilter')]: ['zip'] }
		});
		if (uri === undefined) return t('archiveNoFileName');
		const extension = uri.fsPath.substring(uri.fsPath.lastIndexOf('.') + 1).toLowerCase();
		if (extension !== 'tar' && extension !== 'zip') return t('archiveInvalidExtension', extension);
		return repo.write.run(repoPath, archiveOp({ ref: ref, outputFilePath: uri.fsPath, type: extension }));
	} catch (_) {
		return t('archiveNoSaveDialog');
	}
}

/** The "Uncommitted Changes" zero-confirmation window and re-check interval (see UncommittedCountStabiliser). */
export const PANEL_UNCOMMITTED_ZERO_CONFIRM_MS = 5000;
export const PANEL_UNCOMMITTED_RECHECK_MS = 1000;

/** The refresh ids the regenerated page embeds, owned by the Panel and recorded through the ViewPort. */
export interface PanelRefreshIds {
	loadRepoInfo: number;
	loadCommits: number;
	loadConfig: number;
}

/** The collaborators the view port coordinates (the Panel's own per-repository state machine). */
export interface ViewPortDeps {
	readonly loader: CommitLoader;
	readonly extensionState: ExtensionState;
	/** The repo file watcher to restart on a repository switch. */
	readonly watcher: { start(repo: string): void };
	/** The background poll whose baseline a repository switch resets. */
	readonly poller: { resetBaseline(): void };
	/** The refresh ids the loadRepoInfo/loadCommits/loadConfig handlers record into. */
	readonly refreshIds: PanelRefreshIds;
	/** Reads and updates the repository the view currently shows. */
	currentRepo(): string | null;
	setCurrentRepo(repo: string): void;
	/** Push the merged open-path result to the (now ready) webview — the panel owns the ticket. */
	pushViewLoad(): void;
}

/**
 * The Panel's ViewPort: the loadRepoInfo handler's view-state hooks. The refresh ids ride the
 * regenerated page's initialState (the webview drops responses older than them); a repository
 * switch records the last-active repository, restarts the watcher and the poll baseline, and
 * resets the loader's per-repo view state (the remote-refs deferral and the uncommitted
 * stabiliser) - exactly the block the live loadRepoInfo case ran inline. `viewReady` is the
 * open-path handshake (task 4.7): the panel pushes the merged loadView result it began reading
 * at creation, and records the repository it pushed for as the current one.
 */
export function createViewPort(deps: ViewPortDeps): ViewPort {
	return {
		get viewHasCommits() { return deps.loader.viewHasCommits; },
		noteRefreshId: (kind: RefreshIdKind, id: number) => {
			if (kind === 'loadRepoInfo') deps.refreshIds.loadRepoInfo = id;
			else if (kind === 'loadCommits') deps.refreshIds.loadCommits = id;
			else deps.refreshIds.loadConfig = id;
		},
		repoSwitched: (repo: string) => {
			if (repo === deps.currentRepo()) return;
			deps.setCurrentRepo(repo);
			deps.extensionState.setLastActiveRepo(repo);
			deps.watcher.start(repo);
			// The signature of the previous repository says nothing about this one
			deps.poller.resetBaseline();
			// Neither does its uncommitted count, nor its rendered-commits state
			deps.loader.viewRepoChanged();
		},
		viewReady: () => deps.pushViewLoad()
	};
}

/**
 * Save the `git-graph-rs.interfaceLanguage` setting to the Global User Settings. The
 * onDidChangeConfiguration listener reloads the Git Graph View, which re-renders the webview
 * with the new language (the settings page is restored from the persisted webview state).
 * @param language The interface language.
 * @returns The ErrorInfo of the failure (NULL => saved successfully).
 */
async function setInterfaceLanguage(logger: Logger, language: 'auto' | 'en' | 'zh-cn'): Promise<ErrorInfo> {
	if (language !== 'auto' && language !== 'en' && language !== 'zh-cn') return t('interfaceLanguageInvalid');
	try {
		await vscode.workspace.getConfiguration('git-graph-rs').update('interfaceLanguage', language, vscode.ConfigurationTarget.Global);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.log('Saving the interface language failed: ' + message);
		return message;
	}
	return null;
}

/**
 * Open this session's log file in an editor tab. The file starts empty on every activation, so
 * what it shows is always the log of the current editor session.
 * @returns The ErrorInfo of the failure (NULL => opened).
 */
async function openLogFile(logger: Logger): Promise<ErrorInfo> {
	const logFile = logger.getLogFile();
	if (logFile === null) {
		return t('noLogRecorded');
	}
	try {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logFile));
		await vscode.window.showTextDocument(document, { preview: false });
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
