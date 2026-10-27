/**
 * The wiring of the explicit load state machine: this class owns the
 * machine's state, feeds it the lifecycle events (the boot push, a repository switch, a refresh,
 * a response), projects the state onto the `store.refreshState` flags that out-of-loader
 * readers still consume (the refresh button, the auto load-more gate), and applies the machine's
 * effects to the view through the sibling modules.
 *
 * Acceptance is the machine's: every response is dispatched as an event and is applied only in
 * states that expect it, keyed by its request id — anything else is dropped and logged. The
 * response PAYLOADS ride beside the dispatch (the machine's effects are IO decisions; the data
 * they apply is the caller's): the effect handlers consume the payload of the response that
 * produced them.
 */

import * as GG from '../../common/protocol';
import { formatStr, strings } from '../../common/i18n/index';
import { fetchFromRemotesAction } from '../actions/dialogActions';
import { GraphContext } from '../context';
import type { FirstPaintSnapshot } from '../state/firstPaint';
import { CommitPage, CommitsPayload } from './commitPage';
import { FollowUps } from './followUps';
import { initialLoadState, reduce, stateLabel } from './loadMachine';
import type { DropRecord, LoadEffect, LoadEvent, LoadResult, LoadState } from './loadMachine';
import { noteCommitsApplied, noteDrop, noteLoadState } from './loadDiagnostics';
import { LoadErrors } from './loadErrors';
import { LoadRequests } from './loadRequests';
import { RepoInfoApplier, RepoInfoPayload } from './repoInfoApply';

export interface LoadControllerDeps {
	readonly requests: LoadRequests;
	readonly errors: LoadErrors;
	readonly commitPage: CommitPage;
	readonly repoInfo: RepoInfoApplier;
	readonly followUps: FollowUps;
	/** The commits-only reload (the pushed page's settings mismatch, a selection reset). */
	readonly refreshCommitsOnly: () => void;
	/** Load the next page (the deferred view load paging past the loaded window). */
	readonly loadMore: () => void;
}

/** Derive the follow-up kinds a pushed `loadView` announces (the staged follow-ups carry its id). */
function pushedFollowUps(msg: GG.ResponseLoadView): ReadonlyArray<'remoteRefs' | 'uncommitted' | 'gerrit'> {
	const followUps: Array<'remoteRefs' | 'uncommitted' | 'gerrit'> = [];
	if (msg.repoInfo.remoteRefsPending === true) followUps.push('remoteRefs');
	if (msg.commits.uncommittedPending === true) followUps.push('uncommitted');
	if (msg.commits.gerritPending === true) followUps.push('gerrit');
	return followUps;
}

/**
 * Derive the follow-up kinds a commits response announces. The list REPLACES the tracked one,
 * except `remoteRefs`: it stays pending while no response has carried the complete branch list
 * yet (the scan's result arrives with a `branches` payload).
 */
function responseFollowUps(previous: LoadState, msg: GG.ResponseLoadCommits): ReadonlyArray<'remoteRefs' | 'uncommitted' | 'gerrit'> {
	const followUps: Array<'remoteRefs' | 'uncommitted' | 'gerrit'> = [];
	const remoteRefsStillPending = previous.type === 'loading' || previous.type === 'refreshing'
		? previous.followUpsPending.includes('remoteRefs')
		: previous.type === 'loaded' && previous.followUpsPending.includes('remoteRefs');
	if (remoteRefsStillPending && !Array.isArray(msg.branches)) followUps.push('remoteRefs');
	if (msg.uncommittedPending === true) followUps.push('uncommitted');
	if (msg.gerritPending === true) followUps.push('gerrit');
	return followUps;
}

