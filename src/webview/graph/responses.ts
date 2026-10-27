/**
 * The ResponseRouter (REFACTOR-PLAN task 5.3): every response the extension host can send, mapped
 * to what the view does with it. The table is typed over the protocol's response union, so a
 * response without a handler (or a handler for a response that does not exist) is a compile
 * error.
 *
 * The write actions all answer in one of a few shapes, which the generic handlers below capture:
 * refresh the view on success or show the error (`refresh`), do the same for actions that run
 * several steps and may partly succeed (`refreshAll`), or only report a failure (`finish`).
 */

import { escapeHtml, formatCommaSeparatedHtml, html, setHtml } from '../common/html';
import { ImageResizer } from '../common/imageResizer';
import { formatStr, markup, strings } from '../common/i18n/index';
import { SVG_ICONS } from '../common/icons';
import * as GG from '../common/protocol';
import { isExtensionErrorInfo, parseExtensionErrorInfo, reduceErrorInfos } from '../common/util';
import { isEnabled, mark, MARK, setEnabled } from '../../shared/perf/trace';
import { getMergeActionOnName, getRebaseActionOnName } from './actions/dialogActions';
import { showTagDetails } from './actions/tagDetails';
import { GraphContext } from './context';
import { DialogInputType } from './widgets/dialog';
import { TargetType } from './state/types';

type ResponseCommand = GG.ResponseMessage['command'];
type ResponseOf<C extends ResponseCommand> = Extract<GG.ResponseMessage, { command: C }>;
type ResponseHandlers = { readonly [C in ResponseCommand]: (msg: ResponseOf<C>) => void };

/**
 * Create the function that handles the responses of the extension host. The string tables must
 * already be set (the error titles are read when the router is created).
 */
