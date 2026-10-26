/**
 * The repo-load lifecycle as an explicit state machine (OPTIMIZATION-PLAN §6 F2): a PURE
 * reducer over the lifecycle that the loader's implicit flags used to encode (loading/repoLoader.ts).
 * WIRED IN via `loadController.ts`: every lifecycle event — the boot's awaited push, a repository
 * switch, a refresh, a response, an error — is dispatched here, a response applies only in a
 * state that expects it and keyed by its request id, and anything else is dropped and logged.
 * This module stays the pure, transition-tested core; the side effects live in the loader's
 * sibling modules.
 *
 * The machine decides WHICH phase the load is in and WHAT the caller should do next; it never
 * does IO itself. Every transition returns the next state, a list of effects (issue a request,
 * apply a response, clear the view, show an error, …) and — when the event does not apply — a
 * drop record instead of an exception, so stale traffic is observable and testable.
 *
 * State diagram (see the deviations below for why this differs from the plan's sketch
 * `Idle → SnapshotPainted → Loading(requestId) → Loaded → Refreshing(requestId) → Loaded`):
 *
 *            awaitPush               snapshotArrived
 *   idle ──────────────────▶ awaitingPush ─────────────────▶ snapshotPainted
 *                                │                             │
 *                 loadViewPushed │ cancel                      │ loadViewPushed
 *                                ▼                             ▼
 *                              empty          applyRepoInfo + applyCommits
 *                                                                      │
 *     openRepo / retry / re-checked list ─▶ loading(repo, phase) ◀─────┘ (adopted push id)
 *                                             │
 *                                repoInfoResponse(ok) → phase 'commits'
 *                                             │
 *                                commitsResponse(ok) ──▶ loaded ⇄ commitsResponse (follow-ups)
 *                                             │                ▲          │
 *                                error ◀──────┤     soft refreshRequested │
 *                          (data-less view)   │                │          │
 *                                repoGone ◀───┘         refreshing(phase) ┘
 *                          (isRepo: false)
 *
 * How the legacy RepoLoader flags map onto these states (repoLoader.ts line numbers):
 *
 * - `currentRepoLoading` (set :214 by `loadRepo`, :125 by `paintFirstPaintSnapshot`, cleared
 *   :463 at the first applied page) → the `firstLoad` field of a cycle plus the boot states:
 *   TRUE exactly in `awaitingPush`, `snapshotPainted` and cycles opened by `openRepo`. It
 *   gated the first-paint scroll behaviour (:517-526) — carried into the wiring by the
 *   `applyCommits` effect's `firstPaint` flag.
 * - `refreshState.inProgress` (set :1075, cleared :564/:373/:903) → `loading`/`refreshing`
 *   (a cycle is pending); `loaded` is the "cycle finalised" state (follow-ups may still land).
 * - `refreshState.snapshotRefreshing` (set :135, cleared :538) → `snapshotPainted` exactly.
 * - `refreshState.hard` (set :982/:1060/:1074) → `loading` means hard (view cleared),
 *   `refreshing` means soft (rows kept); `firstLoad: false` separates a hard refresh from a
 *   repository's first load, which `currentRepoLoading` also conflated.
 * - `refreshState.requestingRepoInfo` (set :1091, cleared :369) → the cycle's `phase:
 *   'repoInfo'`.
 * - `refreshState.loadRepoInfoRefreshId` / `loadCommitsRefreshId` (:1006/:1030 incremented,
 *   :775/:830/:883 compared) → the caller keeps owning the counters and stamps each event
 *   with the id of the request it belongs to; the machine records per-kind ids (`repoInfoId`,
 *   `commitsId`) and accepts only matching ones. The two ids stay separate because a join
 *   that skips the repo-info half keeps the in-flight repo-info response valid while
 *   invalidating commit responses (:1062-1066, :1086-1093).
 * - `refreshState.repoInfoChanges` (:368) → computed inside the `applyRepoInfo` effect's
 *   implementation (`loadRepoInfo` already tracks it, :263-331); it shapes dialog refresh,
 *   not the lifecycle.
 * - `refreshState.requestingConfig` / `loadConfigRefreshId` (:1097-1102, :875-893) → kept
 *   OUT: the config load never blocks, clears or re-shapes the view; it is its own one-shot
 *   request/response keyed by its own id, issued from the `applyCommits` effect's
 *   finalisation (`finaliseRepoLoad`, :678-680).
 * - `bootPushExpected` (:48, set :81, consumed :251/:737) → `awaitingPush`/`snapshotPainted`.
 * - `pendingScrollCommitHash` / `countCommitsBeforePending` (:34-38, :577-622) → kept OUT:
 *   the pinned-commit jump is a sub-machine that only OBSERVES load completions
 *   (`checkPendingScrollCommit` runs inside `finaliseLoadCommits`, :568); folding it in would
 *   multiply the transition matrix without changing a single load transition.
 * - `remoteRefsPending` (response-borne, :280-290) / `uncommittedPending` (:388-410) / the
 *   Gerrit pending flag → the `followUpsPending` list: the wiring derives the kinds from each
 *   response message and the machine carries the latest list. A repo-info response that
 *   announces `remoteRefsPending` seeds `['remoteRefs']`; every commits response REPLACES the
 *   list wholesale (the caller keeps listing 'remoteRefs' until a response carried the
 *   complete branch list).
 * - `prStatusRepos` (:42, :790-801) → kept OUT: pull requests are a follow-up subsystem (the
 *   plan's `FollowUps` split), requested once per repository from the `applyRepoInfo` effect.
 *
 * Deviations from the plan's sketch, each forced by what RepoLoader actually does:
 *
 * 1. The boot is push-based (REFACTOR-PLAN task 4.7): between adopting the repository and the
 *    data landing, the webview issues NO request — the host pushes the merged `loadView`
 *    (:59-101, :735-752). Hence `awaitingPush` (the sketch's `Idle → Loading` edge does not
 *    exist at boot) and `snapshotPainted` as a refinement of that wait (:114-138).
 * 2. `Loaded` still accepts commit responses keyed by `requestId`: the staged delivery (remote
 *    refs, Gerrit, "Uncommitted Changes") sends further responses with the SAME refresh id
 *    after the first one finalised the cycle (:6-10, :825-863). The sketch's
 *    `Loaded → Refreshing → Loaded` loop misses that dimension; `followUpsPending` encodes it.
 * 3. Errors have two shapes. With rows on screen (a soft refresh failing) the data STAYS and
 *    the state returns to `loaded` carrying a `lastError` note — the behaviour §6 F2 asks
 *    for. Legacy `displayLoadDataError` instead clears the view in BOTH cases (:895-909); the
 *    machine deliberately emits no `clearView` effect for the data-on-screen case and records
 *    the difference, so the wiring can choose during migration.
 * 4. `repoGone`: a `loadRepoInfo` response with `isRepo: false` ends the cycle and asks the
 *    host to re-check the repository list (:364-379) — the sketch has no home for it.
 * 5. `empty`: reachable only through `cancel`, which legacy has no analogue of (supersession
 *    by id bump is its only invalidation mechanism). It models "abandon the in-flight cycle,
 *    keep what is painted, invalidate the ids" for panel disposal / a future cancel affordance.
 *
 * Tightenings over legacy (cases where legacy would apply, the machine drops): a pushed
 * `loadView` is accepted only while a push is expected — legacy `processLoadView` applies it
 * unconditionally and adopts its refresh ids over a possibly-running cycle (:741-744), which
 * is exactly the mid-boot repo-switch stomp; responses are keyed by repo as well as id
 * (legacy checks repo only for pull requests :810 and config :877); a response in the wrong
 * phase, after an error, or while quiescent drops instead of applying (legacy applies
 * anything whose id matches — :830 has no inProgress gate).
 */


