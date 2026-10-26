import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hasEngineForPlatform, isAddonAvailable, platformKey } from './git/read/addonLoader';
import { createGitResolution } from './git/executable/gitResolution';
import { AskpassManager } from './git/process/askpass/askpassManager';
import { AvatarManager } from './integrations/avatars/avatarManager';
import { CommandManager } from './commands';
import { getConfig } from './platform/config';
import { DiffDocProvider } from './views/diffDocProvider';
import { ExtensionState } from './platform/storage';
import { GitGraphView } from './graphView/panel';
import { createGitRunner } from './graphView/gitRunner';
import type { LegacyViewPort } from './graphView/gitRunner';
import { GitProcess } from './git/process/gitProcess';
import type { GitExecutable } from './git/process/gitProcess';
import { GitRepository } from './git/gitRepository';
import type { ProductionGitRepository } from './git/gitRepository';
import { gerritDataSourceOver } from './integrations/gerrit/gerrit';
import { createBackend, NativeBackend } from './git/read/backendIndex';
import type { GitBackend } from './git/read/backendIndex';
import { GitWriter } from './git/write/gitWriter';
import type { Localize } from './git/write/argSafety';
import { CommitComparisonView } from './views/comparison/viewController';
import { BinaryCompareView } from './views/binaryCompare/viewController';
import type { GitStreamSpawner } from './views/binaryCompare/hexDiff';
import { t } from './platform/i18n';
import { TextMessageKey } from '../shared/i18n';
import { Logger } from './platform/logger';
import { mark, MARK, setEnabled } from '../shared/perf/trace';
import { RepoManager } from './repos/repoManager';
import { createPrewarmController } from './repos/prewarm';
import type { PrewarmReader } from './repos/prewarm';
import { hostScheduler } from './graphView/scheduler';
import { takeSnapshot } from './platform/config';
import { StatusBarItem } from './statusBar';
import { createTrustGate } from './platform/workspaceTrust';
import {
	GitExecutable as LegacyGitExecutable,
	findGit,
	getGitExecutableFromPaths,
	unableToFindGitMsg,
} from './git/executable/findGit';
import { showErrorMessage, showInformationMessage } from './platform/actions';
import { EventEmitter } from '../shared/util/event';

