import type { GitCommitData } from '../git/read/types';

/**
 * Whether the complete (remote-refs-included) response of the remote-refs follow-up differs from
 * the deferred (local-only) response already sent, and is therefore worth sending as a follow-up
 * (task 4.3). Ported verbatim from src/gitGraphView.ts, whose characterization tests
 * (tests/gitGraphView.test.mjs) pin this behavior; the same cases are mirrored in
 * commitLoader.test.ts.
 *
 * Comparing only each commit's `remotes` labels (as an earlier version did) misses two real
 * differences: a commit can differ at the same index without any `remotes` label changing (the
 * local-only walk and the complete walk can disagree on which commits fill a `maxCommits`-
 * truncated window), and the branch dropdown's option list - driven by `branches`, not by any
 * commit's `remotes` - can gain remote-tracking branches whose tip commit never entered the
 * loaded window at all. Either case must still trigger the follow-up, or the webview is left
 * rendering the deferred, local-only data for the rest of the session.
 */
export function remoteRefsFollowUpChanged(deferred: GitCommitData, complete: GitCommitData): boolean {
	if (!stringArraysEqual(deferred.branches, complete.branches)) return true;
	if (deferred.commits.length !== complete.commits.length) return true;
	return complete.commits.some((commit, index) => {
		const previous = deferred.commits[index];
		return commit.hash !== previous.hash ||
			commit.remotes.length !== previous.remotes.length ||
			commit.remotes.some((remote, remoteIndex) => remote.name !== previous.remotes[remoteIndex].name || remote.remote !== previous.remotes[remoteIndex].remote);
	});
}

function stringArraysEqual(a: ReadonlyArray<string> | null | undefined, b: ReadonlyArray<string> | null | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || a === null || b === undefined || b === null || a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}
