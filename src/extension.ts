import * as path from 'path';
import * as vscode from 'vscode';
import { hasEngineForPlatform, isAddonAvailable, platformKey } from './backend/addon';
import { AskpassManager } from './askpass/askpassManager';
import { AvatarManager } from './avatarManager';
import { CommandManager } from './commands';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider } from './diffDocProvider';
import { ExtensionState } from './extensionState';
import { GitGraphView } from './extension/graphView/panel';
import { createGitRunner } from './extension/graphView/gitRunner';
import type { LegacyViewPort } from './extension/graphView/gitRunner';
import { GitProcess } from './extension/git/process/gitProcess';
import type { GitExecutable } from './extension/git/process/gitProcess';
import { GitRepository } from './extension/git/gitRepository';
import type { ProductionGitRepository } from './extension/git/gitRepository';
import { createBackend, NativeBackend } from './extension/git/read/backendIndex';
import type { GitBackend } from './extension/git/read/backendIndex';
import { GitWriter } from './extension/git/write/gitWriter';
import type { Localize } from './extension/git/write/argSafety';
import { CommitComparisonView } from './extension/views/comparison/viewController';
import { BinaryCompareView } from './extension/views/binaryCompare/viewController';
import { t } from './i18n';
import { TextMessageKey } from './shared/i18n';
import { Logger } from './logger';
import { RepoManager } from './extension/repos/repoManager';
import { createPrewarmController } from './extension/repos/prewarm';
import { takeSnapshot } from './extension/platform/config';
import { StatusBarItem } from './statusBarItem';
import {
	GitExecutable as LegacyGitExecutable,
	findGit,
	getGitExecutableFromPaths,
	unableToFindGitMsg,
} from './utils/findGit';
import { showErrorMessage, showInformationMessage } from './utils/actions';
import { EventEmitter } from './utils/event';

