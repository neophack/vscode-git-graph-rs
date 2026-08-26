import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider, decodeDiffDocUri } from './diffDocProvider';
import { CodeReviewData, CodeReviews, ExtensionState } from './extensionState';
import { extractChangeId, generateChangeId } from './gerrit';
import { GitGraphView } from './gitGraphView';
import { isZhCn, t } from './i18n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { ErrorInfo } from './types';
import { GitExecutable, VsCodeVersionRequirement, abbrevCommit, abbrevText, copyToClipboard, doesVersionMeetRequirement, getExtensionVersion, getPathFromStr, getPathFromUri, getRelativeTimeDiff, getRepoName, getSortedRepositoryPaths, isPathInWorkspace, isSafeRefName, openExternalUrl, openFile, resolveToSymbolicPath, showErrorMessage, showInformationMessage, unableToFindGitMsg } from './utils';
import { Disposable } from './utils/disposable';
import { GgEvent } from './utils/event';

/**
 * Manages the registration and execution of Git Graph Commands.
 */
export class CommandManager extends Disposable {
	private readonly context: vscode.ExtensionContext;
	private readonly avatarManager: AvatarManager;
	private readonly dataSource: DataSource;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private readonly repoManager: RepoManager;
	private gitExecutable: GitExecutable | null;

