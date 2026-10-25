import * as vscode from 'vscode';
import { GitGraphView } from '../../gitGraphView';
import { t } from '../../i18n';
import { CodeReviewData, CodeReviews } from '../../extensionState';
import { showErrorMessage, showInformationMessage } from '../../utils/actions';
import { abbrevCommit } from '../../utils/git';
import { abbrevText, getRelativeTimeDiff } from '../../utils/format';
import { getRepoName } from '../../utils/paths';
import type { CommandHost } from './context';

/**
 * The workspace code review commands: ending every in-progress review, ending one picked from
 * a list, and re-opening the view on the commit (or commit comparison) a review covers.
 */

/**
 * The method run when the `git-graph-rs.endAllWorkspaceCodeReviews` command is invoked.
 * @param host The services the command runs with.
 */
export function endAllWorkspaceCodeReviews(host: CommandHost) {
	host.extensionState.endAllWorkspaceCodeReviews();
	showInformationMessage(t('endedAllCodeReviews'));
}

/**
 * The method run when the `git-graph-rs.endSpecificWorkspaceCodeReview` command is invoked.
 * @param host The services the command runs with.
 */
export function endSpecificWorkspaceCodeReview(host: CommandHost) {
	const codeReviews = host.extensionState.getCodeReviews();
	if (Object.keys(codeReviews).length === 0) {
		showErrorMessage(t('noCodeReviewsInProgress'));
		return;
	}

	vscode.window.showQuickPick(getCodeReviewQuickPickItems(host, codeReviews), {
		placeHolder: t('selectCodeReviewToEnd'),
		canPickMany: false
	}).then((item) => {
		if (item) {
			host.extensionState.endCodeReview(item.codeReviewRepo, item.codeReviewId).then((errorInfo) => {
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
 * @param host The services the command runs with.
 */
export function resumeWorkspaceCodeReview(host: CommandHost) {
	const codeReviews = host.extensionState.getCodeReviews();
	if (Object.keys(codeReviews).length === 0) {
		showErrorMessage(t('noCodeReviewsInProgress'));
		return;
	}

	vscode.window.showQuickPick(getCodeReviewQuickPickItems(host, codeReviews), {
		placeHolder: t('selectCodeReviewToResume'),
		canPickMany: false
	}).then((item) => {
		if (item) {
			const commitHashes = item.codeReviewId.split('-');
			GitGraphView.createOrShow(host.context.extensionPath, host.dataSource, host.extensionState, host.avatarManager, host.repoManager, host.logger, {
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
 * Transform a set of Code Reviews into a list of Quick Pick items for use with `vscode.window.showQuickPick`.
 * @param host The services the command runs with.
 * @param codeReviews A set of Code Reviews.
 * @returns A list of Quick Pick items.
 */
function getCodeReviewQuickPickItems(host: CommandHost, codeReviews: CodeReviews): Promise<CodeReviewQuickPickItem[]> {
	const repos = host.repoManager.getRepos();
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

	return Promise.all(fetchCommits.map((fetch) => host.dataSource.getCommitSubject(fetch.repo, fetch.commitHash))).then(
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

interface CodeReviewQuickPickItem extends vscode.QuickPickItem {
	codeReviewRepo: string;
	codeReviewId: string;
}
