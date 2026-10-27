/**
 * The code-review store of the Git Graph Extension State (OPTIMIZATION-PLAN §3 A5): the review
 * records of every repository (one workspaceState key) - split out of the former flat
 * platform/storage.ts, over the one versioned KV (./storageVersioned.ts). The `ExtensionState`
 * facade delegates its code-review methods here.
 */

import { CodeReview } from '../../shared/model/repoState';
import { t } from './i18n';
import { isStateRecord, VersionedStateKv } from './storageVersioned';

const CODE_REVIEWS = 'codeReviews';

export interface CodeReviewData {
	lastActive: number;
	lastViewedFile: string | null;
	remainingFiles: string[];
}
export type CodeReviews = { [repo: string]: { [id: string]: CodeReviewData } };

/** The code-review records of the Git Graph Extension State, over the one versioned KV. */
export class CodeReviewStore {
	constructor(private readonly kv: VersionedStateKv) {}

	// Note: id => the commit arguments to 'git diff' (either <commit hash> or <commit hash>-<commit hash>)

	/**
	 * Start a new Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @param files An array of files that must be reviewed.
	 * @param lastViewedFile The last file the user reviewed before starting the Code Review.
	 * @returns The Code Review that was started.
	 */
	public startCodeReview(repo: string, id: string, files: string[], lastViewedFile: string | null) {
		const reviews = this.getCodeReviews();
		if (typeof reviews[repo] === 'undefined') reviews[repo] = {};
		reviews[repo][id] = { lastActive: (new Date()).getTime(), lastViewedFile: lastViewedFile, remainingFiles: files };
		return this.setCodeReviews(reviews).then((err) => ({
			codeReview: <CodeReview>Object.assign({ id: id }, reviews[repo][id]),
			error: err
		}));
	}

	/**
	 * End an existing Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 */
	public endCodeReview(repo: string, id: string) {
		const reviews = this.getCodeReviews();
		removeCodeReview(reviews, repo, id);
		return this.setCodeReviews(reviews);
	}

	/**
	 * Get an existing Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @returns The Code Review.
	 */
	public getCodeReview(repo: string, id: string) {
		const reviews = this.getCodeReviews();
		if (typeof reviews[repo] !== 'undefined' && typeof reviews[repo][id] !== 'undefined') {
			reviews[repo][id].lastActive = (new Date()).getTime();
			this.setCodeReviews(reviews);
			return <CodeReview>Object.assign({ id: id }, reviews[repo][id]);
		} else {
			return null;
		}
	}

	/**
	 * Update information for a specific Code Review.
	 * @param repo The repository the Code Review is in.
	 * @param id The ID of the Code Review.
	 * @param remainingFiles The files remaining for review.
	 * @param lastViewedFile The last viewed file. If null, don't change the last viewed file.
	 * @returns An error message if request can't be completed.
	 */
	public updateCodeReview(repo: string, id: string, remainingFiles: string[], lastViewedFile: string | null) {
		const reviews = this.getCodeReviews();

		if (typeof reviews[repo] === 'undefined' || typeof reviews[repo][id] === 'undefined') {
			return Promise.resolve(t('codeReviewNotFound'));
		}

		if (remainingFiles.length > 0) {
			reviews[repo][id].remainingFiles = remainingFiles;
			reviews[repo][id].lastActive = (new Date()).getTime();
			if (lastViewedFile !== null) {
				reviews[repo][id].lastViewedFile = lastViewedFile;
			}
		} else {
			removeCodeReview(reviews, repo, id);
		}

		return this.setCodeReviews(reviews);
	}

	/**
	 * Delete any Code Reviews that haven't been active during the last 90 days.
	 */
	public expireOldCodeReviews() {
		const reviews = this.getCodeReviews(), expireReviewsBefore = (new Date()).getTime() - 7776000000; // 90 days x 24 hours x 60 minutes x 60 seconds x 1000 milliseconds
		let change = false;
		Object.keys(reviews).forEach((repo) => {
			Object.keys(reviews[repo]).forEach((id) => {
				if (reviews[repo][id].lastActive < expireReviewsBefore) {
					delete reviews[repo][id];
					change = true;
				}
			});
			removeCodeReviewRepoIfEmpty(reviews, repo);
		});
		if (change) this.setCodeReviews(reviews);
	}

	/**
	 * End all Code Reviews in the current workspace.
	 */
	public endAllWorkspaceCodeReviews() {
		this.setCodeReviews({});
	}

	/**
	 * Get all Code Reviews in the current workspace.
	 * @returns The set of Code Reviews.
	 */
	public getCodeReviews() {
		const reviews = this.kv.readWorkspace<CodeReviews>(CODE_REVIEWS, {});
		return isStateRecord(reviews) ? reviews : {};
	}

	/**
	 * Set the Code Reviews in the current workspace.
	 * @param reviews The set of Code Reviews.
	 */
	public setCodeReviews(reviews: CodeReviews) {
		return this.kv.writeWorkspace(CODE_REVIEWS, reviews);
	}
}


/* Helper Methods */

/**
 * Remove a Code Review from a set of Code Reviews.
 * @param reviews The set of Code Reviews.
 * @param repo The repository the Code Review is in.
 * @param id The ID of the Code Review.
 */
function removeCodeReview(reviews: CodeReviews, repo: string, id: string) {
	if (typeof reviews[repo] !== 'undefined' && typeof reviews[repo][id] !== 'undefined') {
		delete reviews[repo][id];
		removeCodeReviewRepoIfEmpty(reviews, repo);
	}
}

/**
 * Remove a repository from a set of Code Reviews if the repository doesn't contain any Code Reviews.
 * @param reviews The set of Code Reviews.
 * @param repo The repository to perform this action on.
 */
function removeCodeReviewRepoIfEmpty(reviews: CodeReviews, repo: string) {
	if (typeof reviews[repo] !== 'undefined' && Object.keys(reviews[repo]).length === 0) {
		delete reviews[repo];
	}
}