/**
 * Activate Git Graph.
 *
 * The composition root (REFACTOR-PLAN task 3.6, host side): the production git layer is composed
 * here — the read backend (the Rust engine preferred, the `git` CLI answering whatever it
 * declines), the single `GitProcess` every write and runner spawn goes through, the GitWriter
 * over it, and the `GitRepository` facade the Git Graph view runs on. The legacy `DataSource` is
 * still constructed for the consumers that have not migrated (the RepoManager, the AvatarManager,
 * the command registry, the diff document provider and the two auxiliary views); it is drained
 * and deleted as those move.
 * @param context The context of the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	const logger = new Logger(path.join(context.globalStoragePath, 'git-graph-rs.log'));
	logger.setEnabled(getConfig().enableLog);
	logger.log('Starting Git Graph ...');

	// Git Graph Studio defaults the narrow-window phone layout ON (its remote phone sessions are
	// the layout's audience), VS Code keeps it off — and the studio's own Settings dialog reads
	// the store, not this runtime default, so the very first activation under the studio seeds
	// the default into the store once. Only an UNSET value is seeded: a value the user set —
	// including an explicit off after resetting the row — is never touched again.
	if (vscode.env.uriScheme === 'ggs') {
		const inspected = vscode.workspace.getConfiguration('git-graph-rs').inspect<boolean>('mobileAdaptation');
		if ((inspected?.globalValue ?? inspected?.workspaceValue ?? inspected?.workspaceFolderValue) === undefined) {
			await vscode.workspace.getConfiguration('git-graph-rs').update('mobileAdaptation', true, vscode.ConfigurationTarget.Global)
				.then(() => logger.log('mobileAdaptation: seeded the studio default (enabled) into the global settings'), (reason) => logger.log('mobileAdaptation: seeding the studio default failed: ' + String(reason)));
		}
	}

	// No engine binary for this platform is not an error: everything runs over the `git` CLI
	// backend instead, with the full feature set. Say so once, quietly — the Settings widget's
	// backend section is where the per-capability split is shown.
	if (!hasEngineForPlatform(context.extensionPath)) {
		const msg = t('noEngineForPlatform', platformKey());
		showInformationMessage(msg);
		logger.log(msg);
	}

	const gitExecutableEmitter = new EventEmitter<LegacyGitExecutable>();
	const onDidChangeGitExecutable = gitExecutableEmitter.subscribe;

	const extensionState = new ExtensionState(context, onDidChangeGitExecutable);

	let gitExecutable: LegacyGitExecutable | null;
	try {
		gitExecutable = await findGit(extensionState);
		gitExecutableEmitter.emit(gitExecutable);
		logger.log('Using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')');
	} catch (_) {
		gitExecutable = null;
		if (hasEngineForPlatform(context.extensionPath)) {
			// No Git executable, but the engine can serve the whole read path in-process: the
			// extension is usable as-is, and write operations report that they need Git.
			const msg = t('noGitRunsOnEngine');
			showInformationMessage(msg);
			logger.log(msg);
		} else {
			showErrorMessage(unableToFindGitMsg());
			logger.logError(unableToFindGitMsg());
		}
	}

	const configurationEmitter = new EventEmitter<vscode.ConfigurationChangeEvent>();
	const onDidChangeConfiguration = configurationEmitter.subscribe;

	/* ---------- The new git layer (task 3.6) ---------- */

	// The write-path localizer: the GitWriter and the runner speak plain string keys (they must
	// stay vscode-free), the i18n table's own keys are what they carry, so the widening cast only
	// names that agreement.
	const localize: Localize = (key, ...params) => t(key as TextMessageKey, ...params);

	// The Git executable the reader and the writer share; updated in place when it changes.
	const gitCell: { executable: GitExecutable | null } = { executable: toProcessExecutable(gitExecutable) };
	// The one process adapter: askpass environment, cancellation, output limits and the error
	// shape are decided once, for the writer and the view's runner alike.
	const askpass = new AskpassManager();
	const gitProcess = new GitProcess(() => gitCell.executable, undefined, () => ({ ...askpass.getEnv() }));
	// The manager's credential servers are created lazily by the first spawn that carries the
	// askpass environment (the engine's CLI fallback, a writer run); without this they outlive
	// deactivate and hold the process open.

	// The read backend: the engine with the CLI fallback while a Git executable exists, the
	// engine alone without one (the whole read path is engine-served), the CLI alone without
	// the engine. Rebuilt when the Git executable changes, exactly as the legacy DataSource did.
	const readerCell: { backend: GitBackend } = { backend: buildBackend(gitExecutable, logger) };
	// A forwarder over the cell, so the facade's read face follows the rebuilt backend without
	// the view (which holds the facade) having to rebind anything.
	const reader = forwardBackend(() => readerCell.backend);

	const writer = new GitWriter(gitProcess, () => ({
		signCommits: getConfig().signCommits,
		signTags: getConfig().signTags
	}), localize);
	// The facade the Git Graph view runs on: reads on `.read`, writes through the GitWriter, and
	// the in-progress-operation detection over the same process adapter.
	const repo: ProductionGitRepository = new GitRepository(reader, writer, runTextOf(gitProcess));

	// A separate handle onto the engine (the addon load is memoised, so this costs nothing): the
	// Gerrit meta parsing is asked of the Rust engine directly, whatever the read backend is.
	const engine = isAddonAvailable() ? new NativeBackend() : null;
	// The view's raw runner: the few spawns that are not pure ops (the editor-script rebase, the
	// external diff tool, the batched `update-ref --stdin` of the Gerrit integration).
	const gitRunner = createGitRunner(gitProcess, engine, (key) => localize(key));

	/* ---------- The collaborators ---------- */

	const dataSource = new DataSource(gitExecutable, onDidChangeConfiguration, onDidChangeGitExecutable, logger);
	const avatarManager = new AvatarManager(dataSource, extensionState, logger);
	const repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration, logger);
	const statusBarItem = new StatusBarItem(repoManager.getNumRepos(), repoManager.onDidChangeRepos, onDidChangeConfiguration, logger);
	const diffDocProvider = new DiffDocProvider(dataSource);

	// The two auxiliary webviews still hold the legacy data source; composed here, where it
	// lives, so no graphView module imports it.
	const legacyViews: LegacyViewPort = {
		openCompareTab: (extensionPath, repoPath, fromHash, toHash, singleCommit) => {
			// The controller moves to extension/views in Phase 6.
			CommitComparisonView.open(extensionPath, dataSource, repoPath, fromHash, toHash, singleCommit);
		},
		openBinaryCompare: (extensionPath, repoPath, fromHash, toHash, file) => {
			BinaryCompareView.open(extensionPath, dataSource, repoPath, fromHash, toHash, {
				oldFilePath: file.oldFilePath, newFilePath: file.newFilePath,
				type: file.type, additions: file.additions, deletions: file.deletions
			});
		}
	};

	const commandManager = new CommandManager(context, avatarManager, dataSource, repo, gitRunner, legacyViews, extensionState, repoManager, gitExecutable, onDidChangeGitExecutable, onDidChangeConfiguration, logger);

	// Prewarming (task 4.9): 2 s after activation, open engine handles and prefetch the first
	// page of recently-opened repositories, one at a time. The reader rides the same
	// executable-tracking cell as the view's reader, so a Git switch re-aims it too. The real
	// interactive-busy scheduler arrives with task 4.8; until then prewarming yields while the
	// view is still booting (the only state it can observe today).
	const prewarm = createPrewarmController({
		readerFactory: () => forwardBackend(() => readerCell.backend),
		recentRepos: () => repoManager.getRecentRepos(),
		currentRepo: () => GitGraphView.currentPanel !== undefined ? GitGraphView.currentPanel.automationState().currentRepo : null,
		isBusy: () => GitGraphView.currentPanel !== undefined && !GitGraphView.currentPanel.automationState().viewLoaded,
		enabled: takeSnapshot(vscode.workspace).prewarm,
		log: (message) => logger.log(message)
	});
	prewarm.start();
	context.subscriptions.push(prewarm);
	context.subscriptions.push(askpass);

	// The legacy DataSource rebuilds its backend (and the writer follows the executable through
	// the cell) when the Git executable changes; the new layer's reader rebuilds with it.
	context.subscriptions.push(onDidChangeGitExecutable((executable) => {
		gitCell.executable = toProcessExecutable(executable);
		readerCell.backend = buildBackend(executable, logger);
	}));

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DiffDocProvider.scheme, diffDocProvider),
		vscode.window.registerWebviewPanelSerializer('git-graph-rs', {
			deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
				GitGraphView.restore(panel, context.extensionPath, repo, gitRunner, legacyViews, extensionState, avatarManager, repoManager, logger);
			}
		}),
		GitGraphView.watchForOrphanedTabs(context.extensionPath, repo, gitRunner, legacyViews, extensionState, avatarManager, repoManager, logger),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('git-graph-rs')) {
				logger.setEnabled(getConfig().enableLog);
				configurationEmitter.emit(event);
			} else if (event.affectsConfiguration('git.path')) {
				const paths = getConfig().gitPaths;
				if (paths.length === 0) return;

				getGitExecutableFromPaths(paths).then((gitExecutable) => {
					gitExecutableEmitter.emit(gitExecutable);
					const msg = t('nowUsingGit', gitExecutable.path, gitExecutable.version);
					showInformationMessage(msg);
					logger.log(msg);
					repoManager.searchWorkspaceForRepos();
				}, () => {
					const msg = t('gitPathInvalid', paths.join('", "'), paths.length > 1 ? t('gitPathInvalidContain') : t('gitPathInvalidMatch'));
					showErrorMessage(msg);
					logger.logError(msg);
				});
			}
		}),
		diffDocProvider,
		commandManager,
		statusBarItem,
		repoManager,
		avatarManager,
		dataSource,
		configurationEmitter,
		extensionState,
		gitExecutableEmitter,
		logger
	);
	logger.log('Started Git Graph - Ready to use!');

	extensionState.expireOldCodeReviews();
	avatarManager.expireOldAvatars();
}

