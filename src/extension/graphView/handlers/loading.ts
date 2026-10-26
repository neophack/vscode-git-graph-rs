import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import { checkUnsafeGitArgs, isSafeRefName, isValidCommitHash } from '../../git/write/argSafety';
import { UNCOMMITTED } from '../../git/read/types';
import {
	readCommitComparison, readCommitDetails, readFileCounts, readRepoInfo, readStashDetails, readUncommittedDetails
} from '../repoReads';
import type { GitCommitDetails as CommitDetailsView } from '../../../shared/model/git';
import type { Handler } from './context';

/** Handlers answering the view's data reads (branch graph pages, config, counts, details). */

/**
 * The synthetic hash of the "Uncommitted Changes" row, from the read layer's own constant.
 */
const uncommittedHash = UNCOMMITTED;

/**
 * The branch names that are safe to hand to Git (they arrive from the webview). Custom Branch
 * Glob Patterns are the one legitimate exception: a single `--glob=<pattern>` argv token Git
 * cannot reinterpret as a different option.
 */
function safeBranches(branches: ReadonlyArray<string> | null): ReadonlyArray<string> | null {
	return branches === null ? null : branches.filter((branch) => isSafeRefName(branch) || isValidCommitHash(branch) || branch.startsWith('--glob='));
}

export const loadCommits: Handler<'loadCommits'> = {
	mutates: MUTATING_COMMANDS.loadCommits,
	handle: (msg, ctx) => {
		// The id rides the regenerated page's initialState (the webview drops a response whose
		// request was superseded); the staged responses themselves go through the loader
		ctx.view.noteRefreshId('loadCommits', msg.refreshId);
		return ctx.loader.loadCommits(msg, ctx.send);
	}
};

export const loadView: Handler<'loadView'> = {
	mutates: MUTATING_COMMANDS.loadView,
	handle: (msg, ctx) => {
		// The merged open path (task 4.7): the panel began this read at creation and pushes the
		// result on `ready`; a request arriving here (e.g. an automation replay) answers with a
		// fresh merged read. Both route through the loader, which owns the cancellation.
		ctx.view.noteRefreshId('loadCommits', msg.refreshId);
		return ctx.loader.loadView(msg, ctx.send);
	}
};

export const ready: Handler<'ready'> = {
	mutates: MUTATING_COMMANDS.ready,
	handle: (_msg, ctx) => {
		// The boot handshake: the host pushes the merged loadView result it began reading at
		// panel creation (the ViewPort impl owns the cached ticket). No response: the push,
		// and its staged follow-ups, is the answer.
		ctx.view.viewReady();
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
			readRepoInfo(ctx.repo.read, msg.repo, {
				showRemoteBranches: msg.showRemoteBranches && !deferRemoteRefs,
				showRemoteHeads: ctx.config.showRemoteHeads,
				hideRemotes: msg.hideRemotes,
				showStashes: msg.showStashes
			}),
			ctx.repo.getOperationState(msg.repo)
		]);
		let isRepo = true;
		if (repoInfo.error !== null) {
			// If an error occurred, check to make sure the repo still exists
			isRepo = await ctx.repo.read.repoRoot(msg.repo).then(() => true, () => false);
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
		const configData = await ctx.repoConfig.load(msg.repo, msg.remotes);
		ctx.send({ command: 'loadConfig', repo: msg.repo, refreshId: msg.refreshId, ...configData });
	}
};

export const countCommitsBefore: Handler<'countCommitsBefore'> = {
	mutates: MUTATING_COMMANDS.countCommitsBefore,
	async handle(msg, ctx) {
		ctx.send({
			command: 'countCommitsBefore',
			hash: msg.hash,
			// The count deliberately ignores the author/path filters; an unknown hash answers NULL.
			count: await ctx.repo.read.countCommitsBefore(msg.repo, safeBranches(msg.branches), msg.hash, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs).catch(() => null)
		});
	}
};

export const commitBodies: Handler<'commitBodies'> = {
	mutates: MUTATING_COMMANDS.commitBodies,
	async handle(msg, ctx) {
		let bodies: { [hash: string]: string } = {};
		try {
			// The hashes arrive from the webview: only valid ones reach Git.
			const hashes = msg.commitHashes.filter((hash) => isValidCommitHash(hash));
			if (hashes.length > 0) bodies = await ctx.repo.read.getCommitBodies(msg.repo, hashes);
		} catch (_) {
			// A failed body read must still answer the request (the requestId pairing would
			// otherwise hang the view's request).
		}
		ctx.send({ command: 'commitBodies', bodies: bodies, requestId: msg.requestId });
	}
};

export const commitFileCounts: Handler<'commitFileCounts'> = {
	mutates: MUTATING_COMMANDS.commitFileCounts,
	async handle(msg, ctx) {
		const counts = await readFileCounts(ctx.repo.read, ctx.t, msg.repo, msg.from, msg.to, msg.paths);
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
		const hasGit = ctx.git.hasGit();
		const detailsPromise = msg.commitHash === uncommittedHash
			? readUncommittedDetails(ctx.repo.read, msg.repo)
			: msg.stash === null
				? readCommitDetails(ctx.repo.read, hasGit, msg.repo, (repo) => ctx.repo.read.getCommitDetails(repo, msg.commitHash))
				: readStashDetails(ctx.repo.read, hasGit, msg.repo, msg.commitHash, msg.stash);
		const avatarPromise = msg.avatarEmail !== null ? ctx.avatars.getAvatarImage(msg.avatarEmail) : Promise.resolve(null);
		const data = await Promise.all([detailsPromise, avatarPromise]);
		ctx.send({
			command: 'commitDetails',
			// The backend's generated details shape is byte-identical with the view's, modulo the
			// array mutability the wire type spells differently - the boundary cast names that.
			commitDetails: data[0].commitDetails as unknown as CommitDetailsView | null,
			error: data[0].error,
			avatar: data[1],
			codeReview: msg.commitHash !== uncommittedHash ? ctx.storage.getCodeReview(msg.repo, msg.commitHash) : null,
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
			...await readCommitComparison(ctx.repo.read, ctx.t, msg.repo, msg.fromHash, msg.toHash),
			codeReview: msg.toHash !== uncommittedHash ? ctx.storage.getCodeReview(msg.repo, msg.fromHash + '-' + msg.toHash) : null,
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
			ctx.repo.read.getAuthorStatistics(msg.repo).then((list) => [...list], () => []),
			ctx.repo.read.getActivityHeatmap(msg.repo).then((list) => [...list], () => [])
		]);
		ctx.send({ command: 'repoStatistics', repo: msg.repo, authors: authors, activity: activity });
	}
};

export const reflog: Handler<'reflog'> = {
	mutates: MUTATING_COMMANDS.reflog,
	async handle(msg, ctx) {
		const unsafe = checkUnsafeGitArgs(ctx.t, ['ref', msg.ref, 'ref']);
		if (unsafe !== null) {
			ctx.send({ command: 'reflog', repo: msg.repo, ref: msg.ref, entries: [], moreAvailable: false, error: unsafe });
			return;
		}
		try {
			const reflog = await ctx.repo.read.getReflog(msg.repo, msg.ref, msg.limit);
			ctx.send({
				command: 'reflog',
				repo: msg.repo,
				ref: msg.ref,
				entries: [...reflog.entries],
				moreAvailable: reflog.moreAvailable,
				error: null
			});
		} catch (error) {
			ctx.send({
				command: 'reflog',
				repo: msg.repo,
				ref: msg.ref,
				entries: [],
				moreAvailable: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
};