export function createResponseRouter(ctx: GraphContext): (msg: GG.ResponseMessage) => void {
	const dialog = ctx.dialog;
	const imageResizer = new ImageResizer();


	/* Generic action handlers */

	/**
	 * The write-action success contract of REFACTOR-PLAN task 4.8: after a write succeeds, the
	 * view does NOT refresh itself — the extension host pushes the impact-based partial update
	 * (the re-annotated refs page, the uncommitted-changes row, the repository configuration, or
	 * one incremental traversal reload) picked from the write's effects. On success only the
	 * action's "running" dialog is dismissed; on failure the error shows exactly as before.
	 */
	const completeOrDisplayError = (error: GG.ErrorInfo, errorMessage: string) => {
		if (error === null) {
			dialog.closeActionRunning();
		} else {
			dialog.showError(errorMessage, error, null, null);
		}
	};

	/** The multi-step form of {@link completeOrDisplayError}: any partial success dismisses the "running" dialog. */
	const completeAndDisplayErrors = (errors: GG.ErrorInfo[], errorMessage: string) => {
		const reducedErrors = reduceErrorInfos(errors);
		if (reducedErrors.error !== null) {
			dialog.showError(errorMessage, reducedErrors.error, null, null);
		}
		if (reducedErrors.partialOrCompleteSuccess) {
			dialog.closeActionRunning();
		}
	};

	/**
	 * The few write responses whose refresh the VIEW still owns (the host pushes nothing for
	 * them): `exportRepoConfig` writes a file outside the repository, and `gerritSetFetchRefs`
	 * must reload under the integration's NEW fetch settings, which only this view holds.
	 */
	const refreshViewOrDisplayError = (error: GG.ErrorInfo, errorMessage: string, configChanges: boolean = false) => {
		if (error === null) {
			ctx.loader.refresh(false, configChanges);
		} else {
			dialog.showError(errorMessage, error, null, null);
		}
	};

	/** Only report a failure of the action (dismissing its "running" dialog on success when asked). */
	const finishOrDisplayError = (error: GG.ErrorInfo, errorMessage: string, dismissActionRunning: boolean = false) => {
		if (error !== null) {
			dialog.showError(errorMessage, error, null, null);
		} else if (dismissActionRunning) {
			dialog.closeActionRunning();
		}
	};

	const finishOrDisplayErrors = (errors: GG.ErrorInfo[], errorMessage: string, partialOrCompleteSuccessCallback: () => void, dismissActionRunning: boolean = false) => {
		const reducedErrors = reduceErrorInfos(errors);
		finishOrDisplayError(reducedErrors.error, errorMessage, dismissActionRunning);
		if (reducedErrors.partialOrCompleteSuccess) {
			partialOrCompleteSuccessCallback();
		}
	};

	/** The handler of an action answered by a single error: the host pushes the refresh (task 4.8). */
	const complete = (errorMessage: string) => (msg: { readonly error: GG.ErrorInfo }) => completeOrDisplayError(msg.error, errorMessage);
	/** The handler of an action answered by several errors: the host pushes the refresh (task 4.8). */
	const completeAll = (errorMessage: string) => (msg: { readonly errors: GG.ErrorInfo[] }) => completeAndDisplayErrors(msg.errors, errorMessage);
	/** The handler of an action answered by a single error: only report a failure. */
	const finish = (errorMessage: string, dismissActionRunning: boolean = false) => (msg: { readonly error: GG.ErrorInfo }) => finishOrDisplayError(msg.error, errorMessage, dismissActionRunning);
	/** The handler of an action that failed: show the error (the success is handled elsewhere). */
	const showFailure = (errorMessage: string) => (msg: { readonly error: GG.ErrorInfo }) => {
		if (msg.error !== null) dialog.showError(errorMessage, msg.error, null, null);
	};

	const handleResponsePushTagCommitNotOnRemote = (repo: string, tagName: string, remotes: string[], commitHash: string, error: string) => {
		const remotesNotContainingCommit: string[] = parseExtensionErrorInfo(error, GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote);
		const plural = remotesNotContainingCommit.length > 1;
		const names = (list: ReadonlyArray<string>) => formatCommaSeparatedHtml(list.map((remote) => html`<b><i>${remote}</i></b>`));

		dialog.showForm(html`<span class="dialogAlert">${SVG_ICONS.alert}${plural ? strings.warnCommitNotOnRemotes : strings.warnCommitNotOnRemote}</span><br><span class="messageContent"><p style="margin:0 0 6px 0;">${formatStr(plural ? markup.tagCommitNotOnRemotePlural : markup.tagCommitNotOnRemoteSingular, tagName, names(remotesNotContainingCommit))}</p><p style="margin:0;">${formatStr(escapeHtml(remotes.length > 1 ? strings.proceedPushTagPlural : strings.proceedPushTagSingular), names(remotes))}</p></span>`, [{ type: DialogInputType.Checkbox, name: strings.alwaysProceedCheckbox, value: false }], strings.proceedToPushAction, (values) => {
			if (<boolean>values[0]) {
				ctx.persistence.updateGlobalViewState('pushTagSkipRemoteCheck', true);
			}
			ctx.actions.run({
				command: 'pushTag',
				repo: repo,
				tagName: tagName,
				remotes: remotes,
				commitHash: commitHash,
				skipRemoteCheck: true
			}, strings.pushingTag);
		}, { type: TargetType.Repo }, strings.dialogCancel, null, true);
	};


	/* The response table */

	const handlers: ResponseHandlers = {
		abortOperation: complete(strings.errAbortOperation),
		addRemote: complete(strings.errAddRemote),
		addTag: (msg) => {
			if (msg.pushToRemote !== null && msg.errors.length === 2 && msg.errors[0] === null && isExtensionErrorInfo(msg.errors[1], GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote)) {
				// The tag itself was created (the host pushed the refs-only refresh for it); only
				// the push still needs the user's decision
				handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.errors[1]!);
			} else {
				completeAll(strings.errAddTag)(msg);
			}
		},
		applyStash: complete(strings.errApplyStash),
		branchFromStash: complete(strings.errBranchFromStash),
		checkoutBranch: (msg) => completeAndDisplayErrors(msg.errors, msg.pullAfterwards !== null ? strings.errCheckoutBranchPull : strings.errCheckoutBranch),
		checkoutCommit: (msg) => completeOrDisplayError(msg.error, strings.errCheckoutCommit),
		cherrypickCommit: completeAll(strings.errCherryPick),
		cleanUntrackedFiles: complete(strings.errCleanUntracked),
		commitFixup: complete(strings.errCommitFixup),
		commitSquash: complete(strings.errCommitSquash),
		continueOperation: complete(strings.errContinueOperation),
		predictConflicts: (msg) => {
			// Only patches the dialog if it is still showing (or fading out) for the same
			// ours/theirs pair the prediction was requested for - a stale response for a
			// dialog the user has since replaced with a different one must not patch it. A
			// NULL prediction (git too old, or the probe itself failed) leaves the placeholder
			// hidden, and a clean prediction never surfaces to the user.
			const dialogElem = ctx.dialog.openElem;
			const box = dialogElem !== null ? dialogElem.querySelector<HTMLElement>('#predictedConflicts') : null;
			if (box !== null && box.getAttribute('data-ours') === msg.ours && box.getAttribute('data-theirs') === msg.theirs && msg.prediction !== null && msg.prediction.conflicted) {
				box.style.display = '';
				setHtml(box, html`<br><span class="dialogAlert warning">${SVG_ICONS.alert}${strings.conflictPredictedTitle}</span><span class="messageContent"><b>${strings.conflictBannerFilesLabel}</b> ${msg.prediction.files.map((file, i) => (i > 0 ? ', ' : '') + file)}</span>`);
			}
		},
		commitDetails: (msg) => {
			if (msg.commitDetails !== null) {
				ctx.details.showDetails(msg.commitDetails, ctx.details.createFileTree(msg.commitDetails.fileChanges, msg.codeReview), msg.avatar, msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
			} else {
				ctx.details.close(true);
				dialog.showError(strings.errCommitDetails, msg.error, null, null);
			}
		},
		compareCommits: (msg) => {
			if (msg.error === null) {
				ctx.details.showComparison(msg.commitHash, msg.compareWithHash, msg.fileChanges, ctx.details.createFileTree(msg.fileChanges, msg.codeReview), msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
			} else {
				ctx.details.closeComparison(true);
				dialog.showError(strings.errCommitComparison, msg.error, null, null);
			}
		},
		copyFilePath: finish(strings.errCopyFilePath),
		copyToClipboard: (msg) => finishOrDisplayError(msg.error, formatStr(strings.errCopyToClipboard, msg.type)),
		createArchive: finish(strings.errCreateArchive, true),
		createBranch: completeAll(strings.errCreateBranch),
		createPullRequest: (msg) => finishOrDisplayErrors(msg.errors, strings.errCreatePullRequest, () => undefined, true),
		deleteBranch: (msg) => {
			if (msg.errors.length > 0 && msg.errors[0] !== null && msg.errors[0].includes('git branch -D')) {
				dialog.showConfirmation(formatStr(markup.branchNotFullyMerged, msg.branchName), strings.yesForceDeleteBranch, () => {
					ctx.actions.run({ command: 'deleteBranch', repo: msg.repo, branchName: msg.branchName, forceDelete: true, deleteOnRemotes: msg.deleteOnRemotes }, strings.deletingBranch);
				}, { type: TargetType.Repo });
			} else {
				completeAndDisplayErrors(msg.errors, strings.errDeleteBranch);
			}
		},
		deleteRemote: complete(strings.errDeleteRemote),
		deleteRemoteBranch: complete(strings.errDeleteRemoteBranch),
		deleteTag: complete(strings.errDeleteTag),
		deleteUserDetails: (msg) => finishOrDisplayErrors(msg.errors, strings.errDeleteUserDetails, () => undefined, true),
		dropCommit: complete(strings.errDropCommit),
		dropStash: complete(strings.errDropStash),
		editRemote: complete(strings.errEditRemote),
		editUserDetails: (msg) => finishOrDisplayErrors(msg.errors, strings.errEditUserDetails, () => undefined, true),
		exportRepoConfig: (msg) => refreshViewOrDisplayError(msg.error, strings.errExportRepoConfig),
		fetch: complete(strings.errFetch),
		// The extension cleared its commit cache and (when disabling) deleted the local change
		// refs — and the reload must run under the integration's NEW fetch settings, which this
		// view holds: the one write response whose refresh stays here (see task 4.8)
		gerritSetFetchRefs: (msg) => refreshViewOrDisplayError(msg.error, strings.errGerritSetFetchRefs, true),
		fetchAvatar: (msg) => {
			imageResizer.resize(msg.image, (resizedImage) => {
				ctx.loader.loadAvatar(msg.email, resizedImage);
			});
		},
		fetchIntoLocalBranch: complete(strings.errFetchIntoLocalBranch),
		commitBodies: (msg) => ctx.commitBodies.process(msg),
		commitFileCounts: (msg) => ctx.details.lineCounts.apply(msg),
		// The standard data-loss warning: confirm re-sends the original request with its
		// confirmed flag set, so the action runs without asking again
		lossWarning: (msg) => dialog.showDataLossWarning(msg.message, () => ctx.bridge.send(msg.retry)),
		countCommitsBefore: (msg) => ctx.loader.processCountCommitsBefore(msg),
		loadCommits: (msg) => ctx.loader.processLoadCommitsResponse(msg),
		loadConfig: (msg) => ctx.loader.processLoadConfig(msg),
		loadRepoInfo: (msg) => ctx.loader.processLoadRepoInfoResponse(msg),
		// The merged open path (task 4.7): the host pushes the repo info and the first commit page
		// in one message when the page reports `ready`; each half routes through the processing of
		// the corresponding partial response, so the staged follow-ups keep working unchanged.
		loadView: (msg) => ctx.loader.processLoadView(msg),
		reflog: (msg) => ctx.widgets.reflog.processResponse(msg),
		worktreeList: (msg) => ctx.widgets.worktree.processListResponse(msg),
		repoStatistics: (msg) => ctx.widgets.statistics.processResponse(msg),
		worktreeAdd: (msg) => {
			completeOrDisplayError(msg.error, strings.errWorktreeAdd);
			ctx.widgets.worktree.refresh();
		},
		worktreeRemove: (msg) => {
			completeOrDisplayError(msg.error, strings.errWorktreeRemove);
			ctx.widgets.worktree.refresh();
		},
		worktreePrune: (msg) => {
			completeOrDisplayError(msg.error, strings.errWorktreePrune);
			ctx.widgets.worktree.refresh();
		},
		loadRepos: (msg) => {
			ctx.loader.loadRepos(msg.repos, msg.lastActiveRepo, msg.loadViewTo);
		},
		pullRequestStatus: (msg) => ctx.loader.processPullRequestStatus(msg),
		setInterfaceLanguage: finish(strings.settingsUnableToSaveLanguage),
		setGlobalSetting: (msg) => {
			finishOrDisplayError(msg.error, strings.settingsUnableToSaveSetting);
			// Saving commitAuthors also wrote the global Git configuration (the global
			// author was defaulted or cleared): reload the repository configuration from
			// the post-save state, so the Settings Widget's "Use Global Author" row shows
			// what Git really holds now instead of the pre-save snapshot
			if (msg.authorConfigTouched) ctx.loader.requestLoadConfig();
		},
		merge: (msg) => completeOrDisplayError(msg.error, formatStr(strings.errMergeActionOn, getMergeActionOnName(msg.actionOn))),
		openExtensionSettings: finish(strings.errOpenExtensionSettings),
		openLogFile: finish(strings.errOpenLogFile),
		openExternalDirDiff: finish(strings.errOpenExternalDirDiff, true),
		openExternalUrl: finish(strings.errOpenExternalUrl),
		openFile: finish(strings.errOpenFile),
		openTerminal: finish(strings.errOpenTerminal, true),
		popStash: complete(strings.errPopStash),
		pruneRemote: complete(strings.errPruneRemote),
		pullBranch: complete(strings.errPullBranch),
		pushBranch: completeAll(strings.errPushBranch),
		pushStash: complete(strings.errPushStash),
		pushTag: (msg) => {
			if (msg.errors.length === 1 && isExtensionErrorInfo(msg.errors[0], GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote)) {
				handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.errors[0]!);
			} else {
				completeAll(strings.errPushTag)(msg);
			}
		},
		rebase: (msg) => {
			if (msg.error === null) {
				// Both variants wait for the host's pushed impact refresh (task 4.8); the
				// interactive one never had one to wait for (its Git runs in the terminal)
				dialog.closeActionRunning();
			} else {
				dialog.showError(formatStr(strings.errRebaseActionOn, getRebaseActionOnName(msg.actionOn)), msg.error, null, null);
			}
		},
		refresh: () => ctx.loader.refresh(false),
		configChanged: (msg) => {
			// P1: the trace layer follows the same live setting (the host applies the identical
			// rule in the CommandManager's configuration listener).
			setEnabled(msg.config.enableLog);
			ctx.loader.applyConfig(msg.config);
		},
		renameBranch: complete(strings.errRenameBranch),
		resetFileToRevision: complete(strings.errResetFileToRevision),
		resetToCommit: complete(strings.errResetToCommit),
		undoLastCommit: complete(strings.errResetLastCommit),
		revertCommit: complete(strings.errRevertCommit),
		editCommitMessage: complete(strings.errEditCommitMessage),
		setGlobalViewState: finish(strings.errSaveGlobalViewState),
		setWorkspaceViewState: finish(strings.errSaveWorkspaceViewState),
		startCodeReview: (msg) => {
			if (msg.error === null) {
				ctx.details.startCodeReview(msg.commitHash, msg.compareWithHash, msg.codeReview);
			} else {
				dialog.showError(strings.errStartCodeReview, msg.error, null, null);
			}
		},
		tagDetails: (msg) => {
			if (msg.details !== null) {
				showTagDetails(ctx, msg.tagName, msg.commitHash, msg.details);
			} else {
				dialog.showError(strings.errTagDetails, msg.error, null, null);
			}
		},
		updateCodeReview: showFailure(strings.errUpdateCodeReview),
		viewDiff: finish(strings.errViewDiff),
		viewDiffWithWorkingFile: finish(strings.errViewDiffWithWorkingFile),
		viewFileAtRevision: finish(strings.errViewFileAtRevision),
		viewScm: finish(strings.errViewScm)
	};

	return (msg: GG.ResponseMessage) => {
		// The window's message channel is shared. The automation shim receives its step batches
		// as window messages too ({ __automation: ... } — no `command`), and a webview may see
		// other non-protocol events. A message that is not a protocol response — no `command`, or
		// one the exhaustive table above has no handler for — is not for this router and is
		// dropped silently: dispatching it used to throw `handlers[msg.command] is not a function`
		// and surface an error dialog that occluded the view for the rest of the session.
		if (typeof msg !== 'object' || msg === null || !Object.prototype.hasOwnProperty.call(handlers, msg.command)) return;
		// T4 (P1): the boot's data push arrived - the trace report goes out after T5 (main.ts).
		if (isEnabled() && msg.command === 'loadView') mark(MARK.webviewDataReceived);
		try {
			(<(message: GG.ResponseMessage) => void>handlers[msg.command])(msg);
		} catch (error) {
			// Isolate handler errors so that a malformed message cannot break the handling of
			// subsequent messages
			dialog.showError('Git Graph RS', formatStr(strings.unexpectedErrorHandlingMessage, String(error)), null, null);
		}
	};
}
