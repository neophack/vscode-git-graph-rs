import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { Handler } from './context';
import { notWired } from './context';

/** Handlers answering the view's data reads (branch graph pages, config, counts, details). */

export const loadCommits: Handler<'loadCommits'> = {
	mutates: MUTATING_COMMANDS.loadCommits,
	handle: (msg, ctx) => ctx.loader.loadCommits(msg, ctx.send)
};

export const loadRepoInfo: Handler<'loadRepoInfo'> = {
	mutates: MUTATING_COMMANDS.loadRepoInfo,
	handle: () => notWired('the loadRepoInfo pipeline depends on the remote-refs deferral view state, the repo file watcher and the last-active-repo tracking, which move into CommitLoader/Panel in tasks 4.3/4.4')
};

export const loadConfig: Handler<'loadConfig'> = {
	mutates: MUTATING_COMMANDS.loadConfig,
	async handle(msg, ctx) {
		// The refresh id rides the response back: the webview drops a response whose request was
		// superseded by a newer one, so a slow pre-change read can never overwrite the fresh
		// configuration a later request already applied. (Recording the id for the regenerated
		// HTML's initialState moves to Panel in task 4.4.)
		const configData = await ctx.repo.getConfig(msg.repo, msg.remotes);
		ctx.send({ command: 'loadConfig', repo: msg.repo, refreshId: msg.refreshId, ...configData });
	}
};

export const countCommitsBefore: Handler<'countCommitsBefore'> = {
	mutates: MUTATING_COMMANDS.countCommitsBefore,
	async handle(msg, ctx) {
		ctx.send({
			command: 'countCommitsBefore',
			hash: msg.hash,
			count: await ctx.repo.countCommitsBefore(msg.repo, msg.branches, msg.hash, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs)
		});
	}
};

export const commitBodies: Handler<'commitBodies'> = {
	mutates: MUTATING_COMMANDS.commitBodies,
	async handle(msg, ctx) {
		let bodies: { [hash: string]: string } = {};
		try {
			bodies = await ctx.repo.getCommitBodies(msg.repo, msg.commitHashes);
		} catch (_) {
			// A failed body read must still answer the request (the requestId pairing would
			// otherwise hang the view's request); the error itself is logged by the panel's
			// logger once dispatch is wired there.
		}
		ctx.send({ command: 'commitBodies', bodies: bodies, requestId: msg.requestId });
	}
};

export const commitFileCounts: Handler<'commitFileCounts'> = {
	mutates: MUTATING_COMMANDS.commitFileCounts,
	async handle(msg, ctx) {
		const counts = await ctx.repo.getCommitFileCounts(msg.repo, msg.from, msg.to, msg.paths);
		ctx.send({
			command: 'commitFileCounts',
			commitHash: msg.commitHash,
			compareWithHash: msg.compareWithHash,
			counts: counts.counts,
			error: counts.error
		});
	}
};

export const commitDetails: Handler<'commitDetails'> = {
	mutates: MUTATING_COMMANDS.commitDetails,
	handle: () => notWired('commitDetails combines DataSource reads with AvatarManager and the code-review store of ExtensionState, which are not context ports yet (tasks 4.3/4.5)')
};

export const compareCommits: Handler<'compareCommits'> = {
	mutates: MUTATING_COMMANDS.compareCommits,
	handle: () => notWired('compareCommits attaches the code-review state of ExtensionState, which is not a context port yet (task 4.5)')
};

export const fetchAvatar: Handler<'fetchAvatar'> = {
	mutates: MUTATING_COMMANDS.fetchAvatar,
	handle: () => notWired('fetchAvatar drives AvatarManager, which is not a context port yet')
};

export const repoStatistics: Handler<'repoStatistics'> = {
	mutates: MUTATING_COMMANDS.repoStatistics,
	async handle(msg, ctx) {
		const [authors, activity] = await Promise.all([
			ctx.repo.getAuthorStatistics(msg.repo),
			ctx.repo.getActivityHeatmap(msg.repo)
		]);
		ctx.send({ command: 'repoStatistics', repo: msg.repo, authors: authors, activity: activity });
	}
};

export const reflog: Handler<'reflog'> = {
	mutates: MUTATING_COMMANDS.reflog,
	async handle(msg, ctx) {
		const reflog = await ctx.repo.getReflog(msg.repo, msg.ref, msg.limit);
		ctx.send({
			command: 'reflog',
			repo: msg.repo,
			ref: msg.ref,
			entries: reflog.entries,
			moreAvailable: reflog.moreAvailable,
			error: reflog.error
		});
	}
};
