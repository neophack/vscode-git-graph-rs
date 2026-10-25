import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { Handler } from './context';

/** Handlers answering the view's data reads (branch graph pages, config, counts, details). */

/**
 * The synthetic hash of the "Uncommitted Changes" row. Duplicated from src/utils/git.ts's
 * UNCOMMITTED ('*') because importing that module would transitively require the vscode-dependent
 * i18n module - the same trade the CommitLoader makes for its own copy.
 */
const UNCOMMITTED_HASH = '*';

export const loadCommits: Handler<'loadCommits'> = {
	mutates: MUTATING_COMMANDS.loadCommits,
	handle: (msg, ctx) => {
		// The id rides the regenerated page's initialState (the webview drops a response whose
		// request was superseded); the staged responses themselves go through the loader
		ctx.view.noteRefreshId('loadCommits', msg.refreshId);
		return ctx.loader.loadCommits(msg, ctx.send);
	}
};

export const loadRepoInfo: Handler<'loadRepoInfo'> = {
	mutates: MUTATING_COMMANDS.loadRepoInfo,
	async handle(msg, ctx) {
		ctx.view.noteRefreshId('loadRepoInfo', msg.refreshId);
		// The remote-tracking refs are NOT scanned for this response while the view is EMPTY (see
		// CommitLoaderPort.viewHasCommits): the branch dropdown starts local-only, and the complete
		// list rides along the follow-up `loadCommits` response that carries the remote pills - the
		// branch list and the pills come from the same ref scan, so it is run once. Once the view is
		// populated, a deferred (local-only) list would just blink the remote entries out of the
		// dropdown and back on a soft refresh, so the complete list is scanned right away.
		const deferRemoteRefs = msg.showRemoteBranches && !ctx.view.viewHasCommits;
		const [repoInfo, operationState] = await Promise.all([
			ctx.repo.getRepoInfo(msg.repo, msg.showRemoteBranches, msg.showStashes, msg.hideRemotes, deferRemoteRefs),
			ctx.repo.getOperationState(msg.repo)
		]);
		let isRepo = true;
		if (repoInfo.error) {
			// If an error occurred, check to make sure the repo still exists
			isRepo = (await ctx.repo.repoRoot(msg.repo)) !== null;
			if (!isRepo) repoInfo.error = null; // If the error is caused by the repo no longer existing, clear the error message
		}
		ctx.send({
			command: 'loadRepoInfo',
			refreshId: msg.refreshId,
			...repoInfo,
			isRepo: isRepo,
			remoteRefsPending: deferRemoteRefs || undefined,
			operationState: operationState
		});
		// The Panel restarts the repo file watcher, records the last-active repository and resets
		// the per-repo view state (poll baseline, uncommitted stabiliser, the deferral above) when
		// the response is for a repository the view did not show before
		ctx.view.repoSwitched(msg.repo);
	}
};

export const loadConfig: Handler<'loadConfig'> = {
	mutates: MUTATING_COMMANDS.loadConfig,
	async handle(msg, ctx) {
		// The id rides the response back: the webview drops a response whose request was
		// superseded by a newer one, so a slow pre-change read can never overwrite the fresh
		// configuration a later request already applied - and it rides the regenerated page's
		// initialState for the same reason.
		ctx.view.noteRefreshId('loadConfig', msg.refreshId);
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
	async handle(msg, ctx) {
		const detailsPromise = msg.commitHash === UNCOMMITTED_HASH
			? ctx.repo.getUncommittedDetails(msg.repo)
			: msg.stash === null
				? ctx.repo.getCommitDetails(msg.repo, msg.commitHash, msg.hasParents)
				: ctx.repo.getStashDetails(msg.repo, msg.commitHash, msg.stash);
		const avatarPromise = msg.avatarEmail !== null ? ctx.avatars.getAvatarImage(msg.avatarEmail) : Promise.resolve(null);
		const data = await Promise.all([detailsPromise, avatarPromise]);
		ctx.send({
			command: 'commitDetails',
			...data[0],
			avatar: data[1],
			codeReview: msg.commitHash !== UNCOMMITTED_HASH ? ctx.storage.getCodeReview(msg.repo, msg.commitHash) : null,
			refresh: msg.refresh
		});
	}
};

export const compareCommits: Handler<'compareCommits'> = {
	mutates: MUTATING_COMMANDS.compareCommits,
	async handle(msg, ctx) {
		ctx.send({
			command: 'compareCommits',
			commitHash: msg.commitHash,
			compareWithHash: msg.compareWithHash,
			...await ctx.repo.getCommitComparison(msg.repo, msg.fromHash, msg.toHash),
			codeReview: msg.toHash !== UNCOMMITTED_HASH ? ctx.storage.getCodeReview(msg.repo, msg.fromHash + '-' + msg.toHash) : null,
			refresh: msg.refresh
		});
	}
};

export const fetchAvatar: Handler<'fetchAvatar'> = {
	mutates: MUTATING_COMMANDS.fetchAvatar,
	handle(msg, ctx) {
		// No response: the avatar arrives with the manager's completion event, which the Panel
		// forwards to the webview as a fetchAvatar message of its own
		ctx.avatars.fetchAvatarImage(msg.email, msg.repo, msg.remote, msg.commits);
	}
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
