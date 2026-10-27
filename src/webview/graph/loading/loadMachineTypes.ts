/**
 * The type layer of the repo-load state machine: the state, event,
 * effect and drop shapes the reducer in `loadMachine.ts` transitions over. Split out so the
 * reducer file stays under the 600-line production gate; `loadMachine.ts` re-exports everything
 * for consumers.
 */
/** What a load cycle is still waiting for. */
export type LoadPhase = 'repoInfo' | 'commits';

/** The staged follow-ups a response can announce. */
export type FollowUpKind = 'remoteRefs' | 'uncommitted' | 'gerrit';

/**
 * The fields a running cycle (loading or refreshing) carries. `repoInfoId` and `commitsId`
 * hold the request ids the caller stamped the cycle's requests with; responses must match
 * them to apply. `firstLoad` mirrors the view's `currentRepoLoading` reset: TRUE when the
 * cycle is this repository's first paint (scroll-to-head / scroll-restore apply), i.e. it
 * was opened by `openRepo` or feeds off the boot push.
 */
export interface LoadCycle {
	readonly repoInfoId: number;
	readonly commitsId: number;
	readonly phase: LoadPhase;
	readonly firstLoad: boolean;
	readonly followUpsPending: readonly FollowUpKind[];
}

export interface IdleState {
	readonly type: 'idle';
}

/** Boot: repository adopted, no request issued, the host's pushed `loadView` is expected. */
export interface AwaitingPushState {
	readonly type: 'awaitingPush';
	readonly repo: string;
}

/** Boot with a first-paint snapshot on screen, still waiting for the pushed `loadView`. */
export interface SnapshotPaintedState {
	readonly type: 'snapshotPainted';
	readonly repo: string;
}

/** A cycle whose view holds no final rows of the current repository (first load / hard refresh). */
export interface LoadingState extends LoadCycle {
	readonly type: 'loading';
	readonly repo: string;
}

/** A cycle running over rows that stay on screen until the fresh page lands (soft refresh). */
export interface RefreshingState extends LoadCycle {
	readonly type: 'refreshing';
	readonly repo: string;
}

/** Quiescent with data: the cycle's page is applied; staged follow-ups may still land. */
export interface LoadedState {
	readonly type: 'loaded';
	readonly repo: string;
	readonly commitsId: number;
	readonly followUpsPending: readonly FollowUpKind[];
	/** The note of a refresh that failed while rows stayed on screen (cleared by a later success). */
	readonly lastError: string | null;
}

/** A load failed with nothing on screen; the retry dialog's action is `refreshRequested`. */
export interface ErrorState {
	readonly type: 'error';
	readonly repo: string;
	readonly reason: string;
}

/** The repository vanished (`isRepo: false`); the host re-checks the repository list. */
export interface RepoGoneState {
	readonly type: 'repoGone';
	readonly repo: string;
}

/** Nothing loaded, nothing pending — only reachable through `cancel` of a data-less cycle. */
export interface EmptyState {
	readonly type: 'empty';
	readonly repo: string;
}

export type LoadState = IdleState | AwaitingPushState | SnapshotPaintedState | LoadingState | RefreshingState | LoadedState | ErrorState | RepoGoneState | EmptyState;

/** `loadRepo`: adopt a repository and start a hard first-load cycle. */
export interface OpenRepoEvent {
	readonly type: 'openRepo';
	readonly repo: string;
	readonly requestId: number;
}

/** `start` adopting the boot repository: expect the pushed `loadView`. */
export interface AwaitPushEvent {
	readonly type: 'awaitPush';
	readonly repo: string;
}

/** `paintFirstPaintSnapshot` has a decodable snapshot for the awaited repository. */
export interface SnapshotArrivedEvent {
	readonly type: 'snapshotArrived';
	readonly repo: string;
}

/**
 * The host's pushed merged view. `followUpsPending` is derived by the caller from
 * the push's own pending flags (the staged follow-ups carry the same id).
 */
export interface LoadViewPushedEvent {
	readonly type: 'loadViewPushed';
	readonly repo: string;
	readonly requestId: number;
	readonly error: string | null;
	readonly followUpsPending: readonly FollowUpKind[];
}

/** A `loadRepoInfo` response; accepted in phase 'repoInfo' of a matching cycle. */
export interface RepoInfoResponseEvent {
	readonly type: 'repoInfoResponse';
	readonly repo: string;
	readonly requestId: number;
	readonly isRepo: boolean;
	readonly remoteRefsPending: boolean;
	readonly error: string | null;
}