export class LoadController {
	private state: LoadState = initialLoadState();
	// The payloads of the response currently being applied: the machine decides WHETHER they
	// apply (the drop decision happens during dispatch); they are consumed by the effect handlers.
	private repoInfoPayload: RepoInfoPayload | null = null;
	private commitsPayload: CommitsPayload | null = null;
	private snapshotSeed: { readonly snapshot: FirstPaintSnapshot; readonly prevBranchHead: string | null } | null = null;
	// The dialog title of the error a `showLoadError` effect will show (the machine's effect
	// carries only the reason; the title names the pipeline half that failed).
	private errorTitle: string = strings.errLoadCommits;

	constructor(private readonly ctx: () => GraphContext, private readonly deps: LoadControllerDeps) { }

	/** The machine's current state (the loader reads it for the boot sequence's decisions). */
	public get loadState(): LoadState {
		return this.state;
	}


	/* Lifecycle events (the loader's request-side sources) */

	/** The boot adopted its repository: the host's pushed `loadView` is expected. */
	public awaitPush(repo: string): void {
		this.dispatch({ type: 'awaitPush', repo: repo });
	}

	/** A decodable first-paint snapshot for the awaited repository was found. */
	public snapshotArrived(snapshot: FirstPaintSnapshot, prevBranchHead: string | null): void {
		this.snapshotSeed = { snapshot: snapshot, prevBranchHead: prevBranchHead };
		this.dispatch({ type: 'snapshotArrived', repo: this.ctx().store.currentRepo });
	}

	/** Switch the view to a repository: a hard first-load cycle under a fresh id. */
	public openRepo(repo: string): void {
		this.dispatch({ type: 'openRepo', repo: repo, requestId: this.deps.requests.nextRequestId() });
	}

	/** Start (or join) a load cycle. */
	public refreshRequested(repo: string, hard: boolean, skipRepoInfo: boolean): void {
		this.dispatch({ type: 'refreshRequested', repo: repo, requestId: this.deps.requests.nextRequestId(), hard: hard, skipRepoInfo: skipRepoInfo });
	}

	/** Abandon the expected push / the in-flight cycle (a user-driven view clear during the boot wait). */
	public cancel(repo: string): void {
		this.dispatch({ type: 'cancel', repo: repo });
	}


	/* Response acceptance (the router's response-side sources) */

	/**
	 * The pushed merged view of the open path. The machine accepts it only while a
	 * push is expected and for the awaited repository — applying it unconditionally, adopting
	 * its refresh ids over a possibly-running cycle, would stomp a mid-boot load. The
	 * two halves apply through the same `applyRepoInfo` / `applyCommits` effects a partial
	 * response uses; the machine's single error consolidates the halves' errors (the host pushes
	 * one merged read: in practice both halves carry it or neither does).
	 */
	public processLoadView(msg: GG.ResponseLoadView): void {
		this.repoInfoPayload = { ...msg.repoInfo, remoteRefsPending: msg.repoInfo.remoteRefsPending === true };
		this.commitsPayload = { ...msg.commits, uncommittedPending: msg.commits.uncommittedPending === true };
		this.errorTitle = msg.repoInfo.error !== null ? strings.errLoadRepoInfo : strings.errLoadCommits;
		this.dispatch({
			type: 'loadViewPushed',
			repo: msg.repo,
			requestId: msg.refreshId,
			error: msg.repoInfo.error !== null ? msg.repoInfo.error : msg.commits.error,
			followUpsPending: pushedFollowUps(msg)
		});
		// The pushed page used the default view options (Show All branches, the extension's
		// defaults): a repository whose own settings select specific branches, a Gerrit feed or a
		// different ordering re-requests just the commits — one request instead of re-running
		// the whole repo-info-plus-commits cycle.
		if (!this.deps.repoInfo.pushedPageMatchesRepoSettings()) {
			this.deps.refreshCommitsOnly();
		}
	}

