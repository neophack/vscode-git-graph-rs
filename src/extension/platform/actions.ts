// Visual Studio Code command wrappers: the user-facing actions (diffs, files,
// archives, pull requests, dialogs) shared across the extension host.

import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { archive as archiveOp, WriteOp } from '../git/write/ops/index';
import { DiffSide, encodeDiffDocUri } from '../views/diffDocProvider';
import { Clipboard } from './clipboard';
import { Notifications, MessageChoice } from './notifications';
import {
	InputBoxOptionsLike, MessageOptionsLike, OpenDialogOptionsLike, ProgressLike, ProgressOptionsLike,
	QuickPickItemLike, QuickPickOptionsLike, SaveDialogOptionsLike, UiPort, UriLike
} from './uiPort';
import { t } from './i18n';
import { ErrorInfo } from '../../shared/protocol/messages';
import { GitFileStatus } from '../../shared/model/git';
import { PullRequestConfig, PullRequestProvider } from '../../shared/model/pullRequest';
import { UNCOMMITTED, abbrevCommit } from './git';
import { doesFileExist } from './paths';

// The platform adapter instances of this module (task 4.10), built on first use: merely
// importing this module never touches the vscode module surface (test fakes inject minimal
// `vscode` mocks), while every native-UI access still dispatches through one captured window.
// Property lookups happen at call time, so the automation suite's runtime monkey-patching of
// `vscode.window` keeps working until it is replaced by the ScriptedUiPort (plan 6.8.2). This
// is the interim production binding of {@link uiPort} until src/extension/platform/uiPort.ts
// gains its own implementation (INVENTORY.md #3/#5/#13-#24): when it ships, only this lazily
// built instance is rebound and no call site changes.
interface PlatformAdapters {
	readonly window: typeof vscode.window;
	readonly notifications: Notifications;
	readonly clipboard: Clipboard;
}

let platformAdapters: PlatformAdapters | null = null;

function adapters(): PlatformAdapters {
	if (platformAdapters === null) {
		const window = vscode.window;
		platformAdapters = { window: window, notifications: new Notifications(window), clipboard: new Clipboard(vscode.env.clipboard) };
	}
	return platformAdapters;
}

/** Whether a message-call argument after the message is the options object (not a choice item). */
function isMessageOptions<T extends MessageChoice>(value: MessageOptionsLike | T): value is MessageOptionsLike {
	return typeof value === 'object' && !('title' in value);
}

/**
 * The scripted-UiPort override (REFACTOR-PLAN task 4.10 / §6.8.2): the automation and E2E builds
 * install a ScriptedUiPort over this seam so every native dialog the host raises is answered from
 * a per-scenario script and recorded for assertions — the replacement for both the suite runner's
 * `nativeSaveDialog` skip and the command-mode `vscode.window` monkey-patching. Production never
 * installs one (this stays NULL and every method below takes its normal path), so the seam costs
 * one null check per dialog; the implementation lives in src/automation/scriptedUiPort.ts and is
 * absent from the default bundle entirely.
 */
let scriptedUiPort: UiPort | null = null;

/**
 * Install (or, with NULL, remove) the scripted UiPort override. Returns the previously installed
 * port so a caller can restore it. The automation suite runner installs a defaults-answering
 * port for the whole run; the E2E entry installs a strict per-scenario port around each scenario.
 */
export function setScriptedUiPort(port: UiPort | null): UiPort | null {
	const previous = scriptedUiPort;
	scriptedUiPort = port;
	return previous;
}

/**
 * Show a message through the captured window, with or without the options overload. Without
 * options the platform Notifications adapter serves the call (its degradation contract: an
 * unavailable or rejected dialog answers UNDEFINED); the options-bearing (modal) form forwards
 * directly, preserving the caller's rejection handling.
 */