/**
 * Activate Git Graph.
 *
 * The composition root (REFACTOR-PLAN task 3.6, host side): the production git layer is composed
 * here — the read backend (the Rust engine preferred, the `git` CLI answering whatever it
 * declines), the single `GitProcess` every write and runner spawn goes through, the GitWriter
 * over it, and the `GitRepository` facade every consumer runs on (the view, the commands, the
 * repository manager, the avatars, the diff documents and the two auxiliary views).
 *
 * Activation never waits for a `git` spawn (OPTIMIZATION-PLAN V1): commands, the webview panel
 * serializer and the text document content provider are registered synchronously first, and the
 * Git executable is resolved in the background — the last good record from globalState answers
 * immediately, and every Git-CLI-dependent path awaits the resolution instead of activation
 * doing so. While the workspace is untrusted (OPTIMIZATION-PLAN V2, decision D-1) the extension
 * runs in Restricted Mode: reads are served by the engine alone and everything that would run
 * the `git` CLI is disabled.
 * @param context The context of the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	const logger = new Logger(path.join(context.globalStoragePath, 'git-graph-rs.log'));
	logger.setEnabled(getConfig().enableLog);
	setEnabled(getConfig().enableLog);
	mark(MARK.activation);
	logger.log('Starting Git Graph ...');

	const gitExecutableEmitter = new EventEmitter<LegacyGitExecutable | null>();
	const onDidChangeGitExecutable = gitExecutableEmitter.subscribe;

	const extensionState = new ExtensionState(context, onDidChangeGitExecutable);

	// Workspace Trust (V2): untrusted means Restricted Mode — engine-only reads, no Git runs.
	const trust = createTrustGate();
	let restrictedBannerShown = false;
	const showRestrictedBannerOnce = () => {
		if (restrictedBannerShown) return;
		restrictedBannerShown = true;
		const notice = t('restrictedModeNotice');
		showInformationMessage(notice);
		logger.log(notice);
	};
	if (!trust.isTrusted) showRestrictedBannerOnce();

	// The deferred Git resolution (V1): `current()` is the persisted last-good record until the
	// background validation answers, then its result (always NULL while untrusted); `ready()` is
	// what every Git-CLI-dependent path awaits. Validation only starts once everything below is
	// registered — no `git` spawn before that.
	const gitResolution = createGitResolution({
		cache: extensionState,
		restricted: () => !trust.isTrusted,
		find: () => findGit(extensionState),
		onResolved: (executable) => {
			gitExecutableEmitter.emit(executable);
			if (executable === null) {
				if (hasEngineForPlatform(context.extensionPath)) {
					// No Git executable, but the engine can serve the whole read path in-process:
					// the extension is usable as-is, and write operations report that they need
					// Git. Said once per version, not on every activation.
					showInformationMessageOncePerVersion(context, logger, 'noGitRunsOnEngine', t('noGitRunsOnEngine'));
				} else {
					showErrorMessage(unableToFindGitMsg());
					logger.logError(unableToFindGitMsg());
				}
			}
		},
		log: (message) => logger.log(message)
	});

	const configurationEmitter = new EventEmitter<vscode.ConfigurationChangeEvent>();
	const onDidChangeConfiguration = configurationEmitter.subscribe;

	/* ---------- The new git layer (task 3.6) ---------- */

	// The write-path localizer: the GitWriter and the runner speak plain string keys (they must
	// stay vscode-free), the i18n table's own keys are what they carry, so the widening cast only
	// names that agreement.
	const localize: Localize = (key, ...params) => t(key as TextMessageKey, ...params);

	// The Git executable the reader and the writer share; updated in place when the background
	// resolution (or a trust transition) changes it.
	const gitCell: { executable: GitExecutable | null } = { executable: gitResolution.current() };
	const applyGitExecutable = () => {
		gitCell.executable = gitResolution.current();
	};
	// The one process adapter: askpass environment, cancellation, output limits and the error
	// shape are decided once, for the writer and the view's runner alike. Every run awaits the
	// Git resolution first, so a spawn issued while the executable is still being validated
	// waits for it instead of failing with "no Git".
	const askpass = new AskpassManager();
	const gitProcess = new GitProcess(() => gitCell.executable, undefined, () => ({ ...askpass.getEnv() }), () => gitResolution.ready());
	// The manager's credential servers are created lazily by the first spawn that carries the
	// askpass environment (the engine's CLI fallback, a writer run); without this they outlive
	// deactivate and hold the process open.

	// The read backend: the engine with the CLI fallback while a Git executable exists, the
	// engine alone without one (the whole read path is engine-served), the CLI alone without
	// the engine. Rebuilt when the Git executable changes, exactly as the legacy DataSource did.
	// In Restricted Mode it is built engine-only, whatever Git was found (V2).
	const readerCell: { backend: GitBackend } = { backend: buildBackend(gitResolution.current(), logger, !trust.isTrusted) };
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

	const avatarManager = new AvatarManager(reader, extensionState, logger);
	const repoManager = new RepoManager(repo, gitRunner, extensionState, onDidChangeConfiguration, logger);
	const statusBarItem = new StatusBarItem(repoManager.getNumRepos(), repoManager.onDidChangeRepos, onDidChangeConfiguration, logger);
	const diffDocProvider = new DiffDocProvider(reader);

	// The two auxiliary webviews, composed over the read backend and the streaming spawner (the
	// same git layer the Git Graph view's facade runs on), so no graphView module imports them.
	const gitStream: GitStreamSpawner = {
		spawnGitStream: (args, repo) => {
			// The localised no-Git message of the legacy spawn, kept for the hex view's error toast
			if (gitProcess.git === null) throw new Error(unableToFindGitMsg());
			return gitProcess.spawnStream(args, repo);
		}
	};
	const legacyViews: LegacyViewPort = {
		openCompareTab: (extensionPath, repoPath, fromHash, toHash, singleCommit) => {
			// The controller moves to extension/views in Phase 6.
			CommitComparisonView.open(extensionPath, reader, gitStream, repoPath, fromHash, toHash, singleCommit);
		},
		openBinaryCompare: (extensionPath, repoPath, fromHash, toHash, file) => {
			BinaryCompareView.open(extensionPath, gitStream, repoPath, fromHash, toHash, {
				oldFilePath: file.oldFilePath, newFilePath: file.newFilePath,
				type: file.type, additions: file.additions, deletions: file.deletions
			});
		}
	};

	// The Gerrit integration the gerrit commands run (the hook install of `gerritFetchCommitMsgHook`),
	// over the same runner the view's pipeline uses.
	const commandGerrit = gerritDataSourceOver(gitRunner);

	const commandManager = new CommandManager(context, avatarManager, repo, gitRunner, commandGerrit, legacyViews, extensionState, repoManager, gitResolution, onDidChangeConfiguration, logger);

	// Prewarming (task 4.9): 2 s after activation, open engine handles and prefetch the first
	// page of recently-opened repositories, one at a time. The reader rides the same
	// executable-tracking cell as the view's reader, so a Git switch re-aims it too. The
	// prefetch reads run as background jobs of the host scheduler (task 4.8): they yield to any
	// interactive request of the view, and the controller's own isBusy gate keeps the cycle
	// boundaries yielding as well.
	const prewarm = createPrewarmController({
		readerFactory: () => prewarmReader(forwardBackend(() => readerCell.backend)),
		recentRepos: () => repoManager.getRecentRepos(),
		currentRepo: () => GitGraphView.currentPanel !== undefined ? GitGraphView.currentPanel.automationState().currentRepo : null,
		isBusy: () => GitGraphView.currentPanel !== undefined && !GitGraphView.currentPanel.automationState().viewLoaded,
		enabled: takeSnapshot(vscode.workspace).prewarm,
		log: (message) => logger.log(message)
	});

	/* ---------- Registration first, resolution after (V1) ---------- */

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DiffDocProvider.scheme, diffDocProvider),
		vscode.window.registerWebviewPanelSerializer('git-graph-rs', {
			deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
				// The restored panel's first render decides on the Git situation: wait for the
				// background resolution so it cannot render the "unable to load" page for a Git
				// that is merely not validated yet.
				await gitResolution.ready();
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
		configurationEmitter,
		extensionState,
		gitExecutableEmitter,
		logger
	);

	// The read backend rebuilds when the Git executable changes (the writer and the runner follow
	// the executable through the cell), and on every trust transition (V2: entering Restricted
	// Mode swaps to an engine-only backend, leaving it re-arms the CLI fallback).
	context.subscriptions.push(
		onDidChangeGitExecutable(() => {
			applyGitExecutable();
			readerCell.backend = buildBackend(gitResolution.current(), logger, !trust.isTrusted);
		}),
		trust.onChange(() => {
			if (trust.isTrusted) {
				logger.log('Workspace trust granted: Git operations re-enabled');
				gitResolution.start(); // a no-op when validation already ran
			} else {
				logger.log('Workspace trust revoked: serving engine reads only (Restricted Mode)');
				showRestrictedBannerOnce();
			}
			applyGitExecutable();
			readerCell.backend = buildBackend(gitResolution.current(), logger, !trust.isTrusted);
		})
	);

	prewarm.start();
	context.subscriptions.push(prewarm);
	context.subscriptions.push(askpass);

	// No engine binary for this platform is not an error: everything runs over the `git` CLI
	// backend instead, with the full feature set. Say so once per extension version (V1) — the
	// Settings widget's backend section is where the per-capability split is shown afterwards.
	if (!hasEngineForPlatform(context.extensionPath)) {
		showInformationMessageOncePerVersion(context, logger, 'noEngineForPlatform', t('noEngineForPlatform', platformKey()));
	}

	// Everything is registered: start the background Git validation now (V1). Until it answers,
	// `current()` is the persisted last-good record (or NULL), engine reads are already served,
	// and Git-CLI-dependent paths await `ready()`.
	gitResolution.start();

	logger.log('Started Git Graph - Ready to use!');

	extensionState.expireOldCodeReviews();
	avatarManager.expireOldAvatars();
}

