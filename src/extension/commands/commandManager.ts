import * as vscode from 'vscode';
import { AvatarManager } from '../../avatarManager';
import type { GerritDataSource } from '../integrations/gerrit/gerrit';
import type { GitRunnerPort, LegacyViewPort } from '../graphView/gitRunner';
import type { ProductionGitRepository } from '../git/gitRepository';
import { ExtensionState } from '../../extensionState';
import { isZhCn } from '../../i18n';
import { Logger } from '../../logger';
import { RepoManager } from '../repos/repoManager';
import { Disposable } from '../../utils/disposable';
import { GgEvent } from '../../utils/event';
import { GitExecutable } from '../../utils/findGit';
import { VsCodeVersionRequirement, doesVersionMeetRequirement } from '../../utils/git';
import type { CommandHost } from './context';
import type { CommandId } from './registry';
import { automationAvailable, runAutomationTest } from './automation';
import { endAllWorkspaceCodeReviews, endSpecificWorkspaceCodeReview, resumeWorkspaceCodeReview } from './codeReviews';
import { searchCommits } from './commits';
import { gerritFetchCommitMsgHook, gerritPushRef } from './gerrit';
import { clearAvatarCache, openFile, version } from './misc';
import { addGitRepository, removeGitRepository } from './repositories';
import { amendLastCommit, resetCurrentBranchToRemote } from './sourceControl';
import { fetch, filterByFile, view } from './view';

/**
 * Manages the registration and execution of Git Graph Commands.
 *
 * The handlers live in the per-group modules of `src/extension/commands/` (task 4.6); this
 * class owns the registration order, the shared invocation wrapper (logging and promise
 * forwarding), the extension contexts, and disposal — and IS the {@link CommandHost} the
 * handlers run with.
 */
export class CommandManager extends Disposable implements CommandHost {
	public readonly context: vscode.ExtensionContext;
	public readonly avatarManager: AvatarManager;
	public readonly repo: ProductionGitRepository;
	public readonly gerrit: GerritDataSource;
	public readonly gitRunner: GitRunnerPort;
	public readonly legacyViews: LegacyViewPort;
	public readonly extensionState: ExtensionState;
	public readonly logger: Logger;
	public readonly repoManager: RepoManager;
	public gitExecutable: GitExecutable | null;

	/**
	 * Creates the Git Graph Command Manager.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param avatarManager The Git Graph AvatarManager instance.
	 * @param repo The GitRepository facade the commands read and write through.
	 * @param gitRunner The view's raw git runner (editor-script flows the ops do not model).
	 * @param gerrit The Gerrit integration over the same runner.
	 * @param gitRunner The view's raw git runner (editor-script flows the ops do not model).
	 * @param legacyViews The auxiliary views the panel hands off to.
	 * @param extensionState The Git Graph ExtensionState instance.
	 * @param repoManager The Git Graph RepoManager instance.
	 * @param gitExecutable The Git executable available to Git Graph at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 * @param onDidChangeConfiguration The Event emitting Visual Studio Code Configuration Change Events.
	 * @param logger The Git Graph Logger instance.
	 */
	constructor(context: vscode.ExtensionContext, avatarManager: AvatarManager, repo: ProductionGitRepository, gitRunner: GitRunnerPort, gerrit: GerritDataSource, legacyViews: LegacyViewPort, extensionState: ExtensionState, repoManager: RepoManager, gitExecutable: GitExecutable | null, onDidChangeGitExecutable: GgEvent<GitExecutable | null>, onDidChangeConfiguration: GgEvent<vscode.ConfigurationChangeEvent>, logger: Logger) {
		super();
		this.context = context;
		this.avatarManager = avatarManager;
		this.repo = repo;
		this.gerrit = gerrit;
		this.gitRunner = gitRunner;
		this.legacyViews = legacyViews;
		this.extensionState = extensionState;
		this.logger = logger;
		this.repoManager = repoManager;
		this.gitExecutable = gitExecutable;

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

		this.registerDisposable(
			onDidChangeGitExecutable((gitExecutable) => {
				this.gitExecutable = gitExecutable;
			})
		);

		// Register Extension Contexts
		try {
			this.registerContext('git-graph-rs:codiconsSupported', doesVersionMeetRequirement(vscode.version, VsCodeVersionRequirement.Codicons));
		} catch (_) {
			this.logger.logError('Unable to set Visual Studio Code Context "git-graph-rs:codiconsSupported"');
		}
		this.updateInterfaceLanguageContext();
		this.registerDisposable(
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-graph-rs.interfaceLanguage')) this.updateInterfaceLanguageContext();
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
			vscode.commands.registerCommand(command, (...args: unknown[]) => {
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