	/**
	 * Creates the Git Graph Command Manager.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param avatarManager The Git Graph AvatarManager instance.
	 * @param dataSource The Git Graph DataSource instance.
	 * @param extensionState The Git Graph ExtensionState instance.
	 * @param repoManager The Git Graph RepoManager instance.
	 * @param gitExecutable The Git executable available to Git Graph at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 * @param onDidChangeConfiguration The Event emitting Visual Studio Code Configuration Change Events.
	 * @param logger The Git Graph Logger instance.
	 */
	constructor(context: vscode.ExtensionContext, avatarManager: AvatarManager, dataSource: DataSource, extensionState: ExtensionState, repoManager: RepoManager, gitExecutable: GitExecutable | null, onDidChangeGitExecutable: GgEvent<GitExecutable | null>, onDidChangeConfiguration: GgEvent<vscode.ConfigurationChangeEvent>, logger: Logger) {
		super();
		this.context = context;
		this.avatarManager = avatarManager;
		this.dataSource = dataSource;
		this.extensionState = extensionState;
		this.logger = logger;
		this.repoManager = repoManager;
		this.gitExecutable = gitExecutable;

		// Register Extension Commands
		this.registerCommand('git-graph-rs.view', (arg) => this.view(arg));
		this.registerCommand('git-graph-rs.filterByFile', (arg) => this.filterByFile(arg));
		this.registerCommand('git-graph-rs.addGitRepository', () => this.addGitRepository());
		this.registerCommand('git-graph-rs.removeGitRepository', () => this.removeGitRepository());
		this.registerCommand('git-graph-rs.clearAvatarCache', () => this.clearAvatarCache());
		this.registerCommand('git-graph-rs.fetch', () => this.fetch());
		this.registerCommand('git-graph-rs.endAllWorkspaceCodeReviews', () => this.endAllWorkspaceCodeReviews());
		this.registerCommand('git-graph-rs.endSpecificWorkspaceCodeReview', () => this.endSpecificWorkspaceCodeReview());
		this.registerCommand('git-graph-rs.resumeWorkspaceCodeReview', () => this.resumeWorkspaceCodeReview());
		this.registerCommand('git-graph-rs.version', () => this.version());
		this.registerCommand('git-graph-rs.searchCommits', () => this.searchCommits());
		this.registerCommand('git-graph-rs.openFile', (arg) => this.openFile(arg));
		this.registerCommand('git-graph-rs.amendLastCommit', (arg) => this.amendLastCommit(arg));
		this.registerCommand('git-graph-rs.resetCurrentBranchToRemote', (arg) => this.resetCurrentBranchToRemote(arg));
		this.registerCommand('git-graph-rs.gerritPushRef', (arg) => this.gerritPushRef(arg));
		this.registerCommand('git-graph-rs.gerritFetchCommitMsgHook', (arg) => this.gerritFetchCommitMsgHook(arg));
		// A command's title cannot follow an Extension Setting, so every command offered in the
		// Source Control view's menus also ships under a ".zhCn" variant titled in Simplified
		// Chinese; the "git-graph-rs:interfaceZhCn" Context set below decides which variant the
		// menus and the Command Palette offer.
		this.registerCommand('git-graph-rs.amendLastCommit.zhCn', (arg) => this.amendLastCommit(arg));
		this.registerCommand('git-graph-rs.resetCurrentBranchToRemote.zhCn', (arg) => this.resetCurrentBranchToRemote(arg));
		this.registerCommand('git-graph-rs.gerritPushRef.zhCn', (arg) => this.gerritPushRef(arg));
		this.registerCommand('git-graph-rs.gerritFetchCommitMsgHook.zhCn', (arg) => this.gerritFetchCommitMsgHook(arg));

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
	 * @param command A unique identifier for the command.
	 * @param callback A command handler function.
	 */
	private registerCommand(command: string, callback: (...args: any[]) => any) {
		this.registerDisposable(
			vscode.commands.registerCommand(command, (...args: any[]) => {
				this.logger.log('Command Invoked: ' + command);
				try {
					const result = callback(...args);
					// Prevent unhandled promise rejections if the command handler is asynchronous
					if (result !== undefined && result !== null && typeof (<Promise<void>>result).catch === 'function') {
						(<Promise<void>>result).catch((error) => {
							this.logger.logError('Command "' + command + '" failed: ' + error);
						});
					}
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
	private registerContext(key: string, value: any) {
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


	/* Commands */

	/**
	 * Resolve the repository a command should operate on.
	 * Prefers a repository provided in the command argument (e.g. from the Source Control view),
	 * then the repository containing the active text editor document, and finally asks the user.
	 * @param arg The argument passed to the command.
	 * @returns The repository path, or NULL if it could not be determined or the user cancelled.
	 */
	private async getRepoFromCommandArg(arg: any): Promise<string | null> {
		if (typeof arg === 'object' && arg && arg.rootUri) {
			const repoPath = getPathFromUri(arg.rootUri);
			return await this.repoManager.getKnownRepo(repoPath) || this.repoManager.getRepoContainingFile(repoPath);
		}

		if (vscode.window.activeTextEditor) {
			const repo = this.repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
			if (repo !== null) return repo;
		}

		const repos = this.repoManager.getRepos();
		const repoPaths = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder);
		if (repoPaths.length === 0) return null;
		if (repoPaths.length === 1) return repoPaths[0];

		const items: vscode.QuickPickItem[] = repoPaths.map((path) => ({
			label: repos[path].name || getRepoName(path),
			description: path
		}));
		const item = await vscode.window.showQuickPick(items, { canPickMany: false, placeHolder: t('selectRepoForCommand') });
		return item && item.description !== undefined ? item.description : null;
	}

	/**
	 * The method run when the `git-graph-rs.amendLastCommit` command is invoked.
	 * Amends the last commit with the currently staged changes, keeping the existing commit message.
	 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Source Control View).
	 */
	private async amendLastCommit(arg: any) {
		if (this.gitExecutable === null) {
			showErrorMessage(unableToFindGitMsg());
			return;
		}

		const repo = await this.getRepoFromCommandArg(arg);
		if (repo === null) return;

		const errorInfo = await this.dataSource.amendLastCommit(repo);
		if (errorInfo !== null) {
			showErrorMessage(t('unableToAmendLastCommit', errorInfo));
		} else {
			showInformationMessage(t('amendedLastCommit', this.repoManager.getRepos()[repo].name || getRepoName(repo)));
		}
	}

	/**
	 * The method run when the `git-graph-rs.resetCurrentBranchToRemote` command is invoked.
	 * Soft resets the current branch to its upstream (remote tracking) branch, keeping all changes staged.
	 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Source Control View).
	 */
	private async resetCurrentBranchToRemote(arg: any) {
		if (this.gitExecutable === null) {
			showErrorMessage(unableToFindGitMsg());
			return;
		}

		const repo = await this.getRepoFromCommandArg(arg);
		if (repo === null) return;

		const upstream = await this.dataSource.getCurrentBranchUpstream(repo);
		if (upstream === null) {
			showErrorMessage(t('noUpstreamBranch'));
			return;
		}

		const confirmed = await vscode.window.showWarningMessage(
			t('resetToRemoteConfirm', upstream),
			{ modal: true },
			t('resetToRemoteButton')
		);
		if (confirmed !== t('resetToRemoteButton')) return;

		const errorInfo = await this.dataSource.resetCurrentBranchToRemote(repo);
		if (errorInfo !== null) {
			showErrorMessage(t('unableToResetToRemote', errorInfo));
		} else {
			showInformationMessage(t('resetToRemoteDone', upstream));
		}
	}

	/**
	 * The method run when the `git-graph-rs.gerritPushRef` command is invoked.
	 * Pushes HEAD to `refs/for/<current branch>` on the configured Gerrit remote for review,
	 * amending a Change-Id onto HEAD first if it has none (after asking).
	 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Source Control View).
	 */
	private async gerritPushRef(arg: any) {
		if (this.gitExecutable === null) {
			showErrorMessage(unableToFindGitMsg());
			return;
		}

		const repo = await this.getRepoFromCommandArg(arg);
		if (repo === null) return;

		const branch = await this.dataSource.gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], repo, (stdout) => stdout.trim()).catch(() => null);
		if (branch === null || branch === '') {
			showErrorMessage(t('gerritNoCommits'));
			return;
		}
		if (branch === 'HEAD') {
			showErrorMessage(t('gerritDetachedHead'));
			return;
		}
		if (!isSafeRefName(branch)) {
			showErrorMessage(t('gerritInvalidBranch', branch));
			return;
		}

		const amend = await this.ensureHeadChangeId(repo, true);
		if (amend.error !== null) {
			showErrorMessage(amend.error);
			return;
		}

		const remote = getConfig().gerrit.remote;
		try {
			const url = await this.dataSource.gitOutput(['push', remote, 'HEAD:refs/for/' + branch], repo, (stdout) => {
				const match = /(https?:\/\/\S*\/c\/\S*\/\+?\/?\d+)/.exec(stdout.replace(/\r?\n/g, ' '));
				return match !== null ? match[1] : null;
			});
			if (url !== null) {
				vscode.window.showInformationMessage(t('gerritPushedWithUrl', url), t('gerritOpenChange')).then((action) => {
					if (action === t('gerritOpenChange')) openExternalUrl(url);
				}, () => { });
			} else {
				showInformationMessage(t('gerritPushed', branch, remote));
			}
		} catch (errorMessage) {
			showErrorMessage(t('gerritPushFailed', String(errorMessage)));
		}
	}

	/**
	 * The method run when the `git-graph-rs.gerritFetchCommitMsgHook` command is invoked.
	 * Downloads the commit-msg hook from the Gerrit server of the configured remote and installs
	 * it into the repository's hooks directory (so new commits get a Change-Id automatically).
	 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Source Control View).
	 */
	private async gerritFetchCommitMsgHook(arg: any) {
		if (this.gitExecutable === null) {
			showErrorMessage(unableToFindGitMsg());
			return;
		}

		const repo = await this.getRepoFromCommandArg(arg);
		if (repo === null) return;

		const result = await this.dataSource.gerrit.installHook(repo, getConfig().gerrit.remote, 'commit-msg');
		if (result.error !== null) {
			showErrorMessage(t('gerritHookFailed', result.error));
		} else if (result.installed) {
			showInformationMessage(t('gerritHookInstalled'));
		} else {
			showInformationMessage(t('gerritHookUpToDate'));
		}
	}

	/**
	 * Ensure that HEAD has a Gerrit Change-Id footer, amending the commit if (and only if) it is
	 * safe to do so: HEAD must have no Change-Id yet, and must not have been pushed to any remote
	 * (amending an already-published commit would rewrite its history).
	 * @param repo The path of the repository.
	 * @param confirm Ask the user to confirm the amend before performing it (used by the push flow,
	 * where amending is a side effect of another action, rather than the action itself).
	 * @returns The error of the operation (NULL => HEAD already had a Change-Id, or one was amended),
	 *          the Change-Id of HEAD, and whether it was newly amended.
	 */
	private async ensureHeadChangeId(repo: string, confirm: boolean): Promise<{ error: ErrorInfo, changeId: string | null, amended: boolean }> {
		try {
			const message = await this.dataSource.gitOutput(['log', '-1', '--format=%B', 'HEAD', '--'], repo, (stdout) => stdout);
			const existing = extractChangeId(message);
			if (existing !== null) return { error: null, changeId: existing, amended: false }; // nothing to amend

			const remotes = await this.dataSource.gitOutput(['branch', '-r', '--no-color', '--contains=HEAD'], repo, (stdout) =>
				stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
			);
			if (remotes.length > 0) return { error: t('gerritChangeIdPushedError', remotes[0]), changeId: null, amended: false };

			// Generate the Change-Id Gerrit would assign to HEAD (same construction as the commit-msg hook)
			const changeId = await this.dataSource.gitOutput(['show', '-s', '--format=%T%n%P%n%an <%ae> %at%n%cn <%ce> %ct%n%B', 'HEAD'], repo, (stdout) => {
				const lines = stdout.split(/\r?\n/);
				return generateChangeId(lines[0], lines[1], lines[2], lines[3], lines.slice(4).join('\n'));
			});

			if (confirm) {
				const action = await vscode.window.showInformationMessage(
					t('gerritAmendConfirm', changeId.substring(0, 12)),
					t('gerritAmendAndPushButton'),
					t('gerritCancel')
				);
				if (action !== t('gerritAmendAndPushButton')) return { error: t('gerritAmendAborted'), changeId: null, amended: false };
			}

			const args = ['commit', '--amend', '-m', message.replace(/\s+$/, '') + '\n\nChange-Id: ' + changeId];
			if (getConfig().signCommits) args.push('-S');
			const error = await this.dataSource.runGitCommand(args, repo);
			return { error: error, changeId: changeId, amended: error === null };
		} catch (errorMessage) {
			return { error: String(errorMessage), changeId: null, amended: false };
		}
	}

	/**
	 * The method run when the `git-graph-rs.view` command is invoked.
	 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Git Extension).
	 */
	private async view(arg: any) {
		let loadRepo: string | null = null;

		if (typeof arg === 'object' && arg.rootUri) {
			// If command is run from the Visual Studio Code Source Control View, load the specific repo
			const repoPath = getPathFromUri(arg.rootUri);
			loadRepo = await this.repoManager.getKnownRepo(repoPath);
			if (loadRepo === null) {
				// The repo is not currently known, add it
				loadRepo = (await this.repoManager.registerRepo(await resolveToSymbolicPath(repoPath), true)).root;
			}
		} else if (getConfig().openToTheRepoOfTheActiveTextEditorDocument && vscode.window.activeTextEditor) {
			// If the config setting is enabled, load the repo containing the active text editor document
			loadRepo = this.repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
		}

		GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, loadRepo !== null ? { repo: loadRepo } : null);
	}

	/**
	 * The method run when the `git-graph-rs.filterByFile` command is invoked.
	 * Opens the Git Graph view filtered to only show commits that modified any of the specified
	 * files (multiple selected files are combined into a comma-separated filter).
	 * @param arg The argument passed to the command (file URIs, or objects containing file URIs).
	 */
	private async filterByFile(arg: any) {
		const uris = this.getUrisFromCommandArg(arg);
		if (uris.length === 0) {
			showErrorMessage(t('filterByFileUndetermined'));
			return;
		}

		const repo = this.repoManager.getRepoContainingFile(getPathFromUri(uris[0]));
		if (repo === null) {
			showErrorMessage(t('filterByFileNotInRepo', getPathFromUri(uris[0])));
			return;
		}

		// Compute the paths of the files relative to the repository root (using forward slashes, as
		// expected by git), joined into a comma-separated filter (paths containing commas are not
		// supported by this filter syntax)
		const filterPaths: string[] = [];
		for (const uri of uris) {
			const filePath = getPathFromUri(uri);
			if (this.repoManager.getRepoContainingFile(filePath) !== repo) {
				showErrorMessage(t('filterByFileMultipleRepos'));
				return;
			}
			let filterPath = getPathFromStr(path.relative(repo, filePath));
			if (filterPath === '') filterPath = '.';
			if (!filterPaths.includes(filterPath)) filterPaths.push(filterPath);
		}

		GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, { repo: repo, filterPath: filterPaths.join(',') });
	}

	/**
	 * Extract file URIs from a command argument (URIs, or objects containing URIs). When multiple
	 * items are selected in the explorer, VS Code passes an array of them.
	 * @param arg The argument passed to the command.
	 * @returns The file URIs (empty if none could be determined).
	 */
	private getUrisFromCommandArg(arg: any): vscode.Uri[] {
		const args = Array.isArray(arg) ? arg : [arg];
		const uris: vscode.Uri[] = [];
		for (const a of args) {
			if (a && a.resourceUri) uris.push(a.resourceUri); // e.g. a SourceControlResourceState
			else if (a && a.uri && a.uri.scheme) uris.push(a.uri);
			else if (a && a.scheme && a.fsPath) uris.push(a); // a URI
		}
		if (uris.length === 0 && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
			uris.push(vscode.window.activeTextEditor.document.uri);
		}
		return uris;
	}

	/**
	 * The method run when the `git-graph-rs.addGitRepository` command is invoked.
	 */
	private addGitRepository() {
		if (this.gitExecutable === null) {
			showErrorMessage(unableToFindGitMsg());
			return;
		}

		vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }).then(uris => {
			if (uris && uris.length > 0) {
				let path = getPathFromUri(uris[0]);
				if (isPathInWorkspace(path)) {
					this.repoManager.registerRepo(path, false).then(status => {
						if (status.error === null) {
							showInformationMessage(t('repoAdded', status.root!));
						} else {
							showErrorMessage(t('repoAddFailed', status.error));
						}
					});
				} else {
					showErrorMessage(t('folderNotInWorkspace', path));
				}
			}
		}, () => { });
	}

