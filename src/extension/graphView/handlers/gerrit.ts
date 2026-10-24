import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import { notWired } from './context';
import type { Handler } from './context';

/** Gerrit and pull-request integration handlers. */

export const gerritSetFetchRefs: Handler<'gerritSetFetchRefs'> = {
	mutates: MUTATING_COMMANDS.gerritSetFetchRefs,
	async handle(msg, ctx) {
		if (msg.enabled) {
			// Enabling marks the repository's Gerrit data stale, so the very next load runs the
			// fetch pipeline (ls-remote probe, targeted fetch, prune, meta parsing)
			ctx.loader.markGerritStale(msg.repo);
			ctx.loader.invalidateCommitCache();
			ctx.send({ command: 'gerritSetFetchRefs', error: null, enabled: true, cleared: 0 });
			return;
		}
		// Disabling deletes ALL locally fetched change refs with one batched update-ref, so the
		// change commits leave the graph and nothing is re-fetched until it is enabled again
		const { error, cleared } = await ctx.repo.gerrit.clearLocalChanges(msg.repo, ctx.config.gerrit.remote);
		if (error === null) {
			ctx.loader.clearGerritCache(msg.repo);
			ctx.loader.unmarkGerritStale(msg.repo);
			ctx.loader.invalidateCommitCache();
		}
		ctx.send({ command: 'gerritSetFetchRefs', error: error, enabled: false, cleared: cleared });
	}
};

export const fetchPullRequest: Handler<'fetchPullRequest'> = {
	mutates: MUTATING_COMMANDS.fetchPullRequest,
	handle: () => notWired('fetchPullRequest drives the pull-requests manager and the head-ref fetch orchestration of GitGraphView, which move to extension/integrations')
};