function showMessage<T extends MessageChoice>(method: 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage', message: string, optionsOrFirstItem: MessageOptionsLike | T | undefined, items: T[]): Promise<T | undefined> {
	// The scripted override (automation/E2E builds) answers before the window is ever touched.
	if (scriptedUiPort !== null) {
		if (optionsOrFirstItem === undefined) return scriptedUiPort[method](message, ...items);
		if (isMessageOptions(optionsOrFirstItem)) return scriptedUiPort[method](message, optionsOrFirstItem, ...items);
		return scriptedUiPort[method](message, optionsOrFirstItem, ...items);
	}
	if (optionsOrFirstItem === undefined) {
		const adapter = adapters().notifications[method] as (message: string, ...items: T[]) => Promise<T | undefined>;
		return adapter(message, ...items);
	}
	const show = adapters().window[method];
	if (typeof show !== 'function') return Promise.resolve(undefined);
	if (isMessageOptions(optionsOrFirstItem)) {
		const withOptions = show as (message: string, options: MessageOptionsLike, ...items: T[]) => Thenable<T | undefined>;
		return Promise.resolve(withOptions(message, optionsOrFirstItem, ...items));
	}
	const withItems = show as (message: string, ...items: T[]) => Thenable<T | undefined>;
	return Promise.resolve(withItems(message, optionsOrFirstItem, ...items));
}

/**
 * The interim production UiPort (task 4.10): the modal/dialog/input/pick surface of the host,
 * typed against src/extension/platform/uiPort.ts so the E2E build can inject a ScriptedUiPort
 * over the same seam. The plain message forms delegate to the platform Notifications adapter.
 */
class WindowUiPort implements UiPort {
	public showInformationMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	public showInformationMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;
	public showInformationMessage<T extends MessageChoice>(message: string, optionsOrFirstItem?: MessageOptionsLike | T, ...items: T[]): Promise<T | undefined> {
		return showMessage('showInformationMessage', message, optionsOrFirstItem, items);
	}

	public showWarningMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	public showWarningMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;
	public showWarningMessage<T extends MessageChoice>(message: string, optionsOrFirstItem?: MessageOptionsLike | T, ...items: T[]): Promise<T | undefined> {
		return showMessage('showWarningMessage', message, optionsOrFirstItem, items);
	}

	public showErrorMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	public showErrorMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;
	public showErrorMessage<T extends MessageChoice>(message: string, optionsOrFirstItem?: MessageOptionsLike | T, ...items: T[]): Promise<T | undefined> {
		return showMessage('showErrorMessage', message, optionsOrFirstItem, items);
	}

	public showInputBox(options?: InputBoxOptionsLike): Promise<string | undefined> {
		if (scriptedUiPort !== null) return scriptedUiPort.showInputBox(options);
		const showInputBox = adapters().window.showInputBox;
		return typeof showInputBox === 'function' ? Promise.resolve(showInputBox(options)) : Promise.resolve(undefined);
	}

	public showQuickPick<T extends string | QuickPickItemLike>(items: ReadonlyArray<T>, options?: QuickPickOptionsLike): Promise<T | undefined> {
		if (scriptedUiPort !== null) return scriptedUiPort.showQuickPick(items, options);
		const showQuickPick = adapters().window.showQuickPick;
		if (typeof showQuickPick !== 'function') return Promise.resolve(undefined);
		// vscode.window satisfies this subset structurally; the cast bridges the QuickPickItem
		// generic bound of the official typing, which the structural check cannot express.
		const pick = showQuickPick as <T2 extends string | QuickPickItemLike>(items: ReadonlyArray<T2>, options?: QuickPickOptionsLike) => Thenable<T2 | undefined>;
		return Promise.resolve(pick(items, options));
	}

	public showSaveDialog(options: SaveDialogOptionsLike): Promise<UriLike | undefined> {
		if (scriptedUiPort !== null) return scriptedUiPort.showSaveDialog(options);
		const showSaveDialog = adapters().window.showSaveDialog;
		if (typeof showSaveDialog !== 'function') return Promise.resolve(undefined);
		return Promise.resolve(showSaveDialog(options as vscode.SaveDialogOptions));
	}

	public showOpenDialog(options: OpenDialogOptionsLike): Promise<ReadonlyArray<UriLike> | undefined> {
		if (scriptedUiPort !== null) return scriptedUiPort.showOpenDialog(options);
		const showOpenDialog = adapters().window.showOpenDialog;
		if (typeof showOpenDialog !== 'function') return Promise.resolve(undefined);
		return Promise.resolve(showOpenDialog(options as vscode.OpenDialogOptions));
	}