/**
 * A `loadCommits` response; accepted in phase 'commits' of a matching cycle AND in `loaded`
 * (the staged follow-ups). `followUpsPending` REPLACES the tracked list; the caller
 * keeps listing 'remoteRefs' until a response carried the complete branch list.
 */
export interface CommitsResponseEvent {
	readonly type: 'commitsResponse';
	readonly repo: string;
	readonly requestId: number;
	readonly error: string | null;
	readonly followUpsPending: readonly FollowUpKind[];
}

/**
 * `refresh` / `requestLoadRepoInfoAndCommits`: start or join a cycle.
 * `hard` clears the view (loading state), `skipRepoInfo` starts at the commits half (a
 * load-more, a Gerrit filter change) or, joining a cycle still in phase 'repoInfo', waits for
 * the in-flight repo-info response instead of issuing a new request.
 */
export interface RefreshRequestedEvent {
	readonly type: 'refreshRequested';
	readonly repo: string;
	readonly requestId: number;
	readonly hard: boolean;
	readonly skipRepoInfo: boolean;
}

/** Abandon the in-flight cycle; keep what is painted and invalidate its ids. */
export interface CancelEvent {
	readonly type: 'cancel';
	readonly repo: string;
}

export type LoadEvent = OpenRepoEvent | AwaitPushEvent | SnapshotArrivedEvent | LoadViewPushedEvent | RepoInfoResponseEvent | CommitsResponseEvent | RefreshRequestedEvent | CancelEvent;

/**
 * What the caller should do for a transition. Effects are IO decisions the machine does not
 * make itself; their order is the order the caller should apply them in.
 */
export type LoadEffect =
	| { readonly kind: 'issueRepoInfoRequest'; readonly repo: string; readonly requestId: number }
	| { readonly kind: 'issueCommitsRequest'; readonly repo: string; readonly requestId: number; readonly hard: boolean }
	/** Apply the branches/head/remotes/stashes of the response (the `loadRepoInfo` processing). */
	| { readonly kind: 'applyRepoInfo'; readonly repo: string; readonly requestId: number }
	/**
	 * Apply a commit page (the `loadCommits` processing + finalisation). `firstPaint` carries
	 * whether this is the repository's first paint (scroll-to-head / scroll-restore apply);
	 * `followUp` marks a staged follow-up landing in `loaded`.
	 */
	| { readonly kind: 'applyCommits'; readonly repo: string; readonly requestId: number; readonly firstPaint: boolean; readonly followUp: boolean }
	/** Paint the previous session's snapshot rows. */
	| { readonly kind: 'paintSnapshot'; readonly repo: string }
	/** Empty the view of the current repository's commits (`clearCommits`). */
	| { readonly kind: 'clearView' }
	/** Show the loading skeleton (`showLoadingSkeleton`). */
	| { readonly kind: 'showSkeleton' }
	/** Re-render the refresh button in the given spin state (`renderRefreshButton`). */
	| { readonly kind: 'spinRefreshButton'; readonly spinning: boolean }
	/** Show a load error dialog; `retry` offers the retry action (loadErrors' `show`). */
	| { readonly kind: 'showLoadError'; readonly reason: string; readonly retry: boolean }
	/** Re-check the repository list (`{ command: 'loadRepos', check: true }`). */
	| { readonly kind: 'checkRepos' };

/** Why an event was dropped. Drops are data, never exceptions. */
export type DropReason =
	/** The state does not expect this kind of event (including the wrong cycle phase). */
	| 'unexpectedState'
	/** The event names a repository other than the one the state is about. */
	| 'repoMismatch'
	/** The event's requestId does not match the state's recorded request id. */
	| 'staleRequestId'
	/** A refresh while the boot push is still expected (kept out: see the tightening notes). */
	| 'pushPending'
	/** A cancel with nothing in flight. */
	| 'nothingPending'
	/** A refresh with no repository open. */
	| 'noRepoOpen';

export interface DropRecord {
	readonly event: LoadEvent['type'];
	readonly reason: DropReason;
	/** A stable, human-readable trace of the drop: `stateLabel(from) <- eventType`. */
	readonly detail: string;
}

export interface LoadResult {
	readonly state: LoadState;
	readonly effects: readonly LoadEffect[];
	readonly dropped: DropRecord | null;
}

/**
 * The `commitsId` a cancelled cycle leaves behind: no request ever carries it, so any late
 * response of the abandoned cycle drops as stale.
 */
export const CANCELLED_REQUEST_ID = -1;