/** The state every webview starts in; `awaitPush` (the boot) or `openRepo` leaves it. */
export function initialLoadState(): LoadState {
	return { type: 'idle' };
}

/** A stable short label for a state, used in drop details and tests. */
export function stateLabel(state: LoadState): string {
	switch (state.type) {
		case 'idle': return 'idle';
		case 'awaitingPush': return 'awaitingPush(' + state.repo + ')';
		case 'snapshotPainted': return 'snapshotPainted(' + state.repo + ')';
		case 'loading':
		case 'refreshing':
			return state.type + '(' + state.repo + ',' + state.phase + ',' + state.repoInfoId + '/' + state.commitsId + ')';
		case 'loaded': return 'loaded(' + state.repo + ',' + state.commitsId + ')';
		case 'error': return 'error(' + state.repo + ')';
		case 'repoGone': return 'repoGone(' + state.repo + ')';
		case 'empty': return 'empty(' + state.repo + ')';
	}
}

/** Whether the refresh button spins: a pending cycle or a painted snapshot awaiting its push. */
export function refreshSpinning(state: LoadState): boolean {
	return state.type === 'loading' || state.type === 'refreshing' || state.type === 'snapshotPainted';
}

/** The rejected transition: the state is unchanged, nothing is done, the drop is reported. */
function stay(state: LoadState, event: LoadEvent, reason: DropReason): LoadResult {
	return { state: state, effects: [], dropped: { event: event.type, reason: reason, detail: stateLabel(state) + ' <- ' + event.type } };
}

