import * as vscode from 'vscode';
import { AvatarManager } from '../integrations/avatars/avatarManager';
import type { GerritDataSource } from '../integrations/gerrit/gerrit';
import type { AuxiliaryViewsPort, GitRunnerPort } from '../graphView/gitRunner';
import type { PanelRegistry } from '../graphView/panelRegistry';
import type { ProductionGitRepository } from '../git/gitRepository';
import type { ExtensionServices } from '../services';
import type { GitResolution } from '../git/executable/gitResolution';
import { ExtensionState } from '../platform/storage';
import type { ConfigProvider } from '../platform/config';
import { isZhCn, t } from '../platform/i18n';
import { Logger } from '../platform/logger';
import { begin, formatTrace, isEnabled, mark, MARK, onTraceRecorded, setEnabled } from '../../shared/perf/trace';
import { RepoManager } from '../repos/repoManager';
import { Disposable } from '../../shared/util/disposable';
import { GitExecutable } from '../git/executable/findGit';
import { showInformationMessage } from '../platform/actions';
import { VsCodeVersionRequirement, doesVersionMeetRequirement } from '../platform/git';
import type { CommandHost } from './context';
import type { CommandId } from './registry';
import { automationAvailable, runAutomationTest } from './automation';
import { endAllWorkspaceCodeReviews, endSpecificWorkspaceCodeReview, resumeWorkspaceCodeReview } from './codeReviews';
import { searchCommits } from './commits';
import { gerritFetchCommitMsgHook, gerritPushRef } from './gerrit';
import { showDiagnostics } from './diagnostics';
import { clearAvatarCache, openFile, version } from './misc';
import { addGitRepository, removeGitRepository } from './repositories';
import { amendLastCommit, resetCurrentBranchToRemote } from './sourceControl';
import { fetch, filterByFile, view } from './view';

/**
 * Commands whose handler consults Git, or opens a view whose first render decides on the Git
 * situation: they await the background Git resolution first, so a command
 * invoked while the `git --version` validation is still in flight waits for it instead of acting
 * on a "no Git" that only means "not validated yet". Once the resolution has answered, the await
 * is a settled promise and costs nothing.
 */
const GIT_AWAITING_COMMANDS: ReadonlySet<string> = new Set([
	'git-graph-rs.view',
	'git-graph-rs.filterByFile',
	'git-graph-rs.version',
	'git-graph-rs.fetch',
	'git-graph-rs.searchCommits',
	'git-graph-rs.addGitRepository',
	'git-graph-rs.removeGitRepository',
	'git-graph-rs.amendLastCommit',
	'git-graph-rs.amendLastCommit.zhCn',
	'git-graph-rs.resetCurrentBranchToRemote',
	'git-graph-rs.resetCurrentBranchToRemote.zhCn',
	'git-graph-rs.gerritPushRef',
	'git-graph-rs.gerritPushRef.zhCn',
	'git-graph-rs.gerritFetchCommitMsgHook',
	'git-graph-rs.gerritFetchCommitMsgHook.zhCn'
]);

/**
 * Commands that change the repository or run the `git` CLI at all: refused while the workspace is
 * untrusted — in Restricted Mode the extension is read-only, served by the
 * Rust engine alone. The view-opening commands stay available (engine reads are safe).
 */
const RESTRICTED_COMMANDS: ReadonlySet<string> = new Set([
	'git-graph-rs.fetch',
	'git-graph-rs.searchCommits',
	'git-graph-rs.addGitRepository',
	'git-graph-rs.removeGitRepository',
	'git-graph-rs.amendLastCommit',
	'git-graph-rs.amendLastCommit.zhCn',
	'git-graph-rs.resetCurrentBranchToRemote',
	'git-graph-rs.resetCurrentBranchToRemote.zhCn',
	'git-graph-rs.gerritPushRef',
	'git-graph-rs.gerritPushRef.zhCn',
	'git-graph-rs.gerritFetchCommitMsgHook',
	'git-graph-rs.gerritFetchCommitMsgHook.zhCn'
]);

/**
 * Manages the registration and execution of Git Graph Commands.
 *
 * The handlers live in the per-group modules of `src/extension/commands/`; this
 * class owns the registration order, the shared invocation wrapper (logging, the Restricted
 * Mode refusal, the Git-resolution await, and promise forwarding), the extension contexts, and
 * disposal — and IS the {@link CommandHost} the handlers run with.
 */