	/**
	 * A `loadRepoInfo` response: acceptance is repo + id keyed; the payload applies on success.
	 * A response landing in `idle` — before the boot adopted a repository, a state production
	 * cannot reach (the response router installs only after `start()`) — applies as raw data
	 * through the same payload path; the machine's state is untouched (there is no lifecycle
	 * to transition).
	 */
	public processLoadRepoInfoResponse(msg: GG.ResponseLoadRepoInfo): void {
		const store = this.ctx().store;
		this.repoInfoPayload = {
			branches: msg.branches, head: msg.head, remotes: msg.remotes, stashes: msg.stashes,
			isRepo: msg.isRepo, remoteRefsPending: msg.remoteRefsPending === true
		};
		this.errorTitle = strings.errLoadRepoInfo;
		if (this.state.type === 'idle') {
			this.applyEffect({ kind: 'applyRepoInfo', repo: store.currentRepo, requestId: msg.refreshId });
			this.ctx().widgets.conflictBanner.update(msg.operationState);
			return;
		}
		const result = this.dispatch({
			type: 'repoInfoResponse',
			repo: store.currentRepo,
			requestId: msg.refreshId,
			isRepo: msg.isRepo,
			remoteRefsPending: msg.remoteRefsPending === true,
			error: msg.error
		});
		// The merge/rebase banner reflects the operation state of every accepted response,
		// success or error. The effects apply first; the two updates touch disjoint DOM.
		if (result.dropped === null) {
			this.ctx().widgets.conflictBanner.update(msg.operationState);
		}
	}

	/**
	 * A `loadCommits` response: one request can be answered by MULTIPLE responses with the same
	 * refresh id (the staged delivery: remote refs, Gerrit, "Uncommitted Changes"), so the
	 * machine accepts them in the cycle's commits phase AND in `loaded`, always keyed by id.
	 * A response landing in `idle` — before the boot adopted a repository, a state production
	 * cannot reach (the response router installs only after `start()`) — applies as raw data
	 * through the same payload path; the machine's state is untouched (there is no lifecycle
	 * to transition).
	 */
	public processLoadCommitsResponse(msg: GG.ResponseLoadCommits): void {
		const store = this.ctx().store;
		this.commitsPayload = {
			commits: msg.commits,
			head: msg.head,
			tags: msg.tags,
			moreCommitsAvailable: msg.moreCommitsAvailable,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			uncommittedPending: msg.uncommittedPending === true,
			gerritStates: msg.gerritStates,
			branches: msg.branches,
			uncommittedCount: msg.uncommittedCount
		};
		this.errorTitle = strings.errLoadCommits;
		if (this.state.type === 'idle') {
			// (followUp: true keeps the synthetic application from finalising a cycle — none runs)
			this.applyEffect({ kind: 'applyCommits', repo: store.currentRepo, requestId: msg.refreshId, firstPaint: false, followUp: true });
			return;
		}
		this.dispatch({
			type: 'commitsResponse',
			repo: store.currentRepo,
			requestId: msg.refreshId,
			// A stale error response (superseded by a newer load whose data is already rendered)
			// drops with the same guard the success path applies.
			error: msg.error !== null ? LoadErrors.mapCommitsError(store, msg.error) : null,
			followUpsPending: responseFollowUps(this.state, msg)
		});
	}


	/* Load completion */

