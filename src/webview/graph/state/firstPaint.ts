/**
 * The first-paint snapshot (REFACTOR-PLAN §3.8.2 D10, task 5.9): what a reopening Git Graph view
 * paints IMMEDIATELY, before the extension host's pushed `loadView` data arrives. After each
 * stable render the view stores the loaded commits (the graph layout's inputs and the rows'
 * content in one) plus the bookkeeping the render needs, in a compact record capped at 200 KB,
 * under a NEW versioned field of the persisted webview state (`firstPaint`, added by the same
 * schema-version mechanism that versions the state itself - see persistence.ts).
 *
 * On reopen the snapshot paints only when it cannot be stale in a way the caller could not fix:
 * the repository must match the one being opened and the configuration's fingerprint must match
 * (both checked before painting). HEAD cannot be known before the fresh data lands, so it
 * travels WITH the snapshot: the fresh data's arrival reconciles through the seamless-update
 * path (CommitTable.syncCommitRows keys rows by hash and the viewport anchors on the visible
 * commit), which replaces the rows without a coordinate jump when HEAD moved and leaves them
 * untouched when it did not.
 *
 * Everything here is deliberately pure and DOM-free: the encode/decode/cap logic is what the
 * tests pin down (round-trip, corruption, foreign versions, the cap), while the paint itself
 * lives in loading/repoLoader.ts (it reuses the ordinary loadCommits path, so a painted snapshot
 * renders - and later reconciles - through exactly the code a real response uses).
 */

import type * as GG from '../../common/protocol';

/** The schema version of the first-paint snapshot (a foreign version is ignored, never migrated). */
export const FIRST_PAINT_SNAPSHOT_VERSION = 1;

/**
 * The snapshot's size cap: the JSON-encoded record may not exceed 200 KB (§3.8.2's bound for
 * what the webview state carries for the first paint). Measured in UTF-16 code units of the JSON
 * text - every field the writer emits is ASCII or near it, so the units track the bytes.
 */
export const FIRST_PAINT_SNAPSHOT_MAX_LENGTH = 200 * 1024;

/** How many rows beyond the visible window the retained slice keeps, so a small scroll after the reopen stays inside the snapshot. */
const VISIBLE_WINDOW_MARGIN_ROWS = 10;

/** The first-paint snapshot persisted as the `firstPaint` field of the webview state. */
export interface FirstPaintSnapshot {
	readonly version: number;
	/** The repository the commits belong to (a snapshot of another repository is never painted). */
	readonly repo: string;
	/** The HEAD the snapshot was rendered under (fresh data under another HEAD reconciles the rows away). */
	readonly head: string | null;
	/** The fingerprint of the configuration the snapshot was rendered under (see {@link configFingerprint}). */
	readonly configFingerprint: number;
	/** The loaded commits, newest first, oldest trimmed away first when the cap demands it. */
	readonly commits: ReadonlyArray<GG.GitCommit>;
	readonly moreCommitsAvailable: boolean;
	readonly maxCommits: number;
	readonly onlyFollowFirstParent: boolean;
	/** The "Uncommitted Changes" row's file count last known (keeps the row's number stable across the reopen). */
	readonly uncommittedCount: number | null;
	/** Where the view was scrolled to when the snapshot was taken. */
	readonly scrollTop: number;
}

/** Everything the capture reads from the view (pure data, so tests drive it without a DOM). */
export interface FirstPaintCaptureInput {
	readonly repo: string;
	readonly head: string | null;
	readonly config: GG.GitGraphViewConfig;
	readonly commits: ReadonlyArray<GG.GitCommit>;
	readonly moreCommitsAvailable: boolean;
	readonly maxCommits: number;
	readonly onlyFollowFirstParent: boolean;
	readonly uncommittedCount: number | null;
	readonly scrollTop: number;
	/** The rendered row height in pixels (locates the visible window). */
	readonly rowHeight: number;
	/** The scroll viewport's height in pixels (0 => unknown, no visible-window check). */
	readonly viewHeight: number;
}

/**
 * A stable fingerprint of the webview configuration (FNV-1a over the JSON text): both the writer
 * and the reopening reader run THIS function over the config object they hold, so any setting
 * that changes the rendered rows changes the fingerprint and the snapshot is skipped. A hash
 * collision would cost one wrong first paint that the arriving data immediately corrects.
 */