	public withProgress<R>(options: ProgressOptionsLike, task: (progress: ProgressLike, token: import('./uiPort').CancellationTokenLike) => Thenable<R>): Promise<R> {
		if (scriptedUiPort !== null) return scriptedUiPort.withProgress(options, task);
		// No degradation path here (unlike the dialogs): no host call site routes through the
		// port yet (INVENTORY.md #27 stays with its owner), so an absent API should surface.
		return Promise.resolve(adapters().window.withProgress(options as vscode.ProgressOptions, task));
	}
}

/**
 * The host's native-UI port (task 4.10): every modal, input, pick and dialog flow of the host
 * runs through this instance, so the flows are replayable by a scripted port and the 4.10 ESLint
 * rule can keep direct `vscode.window.show*` calls out of the host modules.
 */
export const uiPort: UiPort = new WindowUiPort();

/** The write seam the archive flow runs through (the facade's GitWriter satisfies it). */
export interface ArchiveWriter {
	run(repo: string, op: WriteOp): Promise<ErrorInfo>;
}

/**
 * Create an archive of a repository at a specific reference, and save to disk.
 * @param repo The path of the repository.
 * @param ref The reference of the revision to archive.
 * @param writer The GitWriter the archive write operation runs through.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function archive(repo: string, ref: string, writer: ArchiveWriter): Thenable<ErrorInfo> {
	return uiPort.showSaveDialog({
		defaultUri: vscode.Uri.file(repo),
		saveLabel: t('archiveSaveLabel'),
		filters: { [t('archiveTarFilter')]: ['tar'], [t('archiveZipFilter')]: ['zip'] }
	}).then(
		(uri) => {
			if (uri) {
				const extension = uri.fsPath.substring(uri.fsPath.lastIndexOf('.') + 1).toLowerCase();
				if (extension === 'tar' || extension === 'zip') {
					return writer.run(repo, archiveOp({ ref: ref, outputFilePath: uri.fsPath, type: extension }));
				} else {
					return t('archiveInvalidExtension', extension);
				}
			} else {
				return t('archiveNoFileName');
			}
		},
		() => t('archiveNoSaveDialog')
	);
}

/**
 * Copy the path of a file in a repository to the clipboard.
 * @param repo The repository the file is contained in.
 * @param filePath The relative path of the file within the repository.
 * @param absolute TRUE => Absolute path, FALSE => Relative path.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function copyFilePathToClipboard(repo: string, filePath: string, absolute: boolean) {
	return copyToClipboard(absolute ? path.join(repo, filePath) : filePath);
}

/**
 * Copy a string to the clipboard.
 * @param text The string.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function copyToClipboard(text: string): Thenable<ErrorInfo> {
	// The adapter's contract: FALSE on an unavailable or rejected write - exactly the signal
	// this wrapper turns into its localized failure message.
	return adapters().clipboard.write(text).then((written) => written ? null : t('clipboardWriteFailed'));
}

/**
 * Construct the URL for creating a new Pull Request, and open it in the users default web browser.
 * @param config The Pull Request Provider's Configuration.
 * @param sourceOwner The owner of the repository that is the source of the Pull Request.
 * @param sourceRepo The name of the repository that is the source of the Pull Request.
 * @param sourceBranch The source branch the Pull Request should be created from.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function createPullRequest(config: PullRequestConfig, sourceOwner: string, sourceRepo: string, sourceBranch: string) {
	let templateUrl;
	switch (config.provider) {
		case PullRequestProvider.Bitbucket:
			templateUrl = '$1/$2/$3/pull-requests/new?source=$2/$3::$4&dest=$5/$6::$8';
			break;
		case PullRequestProvider.Custom:
			templateUrl = config.custom.templateUrl;
			break;
		case PullRequestProvider.GitHub:
			templateUrl = '$1/$5/$6/compare/$8...$2:$4';
			break;
		case PullRequestProvider.GitLab:
			templateUrl = '$1/$2/$3/-/merge_requests/new?merge_request[source_branch]=$4&merge_request[target_branch]=$8' +
				(config.destProjectId !== '' ? '&merge_request[target_project_id]=$7' : '');
			break;
	}

	const urlFieldValues = [
		config.hostRootUrl,
		sourceOwner, sourceRepo, sourceBranch,
		config.destOwner, config.destRepo, config.destProjectId, config.destBranch
	];

	const url = templateUrl.replace(/\$([1-8])/g, (_, index) => urlFieldValues[parseInt(index) - 1]);

	return openExternalUrl(url, t('pullRequestUrlType'));
}

/**
 * Open the Visual Studio Code Settings Editor to the Git Graph Extension Settings.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function openExtensionSettings(): Thenable<ErrorInfo> {
	return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:aucneon.git-graph-rs').then(
		() => null,
		() => t('openExtensionSettingsFailed')
	);
}

/**
 * Open an External URL using the default application.
 * @param url The URL for Visual Studio Code to open.
 * @param type The type of URL being opened (defaults to "External URL").
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function openExternalUrl(url: string, type: string = t('externalUrlType')): Thenable<ErrorInfo> {
	const getErrorMessage = () => t('openUrlFailed', type, url);
	try {
		return vscode.env.openExternal(vscode.Uri.parse(url)).then(
			(success) => success ? null : getErrorMessage(),
			getErrorMessage
		);
	} catch (_) {
		return Promise.resolve(getErrorMessage());
	}
}

/** The rename-resolution read the open-file flows consult (a slice of the read backend). */
export interface RenamedPathReader {
	getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string): Promise<string | null>;
}