	/**
	 * The method run when the `git-graph-rs.removeGitRepository` command is invoked.
	 */
	private removeGitRepository() {
		if (this.gitExecutable === null) {
			showErrorMessage(unableToFindGitMsg());
			return;
		}

		const repos = this.repoManager.getRepos();
		const items: vscode.QuickPickItem[] = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder).map((path) => ({
			label: repos[path].name || getRepoName(path),
			description: path
		}));

		vscode.window.showQuickPick(items, {
			placeHolder: t('selectRepoToRemove'),
			canPickMany: false
		}).then((item) => {
			if (item && item.description !== undefined) {
				if (this.repoManager.ignoreRepo(item.description)) {
					showInformationMessage(t('repoRemoved', item.label));
				} else {
					showErrorMessage(t('repoNotKnown', item.label));
				}
			}
		}, () => { });
	}

	/**
	 * The method run when the `git-graph-rs.clearAvatarCache` command is invoked.
	 */
	private clearAvatarCache() {
		this.avatarManager.clearCache().then((errorInfo) => {
			if (errorInfo === null) {
				showInformationMessage(t('avatarCacheCleared'));
			} else {
				showErrorMessage(errorInfo);
			}
		}, () => {
			showErrorMessage(t('unexpectedErrorInCommand', 'Clear Avatar Cache'));
		});
	}

	/**
	 * The method run when the `git-graph-rs.fetch` command is invoked.
	 */
	private fetch() {
		const repos = this.repoManager.getRepos();
		const repoPaths = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder);

		if (repoPaths.length > 1) {
			const items: vscode.QuickPickItem[] = repoPaths.map((path) => ({
				label: repos[path].name || getRepoName(path),
				description: path
			}));

			const lastActiveRepo = this.extensionState.getLastActiveRepo();
			if (lastActiveRepo !== null) {
				let lastActiveRepoIndex = items.findIndex((item) => item.description === lastActiveRepo);
				if (lastActiveRepoIndex > -1) {
					const item = items.splice(lastActiveRepoIndex, 1)[0];
					items.unshift(item);
				}
			}

			vscode.window.showQuickPick(items, {
				placeHolder: t('selectRepoToFetch'),
				canPickMany: false
			}).then((item) => {
				if (item && item.description) {
					GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
						repo: item.description,
						runCommandOnLoad: 'fetch'
					});
				}
			}, () => {
				showErrorMessage(t('unexpectedErrorInCommand', 'Fetch from Remote(s)'));
			});
		} else if (repoPaths.length === 1) {
			GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
				repo: repoPaths[0],
				runCommandOnLoad: 'fetch'
			});
		} else {
			GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, null);
		}
	}

	/**
	 * The method run when the `git-graph-rs.endAllWorkspaceCodeReviews` command is invoked.
	 */
	private endAllWorkspaceCodeReviews() {
		this.extensionState.endAllWorkspaceCodeReviews();
		showInformationMessage(t('endedAllCodeReviews'));
	}

	/**
	 * The method run when the `git-graph-rs.endSpecificWorkspaceCodeReview` command is invoked.
	 */
	private endSpecificWorkspaceCodeReview() {
		const codeReviews = this.extensionState.getCodeReviews();
		if (Object.keys(codeReviews).length === 0) {
			showErrorMessage(t('noCodeReviewsInProgress'));
			return;
		}

		vscode.window.showQuickPick(this.getCodeReviewQuickPickItems(codeReviews), {
			placeHolder: t('selectCodeReviewToEnd'),
			canPickMany: false
		}).then((item) => {
			if (item) {
				this.extensionState.endCodeReview(item.codeReviewRepo, item.codeReviewId).then((errorInfo) => {
					if (errorInfo === null) {
						showInformationMessage(t('endedCodeReview', item.label));
					} else {
						showErrorMessage(errorInfo);
					}
				}, () => { });
			}
		}, () => {
			showErrorMessage(t('unexpectedErrorInCommand', 'End a specific Code Review in Workspace...'));
		});
	}

	/**
	 * The method run when the `git-graph-rs.resumeWorkspaceCodeReview` command is invoked.
	 */
	private resumeWorkspaceCodeReview() {
		const codeReviews = this.extensionState.getCodeReviews();
		if (Object.keys(codeReviews).length === 0) {
			showErrorMessage(t('noCodeReviewsInProgress'));
			return;
		}

		vscode.window.showQuickPick(this.getCodeReviewQuickPickItems(codeReviews), {
			placeHolder: t('selectCodeReviewToResume'),
			canPickMany: false
		}).then((item) => {
			if (item) {
				const commitHashes = item.codeReviewId.split('-');
				GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
					repo: item.codeReviewRepo,
					commitDetails: {
						commitHash: commitHashes[commitHashes.length > 1 ? 1 : 0],
						compareWithHash: commitHashes.length > 1 ? commitHashes[0] : null
					}
				});
			}
		}, () => {
			showErrorMessage(t('unexpectedErrorInCommand', 'Resume a specific Code Review in Workspace...'));
		});
	}

	/**
	 * The method run when the `git-graph-rs.version` command is invoked.
	 */
	/**
	 * The method run when the `git-graph-rs.searchCommits` command is invoked.
	 */
	private async searchCommits() {
		if (this.gitExecutable === null) {
			showErrorMessage(unableToFindGitMsg());
			return;
		}
		const repos = this.repoManager.getRepos();
		const repoOptions = Object.keys(repos).sort();
		if (repoOptions.length === 0) return;

		let repo: string;
		if (repoOptions.length === 1) {
			repo = repoOptions[0];
		} else {
			const selectedRepo = await vscode.window.showQuickPick(repoOptions, { placeHolder: t('selectRepoToSearch') });
			if (!selectedRepo) return;
			repo = selectedRepo;
		}

		const query = await vscode.window.showInputBox({
			prompt: t('searchCommitsPrompt'),
			placeHolder: t('searchCommitsPlaceholder')
		});
		if (typeof query !== 'string' || query.trim() === '') return;

		try {
			const commits = await this.dataSource.searchHistory(repo, query.trim());
			if (commits.length === 0) {
				vscode.window.showInformationMessage(t('noCommitsFound'));
				return;
			}
			const items = commits.map(c => ({
				label: c.hash.substring(0, 8),
				description: c.message,
				detail: c.author + ' - ' + new Date(c.date * 1000).toLocaleString(),
				commitHash: c.hash
			}));
			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: t('selectCommitToView'),
				matchOnDescription: true,
				matchOnDetail: true
			});
			if (selected) {
				GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, { repo: repo, findCommitHash: selected.commitHash });
			}
		} catch (err) {
			showErrorMessage(t('searchCommitsError'));
		}
	}

	private async version() {
		try {
			const gitGraphVersion = await getExtensionVersion(this.context);
			const information = t('versionInfo', gitGraphVersion, vscode.version, os.type() + ' ' + os.arch() + ' ' + os.release(), this.gitExecutable !== null ? this.gitExecutable.version : '(none)');
			vscode.window.showInformationMessage(information, { modal: true }, t('copyButton')).then((selectedItem) => {
				if (selectedItem === t('copyButton')) {
					copyToClipboard(information).then((result) => {
						if (result !== null) {
							showErrorMessage(result);
						}
					});
				}
			}, () => { });
		} catch (_) {
			showErrorMessage(t('versionInfoError'));
		}
	}

	/**
	 * Opens a file in Visual Studio Code, based on a Git Graph URI (from the Diff View).
	 * The method run when the `git-graph-rs.openFile` command is invoked.
	 * @param arg The Git Graph URI.
	 */
	private openFile(arg?: vscode.Uri) {
		const uri = arg || vscode.window.activeTextEditor?.document.uri;
		if (typeof uri === 'object' && uri && uri.scheme === DiffDocProvider.scheme) {
			// A Git Graph URI has been provided
			const request = decodeDiffDocUri(uri);
			return openFile(request.repo, request.filePath, request.commit, this.dataSource, vscode.ViewColumn.Active).then((errorInfo) => {
				if (errorInfo !== null) {
					return showErrorMessage(t('unableToOpenFile', errorInfo));
				}
			});
		} else {
			return showErrorMessage(t('openFileMissingArgs'));
		}
	}


	/* Helper Methods */

	/**
	 * Transform a set of Code Reviews into a list of Quick Pick items for use with `vscode.window.showQuickPick`.
	 * @param codeReviews A set of Code Reviews.
	 * @returns A list of Quick Pick items.
	 */
	private getCodeReviewQuickPickItems(codeReviews: CodeReviews): Promise<CodeReviewQuickPickItem[]> {
		const repos = this.repoManager.getRepos();
		const enrichedCodeReviews: { repo: string, id: string, review: CodeReviewData, fromCommitHash: string, toCommitHash: string }[] = [];
		const fetchCommits: { repo: string, commitHash: string }[] = [];

		Object.keys(codeReviews).forEach((repo) => {
			if (typeof repos[repo] === 'undefined') return;
			Object.keys(codeReviews[repo]).forEach((id) => {
				const commitHashes = id.split('-');
				commitHashes.forEach((commitHash) => fetchCommits.push({ repo: repo, commitHash: commitHash }));
				enrichedCodeReviews.push({
					repo: repo, id: id, review: codeReviews[repo][id],
					fromCommitHash: commitHashes[0], toCommitHash: commitHashes[commitHashes.length > 1 ? 1 : 0]
				});
			});
		});

		return Promise.all(fetchCommits.map((fetch) => this.dataSource.getCommitSubject(fetch.repo, fetch.commitHash))).then(
			(subjects) => {
				const commitSubjects: { [repo: string]: { [commitHash: string]: string } } = {};
				subjects.forEach((subject, i) => {
					if (typeof commitSubjects[fetchCommits[i].repo] === 'undefined') {
						commitSubjects[fetchCommits[i].repo] = {};
					}
					commitSubjects[fetchCommits[i].repo][fetchCommits[i].commitHash] = subject !== null ? subject : t('unknownCommitSubject');
				});

				return enrichedCodeReviews.sort((a, b) => b.review.lastActive - a.review.lastActive).map((codeReview) => {
					const fromSubject = commitSubjects[codeReview.repo][codeReview.fromCommitHash];
					const toSubject = commitSubjects[codeReview.repo][codeReview.toCommitHash];
					const isComparison = codeReview.fromCommitHash !== codeReview.toCommitHash;
					return {
						codeReviewRepo: codeReview.repo,
						codeReviewId: codeReview.id,
						label: (repos[codeReview.repo].name || getRepoName(codeReview.repo)) + ': ' + abbrevCommit(codeReview.fromCommitHash) + (isComparison ? ' ↔ ' + abbrevCommit(codeReview.toCommitHash) : ''),
						description: getRelativeTimeDiff(Math.round(codeReview.review.lastActive / 1000)),
						detail: isComparison
							? abbrevText(fromSubject, 50) + ' ↔ ' + abbrevText(toSubject, 50)
							: fromSubject
					};
				});
			}
		);
	}
}

interface CodeReviewQuickPickItem extends vscode.QuickPickItem {
	codeReviewRepo: string;
	codeReviewId: string;
}
