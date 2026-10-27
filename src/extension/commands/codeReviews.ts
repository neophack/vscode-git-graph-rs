import * as vscode from 'vscode';
import { t } from '../platform/i18n';
import { CodeReviewData, CodeReviews } from '../platform/storage';
import { showErrorMessage, showInformationMessage, uiPort } from '../platform/actions';
import { UiPort } from '../platform/uiPort';
import { abbrevCommit } from '../platform/git';
import { abbrevText, getRelativeTimeDiff } from '../platform/format';
import { getRepoName } from '../platform/paths';
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
 * @param ui The native-UI port the review picker runs through (INVENTORY.md #13);
 * defaults to the production port, injectable for tests.
 */
export function endSpecificWorkspaceCodeReview(host: CommandHost, ui: UiPort = uiPort) {
	const codeReviews = host.extensionState.getCodeReviews();
	if (Object.keys(codeReviews).length === 0) {
		showErrorMessage(t('noCodeReviewsInProgress'));
		return;
	}

	// The review items load asynchronously; resolve them before the port's pick (the port takes
	// the materialized list), with the shared rejection handler catching both stages, exactly as
	// the native pick forwarded a rejected item list before (INVENTORY.md #13).
	getCodeReviewQuickPickItems(host, codeReviews).then((items) => {
		return ui.showQuickPick(items, {
			placeHolder: t('selectCodeReviewToEnd'),
			canPickMany: false
		});
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
	});}

/**
 * The method run when the `git-graph-rs.resumeWorkspaceCodeReview` command is invoked.
 * @param host The services the command runs with.
 * @param ui The native-UI port the review picker runs through (INVENTORY.md #14);
 * defaults to the production port, injectable for tests.
 */
export function resumeWorkspaceCodeReview(host: CommandHost, ui: UiPort = uiPort) {
	const codeReviews = host.extensionState.getCodeReviews();
	if (Object.keys(codeReviews).length === 0) {
		showErrorMessage(t('noCodeReviewsInProgress'));
		return;
	}

	// As in the end-review flow: materialize the items, then pick; one rejection handler covers
	// both stages (INVENTORY.md #14).
	getCodeReviewQuickPickItems(host, codeReviews).then((items) => {
		return ui.showQuickPick(items, {
			placeHolder: t('selectCodeReviewToResume'),
			canPickMany: false
		});
	}).then((item) => {
		if (item) {
			const commitHashes = item.codeReviewId.split('-');
			host.panels.open({
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

	return Promise.all(fetchCommits.map((fetch) => host.repo.read.getCommitSubject(fetch.repo, fetch.commitHash).catch(() => null))).then(
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
