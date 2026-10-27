import * as path from 'path';
import * as vscode from 'vscode';
import { hasEngineForPlatform, isAddonAvailable, loadAddon, platformKey } from './git/read/addonLoader';
import { buildBackend, swappableBackend } from './git/swappableBackend';
import { createGitResolution } from './git/executable/gitResolution';
import { AskpassManager } from './git/process/askpass/askpassManager';
import { GitRepository, repoTextRunnerOf } from './git/gitRepository';
import type { ProductionGitRepository } from './git/gitRepository';
import { AvatarManager } from './integrations/avatars/avatarManager';
import { CommandManager } from './commands';
import { ConfigService, gitPathsOf, viewColumnOfEditorGroup } from './platform/config';
import { setDefaultEditorGroupSource } from './platform/actions';
import { DiffDocProvider } from './views/diffDocProvider';
import { ExtensionState } from './platform/storage';
import { PanelRegistry } from './graphView/panelRegistry';
import { createAuxiliaryViews } from './graphView/panelContext';
import { registerPanelSerializer } from './graphView/panel';
import { createGitRunner } from './graphView/gitRunner';
import { gerritDataSourceOver } from './integrations/gerrit/gerrit';
import { NativeBackend } from './git/read/backendIndex';
import type { GitBackend } from './git/read/backendIndex';
import { GitProcess } from './git/process/gitProcess';
import type { GitExecutable } from './git/process/gitProcess';
import { GitWriter } from './git/write/gitWriter';
import type { Localize } from './git/write/argSafety';
import { t } from './platform/i18n';
import { TextMessageKey } from '../shared/i18n';
import { Logger } from './platform/logger';
import { mark, MARK, setEnabled } from '../shared/perf/trace';
import { RepoManager } from './repos/repoManager';
import { createPrewarmController, createScheduledPrewarmReader } from './repos/prewarm';
import { StatusBarItem } from './statusBar';
import { createTrustGate } from './platform/workspaceTrust';
import { findGit, unableToFindGitMsg } from './git/executable/findGit';
import { followGitPathSetting, showErrorMessage, showInformationMessageOncePerVersion, showRestrictedModeNoticeOnce } from './platform/actions';
import { setInterfaceLanguageSource } from './platform/i18n';
import { EventEmitter } from '../shared/util/event';
import type { ExtensionServices } from './services';