/**
 * The transition table. Checks run in a fixed order — state kind, then repo, then phase, then
 * requestId — so every dropped event has exactly one deterministic reason (a response of a
 * foreign repository is a repoMismatch whatever phase the cycle is in).
 */
export function reduce(state: LoadState, event: LoadEvent): LoadResult {
	switch (event.type) {
		case 'openRepo': return reduceOpenRepo(event);
		case 'awaitPush': return reduceAwaitPush(state, event);
		case 'snapshotArrived': return reduceSnapshotArrived(state, event);
		case 'loadViewPushed': return reduceLoadViewPushed(state, event);
		case 'repoInfoResponse': return reduceRepoInfoResponse(state, event);
		case 'commitsResponse': return reduceCommitsResponse(state, event);
		case 'refreshRequested': return reduceRefreshRequested(state, event);
		case 'cancel': return reduceCancel(state, event);
	}
}

/**
 * `openRepo` is valid from EVERY state (repoLoader.ts:206-243 switches repositories even
 * mid-load; a switch to the same repository is a reload): it resets the view and starts a
 * hard first-load cycle. The clearView effect is unconditional, exactly like legacy's
 * `clearCommits` call in the hard path (a no-op when nothing is painted).
 */

import {
	CANCELLED_REQUEST_ID,
	type AwaitPushEvent,
	type CancelEvent,
	type CommitsResponseEvent,
	type DropReason,
	type LoadEffect,
	type LoadEvent,
	type LoadResult,
	type LoadState,
	type LoadViewPushedEvent,
	type OpenRepoEvent,
	type RefreshRequestedEvent,
	type RepoInfoResponseEvent,
	type SnapshotArrivedEvent
} from './loadMachineTypes';

export * from './loadMachineTypes';
function reduceOpenRepo(event: OpenRepoEvent): LoadResult {
	return {
		state: { type: 'loading', repo: event.repo, repoInfoId: event.requestId, commitsId: event.requestId, phase: 'repoInfo', firstLoad: true, followUpsPending: [] },
		effects: [
			{ kind: 'clearView' },
			{ kind: 'showSkeleton' },
			{ kind: 'spinRefreshButton', spinning: true },
			{ kind: 'issueRepoInfoRequest', repo: event.repo, requestId: event.requestId }
		],
		dropped: null
	};
}

/** `awaitPush` happens once, at boot (repoLoader.ts:67-101): idle → awaitingPush. */
function reduceAwaitPush(state: LoadState, event: AwaitPushEvent): LoadResult {
	if (state.type !== 'idle') return stay(state, event, 'unexpectedState');
	return {
		state: { type: 'awaitingPush', repo: event.repo },
		effects: [{ kind: 'showSkeleton' }],
		dropped: null
	};
}

/** A snapshot paints only during the boot wait, and only for the awaited repository (:114-138). */
function reduceSnapshotArrived(state: LoadState, event: SnapshotArrivedEvent): LoadResult {
	if (state.type !== 'awaitingPush') return stay(state, event, 'unexpectedState');
	if (state.repo !== event.repo) return stay(state, event, 'repoMismatch');
	return {
		state: { type: 'snapshotPainted', repo: state.repo },
		effects: [
			{ kind: 'paintSnapshot', repo: state.repo },
			{ kind: 'spinRefreshButton', spinning: true }
		],
		dropped: null
	};
}

/**
 * The pushed merged view, accepted only while a push is expected. Legacy applies it
 * unconditionally and adopts its refresh ids (:735-752) — the tightening that prevents a
 * switch-during-boot stomp. The caller's post-application decision (a repository whose own
 * settings differ re-requests the commits, :749-752) stays with the wiring: it reads repo
 * settings the machine does not hold.
 */
