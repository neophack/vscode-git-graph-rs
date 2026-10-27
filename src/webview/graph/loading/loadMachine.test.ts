/**
 * The exhaustive transition table of the load state machine: one test
 * per (state, event) cell of the 11-state × 8-event matrix — every case asserts the FULL next
 * state, the full effect list, and the drop record (event, reason, detail) — plus the variant
 * cases the base matrix keeps out (stale request ids, repo mismatches, error shapes, the join
 * rules of requestLoadRepoInfoAndCommits) and the lifecycle scenarios that string cells
 * together the way the real RepoLoader does (repoLoader.ts).
 */

import { describe, expect, it } from 'vitest';

import { CANCELLED_REQUEST_ID, initialLoadState, reduce, refreshSpinning, stateLabel } from './loadMachine';
import type { DropReason, LoadEffect, LoadEvent, LoadState } from './loadMachine';

const REPO = '/repo';
const OTHER = '/other';
const REPO_INFO_ID = 5;
const COMMITS_ID = 6;
const PUSH_ID = 7;
const NEXT_ID = 9;

/* Builders: states (fixed ids so every cell is reproducible), events (matching where the state expects). */

const idle = (): LoadState => ({ type: 'idle' });
const awaitingPush = (): LoadState => ({ type: 'awaitingPush', repo: REPO });
const snapshotPainted = (): LoadState => ({ type: 'snapshotPainted', repo: REPO });
const loadingRepoInfo = (): LoadState => ({ type: 'loading', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'repoInfo', firstLoad: true, followUpsPending: [] });
const loadingCommits = (): LoadState => ({ type: 'loading', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'commits', firstLoad: true, followUpsPending: [] });
const refreshingRepoInfo = (): LoadState => ({ type: 'refreshing', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'repoInfo', firstLoad: false, followUpsPending: [] });
const refreshingCommits = (): LoadState => ({ type: 'refreshing', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'commits', firstLoad: false, followUpsPending: [] });
const loaded = (): LoadState => ({ type: 'loaded', repo: REPO, commitsId: COMMITS_ID, followUpsPending: [], lastError: null });
const errorView = (): LoadState => ({ type: 'error', repo: REPO, reason: 'previous failure' });
const repoGone = (): LoadState => ({ type: 'repoGone', repo: REPO });
const emptyView = (): LoadState => ({ type: 'empty', repo: REPO });

const openOther: LoadEvent = { type: 'openRepo', repo: OTHER, requestId: NEXT_ID };
const awaitPushEv: LoadEvent = { type: 'awaitPush', repo: REPO };
const snapshotEv: LoadEvent = { type: 'snapshotArrived', repo: REPO };
const pushOk: LoadEvent = { type: 'loadViewPushed', repo: REPO, requestId: PUSH_ID, error: null, followUpsPending: [] };
const repoInfoOk: LoadEvent = { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: true, remoteRefsPending: false, error: null };
const commitsOk: LoadEvent = { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: null, followUpsPending: [] };
const refreshSoft: LoadEvent = { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: false };
const cancelEv: LoadEvent = { type: 'cancel', repo: REPO };

/* Effect shorthands (fresh objects each call; the reducer is pure and shares nothing). */

const fx = {
	clearView: (): LoadEffect => ({ kind: 'clearView' }),
	showSkeleton: (): LoadEffect => ({ kind: 'showSkeleton' }),
	spinOn: (): LoadEffect => ({ kind: 'spinRefreshButton', spinning: true }),
	spinOff: (): LoadEffect => ({ kind: 'spinRefreshButton', spinning: false }),
	issueRepoInfo: (repo: string, requestId: number): LoadEffect => ({ kind: 'issueRepoInfoRequest', repo: repo, requestId: requestId }),
	issueCommits: (repo: string, requestId: number, hard: boolean): LoadEffect => ({ kind: 'issueCommitsRequest', repo: repo, requestId: requestId, hard: hard }),
	applyRepoInfo: (repo: string, requestId: number): LoadEffect => ({ kind: 'applyRepoInfo', repo: repo, requestId: requestId }),
	applyCommits: (repo: string, requestId: number, firstPaint: boolean, followUp: boolean): LoadEffect => ({ kind: 'applyCommits', repo: repo, requestId: requestId, firstPaint: firstPaint, followUp: followUp }),
	paintSnapshot: (repo: string): LoadEffect => ({ kind: 'paintSnapshot', repo: repo }),
	showLoadError: (reason: string): LoadEffect => ({ kind: 'showLoadError', reason: reason, retry: true }),
	checkRepos: (): LoadEffect => ({ kind: 'checkRepos' })
};

/* Expected-value shorthands shared by many cells. */

/** Every openRepo lands here: a hard first-load cycle under the caller's fresh id. */
const loadingAfterOpen = (repo: string): LoadState => ({ type: 'loading', repo: repo, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: true, followUpsPending: [] });
const openEffects = (repo: string): readonly LoadEffect[] => [fx.clearView(), fx.showSkeleton(), fx.spinOn(), fx.issueRepoInfo(repo, NEXT_ID)];

/** A soft full refresh joining a running cycle re-issues the repo-info half under the new id. */
const joinedBySoftFull = (from: 'loading' | 'refreshing'): LoadState => ({ type: from, repo: REPO, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: from === 'loading', followUpsPending: [] });
const joinEffectsSoftFull = (from: 'loading' | 'refreshing'): readonly LoadEffect[] => [
	...(from === 'loading' ? [fx.showSkeleton()] : []),
	fx.spinOn(),
	fx.issueRepoInfo(REPO, NEXT_ID)
];

/** A soft refresh from a data-less quiescent state (error retry / repoGone / empty) restarts from the skeleton. */
const restarted = (): LoadState => ({ type: 'loading', repo: REPO, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: false, followUpsPending: [] });
const restartEffects = (): readonly LoadEffect[] => [fx.showSkeleton(), fx.spinOn(), fx.issueRepoInfo(REPO, NEXT_ID)];

/** The completed cycle of the builders' ids. */
const loadedFromCycle = (): LoadState => ({ type: 'loaded', repo: REPO, commitsId: COMMITS_ID, followUpsPending: [], lastError: null });

interface Cell {
	readonly name: string;
	readonly from: LoadState;
	readonly event: LoadEvent;
	readonly to: LoadState;
	readonly effects: readonly LoadEffect[];
	readonly dropped: DropReason | null;
}

/**
 * The base matrix: every (state, event) pair. Variant payloads (stale ids, wrong repos,
 * errors, hard/skipRepoInfo refreshes) live in VARIANTS below so this table stays one cell
 * per pair.
 */