/**
 * Deactivate Git Graph.
 */
export function deactivate() { }

/* ---------- Composition helpers ---------- */

/**
 * Build the read backend for a Git situation (the legacy `DataSource.rebuildBackend`). In
 * Restricted Mode (`engineOnly`, V2) the CLI is never reached: the engine serves every read
 * in-process, and without an engine binary every call fails rather than spawning `git` in an
 * untrusted folder.
 */
function buildBackend(gitExecutable: LegacyGitExecutable | null, logger: Logger, engineOnly: boolean): GitBackend {
	const backend = createBackend({
		gitPath: gitExecutable !== null ? gitExecutable.path : null,
		engineOnly,
		onFallback: (method, error) => {
			logger.log('The Rust engine could not answer ' + method + ' (' + error.message + '); falling back to the git CLI.');
		}
	});
	logger.log('Using the ' + backend.name + ' backend.');
	return backend;
}

/**
 * The extension's own version, keying the once-per-version information flags: read from the
 * installed manifest once per activation (the `ExtensionContext.extension` accessor is newer
 * than the 1.38 API floor, so the package file is read instead — a single read, not per request).
 */
function extensionVersionOf(context: vscode.ExtensionContext): string {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8')) as { version?: unknown };
		return typeof manifest.version === 'string' ? manifest.version : 'unknown';
	} catch (_) {
		return 'unknown';
	}
}