function reduceLoadViewPushed(state: LoadState, event: LoadViewPushedEvent): LoadResult {
	if (state.type !== 'awaitingPush' && state.type !== 'snapshotPainted') {
		return stay(state, event, 'unexpectedState');
	}
	if (state.repo !== event.repo) return stay(state, event, 'repoMismatch');
	const spinOff = state.type === 'snapshotPainted';
	if (event.error !== null) {
		// Legacy clears the view even when the snapshot's rows are on screen (:895-909); the
		// machine does the same here — an empty view with a retry dialog.
		return {
			state: { type: 'error', repo: state.repo, reason: event.error },
			effects: [
				{ kind: 'clearView' },
				{ kind: 'showLoadError', reason: event.error, retry: true },
				...(spinOff ? [{ kind: 'spinRefreshButton', spinning: false } as LoadEffect] : [])
			],
			dropped: null
		};
	}
	return {
		state: { type: 'loaded', repo: state.repo, commitsId: event.requestId, followUpsPending: event.followUpsPending, lastError: null },
		effects: [
			{ kind: 'applyRepoInfo', repo: state.repo, requestId: event.requestId },
			{ kind: 'applyCommits', repo: state.repo, requestId: event.requestId, firstPaint: true, followUp: false },
			...(spinOff ? [{ kind: 'spinRefreshButton', spinning: false } as LoadEffect] : [])
		],
		dropped: null
	};
}

/**
 * The repo-info half of a cycle: accepted in phase 'repoInfo' with matching repo and
 * `repoInfoId`. Success moves to phase 'commits' and asks the caller to issue the commits
 * request (legacy `finaliseLoadRepoInfo` → `requestLoadCommits`, :364-379) under the cycle's
 * `commitsId`. `isRepo: false` ends the cycle for `repoGone`; an error clears an empty view
 * or, with rows on screen, returns to `loaded` with a note.
 */
function reduceRepoInfoResponse(state: LoadState, event: RepoInfoResponseEvent): LoadResult {
	if (state.type !== 'loading' && state.type !== 'refreshing') return stay(state, event, 'unexpectedState');
	if (state.repo !== event.repo) return stay(state, event, 'repoMismatch');
	if (state.phase !== 'repoInfo') return stay(state, event, 'unexpectedState');
	if (state.repoInfoId !== event.requestId) return stay(state, event, 'staleRequestId');

	if (event.error !== null) {
		if (state.type === 'refreshing') {
			// Rows stay on screen (the F2 behaviour); only the spin and the error note change.
			return {
				state: { type: 'loaded', repo: state.repo, commitsId: state.commitsId, followUpsPending: [], lastError: event.error },
				effects: [
					{ kind: 'showLoadError', reason: event.error, retry: true },
					{ kind: 'spinRefreshButton', spinning: false }
				],
				dropped: null
			};
		}
		return {
			state: { type: 'error', repo: state.repo, reason: event.error },
			effects: [
				{ kind: 'clearView' },
				{ kind: 'showLoadError', reason: event.error, retry: true },
				{ kind: 'spinRefreshButton', spinning: false }
			],
			dropped: null
		};
	}
	if (!event.isRepo) {
		// The repository vanished: end the cycle, ask the host to re-check the list. Whatever is
		// on screen stays (legacy does not clear here either, :367-377).
		return {
			state: { type: 'repoGone', repo: state.repo },
			effects: [
				{ kind: 'spinRefreshButton', spinning: false },
				{ kind: 'checkRepos' }
			],
			dropped: null
		};
	}
	return {
		state: {
			type: state.type,
			repo: state.repo,
			repoInfoId: state.repoInfoId,
			commitsId: state.commitsId,
			phase: 'commits',
			firstLoad: state.firstLoad,
			followUpsPending: event.remoteRefsPending ? ['remoteRefs'] : []
		},
		effects: [
			{ kind: 'applyRepoInfo', repo: state.repo, requestId: event.requestId },
			{ kind: 'issueCommitsRequest', repo: state.repo, requestId: state.commitsId, hard: state.type === 'loading' }
		],
		dropped: null
	};
}

/**
 * The commits half: accepted in phase 'commits' with matching repo and `commitsId`, and in
 * `loaded` for the staged follow-ups (same id, cycle already finalised — repoLoader.ts:825-863).
 * Success completes the cycle into `loaded` (firstPaint carries legacy `currentRepoLoading`);
 * an error clears an empty view, but with rows on screen the data stays and the note is
 * recorded (deviation from legacy's unconditional clear, per F2's stated behaviour).
 */
