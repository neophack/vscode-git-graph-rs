/**
 * The pinned-commit jump (OPTIMIZATION-PLAN §6 F2): jumping to a commit that is not in the
 * loaded page. A sub-machine that only OBSERVES load completions (`checkPending` runs inside the
 * commit page's finalisation) plus its own one-shot countCommitsBefore probe — kept OUT of the
 * load machine's transition table on purpose (see the loadMachine module docs): folding it in
 * would multiply the matrix without changing a single load transition.
 */

import { strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import { LoadRequests } from './loadRequests';

export interface PinnedJumpDeps {
	readonly requests: LoadRequests;
	/** The commits-only reload the jump's "load everything up to it" step runs. */
	readonly refreshCommitsOnly: () => void;
	/** Load the next page (keep paging while more commits are available). */
	readonly loadMore: () => void;
}

export class PinnedCommitJump {
	private pendingScrollCommitHash: string | null = null;
	// TRUE between sending a countCommitsBefore request and its response: the response (not
	// checkPending) decides how the pending scroll commit is loaded, so the checks run
	// on intervening loadCommits responses must not error out or start paging on their own
	private countCommitsBeforePending: boolean = false;

	constructor(private readonly ctx: () => GraphContext, private readonly deps: PinnedJumpDeps) { }

	/** Forget a pending jump (the view was cleared; the commit is no longer findable). */
	public reset(): void {
		this.pendingScrollCommitHash = null;
		this.countCommitsBeforePending = false;
	}

	/**
	 * Jump to a commit that is not in the loaded page (a pinned commit): ask the extension how
	 * many commits precede it, so the view can load straight to it.
	 */
	public jumpToUnloadedCommit(hash: string): void {
		this.pendingScrollCommitHash = hash;
		this.countCommitsBeforePending = true;
		this.deps.requests.issueCountCommitsBefore(hash);
	}

	/**
	 * Handle the response of a countCommitsBefore request (made when jumping to a pinned commit
	 * that is not in the view): load enough commits to include it in a single request.
	 */
	public processCountCommitsBefore(msg: GG.ResponseCountCommitsBefore): void {
		const ctx = this.ctx(), store = ctx.store;
		this.countCommitsBeforePending = false;
		if (this.pendingScrollCommitHash !== msg.hash) return;
		if (msg.count === null) {
			this.pendingScrollCommitHash = null;
			ctx.dialog.showError(strings.pinnedCommitTitle, strings.pinnedCommitNotInRepo, null, null);
			return;
		}
		// Jump straight to the commit: load everything up to it (plus a margin), then
		// checkPending scrolls to it once the load completes
		store.maxCommits = Math.max(store.maxCommits, msg.count + store.config.loadMoreCommits);
		ctx.table.setFooterLoading();
		ctx.persistence.saveState();
		this.deps.refreshCommitsOnly();
	}

	/**
	 * Continue (or finish) an auto-load triggered by clicking a pinned commit chip that is not in
	 * the view: scroll to it once loaded, keep paging while more commits are available, or show an
	 * error once the whole repository history has been loaded without finding it.
	 */
	public checkPending(): void {
		const ctx = this.ctx(), store = ctx.store;
		if (this.pendingScrollCommitHash === null) return;
		if (this.countCommitsBeforePending) return; // the count response drives the jump (or reports "not found")
		const hash = this.pendingScrollCommitHash;
		if (store.commitLookup[hash] !== undefined) {
			this.pendingScrollCommitHash = null;
			ctx.viewport.scrollToCommit(hash, true, true);
		} else if (store.moreCommitsAvailable) {
			this.deps.loadMore();
		} else {
			this.pendingScrollCommitHash = null;
			ctx.dialog.showError(strings.pinnedCommitTitle, strings.pinnedCommitNotInLoadedHistory, null, null);
		}
	}
}