/**
 * Open a file within a repository in Visual Studio Code.
 * @param repo The repository the file is contained in.
 * @param filePath The relative path of the file within the repository.
 * @param hash An optional commit hash where the file is known to have existed.
 * @param renames An optional reader used to check if the file has been renamed.
 * @param viewColumn An optional ViewColumn that the file should be opened in.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export async function openFile(repo: string, filePath: string, hash: string | null = null, renames: RenamedPathReader | null = null, viewColumn: vscode.ViewColumn | null = null) {
	let newFilePath = filePath;
	let newAbsoluteFilePath = path.join(repo, newFilePath);
	let fileExists = await doesFileExist(newAbsoluteFilePath);
	if (!fileExists && hash !== null && renames !== null) {
		const renamedFilePath = await renames.getNewPathOfRenamedFile(repo, hash, filePath).catch(() => null);
		if (renamedFilePath !== null) {
			const renamedAbsoluteFilePath = path.join(repo, renamedFilePath);
			if (await doesFileExist(renamedAbsoluteFilePath)) {
				newFilePath = renamedFilePath;
				newAbsoluteFilePath = renamedAbsoluteFilePath;
				fileExists = true;
			}
		}
	}

	if (fileExists) {
		return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(newAbsoluteFilePath), {
			preview: true,
			viewColumn: viewColumn === null ? getConfig().openNewTabEditorGroup : viewColumn
		}).then(
			() => null,
			() => t('openFileFailed', newFilePath)
		);
	} else {
		return t('fileNotInRepo', newFilePath);
	}
}

/**
 * Resolve the actual left-side revision of a diff: UNCOMMITTED means "against HEAD", and a
 * left/right pair that are the same commit means "against that commit's own parent" — the
 * shorthand both the native Diff View and the binary/image comparison views rely on.
 * @param fromHash The nominal revision of the left-side of the Diff View.
 * @param toHash The revision of the right-side of the Diff View.
 * @returns The revision to actually diff from.
 */
export function resolveDiffFromHash(fromHash: string, toHash: string): string {
	if (fromHash === UNCOMMITTED) fromHash = 'HEAD';
	return fromHash === toHash ? fromHash + '^' : fromHash;
}