	/**
	 * Complete a load of repository data: resolve the deferred view load of the open path (the
	 * commit to find, the commit details to re-open, the command to run), then reload the
	 * repository configuration when it is missing or the cycle was flagged with config changes.
	 * The config load is its own one-shot request outside the machine (see the loadMachine module
	 * docs); this runs on every completed page application and after a same-repo `loadRepos`.
	 */
	public finaliseLoad(didLoadRepoData: boolean): void {
		const ctx = this.ctx(), store = ctx.store;
		const loadViewTo = store.loadViewTo;
		if (loadViewTo !== null && store.currentRepo === loadViewTo.repo) {
			if (loadViewTo.findCommitHash) {
				const commitIndex = store.getCommitId(loadViewTo.findCommitHash);
				if (commitIndex !== null) {
					// Windowed rendering may not have the row in the DOM at all: scroll first
					// (which re-renders the window around the target), then resolve the row the
					// window now holds. Resolving before scrolling silently dropped the jump for
					// any commit outside the initially rendered window.
					ctx.viewport.scrollToCommit(loadViewTo.findCommitHash, true, true);
					const commitElem = ctx.table.findCommitElem(commitIndex);
					if (commitElem !== null) {
						ctx.details.load(commitElem);
					}
					store.slices.repos.setLoadViewTo(null);
				} else if (store.moreCommitsAvailable) {
					this.deps.loadMore();
					return; // Wait for next load
				} else {
					ctx.bridge.send({ command: 'showErrorMessage', message: strings.commitNotFound });
					store.slices.repos.setLoadViewTo(null);
				}
			} else if (loadViewTo.commitDetails && (store.expandedCommit === null || store.expandedCommit.commitHash !== loadViewTo.commitDetails.commitHash || store.expandedCommit.compareWithHash !== loadViewTo.commitDetails.compareWithHash)) {
				const commitIndex = store.getCommitId(loadViewTo.commitDetails.commitHash);
				const compareWithIndex = loadViewTo.commitDetails.compareWithHash !== null ? store.getCommitId(loadViewTo.commitDetails.compareWithHash) : null;
				// Bring both rows into the rendered window first (as above), then resolve their
				// elements — under windowed rendering the elements only exist once the window
				// covers their indices.
				if (commitIndex !== null) ctx.viewport.scrollToCommit(loadViewTo.commitDetails.commitHash, true, true);
				if (compareWithIndex !== null) ctx.viewport.scrollToCommit(loadViewTo.commitDetails.compareWithHash!, false, false);
				const commitElem = ctx.table.findCommitElem(commitIndex);
				const compareWithElem = ctx.table.findCommitElem(compareWithIndex);

				if (commitElem !== null && (loadViewTo.commitDetails.compareWithHash === null || compareWithElem !== null)) {
					if (compareWithElem !== null) {
						ctx.details.loadComparison(commitElem, compareWithElem);
					} else {
						ctx.details.load(commitElem);
					}
				} else {
					ctx.bridge.send({ command: 'showErrorMessage', message: formatStr(strings.unableToResumeCodeReview, String(store.maxCommits)) });
				}
			} else if (loadViewTo.runCommandOnLoad) {
				switch (loadViewTo.runCommandOnLoad) {
					case 'fetch':
						fetchFromRemotesAction(ctx);
						break;
				}
			}
		}
		store.slices.repos.setLoadViewTo(null);

		if (store.gitConfig === null || (didLoadRepoData && store.refreshState.configChanges)) {
			this.deps.requests.requestLoadConfig();
		}
	}


	/* The dispatch core */

	/**
	 * Run one transition: reduce, project the new state onto the store flags, then apply the
	 * effects in the machine's order (a nested dispatch from inside an effect — a selection
	 * reset's reload, a pinned-commit jump's auto page — is fine: dispatch is synchronous and
	 * each event is decided from the state current at its arrival).
	 */
	private dispatch(event: LoadEvent): LoadResult {
		const result = reduce(this.state, event);
		this.state = result.state;
		// The page-level diagnostic mirror (see loadDiagnostics): the machine's state, its drops
		// and the transitions between them stay observable from a page step, not only from the
		// devtools console.
		const eventId = 'requestId' in event ? event.type + '#' + event.requestId : event.type;
		noteLoadState(stateLabel(this.state), eventId);
		this.project();
		if (result.dropped !== null) {
			noteDrop(result.dropped);
			this.logDrop(result.dropped);
			return result;
		}
		// The machine emits `clearView` before `showLoadError`, and the pre-collapse anchor must
		// be captured BEFORE the view is cleared (the collapse clamps the scroll away), so
		// capture up front whenever the transition is about to show an error.
		if (result.effects.some((effect) => effect.kind === 'showLoadError')) {
			this.ctx().viewport.capturePendingViewportAnchor();
		}
		for (const effect of result.effects) {
			this.applyEffect(effect);
		}
		return result;
	}