export function configFingerprint(config: GG.GitGraphViewConfig): number {
	const text = JSON.stringify(config);
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		// FNV-1a's multiply, kept in 32 bits the way ES2018's `*` on numbers needs it
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/** The index range of rows the user was looking at (inclusive bounds; NULL when not measurable). */
function visibleWindowRange(input: FirstPaintCaptureInput): { start: number, end: number } | null {
	if (input.rowHeight <= 0 || input.viewHeight <= 0) return null;
	const start = Math.floor(input.scrollTop / input.rowHeight);
	const end = Math.ceil((input.scrollTop + input.viewHeight) / input.rowHeight);
	return { start: Math.max(0, start - VISIBLE_WINDOW_MARGIN_ROWS), end: end + VISIBLE_WINDOW_MARGIN_ROWS };
}

/**
 * Capture a first-paint snapshot, honouring the 200 KB cap.
 *
 * Trimming drops the OLDEST commits first (the tail of the array): the reopened view's fresh
 * data starts from HEAD, so the head-side rows are exactly the ones the reconciliation overlaps.
 * When the cap cannot retain the rows the user was looking at, the snapshot is skipped entirely
 * (NULL) - a head-only snapshot of a deep-scroll would paint rows the user is not looking at and
 * drop theirs, which is worse than the ordinary loading skeleton.
 */
export function captureFirstPaintSnapshot(input: FirstPaintCaptureInput): FirstPaintSnapshot | null {
	if (input.commits.length === 0) return null;
	const fingerprint = configFingerprint(input.config);
	const window = visibleWindowRange(input);

	let retained = input.commits;
	for (;;) {
		const snapshot = snapshotOf(input, fingerprint, retained);
		if (JSON.stringify(snapshot).length <= FIRST_PAINT_SNAPSHOT_MAX_LENGTH) {
			if (window === null) return snapshot;
			// The visible window must survive the trim: indices are newest-first from HEAD, the
			// window's end bound may exceed the loaded list (scrolled near its top is impossible,
			// near its bottom it just means "everything to the end")
			return window.start < retained.length ? snapshot : null;
		}
		if (retained.length <= 1) return null; // not even one commit fits the cap
		retained = retained.slice(0, retained.length - 1);
	}
}

function snapshotOf(input: FirstPaintCaptureInput, fingerprint: number, commits: ReadonlyArray<GG.GitCommit>): FirstPaintSnapshot {
	return {
		version: FIRST_PAINT_SNAPSHOT_VERSION,
		repo: input.repo,
		head: input.head,
		configFingerprint: fingerprint,
		commits: commits,
		moreCommitsAvailable: input.moreCommitsAvailable,
		maxCommits: input.maxCommits,
		onlyFollowFirstParent: input.onlyFollowFirstParent,
		uncommittedCount: input.uncommittedCount,
		scrollTop: input.scrollTop
	};
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** One persisted commit entry passes its shape check (the fields the render and the graph layout read). */
function isValidCommitEntry(value: unknown): value is GG.GitCommit {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const commit = value as Record<string, unknown>;
	return typeof commit.hash === 'string'
		&& isStringArray(commit.parents)
		&& typeof commit.author === 'string'
		&& typeof commit.email === 'string'
		&& typeof commit.date === 'number'
		&& typeof commit.message === 'string'
		&& isStringArray(commit.heads)
		&& (Array.isArray(commit.tags) && commit.tags.every((tag) => tag !== null && typeof tag === 'object' && typeof (<GG.GitCommitTag>tag).name === 'string' && typeof (<GG.GitCommitTag>tag).annotated === 'boolean'))
		&& (Array.isArray(commit.remotes) && commit.remotes.every((remote) => remote !== null && typeof remote === 'object' && typeof (<GG.GitCommitRemote>remote).name === 'string' && typeof (<GG.GitCommitRemote>remote).remote === 'string'))
		&& (commit.stash === null || (commit.stash !== null && typeof commit.stash === 'object' && typeof (<GG.GitCommitStash>commit.stash).selector === 'string'));
}

/**
 * Leniently decode a persisted first-paint snapshot: anything corrupt - a foreign schema
 * version, a wrong-typed field, a malformed commit entry - answers NULL, and the caller falls
 * back to the ordinary loading path. A snapshot written by a NEWER version is ignored the same
 * way (its layout is unknown), never partially trusted.
 */
export function decodeFirstPaintSnapshot(raw: unknown): FirstPaintSnapshot | null {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	if (record.version !== FIRST_PAINT_SNAPSHOT_VERSION) return null;
	if (typeof record.repo !== 'string') return null;
	if (record.head !== null && typeof record.head !== 'string') return null;
	if (typeof record.configFingerprint !== 'number') return null;
	if (!Array.isArray(record.commits) || record.commits.length === 0 || !record.commits.every(isValidCommitEntry)) return null;
	if (typeof record.moreCommitsAvailable !== 'boolean') return null;
	if (typeof record.maxCommits !== 'number') return null;
	if (typeof record.onlyFollowFirstParent !== 'boolean') return null;
	if (record.uncommittedCount !== null && typeof record.uncommittedCount !== 'number') return null;
	if (typeof record.scrollTop !== 'number' || record.scrollTop < 0 || !Number.isFinite(record.scrollTop)) return null;
	return {
		version: FIRST_PAINT_SNAPSHOT_VERSION,
		repo: record.repo,
		head: record.head as string | null,
		configFingerprint: record.configFingerprint,
		commits: record.commits as ReadonlyArray<GG.GitCommit>,
		moreCommitsAvailable: record.moreCommitsAvailable,
		maxCommits: record.maxCommits,
		onlyFollowFirstParent: record.onlyFollowFirstParent,
		uncommittedCount: record.uncommittedCount as number | null,
		scrollTop: record.scrollTop
	};
}
