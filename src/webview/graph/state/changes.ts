/**
 * Typed change sets (OPTIMIZATION-PLAN §6 F1): what a slice action changed, in a shape precise
 * enough for the render scheduler to route by slice - and later, for the keyed row patching of
 * REFACTOR-PLAN task 5.10, to patch by commit hash without re-comparing the whole page.
 *
 * A slice action NEVER notifies renderers directly: it returns/emits one `StoreChange`, the store
 * forwards it to its render-change listeners, and the render scheduler collects one frame's
 * changes and runs only the renderers subscribed to the touched slices. `null` (the shape
 * `invalidateRender()` emits) is the legacy "something changed, anything could be stale" full
 * invalidation - today only the configuration applier and the Gerrit filter path use it.
 */

/** The slices of the store (REFACTOR-PLAN task 5.4): the partitions every field belongs to. */
export type SliceId = 'repos' | 'refs' | 'commits' | 'details' | 'ui' | 'integrations';

/** What changed within the repositories slice. */
export type ReposKey = 'repos' | 'currentRepo' | 'currentRepoLoading' | 'loadViewTo' | 'refreshState';
/** What changed within the refs slice (the current repository's refs and the query filters). */
export type RefsKey = 'branches' | 'head' | 'repoConfig' | 'remotes' | 'stashes' | 'tags' | 'branchSelection' | 'authorSelection' | 'pathFilter';
/** What changed within the commits slice (the loaded page and its bookkeeping). */
export type CommitsKey = 'page' | 'head' | 'lookup' | 'moreAvailable' | 'maxCommits' | 'uncommittedCount' | 'avatars' | 'renderedHead';
/** What changed within the details slice (the open Commit Details / Comparison view). */
export type DetailsKey = 'open' | 'closed' | 'data' | 'scroll' | 'contextMenu' | 'lineCounts';
/** What changed within the ui slice (the view-level selections that feed persistence). */
export type UiKey = 'scrollTop' | 'compareSourceHash';
/** What changed within the integrations slice (Gerrit badges, pull request badges). */
export type IntegrationsKey = 'gerritStates' | 'gerritVisible' | 'pullRequests';

/** The keys a slice's changes are typed with. */
export type SliceKey<S extends SliceId> = [S] extends ['repos'] ? ReposKey
	: [S] extends ['refs'] ? RefsKey
	: [S] extends ['commits'] ? CommitsKey
	: [S] extends ['details'] ? DetailsKey
	: [S] extends ['ui'] ? UiKey
	: IntegrationsKey;

/** One slice's change: which slice, and the keys identifying what changed within it. */
export interface SliceChange<S extends SliceId = SliceId> {
	readonly slice: S;
	readonly keys: ReadonlyArray<SliceKey<S>>;
	/**
	 * The commit hashes the change is scoped to, when it touches specific rows (e.g. the
	 * "Uncommitted Changes" row patch) - the input the keyed row patching (task 5.10) will read
	 * instead of re-comparing the page. A page-level change (`replacePage`) carries none: its
	 * precise row-level diff is the (old, new) page pair the patcher compares by hash.
	 */
	readonly hashes?: ReadonlyArray<string>;
}

/** Every change the store can emit, discriminated by its slice. */
export type StoreChange =
	| SliceChange<'repos'>
	| SliceChange<'refs'>
	| SliceChange<'commits'>
	| SliceChange<'details'>
	| SliceChange<'ui'>
	| SliceChange<'integrations'>;

/** The callback a slice uses to emit its changes (the store forwards them to the render scheduler). */
export type EmitChange<C extends SliceChange> = (change: C) => void;

/**
 * The changes collected for one frame: the union of every change the actions emitted since the
 * last render. The scheduler reads it as "which slices are dirty"; the keys and hashes travel
 * along for the keyed patching that consumes the frame after routing lands (task 5.10).
 */
export class ChangeFrame {
	private readonly keys = new Map<SliceId, Set<string>>();
	private readonly hashes = new Map<SliceId, Set<string>>();

	/** Merge one change into the frame (idempotent per slice + key). */
	public add(change: StoreChange): void {
		let sliceKeys = this.keys.get(change.slice);
		if (sliceKeys === undefined) {
			sliceKeys = new Set<string>();
			this.keys.set(change.slice, sliceKeys);
		}
		for (let i = 0; i < change.keys.length; i++) sliceKeys.add(change.keys[i]);
		if (change.hashes !== undefined) {
			let sliceHashes = this.hashes.get(change.slice);
			if (sliceHashes === undefined) {
				sliceHashes = new Set<string>();
				this.hashes.set(change.slice, sliceHashes);
			}
			for (let i = 0; i < change.hashes.length; i++) sliceHashes.add(change.hashes[i]);
		}
	}

	/** Did anything in this frame touch the slice? */
	public touches(slice: SliceId): boolean {
		return this.keys.has(slice);
	}

	/** The merged keys recorded for a slice (undefined when the slice is clean). */
	public keysOf(slice: SliceId): ReadonlyArray<string> | undefined {
		const sliceKeys = this.keys.get(slice);
		return sliceKeys !== undefined ? Array.from(sliceKeys) : undefined;
	}

	/** The merged row hashes recorded for a slice (undefined when none were recorded). */
	public hashesOf(slice: SliceId): ReadonlyArray<string> | undefined {
		const sliceHashes = this.hashes.get(slice);
		return sliceHashes !== undefined ? Array.from(sliceHashes) : undefined;
	}

	/** How many distinct slices the frame covers (0 = nothing changed). */
	public get sliceCount(): number {
		return this.keys.size;
	}

	public clear(): void {
		this.keys.clear();
		this.hashes.clear();
	}
}