/**
 * Deactivate Git Graph.
 */
export function deactivate() { }

/* ---------- Composition helpers ---------- */

/** The process adapter's executable record for a located Git (the legacy `findGit` shape is the same). */
function toProcessExecutable(executable: LegacyGitExecutable | null): GitExecutable | null {
	return executable;
}

/** Build the read backend for a Git situation (the legacy `DataSource.rebuildBackend`). */
function buildBackend(gitExecutable: LegacyGitExecutable | null, logger: Logger): GitBackend {
	const backend = createBackend({
		gitPath: gitExecutable !== null ? gitExecutable.path : null,
		onFallback: (method, error) => {
			logger.log('The Rust engine could not answer ' + method + ' (' + error.message + '); falling back to the git CLI.');
		}
	});
	logger.log('Using the ' + backend.name + ' backend.');
	return backend;
}

/** A GitBackend forwarding every member to the current backend of a cell (rebuilt on Git changes). */
function forwardBackend(current: () => GitBackend): GitBackend {
	return {
		get name() { return current().name; },
		openRepository: (path) => current().openRepository(path),
		closeRepository: (path) => current().closeRepository(path),
		closeAllRepositories: () => current().closeAllRepositories(),
		getRepoInfo: (repo, options) => current().getRepoInfo(repo, options),
		getCommits: (repo, options, signal) => current().getCommits(repo, options, signal),
		getRefs: (repo, options) => current().getRefs(repo, options),
		getRepoChangeSignature: (repo) => current().getRepoChangeSignature(repo),
		getCommitDetails: (repo, hash) => current().getCommitDetails(repo, hash),
		getCommitSignature: (repo, hash) => current().getCommitSignature(repo, hash),
		getLineCounts: (repo, from, to, paths) => current().getLineCounts(repo, from, to, paths),
		getUncommittedDetails: (repo) => current().getUncommittedDetails(repo),
		getStashDetails: (repo, hash, stash) => current().getStashDetails(repo, hash, stash),
		compareCommits: (repo, from, to) => current().compareCommits(repo, from, to),
		getUncommittedChangeCount: (repo, includeUntracked) => current().getUncommittedChangeCount(repo, includeUntracked),
		getStashes: (repo) => current().getStashes(repo),
		getConfig: (repo) => current().getConfig(repo),
		getCommitFile: (repo, hash, file) => current().getCommitFile(repo, hash, file),
		getCommitFileDiff: (repo, hash, file) => current().getCommitFileDiff(repo, hash, file),
		compareFileDiff: (repo, from, to, oldFilePath, newFilePath) => current().compareFileDiff(repo, from, to, oldFilePath, newFilePath),
		getCommitBodies: (repo, hashes) => current().getCommitBodies(repo, hashes),
		getCommitSubject: (repo, hash) => current().getCommitSubject(repo, hash),
		getCommitSummaries: (repo, hashes) => current().getCommitSummaries(repo, hashes),
		searchHistory: (repo, query) => current().searchHistory(repo, query),
		getReflog: (repo, ref, limit) => current().getReflog(repo, ref, limit),
		getWorktrees: (repo) => current().getWorktrees(repo),
		predictConflicts: (repo, ours, theirs) => current().predictConflicts(repo, ours, theirs),
		getTagDetails: (repo, tagName) => current().getTagDetails(repo, tagName),
		getTagSignature: (repo, tagName) => current().getTagSignature(repo, tagName),
		getRemoteUrl: (repo, remote) => current().getRemoteUrl(repo, remote),
		getNewPathOfRenamedFile: (repo, commitHash, oldFilePath) => current().getNewPathOfRenamedFile(repo, commitHash, oldFilePath),
		getSubmodules: (repo) => current().getSubmodules(repo),
		getCurrentBranchUpstream: (repo) => current().getCurrentBranchUpstream(repo),
		countCommitsBefore: (repo, branches, hash, showRemoteBranches, includeReflogs) => current().countCommitsBefore(repo, branches, hash, showRemoteBranches, includeReflogs),
		repoRoot: (path) => current().repoRoot(path),
		getRemotes: (repo) => current().getRemotes(repo),
		getAuthors: (repo) => current().getAuthors(repo),
		getAuthorStatistics: (repo) => current().getAuthorStatistics(repo),
		getActivityHeatmap: (repo) => current().getActivityHeatmap(repo),
		getConfigList: (repo, location) => current().getConfigList(repo, location),
		currentBranchName: (repo) => current().currentBranchName(repo),
		getGlobalUserDetails: (repo) => current().getGlobalUserDetails(repo),
		parseGerritMetas: (repo, remote, changes, urlBase) => current().parseGerritMetas(repo, remote, changes, urlBase),
		listChangeRefs: (repo, remote) => current().listChangeRefs(repo, remote)
	};
}

/** The facade's text runner: one Git read resolving its stdout, rejecting when it fails. */
function runTextOf(process: GitProcess): (argv: ReadonlyArray<string>, repo: string) => Promise<string> {
	return (argv, repo) => process.run(argv, { cwd: repo }).then((result) => {
		if (result.code !== 0) {
			const lines = (result.stderr + result.stdout.toString('utf8')).split(/\r\n|\r|\n/);
			lines.pop();
			throw lines.join('\n');
		}
		return result.stdout.toString('utf8');
	});
}