/**
 * Show an informational message once per extension version (OPTIMIZATION-PLAN V1): the flag is
 * keyed by the version in globalState, so an update shows the message again while a plain reload
 * does not. The "no engine for this platform" and "running without Git" notices both go through
 * here — their information lives on in the Settings widget's backend section afterwards.
 */
function showInformationMessageOncePerVersion(context: vscode.ExtensionContext, logger: Logger, key: string, message: string): void {
	const flagKey = 'infoMessageShown:' + key + ':' + extensionVersionOf(context);
	if (context.globalState.get<boolean>(flagKey) === true) return;
	showInformationMessage(message);
	logger.log(message);
	void context.globalState.update(flagKey, true).then(undefined, () => undefined);
}

/**
 * The prewarm controller's reader (task 4.9 wired onto task 4.8's scheduler): the handle is
 * opened directly (cheap, and the controller tracks it), while the two prefetch reads run as
 * background jobs of the host scheduler — one at a time, and yielded (abandoned) by any
 * interactive request the view is making, which is exactly the prewarm policy of §3.8.2 D11.
 */
function prewarmReader(backend: GitBackend): PrewarmReader {
	return {
		openRepository: (repo) => backend.openRepository(repo),
		closeRepository: (repo) => backend.closeRepository(repo),
		getRepoInfo: (repo, options) => hostScheduler.run('prewarm:info:' + repo, 'background', () => backend.getRepoInfo(repo, options)),
		getCommits: (repo, options) => hostScheduler.run('prewarm:commits:' + repo, 'background', () => backend.getCommits(repo, options))
	};
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
		getRefSnapshot: (repo, options) => current().getRefSnapshot(repo, options),
		annotate: (repo, commits, options, signal) => current().annotate(repo, commits, options, signal),
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