function reduceCommitsResponse(state: LoadState, event: CommitsResponseEvent): LoadResult {
	if (state.type === 'loading' || state.type === 'refreshing') {
		if (state.repo !== event.repo) return stay(state, event, 'repoMismatch');
		if (state.phase !== 'commits') return stay(state, event, 'unexpectedState');
		if (state.commitsId !== event.requestId) return stay(state, event, 'staleRequestId');

		if (event.error !== null) {
			if (state.type === 'refreshing') {
				return {
					state: { type: 'loaded', repo: state.repo, commitsId: state.commitsId, followUpsPending: [], lastError: event.error },
					effects: [
						{ kind: 'showLoadError', reason: event.error, retry: true },
						{ kind: 'spinRefreshButton', spinning: false }
					],
					dropped: null
				};
			}
			return {
				state: { type: 'error', repo: state.repo, reason: event.error },
				effects: [
					{ kind: 'clearView' },
					{ kind: 'showLoadError', reason: event.error, retry: true },
					{ kind: 'spinRefreshButton', spinning: false }
				],
				dropped: null
			};
		}
		return {
			state: { type: 'loaded', repo: state.repo, commitsId: state.commitsId, followUpsPending: event.followUpsPending, lastError: null },
			effects: [
				{ kind: 'applyCommits', repo: state.repo, requestId: event.requestId, firstPaint: state.firstLoad, followUp: false },
				{ kind: 'spinRefreshButton', spinning: false }
			],
			dropped: null
		};
	}
	if (state.type === 'loaded') {
		if (state.repo !== event.repo) return stay(state, event, 'repoMismatch');
		if (state.commitsId !== event.requestId) return stay(state, event, 'staleRequestId');

		if (event.error !== null) {
			// A follow-up failed: rows stay, the note is recorded (legacy clears here too —
			// :864-872 — the same F2 deviation as a refresh error).
			return {
				state: { type: 'loaded', repo: state.repo, commitsId: state.commitsId, followUpsPending: [], lastError: event.error },
				effects: [{ kind: 'showLoadError', reason: event.error, retry: true }],
				dropped: null
			};
		}
		return {
			state: { type: 'loaded', repo: state.repo, commitsId: state.commitsId, followUpsPending: event.followUpsPending, lastError: null },
			effects: [{ kind: 'applyCommits', repo: state.repo, requestId: event.requestId, firstPaint: false, followUp: true }],
			dropped: null
		};
	}
	return stay(state, event, 'unexpectedState');
}

/**
 * Start or join a cycle (repoLoader.ts:1057-1094). From a quiescent state: a hard request
 * enters `loading` (clearView + skeleton), a soft one `refreshing` (rows kept). Joining a
 * running cycle replaces its ids (invalidating stragglers) but keeps the in-flight repo-info
 * half valid when `skipRepoInfo` joined it in phase 'repoInfo' — the join rule of
 * :1062-1066/:1086-1093. A refresh during the boot push is refused: legacy lets it run and
 * the late push then stomps the cycle by adopting its ids (:741-744); the wiring should
 * disable the refresh affordance while a push is pending.
 */