const TABLE: readonly Cell[] = [
	/* idle — nothing open yet */
	{ name: 'idle + openRepo → loading, full open effects', from: idle(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'idle + awaitPush → awaitingPush, skeleton shows', from: idle(), event: awaitPushEv, to: awaitingPush(), effects: [fx.showSkeleton()], dropped: null },
	{ name: 'idle + snapshotArrived → dropped (no boot to paint into)', from: idle(), event: snapshotEv, to: idle(), effects: [], dropped: 'unexpectedState' },
	{ name: 'idle + loadViewPushed → dropped (nothing awaits a push)', from: idle(), event: pushOk, to: idle(), effects: [], dropped: 'unexpectedState' },
	{ name: 'idle + repoInfoResponse → dropped', from: idle(), event: repoInfoOk, to: idle(), effects: [], dropped: 'unexpectedState' },
	{ name: 'idle + commitsResponse → dropped', from: idle(), event: commitsOk, to: idle(), effects: [], dropped: 'unexpectedState' },
	{ name: 'idle + refreshRequested → dropped (no repo open)', from: idle(), event: refreshSoft, to: idle(), effects: [], dropped: 'noRepoOpen' },
	{ name: 'idle + cancel → dropped (nothing pending)', from: idle(), event: cancelEv, to: idle(), effects: [], dropped: 'nothingPending' },

	/* awaitingPush — the boot, empty view */
	{ name: 'awaitingPush + openRepo → loading (switch during boot wait consumes the push expectation)', from: awaitingPush(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'awaitingPush + awaitPush → dropped (boot happens once)', from: awaitingPush(), event: awaitPushEv, to: awaitingPush(), effects: [], dropped: 'unexpectedState' },
	{ name: 'awaitingPush + snapshotArrived → snapshotPainted, paint + spin', from: awaitingPush(), event: snapshotEv, to: snapshotPainted(), effects: [fx.paintSnapshot(REPO), fx.spinOn()], dropped: null },
	{ name: 'awaitingPush + loadViewPushed → loaded, both halves applied (firstPaint)', from: awaitingPush(), event: pushOk, to: { type: 'loaded', repo: REPO, commitsId: PUSH_ID, followUpsPending: [], lastError: null }, effects: [fx.applyRepoInfo(REPO, PUSH_ID), fx.applyCommits(REPO, PUSH_ID, true, false)], dropped: null },
	{ name: 'awaitingPush + repoInfoResponse → dropped (the boot issued no request)', from: awaitingPush(), event: repoInfoOk, to: awaitingPush(), effects: [], dropped: 'unexpectedState' },
	{ name: 'awaitingPush + commitsResponse → dropped', from: awaitingPush(), event: commitsOk, to: awaitingPush(), effects: [], dropped: 'unexpectedState' },
	{ name: 'awaitingPush + refreshRequested → dropped (refresh would race the push)', from: awaitingPush(), event: refreshSoft, to: awaitingPush(), effects: [], dropped: 'pushPending' },
	{ name: 'awaitingPush + cancel → empty, nothing done', from: awaitingPush(), event: cancelEv, to: emptyView(), effects: [], dropped: null },

	/* snapshotPainted — the boot, previous session's rows on screen */
	{ name: 'snapshotPainted + openRepo → loading, snapshot cleared', from: snapshotPainted(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'snapshotPainted + awaitPush → dropped', from: snapshotPainted(), event: awaitPushEv, to: snapshotPainted(), effects: [], dropped: 'unexpectedState' },
	{ name: 'snapshotPainted + snapshotArrived → dropped (a second snapshot never paints)', from: snapshotPainted(), event: snapshotEv, to: snapshotPainted(), effects: [], dropped: 'unexpectedState' },
	{ name: 'snapshotPainted + loadViewPushed → loaded, push reconciles and the spin stops', from: snapshotPainted(), event: pushOk, to: { type: 'loaded', repo: REPO, commitsId: PUSH_ID, followUpsPending: [], lastError: null }, effects: [fx.applyRepoInfo(REPO, PUSH_ID), fx.applyCommits(REPO, PUSH_ID, true, false), fx.spinOff()], dropped: null },
	{ name: 'snapshotPainted + repoInfoResponse → dropped', from: snapshotPainted(), event: repoInfoOk, to: snapshotPainted(), effects: [], dropped: 'unexpectedState' },
	{ name: 'snapshotPainted + commitsResponse → dropped', from: snapshotPainted(), event: commitsOk, to: snapshotPainted(), effects: [], dropped: 'unexpectedState' },
	{ name: 'snapshotPainted + refreshRequested → dropped (pushPending)', from: snapshotPainted(), event: refreshSoft, to: snapshotPainted(), effects: [], dropped: 'pushPending' },
	{ name: 'snapshotPainted + cancel → empty, stale snapshot cleared and spin stopped', from: snapshotPainted(), event: cancelEv, to: emptyView(), effects: [fx.clearView(), fx.spinOff()], dropped: null },

	/* loading, phase repoInfo — first load between the repo-info request and its response */
	{ name: 'loading(repoInfo) + openRepo → loading (repo switch mid-load restarts under the new id)', from: loadingRepoInfo(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'loading(repoInfo) + awaitPush → dropped', from: loadingRepoInfo(), event: awaitPushEv, to: loadingRepoInfo(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loading(repoInfo) + snapshotArrived → dropped (snapshots only at boot)', from: loadingRepoInfo(), event: snapshotEv, to: loadingRepoInfo(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loading(repoInfo) + loadViewPushed → dropped (a late push must not stomp a running cycle)', from: loadingRepoInfo(), event: pushOk, to: loadingRepoInfo(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loading(repoInfo) + repoInfoResponse → phase commits, apply + issue the commits request (hard)', from: loadingRepoInfo(), event: repoInfoOk, to: { type: 'loading', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'commits', firstLoad: true, followUpsPending: [] }, effects: [fx.applyRepoInfo(REPO, REPO_INFO_ID), fx.issueCommits(REPO, COMMITS_ID, true)], dropped: null },
	{ name: 'loading(repoInfo) + commitsResponse → dropped (early: the commits request does not exist yet)', from: loadingRepoInfo(), event: commitsOk, to: loadingRepoInfo(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loading(repoInfo) + refreshRequested → joined under the new id, repo-info re-issued', from: loadingRepoInfo(), event: refreshSoft, to: joinedBySoftFull('loading'), effects: joinEffectsSoftFull('loading'), dropped: null },
	{ name: 'loading(repoInfo) + cancel → empty, spin stopped', from: loadingRepoInfo(), event: cancelEv, to: emptyView(), effects: [fx.spinOff()], dropped: null },

	/* loading, phase commits — first load, commits request in flight */
	{ name: 'loading(commits) + openRepo → loading (repo switch mid-load)', from: loadingCommits(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'loading(commits) + awaitPush → dropped', from: loadingCommits(), event: awaitPushEv, to: loadingCommits(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loading(commits) + snapshotArrived → dropped', from: loadingCommits(), event: snapshotEv, to: loadingCommits(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loading(commits) + loadViewPushed → dropped', from: loadingCommits(), event: pushOk, to: loadingCommits(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loading(commits) + repoInfoResponse → dropped (the repo-info half already answered)', from: loadingCommits(), event: repoInfoOk, to: loadingCommits(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loading(commits) + commitsResponse → loaded, first paint + spin stop', from: loadingCommits(), event: commitsOk, to: loadedFromCycle(), effects: [fx.applyCommits(REPO, COMMITS_ID, true, false), fx.spinOff()], dropped: null },
	{ name: 'loading(commits) + refreshRequested → joined under the new id, repo-info re-issued', from: loadingCommits(), event: refreshSoft, to: joinedBySoftFull('loading'), effects: joinEffectsSoftFull('loading'), dropped: null },
	{ name: 'loading(commits) + cancel → empty, spin stopped', from: loadingCommits(), event: cancelEv, to: emptyView(), effects: [fx.spinOff()], dropped: null },

	/* refreshing, phase repoInfo — soft refresh over rows that stay on screen */
	{ name: 'refreshing(repoInfo) + openRepo → loading, painted rows cleared', from: refreshingRepoInfo(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'refreshing(repoInfo) + awaitPush → dropped', from: refreshingRepoInfo(), event: awaitPushEv, to: refreshingRepoInfo(), effects: [], dropped: 'unexpectedState' },
	{ name: 'refreshing(repoInfo) + snapshotArrived → dropped', from: refreshingRepoInfo(), event: snapshotEv, to: refreshingRepoInfo(), effects: [], dropped: 'unexpectedState' },
	{ name: 'refreshing(repoInfo) + loadViewPushed → dropped', from: refreshingRepoInfo(), event: pushOk, to: refreshingRepoInfo(), effects: [], dropped: 'unexpectedState' },
	{ name: 'refreshing(repoInfo) + repoInfoResponse → phase commits, apply + issue the commits request (soft)', from: refreshingRepoInfo(), event: repoInfoOk, to: { type: 'refreshing', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'commits', firstLoad: false, followUpsPending: [] }, effects: [fx.applyRepoInfo(REPO, REPO_INFO_ID), fx.issueCommits(REPO, COMMITS_ID, false)], dropped: null },
	{ name: 'refreshing(repoInfo) + commitsResponse → dropped (early)', from: refreshingRepoInfo(), event: commitsOk, to: refreshingRepoInfo(), effects: [], dropped: 'unexpectedState' },
	{ name: 'refreshing(repoInfo) + refreshRequested → joined, rows kept (no clearView, no skeleton)', from: refreshingRepoInfo(), event: refreshSoft, to: joinedBySoftFull('refreshing'), effects: joinEffectsSoftFull('refreshing'), dropped: null },
	{ name: 'refreshing(repoInfo) + cancel → loaded under the cancelled id sentinel, rows kept', from: refreshingRepoInfo(), event: cancelEv, to: { type: 'loaded', repo: REPO, commitsId: CANCELLED_REQUEST_ID, followUpsPending: [], lastError: null }, effects: [fx.spinOff()], dropped: null },

	/* refreshing, phase commits — soft refresh, commits request in flight */
	{ name: 'refreshing(commits) + openRepo → loading, painted rows cleared', from: refreshingCommits(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'refreshing(commits) + awaitPush → dropped', from: refreshingCommits(), event: awaitPushEv, to: refreshingCommits(), effects: [], dropped: 'unexpectedState' },
	{ name: 'refreshing(commits) + snapshotArrived → dropped', from: refreshingCommits(), event: snapshotEv, to: refreshingCommits(), effects: [], dropped: 'unexpectedState' },
	{ name: 'refreshing(commits) + loadViewPushed → dropped', from: refreshingCommits(), event: pushOk, to: refreshingCommits(), effects: [], dropped: 'unexpectedState' },
	{ name: 'refreshing(commits) + repoInfoResponse → dropped (repo-info half already answered)', from: refreshingCommits(), event: repoInfoOk, to: refreshingCommits(), effects: [], dropped: 'unexpectedState' },
	{ name: 'refreshing(commits) + commitsResponse → loaded, rows reconciled (not a first paint) + spin stop', from: refreshingCommits(), event: commitsOk, to: loadedFromCycle(), effects: [fx.applyCommits(REPO, COMMITS_ID, false, false), fx.spinOff()], dropped: null },
	{ name: 'refreshing(commits) + refreshRequested → joined, rows kept', from: refreshingCommits(), event: refreshSoft, to: joinedBySoftFull('refreshing'), effects: joinEffectsSoftFull('refreshing'), dropped: null },
	{ name: 'refreshing(commits) + cancel → loaded under the cancelled id sentinel, rows kept', from: refreshingCommits(), event: cancelEv, to: { type: 'loaded', repo: REPO, commitsId: CANCELLED_REQUEST_ID, followUpsPending: [], lastError: null }, effects: [fx.spinOff()], dropped: null },

	/* loaded — quiescent with data; staged follow-ups may still land */
	{ name: 'loaded + openRepo → loading (a switch to any repo is a full reload)', from: loaded(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'loaded + awaitPush → dropped', from: loaded(), event: awaitPushEv, to: loaded(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loaded + snapshotArrived → dropped', from: loaded(), event: snapshotEv, to: loaded(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loaded + loadViewPushed → dropped (a duplicate/late push)', from: loaded(), event: pushOk, to: loaded(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loaded + repoInfoResponse → dropped (quiescent: the repo-info half answered long ago)', from: loaded(), event: repoInfoOk, to: loaded(), effects: [], dropped: 'unexpectedState' },
	{ name: 'loaded + commitsResponse → still loaded, the staged follow-up applies (same id)', from: loaded(), event: commitsOk, to: loadedFromCycle(), effects: [fx.applyCommits(REPO, COMMITS_ID, false, true)], dropped: null },
	{ name: 'loaded + refreshRequested → refreshing under the new id, rows kept', from: loaded(), event: refreshSoft, to: joinedBySoftFull('refreshing'), effects: joinEffectsSoftFull('refreshing'), dropped: null },
	{ name: 'loaded + cancel → dropped (nothing pending)', from: loaded(), event: cancelEv, to: loaded(), effects: [], dropped: 'nothingPending' },

	/* error — failed with nothing on screen */
	{ name: 'error + openRepo → loading, full open effects', from: errorView(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'error + awaitPush → dropped', from: errorView(), event: awaitPushEv, to: errorView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'error + snapshotArrived → dropped', from: errorView(), event: snapshotEv, to: errorView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'error + loadViewPushed → dropped', from: errorView(), event: pushOk, to: errorView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'error + repoInfoResponse → dropped (the failed cycle is closed; no half-recovery under the retry dialog)', from: errorView(), event: repoInfoOk, to: errorView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'error + commitsResponse → dropped (the failed cycle is closed)', from: errorView(), event: commitsOk, to: errorView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'error + refreshRequested → loading (the retry), skeleton + repo-info request', from: errorView(), event: refreshSoft, to: restarted(), effects: restartEffects(), dropped: null },
	{ name: 'error + cancel → dropped (nothing pending)', from: errorView(), event: cancelEv, to: errorView(), effects: [], dropped: 'nothingPending' },

	/* repoGone — the repository vanished (isRepo: false) */
	{ name: 'repoGone + openRepo → loading (the re-checked list switched repositories)', from: repoGone(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'repoGone + awaitPush → dropped', from: repoGone(), event: awaitPushEv, to: repoGone(), effects: [], dropped: 'unexpectedState' },
	{ name: 'repoGone + snapshotArrived → dropped', from: repoGone(), event: snapshotEv, to: repoGone(), effects: [], dropped: 'unexpectedState' },
	{ name: 'repoGone + loadViewPushed → dropped', from: repoGone(), event: pushOk, to: repoGone(), effects: [], dropped: 'unexpectedState' },
	{ name: 'repoGone + repoInfoResponse → dropped', from: repoGone(), event: repoInfoOk, to: repoGone(), effects: [], dropped: 'unexpectedState' },
	{ name: 'repoGone + commitsResponse → dropped', from: repoGone(), event: commitsOk, to: repoGone(), effects: [], dropped: 'unexpectedState' },
	{ name: 'repoGone + refreshRequested → loading, skeleton + repo-info request', from: repoGone(), event: refreshSoft, to: restarted(), effects: restartEffects(), dropped: null },
	{ name: 'repoGone + cancel → dropped (nothing pending)', from: repoGone(), event: cancelEv, to: repoGone(), effects: [], dropped: 'nothingPending' },

	/* empty — a cancelled data-less cycle */
	{ name: 'empty + openRepo → loading, full open effects', from: emptyView(), event: openOther, to: loadingAfterOpen(OTHER), effects: openEffects(OTHER), dropped: null },
	{ name: 'empty + awaitPush → dropped', from: emptyView(), event: awaitPushEv, to: emptyView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'empty + snapshotArrived → dropped', from: emptyView(), event: snapshotEv, to: emptyView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'empty + loadViewPushed → dropped', from: emptyView(), event: pushOk, to: emptyView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'empty + repoInfoResponse → dropped', from: emptyView(), event: repoInfoOk, to: emptyView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'empty + commitsResponse → dropped', from: emptyView(), event: commitsOk, to: emptyView(), effects: [], dropped: 'unexpectedState' },
	{ name: 'empty + refreshRequested → loading, skeleton + repo-info request', from: emptyView(), event: refreshSoft, to: restarted(), effects: restartEffects(), dropped: null },
	{ name: 'empty + cancel → dropped (nothing pending)', from: emptyView(), event: cancelEv, to: emptyView(), effects: [], dropped: 'nothingPending' }
];

/** The variant payloads the base matrix keeps out: mismatches, error shapes, join flavours. */
const VARIANTS: readonly Cell[] = [
	/* requestId mismatches — stale responses of a previous repo/request */
	{ name: 'loading(repoInfo) + repoInfoResponse with a stale id → dropped (staleRequestId)', from: loadingRepoInfo(), event: { type: 'repoInfoResponse', repo: REPO, requestId: 4, isRepo: true, remoteRefsPending: false, error: null }, to: loadingRepoInfo(), effects: [], dropped: 'staleRequestId' },
	{ name: 'loading(commits) + commitsResponse with a stale id → dropped (staleRequestId)', from: loadingCommits(), event: { type: 'commitsResponse', repo: REPO, requestId: 4, error: null, followUpsPending: [] }, to: loadingCommits(), effects: [], dropped: 'staleRequestId' },
	{ name: 'loaded + commitsResponse with the previous cycle\'s id → dropped (staleRequestId)', from: loaded(), event: { type: 'commitsResponse', repo: REPO, requestId: 4, error: null, followUpsPending: [] }, to: loaded(), effects: [], dropped: 'staleRequestId' },
	{ name: 'refreshing(commits) + commitsResponse with a stale id → dropped (staleRequestId)', from: refreshingCommits(), event: { type: 'commitsResponse', repo: REPO, requestId: 4, error: null, followUpsPending: [] }, to: refreshingCommits(), effects: [], dropped: 'staleRequestId' },

	/* repo mismatches — responses of another repository */
	{ name: 'loading(repoInfo) + repoInfoResponse for another repo → dropped (repoMismatch)', from: loadingRepoInfo(), event: { type: 'repoInfoResponse', repo: OTHER, requestId: REPO_INFO_ID, isRepo: true, remoteRefsPending: false, error: null }, to: loadingRepoInfo(), effects: [], dropped: 'repoMismatch' },
	{ name: 'loading(commits) + commitsResponse for another repo → dropped (repoMismatch)', from: loadingCommits(), event: { type: 'commitsResponse', repo: OTHER, requestId: COMMITS_ID, error: null, followUpsPending: [] }, to: loadingCommits(), effects: [], dropped: 'repoMismatch' },
	{ name: 'loaded + commitsResponse for another repo → dropped (repoMismatch)', from: loaded(), event: { type: 'commitsResponse', repo: OTHER, requestId: COMMITS_ID, error: null, followUpsPending: [] }, to: loaded(), effects: [], dropped: 'repoMismatch' },
	{ name: 'awaitingPush + loadViewPushed for another repo → dropped (repoMismatch)', from: awaitingPush(), event: { type: 'loadViewPushed', repo: OTHER, requestId: PUSH_ID, error: null, followUpsPending: [] }, to: awaitingPush(), effects: [], dropped: 'repoMismatch' },
	{ name: 'awaitingPush + snapshotArrived for another repo → dropped (repoMismatch)', from: awaitingPush(), event: { type: 'snapshotArrived', repo: OTHER }, to: awaitingPush(), effects: [], dropped: 'repoMismatch' },
	{ name: 'loading(repoInfo) + cancel for another repo → dropped (repoMismatch)', from: loadingRepoInfo(), event: { type: 'cancel', repo: OTHER }, to: loadingRepoInfo(), effects: [], dropped: 'repoMismatch' },
	{ name: 'loaded + refreshRequested for another repo → dropped (repoMismatch)', from: loaded(), event: { type: 'refreshRequested', repo: OTHER, requestId: NEXT_ID, hard: false, skipRepoInfo: false }, to: loaded(), effects: [], dropped: 'repoMismatch' },

	/* error shapes */
	{ name: 'loading(repoInfo) + repoInfoResponse(error) → error, view cleared + retryable dialog', from: loadingRepoInfo(), event: { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: true, remoteRefsPending: false, error: 'no such repository' }, to: { type: 'error', repo: REPO, reason: 'no such repository' }, effects: [fx.clearView(), fx.showLoadError('no such repository'), fx.spinOff()], dropped: null },
	{ name: 'loading(commits) + commitsResponse(error) → error, view cleared + retryable dialog', from: loadingCommits(), event: { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: 'bad revision', followUpsPending: [] }, to: { type: 'error', repo: REPO, reason: 'bad revision' }, effects: [fx.clearView(), fx.showLoadError('bad revision'), fx.spinOff()], dropped: null },
	{ name: 'refreshing(repoInfo) + repoInfoResponse(error) → loaded with the error note, DATA STAYS (no clearView)', from: refreshingRepoInfo(), event: { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: true, remoteRefsPending: false, error: 'git index locked' }, to: { type: 'loaded', repo: REPO, commitsId: COMMITS_ID, followUpsPending: [], lastError: 'git index locked' }, effects: [fx.showLoadError('git index locked'), fx.spinOff()], dropped: null },
	{ name: 'refreshing(commits) + commitsResponse(error) → loaded with the error note, DATA STAYS (no clearView)', from: refreshingCommits(), event: { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: 'git index locked', followUpsPending: [] }, to: { type: 'loaded', repo: REPO, commitsId: COMMITS_ID, followUpsPending: [], lastError: 'git index locked' }, effects: [fx.showLoadError('git index locked'), fx.spinOff()], dropped: null },
	{ name: 'loaded + commitsResponse(error) of a follow-up → loaded with the error note, data stays', from: loaded(), event: { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: 'uncommitted status failed', followUpsPending: [] }, to: { type: 'loaded', repo: REPO, commitsId: COMMITS_ID, followUpsPending: [], lastError: 'uncommitted status failed' }, effects: [fx.showLoadError('uncommitted status failed')], dropped: null },
	{ name: 'awaitingPush + loadViewPushed(error) → error, view cleared + retryable dialog', from: awaitingPush(), event: { type: 'loadViewPushed', repo: REPO, requestId: PUSH_ID, error: 'push failed', followUpsPending: [] }, to: { type: 'error', repo: REPO, reason: 'push failed' }, effects: [fx.clearView(), fx.showLoadError('push failed')], dropped: null },
	{ name: 'snapshotPainted + loadViewPushed(error) → error, snapshot cleared + spin stopped', from: snapshotPainted(), event: { type: 'loadViewPushed', repo: REPO, requestId: PUSH_ID, error: 'push failed', followUpsPending: [] }, to: { type: 'error', repo: REPO, reason: 'push failed' }, effects: [fx.clearView(), fx.showLoadError('push failed'), fx.spinOff()], dropped: null },

	/* the repoGone outcome */
	{ name: 'loading(repoInfo) + repoInfoResponse(isRepo: false) → repoGone, list re-checked', from: loadingRepoInfo(), event: { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: false, remoteRefsPending: false, error: null }, to: repoGone(), effects: [fx.spinOff(), fx.checkRepos()], dropped: null },
	{ name: 'refreshing(repoInfo) + repoInfoResponse(isRepo: false) → repoGone (rows on screen are left alone)', from: refreshingRepoInfo(), event: { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: false, remoteRefsPending: false, error: null }, to: repoGone(), effects: [fx.spinOff(), fx.checkRepos()], dropped: null },

	/* follow-up tracking */
	{ name: 'refreshing(repoInfo) + repoInfoResponse(remoteRefsPending) → phase commits with remoteRefs pending', from: refreshingRepoInfo(), event: { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: true, remoteRefsPending: true, error: null }, to: { type: 'refreshing', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'commits', firstLoad: false, followUpsPending: ['remoteRefs'] }, effects: [fx.applyRepoInfo(REPO, REPO_INFO_ID), fx.issueCommits(REPO, COMMITS_ID, false)], dropped: null },
	{ name: 'loaded + commitsResponse announcing follow-ups → the pending list is replaced', from: loaded(), event: { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: null, followUpsPending: ['uncommitted', 'gerrit'] }, to: { type: 'loaded', repo: REPO, commitsId: COMMITS_ID, followUpsPending: ['uncommitted', 'gerrit'], lastError: null }, effects: [fx.applyCommits(REPO, COMMITS_ID, false, true)], dropped: null },
	{ name: 'loaded(with lastError) + commitsResponse(ok) → the note clears', from: { type: 'loaded', repo: REPO, commitsId: COMMITS_ID, followUpsPending: [], lastError: 'earlier failure' }, event: commitsOk, to: loadedFromCycle(), effects: [fx.applyCommits(REPO, COMMITS_ID, false, true)], dropped: null },
	{ name: 'snapshotPainted + loadViewPushed with pending follow-ups → loaded tracks them', from: snapshotPainted(), event: { type: 'loadViewPushed', repo: REPO, requestId: PUSH_ID, error: null, followUpsPending: ['uncommitted'] }, to: { type: 'loaded', repo: REPO, commitsId: PUSH_ID, followUpsPending: ['uncommitted'], lastError: null }, effects: [fx.applyRepoInfo(REPO, PUSH_ID), fx.applyCommits(REPO, PUSH_ID, true, false), fx.spinOff()], dropped: null },

	/* refresh flavours */
	{ name: 'loaded + refreshRequested(hard) → loading, rows cleared + skeleton', from: loaded(), event: { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: true, skipRepoInfo: false }, to: { type: 'loading', repo: REPO, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: false, followUpsPending: [] }, effects: [fx.clearView(), fx.showSkeleton(), fx.spinOn(), fx.issueRepoInfo(REPO, NEXT_ID)], dropped: null },
	{ name: 'loaded + refreshRequested(skipRepoInfo: load-more) → refreshing at the commits half directly', from: loaded(), event: { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: true }, to: { type: 'refreshing', repo: REPO, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'commits', firstLoad: false, followUpsPending: [] }, effects: [fx.spinOn(), fx.issueCommits(REPO, NEXT_ID, false)], dropped: null },
	{ name: 'loaded + openRepo of the SAME repo → a full reload (loading, firstLoad)', from: loaded(), event: { type: 'openRepo', repo: REPO, requestId: NEXT_ID }, to: loadingAfterOpen(REPO), effects: openEffects(REPO), dropped: null },
	{ name: 'error + refreshRequested(hard retry) → loading, skeleton + repo-info request', from: errorView(), event: { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: true, skipRepoInfo: false }, to: restarted(), effects: restartEffects(), dropped: null },
	{ name: 'refreshing(commits) + refreshRequested(hard join) → loading, rows cleared + skeleton + repo-info re-issued', from: refreshingCommits(), event: { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: true, skipRepoInfo: false }, to: { type: 'loading', repo: REPO, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: false, followUpsPending: [] }, effects: [fx.clearView(), fx.showSkeleton(), fx.spinOn(), fx.issueRepoInfo(REPO, NEXT_ID)], dropped: null },
	{ name: 'loading(repoInfo) + refreshRequested(skipRepoInfo join) → waits for the in-flight repo info (id kept, no request)', from: loadingRepoInfo(), event: { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: true }, to: { type: 'loading', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: true, followUpsPending: [] }, effects: [fx.showSkeleton(), fx.spinOn()], dropped: null },
	{ name: 'loading(commits) + refreshRequested(skipRepoInfo join: load-more) → issues the commits request under the new id (hard)', from: loadingCommits(), event: { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: true }, to: { type: 'loading', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: NEXT_ID, phase: 'commits', firstLoad: true, followUpsPending: [] }, effects: [fx.showSkeleton(), fx.spinOn(), fx.issueCommits(REPO, NEXT_ID, true)], dropped: null },
	{ name: 'refreshing(repoInfo) + refreshRequested(skipRepoInfo join) → waits for the in-flight repo info', from: refreshingRepoInfo(), event: { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: true }, to: { type: 'refreshing', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: false, followUpsPending: [] }, effects: [fx.spinOn()], dropped: null },
	{ name: 'refreshing(commits) + refreshRequested(skipRepoInfo join: load-more) → issues the commits request under the new id (soft)', from: refreshingCommits(), event: { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: true }, to: { type: 'refreshing', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: NEXT_ID, phase: 'commits', firstLoad: false, followUpsPending: [] }, effects: [fx.spinOn(), fx.issueCommits(REPO, NEXT_ID, false)], dropped: null }
];

/** Asserts one matrix cell: the full state, the full effects, and the exact drop record. */
function expectCell(cell: Cell) {
	const result = reduce(cell.from, cell.event);
	expect(result.state).toEqual(cell.to);
	expect(result.effects).toEqual(cell.effects);
	if (cell.dropped === null) {
		expect(result.dropped).toBeNull();
	} else {
		expect(result.dropped).not.toBeNull();
		expect(result.dropped!.event).toBe(cell.event.type);
		expect(result.dropped!.reason).toBe(cell.dropped);
		expect(result.dropped!.detail).toBe(stateLabel(cell.from) + ' <- ' + cell.event.type);
	}
}

describe('loadMachine transition table', () => {
	describe('one test per (state, event) pair: the 11 × 8 base matrix', () => {
		for (const cell of TABLE) {
			it(cell.name, () => { expectCell(cell); });
		}
	});

	describe('variant payloads: mismatches, error shapes, follow-ups, refresh flavours', () => {
		for (const cell of VARIANTS) {
			it(cell.name, () => { expectCell(cell); });
		}
	});

	it('the base matrix really is the full cross product: 11 states × 8 events = 88 cells, no pair repeated', () => {
		const seen: string[] = [];
		for (const cell of TABLE) {
			const key = cell.from.type + (cell.from.type === 'loading' || cell.from.type === 'refreshing' ? ':' + cell.from.phase : '') + ' × ' + cell.event.type;
			expect(seen).not.toContain(key);
			seen.push(key);
		}
		expect(TABLE).toHaveLength(88);
	});

	it('every transition is deterministic: applying the same event twice gives the same result', () => {
		const states = [idle(), awaitingPush(), snapshotPainted(), loadingRepoInfo(), loadingCommits(), refreshingRepoInfo(), refreshingCommits(), loaded(), errorView(), repoGone(), emptyView()];
		const events = [openOther, awaitPushEv, snapshotEv, pushOk, repoInfoOk, commitsOk, refreshSoft, cancelEv];
		for (const state of states) {
			for (const event of events) {
				expect(reduce(state, event)).toEqual(reduce(state, event));
			}
		}
	});

	it('the reducer never throws: the full 11 × 8 cross product returns a result, not an exception', () => {
		const states = [idle(), awaitingPush(), snapshotPainted(), loadingRepoInfo(), loadingCommits(), refreshingRepoInfo(), refreshingCommits(), loaded(), errorView(), repoGone(), emptyView()];
		const events = [openOther, awaitPushEv, snapshotEv, pushOk, repoInfoOk, commitsOk, refreshSoft, cancelEv];
		for (const state of states) {
			for (const event of events) {
				const result = reduce(state, event);
				expect(result.state.type).toBeTruthy();
				expect(Array.isArray(result.effects)).toBe(true);
			}
		}
	});

	it('initialLoadState is idle; refreshSpinning spins exactly for the pending states', () => {
		expect(initialLoadState()).toEqual({ type: 'idle' });
		// inProgress (loading/refreshing) or snapshotRefreshing (snapshotPainted) spin the button;
		// the boot's empty wait (awaitingPush) does not.
		expect(refreshSpinning(initialLoadState())).toBe(false);
		expect(refreshSpinning(awaitingPush())).toBe(false);
		expect(refreshSpinning(snapshotPainted())).toBe(true);
		expect(refreshSpinning(loadingRepoInfo())).toBe(true);
		expect(refreshSpinning(refreshingCommits())).toBe(true);
		expect(refreshSpinning(loaded())).toBe(false);
		expect(refreshSpinning(errorView())).toBe(false);
		expect(refreshSpinning(repoGone())).toBe(false);
		expect(refreshSpinning(emptyView())).toBe(false);
	});
});

describe('loadMachine lifecycle scenarios (the sequences RepoLoader really runs)', () => {
	it('boot without a snapshot: wait for the push, apply it, then accept its staged follow-ups', () => {
		let state = initialLoadState();
		let result = reduce(state, { type: 'awaitPush', repo: REPO });
		state = result.state;
		expect(state).toEqual({ type: 'awaitingPush', repo: REPO });
		expect(refreshSpinning(state)).toBe(false); // nothing paints yet, nothing spins

		result = reduce(state, { type: 'loadViewPushed', repo: REPO, requestId: PUSH_ID, error: null, followUpsPending: ['uncommitted'] });
		state = result.state;
		expect(state).toEqual({ type: 'loaded', repo: REPO, commitsId: PUSH_ID, followUpsPending: ['uncommitted'], lastError: null });

		// The deferred "Uncommitted Changes" follow-up carries the push's id
		result = reduce(state, { type: 'commitsResponse', repo: REPO, requestId: PUSH_ID, error: null, followUpsPending: [] });
		expect(result.state).toEqual({ type: 'loaded', repo: REPO, commitsId: PUSH_ID, followUpsPending: [], lastError: null });
		expect(result.effects).toEqual([fx.applyCommits(REPO, PUSH_ID, false, true)]);
	});

	it('boot with a snapshot: paint, reconcile with the push, spin stops', () => {
		let state = reduce(initialLoadState(), { type: 'awaitPush', repo: REPO }).state;
		state = reduce(state, { type: 'snapshotArrived', repo: REPO }).state;
		expect(state).toEqual({ type: 'snapshotPainted', repo: REPO });
		expect(refreshSpinning(state)).toBe(true); // snapshotRefreshing

		const result = reduce(state, { type: 'loadViewPushed', repo: REPO, requestId: PUSH_ID, error: null, followUpsPending: [] });
		expect(result.state).toEqual({ type: 'loaded', repo: REPO, commitsId: PUSH_ID, followUpsPending: [], lastError: null });
		expect(result.effects).toEqual([fx.applyRepoInfo(REPO, PUSH_ID), fx.applyCommits(REPO, PUSH_ID, true, false), fx.spinOff()]);
		expect(refreshSpinning(result.state)).toBe(false);
	});

	it('repo switch mid-load: the old repo\'s in-flight responses drop on repo and id, the new cycle completes', () => {
		let state = reduce(initialLoadState(), { type: 'openRepo', repo: REPO, requestId: REPO_INFO_ID }).state;
		state = reduce(state, { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: true, remoteRefsPending: false, error: null }).state;
		expect(state.type).toBe('loading');

		// The user switches before the commits response lands
		state = reduce(state, { type: 'openRepo', repo: OTHER, requestId: NEXT_ID }).state;
		expect(state).toEqual({ type: 'loading', repo: OTHER, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: true, followUpsPending: [] });

		// The first repo's commits response arrives late: wrong repo AND stale id — dropped
		const late = reduce(state, { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: null, followUpsPending: [] });
		expect(late.dropped!.reason).toBe('repoMismatch');
		expect(late.state).toEqual(state);

		// The new repo's cycle runs to completion
		state = reduce(state, { type: 'repoInfoResponse', repo: OTHER, requestId: NEXT_ID, isRepo: true, remoteRefsPending: false, error: null }).state;
		expect(state).toEqual({ type: 'loading', repo: OTHER, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'commits', firstLoad: true, followUpsPending: [] });
		const done = reduce(state, { type: 'commitsResponse', repo: OTHER, requestId: NEXT_ID, error: null, followUpsPending: [] });
		expect(done.state).toEqual({ type: 'loaded', repo: OTHER, commitsId: NEXT_ID, followUpsPending: [], lastError: null });
		expect(done.effects).toEqual([fx.applyCommits(OTHER, NEXT_ID, true, false), fx.spinOff()]);
	});

	it('error during a soft refresh: data stays visible, the state returns to loaded with an error note', () => {
		let state = loaded();
		state = reduce(state, { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: false }).state;
		expect(state).toEqual({ type: 'refreshing', repo: REPO, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: false, followUpsPending: [] });

		state = reduce(state, { type: 'repoInfoResponse', repo: REPO, requestId: NEXT_ID, isRepo: true, remoteRefsPending: false, error: null }).state;
		expect(state.type).toBe('refreshing');

		const failed = reduce(state, { type: 'commitsResponse', repo: REPO, requestId: NEXT_ID, error: 'git index locked', followUpsPending: [] });
		expect(failed.state).toEqual({ type: 'loaded', repo: REPO, commitsId: NEXT_ID, followUpsPending: [], lastError: 'git index locked' });
		// No clearView — the rendered rows stay on screen under the error note
		expect(failed.effects).toEqual([fx.showLoadError('git index locked'), fx.spinOff()]);

		// A later successful refresh clears the note
		state = failed.state;
		state = reduce(state, { type: 'refreshRequested', repo: REPO, requestId: 10, hard: false, skipRepoInfo: true }).state;
		const recovered = reduce(state, { type: 'commitsResponse', repo: REPO, requestId: 10, error: null, followUpsPending: [] });
		expect(recovered.state).toEqual({ type: 'loaded', repo: REPO, commitsId: 10, followUpsPending: [], lastError: null });
	});

	it('error during the initial load: the view empties into the error state; the retry restarts the cycle', () => {
		let state = reduce(initialLoadState(), { type: 'openRepo', repo: REPO, requestId: REPO_INFO_ID }).state;
		state = reduce(state, { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: true, remoteRefsPending: false, error: null }).state;
		// The cycle opened by openRepo(5) carries commitsId 5: the failing response answers it
		const failed = reduce(state, { type: 'commitsResponse', repo: REPO, requestId: REPO_INFO_ID, error: 'bad revision \'HEAD\'', followUpsPending: [] });
		expect(failed.state).toEqual({ type: 'error', repo: REPO, reason: 'bad revision \'HEAD\'' });
		expect(failed.effects).toEqual([fx.clearView(), fx.showLoadError('bad revision \'HEAD\''), fx.spinOff()]);

		// The retry dialog's action: a fresh cycle under a fresh id
		const retried = reduce(failed.state, { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: true, skipRepoInfo: false });
		expect(retried.state).toEqual({ type: 'loading', repo: REPO, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: false, followUpsPending: [] });
		expect(retried.effects).toEqual(restartEffects());

		// Responses of the FAILED cycle never half-recover the view: while the retry is still in
		// its repo-info half the straggler drops on the phase guard ...
		const early = reduce(retried.state, { type: 'commitsResponse', repo: REPO, requestId: REPO_INFO_ID, error: null, followUpsPending: [] });
		expect(early.dropped!.reason).toBe('unexpectedState');
		// ... and once the retry reaches its commits half, the old id drops as stale
		const inCommits = reduce(retried.state, { type: 'repoInfoResponse', repo: REPO, requestId: NEXT_ID, isRepo: true, remoteRefsPending: false, error: null }).state;
		const stale = reduce(inCommits, { type: 'commitsResponse', repo: REPO, requestId: REPO_INFO_ID, error: null, followUpsPending: [] });
		expect(stale.dropped!.reason).toBe('staleRequestId');
	});

	it('a follow-up of the previous cycle is dropped once a new refresh superseded its id', () => {
		// The reseed hazard: the first response finalised the cycle, its follow-up is still in
		// flight, a new refresh starts.
		let state = reduce(initialLoadState(), { type: 'awaitPush', repo: REPO }).state;
		state = reduce(state, { type: 'loadViewPushed', repo: REPO, requestId: PUSH_ID, error: null, followUpsPending: ['uncommitted'] }).state;
		state = reduce(state, { type: 'commitsResponse', repo: REPO, requestId: PUSH_ID, error: null, followUpsPending: [] }).state;
		expect(state.type).toBe('loaded');

		state = reduce(state, { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: true }).state;
		const stale = reduce(state, { type: 'commitsResponse', repo: REPO, requestId: PUSH_ID, error: null, followUpsPending: [] });
		expect(stale.dropped).toEqual({ event: 'commitsResponse', reason: 'staleRequestId', detail: stateLabel(state) + ' <- commitsResponse' });
		expect(stale.state).toEqual(state); // untouched
	});

	it('a push landing after the user switched repositories during boot is dropped (the stomp prevented)', () => {
		// A push applied unconditionally would adopt its refresh ids over the switched-to
		// repository's cycle; the machine refuses it once the boot wait is over.
		let state = reduce(initialLoadState(), { type: 'awaitPush', repo: '/repo-a' }).state;
		state = reduce(state, { type: 'openRepo', repo: '/repo-b', requestId: NEXT_ID }).state;
		expect(state).toEqual({ type: 'loading', repo: '/repo-b', repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: true, followUpsPending: [] });

		const stomp = reduce(state, { type: 'loadViewPushed', repo: '/repo-a', requestId: PUSH_ID, error: null, followUpsPending: [] });
		expect(stomp.dropped!.reason).toBe('unexpectedState');
		expect(stomp.state).toEqual(state);
	});

	it('repoGone: isRepo false ends the cycle, the list is re-checked, the replacement repo opens', () => {
		const state = reduce(initialLoadState(), { type: 'openRepo', repo: REPO, requestId: REPO_INFO_ID }).state;
		const gone = reduce(state, { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: false, remoteRefsPending: false, error: null });
		expect(gone.state).toEqual({ type: 'repoGone', repo: REPO });
		expect(gone.effects).toEqual([fx.spinOff(), fx.checkRepos()]);

		// The loadRepos(check) response switches to another repository
		const reopened = reduce(gone.state, { type: 'openRepo', repo: OTHER, requestId: NEXT_ID });
		expect(reopened.state.type).toBe('loading');
		expect(reopened.state).toEqual({ type: 'loading', repo: OTHER, repoInfoId: NEXT_ID, commitsId: NEXT_ID, phase: 'repoInfo', firstLoad: true, followUpsPending: [] });
	});

	it('a load-more joining a refresh still in its repo-info half waits for the in-flight response (two-id rule)', () => {
		// skipRepoInfo while still in the repo-info phase ⇒ nothing is issued now;
		// the repo-info response triggers the commits request — under the JOIN's new id.
		let state = loaded();
		state = reduce(state, { type: 'refreshRequested', repo: REPO, requestId: REPO_INFO_ID, hard: false, skipRepoInfo: false }).state;
		const joined = reduce(state, { type: 'refreshRequested', repo: REPO, requestId: COMMITS_ID, hard: false, skipRepoInfo: true });
		expect(joined.state).toEqual({ type: 'refreshing', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'repoInfo', firstLoad: false, followUpsPending: [] });
		expect(joined.effects).toEqual([fx.spinOn()]); // no request: the repo-info half is still in flight

		const repoInfo = reduce(joined.state, { type: 'repoInfoResponse', repo: REPO, requestId: REPO_INFO_ID, isRepo: true, remoteRefsPending: false, error: null });
		expect(repoInfo.state).toEqual({ type: 'refreshing', repo: REPO, repoInfoId: REPO_INFO_ID, commitsId: COMMITS_ID, phase: 'commits', firstLoad: false, followUpsPending: [] });
		expect(repoInfo.effects).toEqual([fx.applyRepoInfo(REPO, REPO_INFO_ID), fx.issueCommits(REPO, COMMITS_ID, false)]);

		const done = reduce(repoInfo.state, { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: null, followUpsPending: [] });
		expect(done.state).toEqual({ type: 'loaded', repo: REPO, commitsId: COMMITS_ID, followUpsPending: [], lastError: null });
	});

	it('cancel of a refresh keeps the rows and invalidates the cycle: stragglers drop', () => {
		const state = reduce(loaded(), { type: 'refreshRequested', repo: REPO, requestId: NEXT_ID, hard: false, skipRepoInfo: false }).state;
		const cancelled = reduce(state, { type: 'cancel', repo: REPO });
		expect(cancelled.state).toEqual({ type: 'loaded', repo: REPO, commitsId: CANCELLED_REQUEST_ID, followUpsPending: [], lastError: null });

		// The abandoned cycle's responses find no matching id: dropped, never applied
		const straggler = reduce(cancelled.state, { type: 'commitsResponse', repo: REPO, requestId: NEXT_ID, error: null, followUpsPending: [] });
		expect(straggler.dropped!.reason).toBe('staleRequestId');
		expect(straggler.state).toEqual(cancelled.state);
	});

	it('a duplicate event is absorbed: the same follow-up applied twice yields identical results', () => {
		const first = reduce(loaded(), { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: null, followUpsPending: ['uncommitted'] });
		const second = reduce(first.state, { type: 'commitsResponse', repo: REPO, requestId: COMMITS_ID, error: null, followUpsPending: ['uncommitted'] });
		expect(second.state).toEqual(first.state);
		expect(second.effects).toEqual(first.effects);
	});
});
