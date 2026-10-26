/**
 * Applying a commit page (OPTIMIZATION-PLAN §6 F2): the data half of a `loadCommits` response —
 * the staged pre-processing (Gerrit states, the late branch list, the exact "Uncommitted
 * Changes" count) and the page application itself (the seamless-update equality check, the
 * anchored full render, the cycle finalisation's dialog refresh).
 *
 * The machine decides WHETHER a payload applies (the `applyCommits` / `paintSnapshot` effects
 * fire only for accepted responses); this module is the WHAT. Two legacy concerns moved out of
 * the body: the in-progress flag of the finalisation became the `cycleCompleting` argument (the
 * machine knows whether the response completes a cycle or is a staged follow-up), the spin flags
 * are the machine state's projection (`spinRefreshButton` effects render the button), the
 * deferred view load completes through `completeLoad`, and the pinned-commit jump observes the
 * completions from its own sub-machine (`pinnedJump.ts`).
 */

import { html } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { arraysEqual, arraysStrictlyEqual, UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { gerritStatesEqual, refreshGerritReviewDialog } from '../integrations/gerrit';
import type { FirstPaintSnapshot } from '../state/firstPaint';
import { FollowUps } from './followUps';
import { PinnedCommitJump } from './pinnedJump';
import { RepoInfoApplier } from './repoInfoApply';

/** The commits half of a `loadCommits` response (or of a pushed `loadView`). */
export interface CommitsPayload {
	readonly commits: GG.GitCommit[];
	readonly head: string | null;
	readonly tags: ReadonlyArray<string>;
	readonly moreCommitsAvailable: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly uncommittedPending: boolean;
	/** The Gerrit change states of the response (NULL => the integration is disabled; undefined => a snapshot seed). */
	readonly gerritStates: ReadonlyArray<GG.GerritChangeState> | null;
	/** The branch list of the ref scan this page was built from (absent when the response carries none). */
	readonly branches?: ReadonlyArray<string> | null;
	readonly uncommittedCount?: number | undefined;
}

export interface CommitPageDeps {
	readonly repoInfo: RepoInfoApplier;
	readonly followUps: FollowUps;
	/** The pinned-commit jump's sub-machine (it observes this module's load completions). */
	readonly jump: PinnedCommitJump;
	/** The commits-only reload (a branch-selection reset late-arriving with a page). */
	readonly refreshCommitsOnly: () => void;
	/** Complete the load of repository data (the deferred view load, the config reload). */
	readonly completeLoad: (didLoadRepoData: boolean) => void;
}

export class CommitPage {
	constructor(private readonly ctx: () => GraphContext, private readonly deps: CommitPageDeps) { }


	/* View-level operations */

	/** Empty the view of the current repository's commits (before they are reloaded). */
	public clearView(): void {
		const ctx = this.ctx(), store = ctx.store;
		ctx.closeDialogAndContextMenu();
		// (the "refreshing" marker of a painted snapshot is the machine state's projection now)
		store.moreCommitsAvailable = false;
		this.deps.jump.reset();
		store.commits = [];
		store.commitHead = null;
		store.commitLookup = {};
		store.uncommittedCount = null;
		store.renderedGitBranchHead = null;
		store.gerritStates = {};
		store.gerritStatesDirty = false;
		ctx.commitBodies.clear();
		ctx.viewport.renderedRange = null;
		ctx.details.close(false);
		ctx.persistence.saveState();
		ctx.graph.loadCommits(store.commits, store.commitHead, store.commitLookup, store.onlyFollowFirstParent);
		ctx.table.clear();
		ctx.table.setFooter(html``);
		ctx.table.renderGraph();
		ctx.widgets.find.refresh();
	}

	/**
	 * Paint the first-paint snapshot's rows (REFACTOR-PLAN 3.8.2 D10, task 5.9; the
	 * `paintSnapshot` effect): the previous session's rows go on screen IMMEDIATELY, and the
	 * pushed `loadView` data reconciles them when it lands - through the same page-application
	 * path, whose equality check leaves identical rows untouched (the seamless update) and whose
	 * anchored rebuild replaces the rest without a coordinate jump. The snapshot was already
	 * checked to be decodable and to belong to the repository and configuration being opened;
	 * HEAD cannot be checked before the data arrives, so it travels with the snapshot and the
	 * reconciliation is what replaces rows under a moved HEAD.
	 */
	public seedSnapshot(snapshot: FirstPaintSnapshot, prevBranchHead: string | null): void {
		const ctx = this.ctx(), store = ctx.store;
		// Seed exactly what the pushed response reconciles against: the commits, their head and
		// the bookkeeping the equality check reads. The repo-info half (branches, remotes,
		// selections) stays to the push, exactly as on an ordinary boot.
		store.currentRepoLoading = true;
		store.gitBranchHead = typeof prevBranchHead === 'string' ? prevBranchHead : null; // the pushed repo info re-reads and confirms it
		store.maxCommits = snapshot.maxCommits;
		store.uncommittedCount = snapshot.uncommittedCount;
		store.scrollTop = snapshot.scrollTop;
		ctx.viewport.restoreScrollTop = snapshot.scrollTop;
		this.applyPage({
			commits: snapshot.commits.slice(),
			head: snapshot.head,
			tags: [],
			moreCommitsAvailable: snapshot.moreCommitsAvailable,
			onlyFollowFirstParent: snapshot.onlyFollowFirstParent,
			uncommittedPending: false,
			gerritStates: null,
			branches: undefined,
			uncommittedCount: undefined
		}, false);
	}


	/* Response application */

	/**
	 * Apply a commits response: the staged pre-processing its envelope carried (the Gerrit
	 * states, the late branch list, the exact uncommitted count — the parts legacy
	 * `processLoadCommitsResponse` ran ahead of the page), then the page itself.
	 * `cycleCompleting` is TRUE when this response completes a cycle (legacy's
	 * `refreshState.inProgress` at this point) and FALSE for a staged follow-up landing after it.
	 */
	public applyResponse(payload: CommitsPayload, cycleCompleting: boolean): void {
		const ctx = this.ctx(), store = ctx.store;
		// The Gerrit states ride along every loadCommits response: swap the map in and force
		// a re-render when it changed (the extension serves the fetched states of the cache
		// entry — the event timelines of the visible ones only — so the status filter and
		// the fetch limit of the Repository Settings are applied locally by this view). The
		// array is checked (not merely non-null): a response from a mismatched extension
		// build that omits the field entirely (undefined) must keep the current states,
		// never crash.
		//
		// The staged Gerrit load delivers the states in two parts: the light part the badges
		// render (arriving with the change refs), then the event timelines (which only the
		// review dialog reads). A change confined to the timelines therefore swaps the map
		// without re-rendering the commit table, refreshing an open review dialog in place.
		if (Array.isArray(payload.gerritStates)) {
			const newStates: { [hash: string]: GG.GerritChangeState } = {};
			for (const state of payload.gerritStates) newStates[state.headHash] = state;
			const changed = !gerritStatesEqual(store.gerritStates, newStates);
			const badgesChanged = !gerritStatesEqual(store.gerritStates, newStates, false);
			store.gerritStatesDirty = badgesChanged;
			store.gerritStates = newStates;
			if (changed) refreshGerritReviewDialog(ctx.dialog, store.gerritStates, store.config.dateFormat);
		} else if (Object.keys(store.gerritStates).length > 0) {
			store.gerritStatesDirty = true;
			store.gerritStates = {};
		}
		// The branch list of the ref scan this page was built from: the deferred view load
		// delivers the remote-tracking entries here (they are the same scan the remote
		// pills come from), completing the branch dropdown without another request. A reset
		// selection re-requests just the commits (nested into this application, exactly as
		// legacy's applyBranches did).
		if (Array.isArray(payload.branches) && this.deps.repoInfo.applyBranchList(payload.branches)) {
			this.deps.refreshCommitsOnly();
		}
		// The exact "Uncommitted Changes" count arrives with the final follow-up: record it
		// as view state so subsequent deferred responses can keep the row rendered
		if (typeof payload.uncommittedCount === 'number') store.uncommittedCount = payload.uncommittedCount;
		this.applyPage(payload, cycleCompleting);
	}

	/**
	 * Apply a commit page: the equality check keeps identical rows untouched (the seamless
	 * update), everything else goes through the ONE anchored render path, then the cycle (or
	 * follow-up) finalises.
	 */
	private applyPage(payload: CommitsPayload, cycleCompleting: boolean): void {
		const ctx = this.ctx(), store = ctx.store, viewport = ctx.viewport;
		let commits = payload.commits;
		const commitHead = payload.head, tags = payload.tags;
		const moreAvailable = payload.moreCommitsAvailable, onlyFollowFirstParent = payload.onlyFollowFirstParent;
		// This list of tags is just used to provide additional information in the dialogs. Tag information included in commits is used for all other purposes (e.g. rendering, context menus)
		const tagsChanged = !arraysStrictlyEqual(store.gitTags, tags);
		store.gitTags = tags;

		if (payload.uncommittedPending && commits.length > 0 && commits[0].hash !== UNCOMMITTED && commitHead !== null
			&& store.uncommittedCount !== null && store.uncommittedCount > 0) {
			// Deferred response: the "Uncommitted Changes" status arrives in a follow-up response.
			// Keep the row rendered so it never flickers away and back on a refresh - the follow-up
			// just updates its number in place. The row is reused when it is already rendered, and
			// synthesized from the last known count otherwise: any response of the load pipeline
			// (initial, remote refs, Gerrit stages) carries a list without the row, and none of
			// them may drop it.
			commits = [store.commits.length > 0 && store.commits[0].hash === UNCOMMITTED
				? { ...store.commits[0], parents: [commitHead] }
				: {
					hash: UNCOMMITTED,
					parents: [commitHead],
					author: '*',
					email: '',
					date: Math.round(Date.now() / 1000),
					message: formatStr(strings.uncommittedChangesRow, String(store.uncommittedCount)),
					heads: [],
					tags: [],
					remotes: [],
					stash: null
				}, ...commits];
		}

		if (!store.currentRepoLoading && !store.refreshState.hard && store.moreCommitsAvailable === moreAvailable && store.onlyFollowFirstParent === onlyFollowFirstParent && store.commitHead === commitHead && commits.length > 0 && arraysEqual(store.commits, commits, (a, b) =>
			a.hash === b.hash &&
			arraysStrictlyEqual(a.heads, b.heads) &&
			arraysEqual(a.tags, b.tags, (a: GG.GitCommitTag, b: GG.GitCommitTag) => a.name === b.name && a.annotated === b.annotated) &&
			arraysEqual(a.remotes, b.remotes, (a: GG.GitCommitRemote, b: GG.GitCommitRemote) => a.name === b.name && a.remote === b.remote) &&
			arraysStrictlyEqual(a.parents, b.parents) &&
			((a.stash === null && b.stash === null) || (a.stash !== null && b.stash !== null && a.stash.selector === b.stash.selector))
		) && store.renderedGitBranchHead === store.gitBranchHead && !store.gerritStatesDirty) {

			if (store.commits[0].hash === UNCOMMITTED) {
				store.commits[0] = commits[0];
				ctx.persistence.saveState();
				ctx.table.renderUncommittedChanges();
				if (store.expandedCommit !== null && store.expandedCommit.commitElem !== null) {
					if (store.expandedCommit.compareWithHash === null) {
						// Commit Details View is open
						if (store.expandedCommit.commitHash === UNCOMMITTED) {
							ctx.details.requestCommitDetails(store.expandedCommit.commitHash, true);
						}
					} else {
						// Commit Comparison is open
						if (store.expandedCommit.compareWithElem !== null && (store.expandedCommit.commitHash === UNCOMMITTED || store.expandedCommit.compareWithHash === UNCOMMITTED)) {
							ctx.details.requestCommitComparison(store.expandedCommit.commitHash, store.expandedCommit.compareWithHash, true);
						}
					}
				}
			} else if (tagsChanged) {
				ctx.persistence.saveState();
			}
			this.finalise(cycleCompleting);
			ctx.persistence.scheduleFirstPaintCapture();
			return;
		}

		// Everything else - a commit landing at the top, the Uncommitted Changes row appearing or
		// vanishing, a "Load More Commits" page arriving at the bottom, a background fetch moving a
		// label deep in the history, a rebase rewriting the middle - goes through this one path.
		// Rendering reconciles rows by commit identity and rebuilds only the rows that actually
		// differ (see CommitTable.syncCommitRows), which is correct for every shape of change.
		const currentRepoLoading = store.currentRepoLoading;
		// A background refresh reaching this full re-render changes the table's shape under the
		// user (a commit inserted/removed anywhere, a rebase rewriting mid-history, the Gerrit
		// states arriving). Anchor the rebuild on the commit the user is looking at, exactly like
		// every other update path does. A pre-collapse anchor (a hard refresh or an error cleared
		// the table while the user was scrolled into the history) outranks the live capture: the
		// collapse already clamped scrollTop to 0, so the live capture would read "at the very
		// top" and pin the view there once the same commits render again.
		const anchorFromPending = viewport.pendingViewportAnchor !== null;
		const anchor = currentRepoLoading ? null
			: (anchorFromPending ? viewport.pendingViewportAnchor : viewport.captureViewportAnchor());
		viewport.pendingViewportAnchor = null; // one shot: consumed here, or dropped with its hash lookup
		store.currentRepoLoading = false;
		store.moreCommitsAvailable = moreAvailable;
		store.onlyFollowFirstParent = onlyFollowFirstParent;
		store.commits = commits;
		store.commitHead = commitHead;
		store.commitLookup = {};

		let expandedCommitVisible = false, expandedCompareWithCommitVisible = false;
		const avatarsNeeded: { [email: string]: string[] } = {};
		for (let i = 0; i < store.commits.length; i++) {
			const commit = store.commits[i];
			store.commitLookup[commit.hash] = i;
			if (store.expandedCommit !== null) {
				if (store.expandedCommit.commitHash === commit.hash) {
					expandedCommitVisible = true;
				} else if (store.expandedCommit.compareWithHash === commit.hash) {
					expandedCompareWithCommitVisible = true;
				}
			}
			if (store.config.fetchAvatars && typeof store.avatars[commit.email] !== 'string' && commit.email !== '') {
				if (typeof avatarsNeeded[commit.email] === 'undefined') {
					avatarsNeeded[commit.email] = [commit.hash];
				} else {
					avatarsNeeded[commit.email].push(commit.hash);
				}
			}
		}

		if (store.expandedCommit !== null && (!expandedCommitVisible || (store.expandedCommit.compareWithHash !== null && !expandedCompareWithCommitVisible))) {
			ctx.details.close(false);
		}

		ctx.persistence.saveState();

		ctx.graph.loadCommits(store.commits, store.commitHead, store.commitLookup, store.onlyFollowFirstParent);

		// Put the scroll where the anchored commit needs it BEFORE rendering, so the window is
		// computed at its final position and every row in it is reconciled exactly once.
		// (Rendering first and correcting afterwards would window the list at the stale position,
		// then move - destroying and rebuilding the rows at both edges of the window for nothing.)
		viewport.applyViewportAnchor(anchor);
		// The ONE render of this response (task 5.10): synchronous because the anchor re-application
		// below measures the rows this pass wrote, and it satisfies any render requested earlier in
		// the same response (the scheduler's pending flag), so nothing renders twice
		ctx.renderScheduler.renderSync();
		store.gerritStatesDirty = false;
		// A full render has variable row heights, so its anchor can only be measured now that the
		// rows are on screen. Windowed rendering already landed exactly, and this is a no-op.
		// A pre-collapse anchor additionally could not hold before the render: it was clamped away
		// by the collapsed scroll height of the cleared table, so it is re-applied now that the
		// reloaded rows give the view its full height back (absolute, never a delta - applying it
		// twice cannot accumulate).
		if (viewport.renderedRange === null || anchorFromPending) viewport.applyViewportAnchor(anchor);

		if (currentRepoLoading) {
			if (store.config.onRepoLoad.scrollToHead && store.commitHead !== null) {
				viewport.scrollToCommit(store.commitHead, true);
			} else if (viewport.restoreScrollTop !== null) {
				// Webview reload: re-apply the scroll position saved before the reload
				ctx.dom.view.scrollTop = viewport.restoreScrollTop;
				viewport.updateVirtualWindow(); // re-render the window around the restored position
			}
			viewport.restoreScrollTop = null;
		}

		this.finalise(cycleCompleting);
		this.deps.followUps.requestAvatars(avatarsNeeded);
		// A stable commits render is the first-paint snapshot's capture point (D10): debounced, so
		// a rapid load-more sequence captures once, at its end
		ctx.persistence.scheduleFirstPaintCapture();
	}

	/**
	 * Finalise the application of a commit page: refresh (or close) a dialog and context menu
	 * that targeted the dynamic sources of the previous data, then complete the deferred view
	 * load and the pinned-commit jump. `cycleCompleting` carries legacy's
	 * `refreshState.inProgress` gate (TRUE only for the response that completes a cycle).
	 */
	private finalise(cycleCompleting: boolean): void {
		const ctx = this.ctx(), store = ctx.store;
		if (cycleCompleting) {
			ctx.dialog.closeActionRunning();

			if (ctx.dialog.isTargetDynamicSource()) {
				if (store.refreshState.repoInfoChanges) {
					ctx.dialog.close();
				} else {
					ctx.dialog.refresh(store.commits);
				}
			}

			if (ctx.contextMenu.isTargetDynamicSource()) {
				if (store.refreshState.repoInfoChanges) {
					ctx.contextMenu.close();
				} else {
					ctx.contextMenu.refresh(store.commits);
				}
			}

			// (the in-progress flag and the button's spin are the machine state's projection now;
			// this render reads it — the completing transition's own spin effect rendered it first)
			ctx.controls.renderRefreshButton();
		}

		this.deps.jump.checkPending();
		this.deps.completeLoad(true);
	}
}