/**
 * Open the Visual Studio Code Diff View for a specific Git file change.
 * @param repo The repository the file is contained in.
 * @param fromHash The revision of the left-side of the Diff View.
 * @param toHash The revision of the right-side of the Diff View.
 * @param oldFilePath The relative path of the left-side file within the repository.
 * @param newFilePath The relative path of the right-side file within the repository.
 * @param type The Git file status of the change.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewDiff(repo: string, fromHash: string, toHash: string, oldFilePath: string, newFilePath: string, type: GitFileStatus) {
	if (type !== GitFileStatus.Untracked) {
		let abbrevFromHash = abbrevCommit(fromHash), abbrevToHash = toHash !== UNCOMMITTED ? abbrevCommit(toHash) : t('diffTitlePresent'), pathComponents = newFilePath.split('/');
		let desc = fromHash === toHash
			? fromHash === UNCOMMITTED
				? t('diffTitleUncommitted')
				: (type === GitFileStatus.Added ? t('diffTitleAddedIn', abbrevToHash) : type === GitFileStatus.Deleted ? t('diffTitleDeletedIn', abbrevToHash) : t('diffTitleChangedWithParent', abbrevFromHash, abbrevToHash))
			: (type === GitFileStatus.Added ? t('diffTitleAddedBetween', abbrevFromHash, abbrevToHash) : type === GitFileStatus.Deleted ? t('diffTitleDeletedBetween', abbrevFromHash, abbrevToHash) : t('diffTitleChanged', abbrevFromHash, abbrevToHash));
		let title = pathComponents[pathComponents.length - 1] + ' (' + desc + ')';

		return vscode.commands.executeCommand('vscode.diff', encodeDiffDocUri(repo, oldFilePath, resolveDiffFromHash(fromHash, toHash), type, DiffSide.Old), encodeDiffDocUri(repo, newFilePath, toHash, type, DiffSide.New), title, {
			preview: true,
			viewColumn: getConfig().openNewTabEditorGroup
		}).then(
			() => null,
			() => t('diffEditorFailed', newFilePath)
		);
	} else {
		return openFile(repo, newFilePath);
	}
}

/**
 * Open the Visual Studio Code Diff View to display the changes of a file between a commit hash and the working tree.
 * @param repo The repository the file is contained in.
 * @param hash The revision of the left-side of the Diff View.
 * @param filePath The relative path of the file within the repository.
 * @param renames The reader used to check if the file has been renamed.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export async function viewDiffWithWorkingFile(repo: string, hash: string, filePath: string, renames: RenamedPathReader) {
	let newFilePath = filePath;
	let fileExists = await doesFileExist(path.join(repo, newFilePath));
	if (!fileExists) {
		const renamedFilePath = await renames.getNewPathOfRenamedFile(repo, hash, filePath).catch(() => null);
		if (renamedFilePath !== null && await doesFileExist(path.join(repo, renamedFilePath))) {
			newFilePath = renamedFilePath;
			fileExists = true;
		}
	}

	const type = fileExists
		? filePath === newFilePath
			? GitFileStatus.Modified
			: GitFileStatus.Renamed
		: GitFileStatus.Deleted;

	return viewDiff(repo, hash, UNCOMMITTED, filePath, newFilePath, type);
}

/**
 * Open a Visual Studio Code Editor (readonly) for a file a specific Git revision.
 * @param repo The repository the file is contained in.
 * @param hash The revision of the file.
 * @param filePath The relative path of the file within the repository.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewFileAtRevision(repo: string, hash: string, filePath: string) {
	const pathComponents = filePath.split('/');
	const title = abbrevCommit(hash) + ': ' + pathComponents[pathComponents.length - 1];

	return vscode.commands.executeCommand('vscode.open', encodeDiffDocUri(repo, filePath, hash, GitFileStatus.Modified, DiffSide.New).with({ path: title }), {
		preview: true,
		viewColumn: getConfig().openNewTabEditorGroup
	}).then(
		() => null,
		() => t('viewFileAtRevisionFailed', filePath, abbrevCommit(hash))
	);
}

/**
 * Open the Visual Studio Code Source Control View.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewScm(): Thenable<ErrorInfo> {
	return vscode.commands.executeCommand('workbench.view.scm').then(
		() => null,
		() => t('openScmFailed')
	);
}

/**
 * Show a Visual Studio Code Information Message Dialog with the specified message.
 * Delegates to the platform notifications adapter (task 4.10, INVENTORY.md #9); every remaining
 * importer keeps this wrapper as its seam.
 * @param message The message to show.
 */
export function showInformationMessage(message: string) {
	return adapters().notifications.showInformationMessage(message).then(() => { }, () => { });
}

/**
 * Show a Visual Studio Code Error Message Dialog with the specified message.
 * Delegates to the platform notifications adapter (task 4.10, INVENTORY.md #10); every remaining
 * importer keeps this wrapper as its seam.
 * @param message The message to show.
 */
export function showErrorMessage(message: string) {
	return adapters().notifications.showErrorMessage(message).then(() => { }, () => { });
}