/**
 * Activate Git Graph — the composition root: everything is constructed and wired here, once,
 * into the frozen {@link ExtensionServices} bag (OPTIMIZATION-PLAN A2). Activation never waits
 * for a `git` spawn (V1): everything is registered synchronously first and Git is resolved in
 * the background; while the workspace is untrusted (V2, D-1) the extension runs in Restricted
 * Mode — engine-only reads, no Git runs.
 * @param context The context of the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	// The configuration service first: the latest snapshot of the settings, kept current by one
	// subscription (A4) — every read below answers from `.current` instead of re-reading
	// vscode.workspace.getConfiguration, and the platform free-function seams (the interface
	// language, the default editor group) are pointed at it before anything can localize.
	const config = new ConfigService(vscode.workspace);
	setInterfaceLanguageSource(() => config.current.interfaceLanguage);
	setDefaultEditorGroupSource(() => viewColumnOfEditorGroup(config.current.openNewTabEditorGroup));
	const logger = new Logger(path.join(context.globalStoragePath, 'git-graph-rs.log'));
	logger.setEnabled(config.current.enableLog);
	setEnabled(config.current.enableLog);
	mark(MARK.activation);
	logger.log('Starting Git Graph ...');

	const gitExecutableEmitter = new EventEmitter<GitExecutable | null>();
	const onDidChangeGitExecutable = gitExecutableEmitter.subscribe;
	const state = new ExtensionState(context, onDidChangeGitExecutable, config);

	// Workspace Trust (V2): untrusted means Restricted Mode — engine-only reads, no Git runs.
	const trust = createTrustGate();
	if (!trust.isTrusted) showRestrictedModeNoticeOnce(logger);

	// The deferred Git resolution (V1): `current()` is the persisted last-good record until the
	// background validation answers, then its result (NULL while untrusted); `ready()` is what
	// every Git-CLI-dependent path awaits. Validation starts only once everything is registered.
	const gitResolution = createGitResolution({
		cache: state,
		restricted: () => !trust.isTrusted,
		find: () => findGit(state, gitPathsOf(vscode.workspace)),
		onResolved: (executable) => {
			gitExecutableEmitter.emit(executable);
			// No Git but an engine: usable as-is (said once per version); no engine: the plain failure.
			if (executable === null && hasEngineForPlatform(context.extensionPath)) {
				showInformationMessageOncePerVersion(context, logger, 'noGitRunsOnEngine', t('noGitRunsOnEngine'));
			} else if (executable === null) {
				void showErrorMessage(unableToFindGitMsg());
				logger.logError(unableToFindGitMsg());
			}
		},
		log: (message) => logger.log(message)
	});

	const configurationEmitter = new EventEmitter<vscode.ConfigurationChangeEvent>();
	const onDidChangeConfiguration = configurationEmitter.subscribe;

	// The write-path localizer: the writer and the runner speak plain string keys, vscode-free.
	const localize: Localize = (key, ...params) => t(key as TextMessageKey, ...params);
	// The Git executable the reader and the writer share, following resolution and trust changes.
	const gitCell: { executable: GitExecutable | null } = { executable: gitResolution.current() };
	const applyGitExecutable = () => { gitCell.executable = gitResolution.current(); };
	// The one process adapter (askpass, cancellation, output limits, error shape), shared by the
	// writer and the runner; every run awaits the Git resolution first (V1), so a spawn issued
	// while validation is still in flight waits instead of failing with "no Git".
	const askpass = new AskpassManager();
	const gitProcess = new GitProcess(() => gitCell.executable, undefined, () => ({ ...askpass.getEnv() }), () => gitResolution.ready());
	// The read backend, rebuilt when the Git executable changes or trust transitions (V2); the
	// host holds the swappable forwarder, so a rebuild re-aims every consumer without rebinding.
	const readerCell: { backend: GitBackend } = { backend: buildBackend(gitResolution.current(), logger, !trust.isTrusted) };
	const reader = swappableBackend(() => readerCell.backend);
	const rebuildBackend = () => { readerCell.backend = buildBackend(gitResolution.current(), logger, !trust.isTrusted); };

	const writer = new GitWriter(gitProcess, () => ({
		signCommits: config.current.repositorySignCommits,
		signTags: config.current.repositorySignTags
	}), localize);
	// The facade the view runs on: reads, writes, and operation state over the process adapter.
	const repo: ProductionGitRepository = new GitRepository(reader, writer, repoTextRunnerOf(gitProcess));
	// A separate engine handle (the addon load is memoised): the Gerrit meta parsing asks the engine directly.
	const engine = isAddonAvailable() ? new NativeBackend() : null;
	// The view's raw runner: the few spawns that are not pure ops (rebase editor, difftool, `update-ref --stdin`).
	const git = createGitRunner(gitProcess, engine, (key) => localize(key));

	const avatars = new AvatarManager(reader, state, logger, config);
	const repos = new RepoManager({ repo, git, state, onDidChangeConfiguration, logger });
	const statusBarItem = new StatusBarItem(repos.getNumRepos(), repos.onDidChangeRepos, onDidChangeConfiguration, config, logger);
	const diffDocProvider = new DiffDocProvider(reader);
	// The auxiliary views port (with its streaming spawner) and the Gerrit integration, same git layer.
	const auxViews = createAuxiliaryViews(reader, gitProcess);
	const gerrit = gerritDataSourceOver(git);

	const services: ExtensionServices = Object.freeze({
		context: context, logger: logger, state: state, repo: repo, reader: reader, git: git,
		avatars: avatars, repos: repos, auxViews: auxViews, gerrit: gerrit,
		gitResolution: gitResolution, config: config, onDidChangeConfiguration: onDidChangeConfiguration
	});
	const panels = new PanelRegistry(services);
	const commandManager = new CommandManager(services, panels);

	// Prewarming (§3.8.2 D11): prefetch recently-opened repositories 2 s after activation; the
	// live view is read only through the registry's 2-method port, cycles yield to interactive work.
	const prewarmReader = createScheduledPrewarmReader(reader);
	const prewarm = createPrewarmController({
		readerFactory: () => prewarmReader,
		recentRepos: () => services.repos.getRecentRepos(),
		liveView: panels,
		enabled: config.current.prewarm,
		log: (message) => logger.log(message)
	});

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DiffDocProvider.scheme, diffDocProvider),
		registerPanelSerializer(() => gitResolution.ready(), (panel) => panels.restore(panel)),
		panels.watchForOrphanedTabs(),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('git-graph-rs')) {
				logger.setEnabled(config.current.enableLog);
				configurationEmitter.emit(event);
			} else if (event.affectsConfiguration('git.path')) {
				const paths = gitPathsOf(vscode.workspace);
				if (paths.length > 0) followGitPathSetting(paths, (executable) => gitExecutableEmitter.emit(executable), () => { void repos.searchWorkspaceForRepos(); }, logger);
			}
		}),
		diffDocProvider,
		commandManager,
		statusBarItem,
		repos,
		avatars,
		configurationEmitter,
		state,
		gitExecutableEmitter,
		config,
		logger
	);

	// The backend follows the Git executable and trust transitions; askpass and prewarm dispose with the subscriptions.
	context.subscriptions.push(
		onDidChangeGitExecutable(() => {
			applyGitExecutable();
			rebuildBackend();
		}),
		trust.onChange(() => {
			logger.log(trust.isTrusted ? 'Workspace trust granted: Git operations re-enabled' : 'Workspace trust revoked: serving engine reads only (Restricted Mode)');
			if (trust.isTrusted) gitResolution.start(); // a no-op when validation already ran
			else showRestrictedModeNoticeOnce(logger);
			applyGitExecutable();
			rebuildBackend();
		}),
		prewarm,
		askpass
	);
	prewarm.start();

	// No engine binary is not an error (everything runs over the CLI); said once per version (V1).
	if (!hasEngineForPlatform(context.extensionPath)) {
		showInformationMessageOncePerVersion(context, logger, 'noEngineForPlatform', t('noEngineForPlatform', platformKey()));
	}

	// Everything is registered: start the background Git validation now (V1). Until it answers,
	// `current()` is the persisted last-good record and engine reads are already served.
	gitResolution.start();
	logger.log('Started Git Graph - Ready to use!');
	state.expireOldCodeReviews();
	avatars.expireOldAvatars();
}

/**
 * Deactivate Git Graph: close the engine's warm repository handles explicitly (one `close_all`
 * call) instead of relying on the disposal order; a no-op without an engine binary.
 */
export function deactivate() {
	if (isAddonAvailable()) loadAddon().closeAll();
}