export class CommandManager extends Disposable implements CommandHost {
	public readonly context: vscode.ExtensionContext;
	public readonly avatarManager: AvatarManager;
	public readonly repo: ProductionGitRepository;
	public readonly gerrit: GerritDataSource;
	public readonly gitRunner: GitRunnerPort;
	public readonly auxViews: AuxiliaryViewsPort;
	public readonly extensionState: ExtensionState;
	public readonly logger: Logger;
	public readonly repoManager: RepoManager;
	public readonly panels: PanelRegistry;
	public readonly config: ConfigProvider;
	private readonly gitResolution: GitResolution;

	/**
	 * The Git executable the commands run on: the deferred resolution's current value (the
	 * persisted last-good record until the background validation answers, then its result), and
	 * NULL while the workspace is untrusted — Git must not run there.
	 */
	public get gitExecutable(): GitExecutable | null {
		return this.gitResolution.current();
	}

	/**
	 * Creates the Git Graph Command Manager.
	 * @param services The extension services (the composition root's frozen bag):
	 * every collaborator the handlers run with.
	 * @param panels The registry of the live Git Graph view (the view-opening commands open
	 * through it).
	 */
	constructor(services: ExtensionServices, panels: PanelRegistry) {
		super();
		this.context = services.context;
		this.avatarManager = services.avatars;
		this.repo = services.repo;
		this.gerrit = services.gerrit;
		this.gitRunner = services.git;
		this.auxViews = services.auxViews;
		this.extensionState = services.state;
		this.logger = services.logger;
		this.repoManager = services.repos;
		this.gitResolution = services.gitResolution;
		this.config = services.config;
		this.panels = panels;

		// P1 tracing: gated by the same setting as the session log, and
		// every recorded trace is written to that log in the one-line shape
		// scripts/analyze-log.mjs aggregates into P50/P95. The ring buffer itself is read through
		// shared/perf/trace's `traces()` (the Diagnostics command, ./diagnostics).
		// The extension entry (src/extension/main.ts) calls setEnabled before its ACTIVATION mark
		// so that mark is recorded; the wiring here re-asserts the value.
		setEnabled(this.config.current.enableLog);
		onTraceRecorded((trace) => this.logger.log('Trace ' + formatTrace(trace)));

		// Register Extension Commands (in registry order — see registry.ts)
		this.registerCommand('git-graph-rs.view', (arg) => view(this, arg));
		this.registerCommand('git-graph-rs.filterByFile', (arg) => filterByFile(this, arg));
		this.registerCommand('git-graph-rs.addGitRepository', () => addGitRepository(this));
		this.registerCommand('git-graph-rs.removeGitRepository', () => removeGitRepository(this));
		this.registerCommand('git-graph-rs.clearAvatarCache', () => clearAvatarCache(this));
		this.registerCommand('git-graph-rs.fetch', () => fetch(this));
		this.registerCommand('git-graph-rs.endAllWorkspaceCodeReviews', () => endAllWorkspaceCodeReviews(this));
		this.registerCommand('git-graph-rs.endSpecificWorkspaceCodeReview', () => endSpecificWorkspaceCodeReview(this));
		this.registerCommand('git-graph-rs.resumeWorkspaceCodeReview', () => resumeWorkspaceCodeReview(this));
		this.registerCommand('git-graph-rs.version', () => version(this));
		this.registerCommand('git-graph-rs.showDiagnostics', () => showDiagnostics(this));
		this.registerCommand('git-graph-rs.searchCommits', () => searchCommits(this));
		this.registerCommand('git-graph-rs.openFile', (arg) => openFile(this, arg));
		if (automationAvailable()) {
			this.registerCommand('git-graph-rs.runAutomationTest', (arg) => runAutomationTest(this, arg));
		}
		this.registerCommand('git-graph-rs.amendLastCommit', (arg) => amendLastCommit(this, arg));
		this.registerCommand('git-graph-rs.resetCurrentBranchToRemote', (arg) => resetCurrentBranchToRemote(this, arg));
		this.registerCommand('git-graph-rs.gerritPushRef', (arg) => gerritPushRef(this, arg));
		this.registerCommand('git-graph-rs.gerritFetchCommitMsgHook', (arg) => gerritFetchCommitMsgHook(this, arg));
		// A command's title cannot follow an Extension Setting, so every command offered in the
		// Source Control view's menus also ships under a ".zhCn" variant titled in Simplified
		// Chinese; the "git-graph-rs:interfaceZhCn" Context set below decides which variant the
		// menus and the Command Palette offer.
		this.registerCommand('git-graph-rs.amendLastCommit.zhCn', (arg) => amendLastCommit(this, arg));
		this.registerCommand('git-graph-rs.resetCurrentBranchToRemote.zhCn', (arg) => resetCurrentBranchToRemote(this, arg));
		this.registerCommand('git-graph-rs.gerritPushRef.zhCn', (arg) => gerritPushRef(this, arg));
		this.registerCommand('git-graph-rs.gerritFetchCommitMsgHook.zhCn', (arg) => gerritFetchCommitMsgHook(this, arg));

		// Register Extension Contexts
		try {
			this.registerContext('git-graph-rs:codiconsSupported', doesVersionMeetRequirement(vscode.version, VsCodeVersionRequirement.Codicons));
		} catch (_) {
			this.logger.logError('Unable to set Visual Studio Code Context "git-graph-rs:codiconsSupported"');
		}
		this.updateInterfaceLanguageContext();
		this.registerDisposable(
			services.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-graph-rs.interfaceLanguage')) this.updateInterfaceLanguageContext();
				// P1: the trace layer follows the log gate live.
				if (event.affectsConfiguration('git-graph-rs.enableLog')) setEnabled(this.config.current.enableLog);
			})
		);
	}

	/**
	 * Register a Git Graph command with Visual Studio Code.
	 * @param command A unique identifier for the command (which must be declared in the registry).
	 * @param callback A command handler function.
	 */
	private registerCommand(command: CommandId, callback: (...args: unknown[]) => unknown) {
		this.registerDisposable(
			vscode.commands.registerCommand(command, async (...args: unknown[]) => {
				// T0 (P1): the view-opening commands begin the boot trace the panel's T1/T3 marks
				// join; the webview completes it with its T2/T4/T5 batch (the `webviewTraces`
				// message). Other commands start no trace - they are not part of the measured
				// open path.
				if (isEnabled() && (command === 'git-graph-rs.view' || command === 'git-graph-rs.filterByFile')) {
					begin('boot');
					mark(MARK.commandDispatch);
				}
				// Restricted Mode: the Git-running commands are refused outright — the engine
				// keeps serving the reads, but nothing may spawn `git` in an untrusted folder.
				if (RESTRICTED_COMMANDS.has(command) && this.gitResolution.restricted()) {
					this.logger.log('Command refused in Restricted Mode: ' + command);
					void showInformationMessage(t('restrictedModeNotice'));
					return undefined;
				}
				// Git-dependent commands await the background resolution before running.
				if (GIT_AWAITING_COMMANDS.has(command)) await this.gitResolution.ready();
				this.logger.log('Command Invoked: ' + command);
				try {
					const result = callback(...args);
					// Forward the handler's result so a caller awaiting executeCommand observes the
					// handler's COMPLETION, not its dispatch (the automation server relies on this
					// to hold its dialog auto-answer over every notification and modal the command
					// raises). The catch keeps the forwarded promise resolving — never rejecting —
					// so no caller inherits an unhandled rejection.
					if (result !== undefined && result !== null && typeof (<Promise<void>>result).catch === 'function') {
						return (<Promise<void>>result).catch((error) => {
							this.logger.logError('Command "' + command + '" failed: ' + error);
						});
					}
					return result;
				} catch (error) {
					this.logger.logError('Command "' + command + '" failed: ' + error);
					return undefined;
				}
			})
		);
	}

	/**
	 * Register a context with Visual Studio Code.
	 * @param key The Context Key.
	 * @param value The Context Value.
	 */
	private registerContext(key: string, value: boolean) {
		return vscode.commands.executeCommand('setContext', key, value).then(
			() => this.logger.log('Successfully set Visual Studio Code Context "' + key + '" to "' + JSON.stringify(value) + '"'),
			() => this.logger.logError('Failed to set Visual Studio Code Context "' + key + '" to "' + JSON.stringify(value) + '"')
		);
	}

	/**
	 * Set the "git-graph-rs:interfaceZhCn" Context to the currently configured interface language,
	 * deciding whether the Source Control view's menus and the Command Palette offer each command's
	 * English- or Simplified-Chinese-titled variant.
	 */
	private updateInterfaceLanguageContext() {
		this.registerContext('git-graph-rs:interfaceZhCn', isZhCn());
	}
}
