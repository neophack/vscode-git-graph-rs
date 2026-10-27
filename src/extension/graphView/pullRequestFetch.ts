import type { PullRequestInfo } from '../../shared/model/pullRequest';
import {
	buildPullRequestHeadRefspecs, findStalePullRequestRefs, parseGitRemoteVerbose, parseRemoteUrl, selectRemote
} from '../integrations/pullRequests';
import type { PullRequestRemote } from './handlers/context';

/**
 * The pull-request fetch orchestration of the graph view. Everything the two functions touch
 * arrives injected through
 * {@link PullRequestFetchDeps}, so the orchestration is unit-testable without Git and without
 * 'vscode'; the pure URL/refspec helpers live in the shared integration module
 * (extension/integrations/pullRequests.ts).
 */

/** The git and pull-request reads the orchestration needs, injected so tests run without Git. */
export interface PullRequestFetchDeps {
	/** Run a raw git invocation in the repository (the runner's gitOutput). */
	gitOutput<T>(args: string[], repo: string, resolveValue: (stdout: string) => T): Promise<T>;
	/** Load the pull/merge requests of a remote URL: the list and whether it is complete, or NULL on failure. */
	loadPullRequests(url: string): Promise<{ prs: PullRequestInfo[], complete: boolean } | null>;
	/** Whether the pull-request integration is enabled (the Extension Setting). */
	isEnabled(): boolean;
	readonly logger: { log(message: string): void };
}

/**
 * Get the pull/merge requests of a repository's GitHub/GitLab remote. Degrades to NULL whenever
 * the integration is disabled or no remote is hosted on GitHub or GitLab - logging the reason,
 * so missing badges are diagnosable in the extension's output channel.
 * @param repo The path of the repository.
 * @returns The remote and its pull requests, or NULL when unavailable.
 */
export async function fetchPullRequests(deps: PullRequestFetchDeps, repo: string): Promise<PullRequestRemote | null> {
	if (!deps.isEnabled()) return null;
	try {
		const remotes = parseGitRemoteVerbose(await deps.gitOutput(['remote', '-v'], repo, (stdout) => stdout));
		const remote = selectRemote(remotes);
		if (remote === null) {
			deps.logger.log('Pull requests unavailable: no remote of the repository is hosted on GitHub or GitLab');
			return null;
		}
		const prs = await deps.loadPullRequests(remote.url);
		if (prs === null) {
			deps.logger.log('Pull requests unavailable: the GitHub/GitLab request for ' + remote.url + ' failed');
		} else {
			deps.logger.log('Pull requests of ' + remote.url + ': ' + prs.prs.length + ' request(s)' + (prs.complete ? '' : ' (list truncated by the pagination cap)'));
		}
		// A failed request knows nothing about the remote's list: it must not be reported as
		// complete, or the empty list would prune every fetched pull request ref
		return { name: remote.name, url: remote.url, prs: prs === null ? [] : prs.prs, complete: prs !== null && prs.complete };
	} catch (error) {
		deps.logger.log('Pull requests unavailable: ' + (error instanceof Error ? error.message : String(error)));
		return null;
	}
}

/**
 * Fetch the head commits of the still-open pull requests into the repository (under
 * refs/remotes/&lt;remote&gt;/prs/), so that pull requests opened from a fork appear in the Git
 * Graph View with their commits, and prune the refs of pull requests that closed since. The
 * fetched refs trip the RepoFileWatcher, which refreshes the view with the new commits.
 * @param repo The path of the repository.
 * @param remote The remote whose pull requests were loaded (see fetchPullRequests).
 */
export async function fetchPullRequestHeadRefs(deps: PullRequestFetchDeps, repo: string, remote: PullRequestRemote): Promise<void> {
	try {
		const refspecs = buildPullRequestHeadRefspecs(remote.name, parseRemoteUrl(remote.url), remote.prs);
		const existing = await deps.gitOutput(['for-each-ref', '--format=%(refname)', 'refs/remotes/' + remote.name + '/prs/'], repo, (stdout) => stdout.split('\n').filter((line) => line !== ''));
		let pruned = 0;
		for (const ref of findStalePullRequestRefs(existing, remote.name, remote.prs, remote.complete)) {
			await deps.gitOutput(['update-ref', '-d', ref], repo, () => null);
			pruned++;
		}
		if (refspecs.length > 0) {
			await deps.gitOutput(['fetch', '--no-tags', remote.name, ...refspecs], repo, () => null);
			deps.logger.log('Fetched the head commits of ' + refspecs.length + ' open pull request(s) into refs/remotes/' + remote.name + '/prs/');
		}
		if (pruned > 0) deps.logger.log('Pruned ' + pruned + ' pull request ref(s) that are no longer open');
	} catch (error) {
		deps.logger.log('Fetching the pull request head refs failed: ' + (error instanceof Error ? error.message : String(error)));
	}
}