	/** Mirror the machine state onto the store flags the rest of the view reads. */
	private project(): void {
		const state = this.state;
		this.ctx().store.slices.repos.projectLoadState(
			state.type === 'loading' || state.type === 'refreshing',
			state.type === 'snapshotPainted',
			(state.type === 'loading' || state.type === 'refreshing') && state.phase === 'repoInfo'
		);
	}

	private logDrop(drop: DropRecord): void {
		// Drops are data, not exceptions: a stale response is normal traffic after a supersession.
		console.info('[load] dropped ' + drop.event + ' (' + drop.reason + '): ' + drop.detail);
	}

	private applyEffect(effect: LoadEffect): void {
		const ctx = this.ctx();
		switch (effect.kind) {
			case 'issueRepoInfoRequest':
				this.deps.requests.issueRepoInfo(effect.requestId);
				break;
			case 'issueCommitsRequest':
				this.deps.requests.issueCommits(effect.requestId, effect.hard);
				break;
			case 'applyRepoInfo': {
				const payload = this.repoInfoPayload;
				this.repoInfoPayload = null;
				// The accepted response's id IS the repo-info id of the view state: a cycle's
				// response re-stamps what its request already carried; the pushed `loadView`
				// ADOPTS its pushed id here, so its staged follow-ups validate while anything
				// older drops.
				ctx.store.slices.repos.stampRepoInfoRequestId(effect.requestId);
				if (payload !== null) {
					// The cycle's response tracks its change note for the dialog refresh; the boot
					// push applies with no cycle running.
					const inCycle = this.state.type === 'loading' || this.state.type === 'refreshing';
					this.deps.repoInfo.apply(payload, inCycle);
					// The pull/merge request badges ride the repo info of every accepted response
					this.deps.followUps.requestPullRequests();
				}
				break;
			}
			case 'applyCommits': {
				const payload = this.commitsPayload;
				this.commitsPayload = null;
				// See applyRepoInfo: the accepted response's id IS the commits id of the view state.
				ctx.store.slices.repos.stampCommitsRequestId(effect.requestId);
				if (payload !== null) {
					noteCommitsApplied({
						count: payload.commits.length,
						head: payload.head,
						headInList: payload.commits.some((commit) => commit.hash === payload.head),
						headIndex: payload.commits.findIndex((commit) => commit.hash === payload.head),
						first: payload.commits.length > 0 ? payload.commits[0].hash : null,
						secondSubject: payload.commits.length > 1 ? (payload.commits[1].message || '').split('\n', 1)[0] : null
					});
					this.deps.commitPage.applyResponse(payload, !effect.followUp);
				}
				break;
			}
			case 'paintSnapshot': {
				const seed = this.snapshotSeed;
				this.snapshotSeed = null;
				if (seed !== null) {
					this.deps.commitPage.seedSnapshot(seed.snapshot, seed.prevBranchHead);
				}
				break;
			}
			case 'clearView':
				this.deps.commitPage.clearView();
				break;
			case 'showSkeleton':
				// The skeleton shows only while the view holds no final rows (a painted
				// snapshot or pushed page must not be covered by it)
				if (ctx.store.commits.length === 0) {
					ctx.table.showLoadingSkeleton();
				}
				break;
			case 'spinRefreshButton':
				// The button renders from the projected flags, so the render is correct even when
				// a nested dispatch moved the machine on before this effect ran
				ctx.controls.renderRefreshButton();
				break;
			case 'showLoadError':
				this.deps.errors.show(this.errorTitle, effect.reason);
				break;
			case 'checkRepos':
				// The repository vanished: close the running action's dialog, drop the deferred
				// view load and ask the host to re-check the list
				ctx.dialog.closeActionRunning();
				ctx.store.slices.repos.setLoadViewTo(null);
				ctx.bridge.send({ command: 'loadRepos', check: true });
				break;
		}
	}
}
