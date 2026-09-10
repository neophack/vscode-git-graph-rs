/** A pull request (GitHub) or merge request (GitLab) of the repository's remote. */
export interface PullRequestInfo {
	number: number;
	title: string;
	state: PullRequestState;
	author: string;
	url: string;
	sourceBranch: string;
	/** The branch the pull request is opened against (GitHub's `base.ref`, GitLab's `target_branch`). */
	targetBranch: string;
	/** The commit the pull request currently points at (GitHub's `head.sha`, GitLab's `sha`). */
	headHash: string;
	/** The description of the pull request (GitHub's `body`, GitLab's `description`). */
	body: string;
}

export type PullRequestState = 'open' | 'merged' | 'closed' | 'draft';

export interface PullRequestsConfig {
	enabled: boolean;
}

export interface PullRequestConfigBase {
	readonly hostRootUrl: string;
	readonly sourceRemote: string;
	readonly sourceOwner: string;
	readonly sourceRepo: string;
	readonly destRemote: string | null;
	readonly destOwner: string;
	readonly destRepo: string;
	readonly destProjectId: string; // Only used by GitLab
	readonly destBranch: string;
}

export const enum PullRequestProvider {
	Bitbucket,
	Custom,
	GitHub,
	GitLab
}

interface PullRequestConfigBuiltIn extends PullRequestConfigBase {
	readonly provider: Exclude<PullRequestProvider, PullRequestProvider.Custom>;
	readonly custom: null;
}

interface PullRequestConfigCustom extends PullRequestConfigBase {
	readonly provider: PullRequestProvider.Custom;
	readonly custom: {
		readonly name: string,
		readonly templateUrl: string
	};
}

export type PullRequestConfig = PullRequestConfigBuiltIn | PullRequestConfigCustom;
