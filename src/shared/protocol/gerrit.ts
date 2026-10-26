/**
 * The Gerrit-domain messages of the Git Graph view protocol: the change-ref fetch switch
 * and the pull-request status read. Split out of src/types/messages.ts verbatim; the
 * domain mirrors handlers/gerrit.ts.
 */

import type { PullRequestInfo } from '../model/pullRequest';
import type { RepoRequest, ResponseWithErrorInfo } from './messages';

/**
 * Enable or disable the fetching of Gerrit change refs of a repository. Disabling also deletes
 * the locally fetched change refs (`refs/remotes/<gerrit.remote>/changes/*`), so the change
 * commits disappear from the graph and no further fetches happen until it is enabled again.
 */
export interface RequestGerritSetFetchRefs extends RepoRequest {
	readonly command: 'gerritSetFetchRefs';
	readonly enabled: boolean;
}
export interface ResponseGerritSetFetchRefs extends ResponseWithErrorInfo {
	readonly command: 'gerritSetFetchRefs';
	readonly enabled: boolean;
	readonly cleared: number; // the number of local change refs deleted (0 when enabling)
}

export interface RequestFetchPullRequest extends RepoRequest {
	readonly command: 'fetchPullRequest';
}
export interface ResponsePullRequestStatus {
	readonly command: 'pullRequestStatus';
	readonly repo: string;
	/** The pull requests of the repository's remote (NULL when they couldn't be determined). */
	readonly prs: PullRequestInfo[] | null;
}