function reduceRefreshRequested(state: LoadState, event: RefreshRequestedEvent): LoadResult {
	if (state.type === 'idle') return stay(state, event, 'noRepoOpen');
	if (state.type === 'awaitingPush' || state.type === 'snapshotPainted') return stay(state, event, 'pushPending');
	if (state.repo !== event.repo) return stay(state, event, 'repoMismatch');

	if (state.type === 'loaded') {
		if (event.hard) {
			// A hard refresh clears the view; `skipRepoInfo` skips the repo-info half (a selection
			// or filter change re-queries just the commits — legacy controlBar's
			// clearCommits + requestLoadRepoInfoAndCommits(true, true) shape).
			return {
				state: { type: 'loading', repo: state.repo, repoInfoId: event.requestId, commitsId: event.requestId, phase: event.skipRepoInfo ? 'commits' : 'repoInfo', firstLoad: false, followUpsPending: [] },
				effects: [
					{ kind: 'clearView' },
					{ kind: 'showSkeleton' },
					{ kind: 'spinRefreshButton', spinning: true },
					event.skipRepoInfo
						? { kind: 'issueCommitsRequest', repo: state.repo, requestId: event.requestId, hard: true }
						: { kind: 'issueRepoInfoRequest', repo: state.repo, requestId: event.requestId }
				],
				dropped: null
			};
		}
		if (event.skipRepoInfo) {
			return {
				state: { type: 'refreshing', repo: state.repo, repoInfoId: event.requestId, commitsId: event.requestId, phase: 'commits', firstLoad: false, followUpsPending: [] },
				effects: [
					{ kind: 'spinRefreshButton', spinning: true },
					{ kind: 'issueCommitsRequest', repo: state.repo, requestId: event.requestId, hard: false }
				],
				dropped: null
			};
		}
		return {
			state: { type: 'refreshing', repo: state.repo, repoInfoId: event.requestId, commitsId: event.requestId, phase: 'repoInfo', firstLoad: false, followUpsPending: [] },
			effects: [
				{ kind: 'spinRefreshButton', spinning: true },
				{ kind: 'issueRepoInfoRequest', repo: state.repo, requestId: event.requestId }
			],
			dropped: null
		};
	}
	if (state.type === 'error' || state.type === 'repoGone' || state.type === 'empty') {
		// Nothing is painted: every cycle from these states shows the skeleton (the retry
		// dialog's action, a re-checked repository list, a cancelled load restarting).
		return {
			state: {
				type: 'loading',
				repo: state.repo,
				repoInfoId: event.requestId,
				commitsId: event.requestId,
				phase: event.skipRepoInfo ? 'commits' : 'repoInfo',
				firstLoad: false,
				followUpsPending: []
			},
			effects: [
				{ kind: 'showSkeleton' },
				{ kind: 'spinRefreshButton', spinning: true },
				event.skipRepoInfo
					? { kind: 'issueCommitsRequest', repo: state.repo, requestId: event.requestId, hard: true }
					: { kind: 'issueRepoInfoRequest', repo: state.repo, requestId: event.requestId }
			],
			dropped: null
		};
	}

	// Joining a running cycle (loading/refreshing): replace the ids the new requests will
	// carry, keep the in-flight repo-info id when the join waits for it (:1086-1093).
	const joinedRepoInfoId = event.skipRepoInfo ? state.repoInfoId : event.requestId;
	const phase = event.skipRepoInfo
		? (state.phase === 'repoInfo' ? 'repoInfo' : 'commits')
		: 'repoInfo';
	const targetType = event.hard ? 'loading' : state.type;
	const requests: LoadEffect[] = [];
	if (!event.skipRepoInfo) {
		requests.push({ kind: 'issueRepoInfoRequest', repo: state.repo, requestId: event.requestId });
	} else if (state.phase === 'commits') {
		requests.push({ kind: 'issueCommitsRequest', repo: state.repo, requestId: event.requestId, hard: targetType === 'loading' });
	}
	return {
		state: {
			type: targetType,
			repo: state.repo,
			repoInfoId: joinedRepoInfoId,
			commitsId: event.requestId,
			phase: phase,
			firstLoad: state.firstLoad,
			followUpsPending: state.followUpsPending
		},
		effects: [
			...(event.hard
				? [{ kind: 'clearView' } as LoadEffect, { kind: 'showSkeleton' } as LoadEffect]
				: (targetType === 'loading' ? [{ kind: 'showSkeleton' } as LoadEffect] : [])),
			{ kind: 'spinRefreshButton', spinning: true },
			...requests
		],
		dropped: null
	};
}

/**
 * Abandon the in-flight cycle (no legacy analogue — legacy only invalidates by issuing newer
 * requests). Whatever is painted stays; a painted-rows cycle returns to `loaded` under the
 * `CANCELLED_REQUEST_ID` sentinel so stragglers of the abandoned cycle drop, a data-less
 * cycle lands in `empty`, and a snapshot that can never be reconciled (its push is gone) is
 * cleared.
 */
function reduceCancel(state: LoadState, event: CancelEvent): LoadResult {
	if (state.type !== 'awaitingPush' && state.type !== 'snapshotPainted' && state.type !== 'loading' && state.type !== 'refreshing') {
		return stay(state, event, 'nothingPending');
	}
	if (state.repo !== event.repo) return stay(state, event, 'repoMismatch');
	if (state.type === 'awaitingPush') {
		return { state: { type: 'empty', repo: state.repo }, effects: [], dropped: null };
	}
	if (state.type === 'snapshotPainted') {
		return {
			state: { type: 'empty', repo: state.repo },
			effects: [
				{ kind: 'clearView' },
				{ kind: 'spinRefreshButton', spinning: false }
			],
			dropped: null
		};
	}
	if (state.type === 'loading') {
		return {
			state: { type: 'empty', repo: state.repo },
			effects: [{ kind: 'spinRefreshButton', spinning: false }],
			dropped: null
		};
	}
	return {
		state: { type: 'loaded', repo: state.repo, commitsId: CANCELLED_REQUEST_ID, followUpsPending: [], lastError: null },
		effects: [{ kind: 'spinRefreshButton', spinning: false }],
		dropped: null
	};
}
