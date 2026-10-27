/**
 * The render scheduler (REFACTOR-PLAN task 5.10, OPTIMIZATION-PLAN §6 F1): every request to
 * re-render the view funnels through here, and multiple requests within one frame merge into a
 * SINGLE render pass on the next animation frame. A response - or any burst of store changes -
 * therefore never triggers more than one render, and the frame's layout work happens once, right
 * before the paint.
 *
 * Routing by slice (F1): the store's slice actions emit typed changes (`{ slice, keys }`),
 * `request(change)` collects them into ONE ChangeFrame per pass and marks every renderer
 * SUBSCRIBED to a changed slice dirty; the pass runs only the dirty renderers, in subscription
 * order, handing each the collected frame - the input the keyed row patching (task 5.10) reads.
 * `request()` without a change (a geometry-driven render: a resize, a scroll re-windowing) and
 * `invalidateRender()` (the legacy full invalidation) mark EVERY renderer dirty - the whole pass
 * runs, exactly as it did before the routing existed.
 *
 * Two entry styles:
 *  - `request()` coalesces: it marks the view dirty and schedules one frame callback; further
 *    requests before the frame arrives are absorbed by the same callback.
 *  - `renderSync()` runs the pass immediately, once, and cancels a pending frame - for the paths
 *    that measure the DOM the render just wrote (viewport anchors, the find widget's row scan).
 *    Because it clears the pending flag, a sync render satisfies the requests that preceded it:
 *    a response that renders synchronously does not render a second time on the next frame.
 *    A sync render with nothing pending is the forced pass: the DOM is stale for a reason no
 *    store change describes (the viewport moved), so every renderer runs.
 *
 * Frame scheduling uses `requestAnimationFrame` when it exists and falls back to a `setTimeout(0)`
 * style task otherwise (test environments without a compositor). The fallback preserves the
 * coalescing contract: one timer, one render, however many requests.
 */

import { ChangeFrame, SliceId, StoreChange } from '../state/changes';

/** A part of the render pass, subscribed to the slices whose changes it re-renders for. */
export interface SliceRenderer {
	/** The store slices whose changes this renderer re-renders for. */
	readonly slices: ReadonlyArray<SliceId>;
	/** Run the renderer's part of the pass, with the changes collected for it. */
	render(changes: ChangeFrame): void;
}

/** Schedule `callback` for the next animation frame (or the nearest task when rAF is unavailable). */
export function scheduleFrame(callback: () => void): number {
	if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
	return window.setTimeout(callback, 0);
}

/** Cancel a callback scheduled by `scheduleFrame`. */
export function cancelScheduledFrame(id: number): void {
	if (typeof requestAnimationFrame === 'function') cancelAnimationFrame(id);
	else window.clearTimeout(id);
}

export class RenderScheduler {
	/** TRUE from the first `request()` until the pass runs (the DOM lags the store). */
	private pending: boolean = false;
	private frameId: number | null = null;
	/** The pass's renderers, in subscription order (the pass preserves their order). */
	private readonly renderers: SliceRenderer[] = [];
	/** Per renderer: does the rendered output lag the store slices it subscribed to? */
	private readonly dirty: boolean[] = [];
	/** The changes collected since the last pass (the renderers' and the keyed patcher's input). */
	private readonly collected: ChangeFrame = new ChangeFrame();

	/**
	 * Subscribe a renderer to the slices whose changes it re-renders for. Subscription order IS
	 * render order (the pass's steps depend on each other: the pinned row, the table, the graph,
	 * the graph column's auto layout). A renderer starts CLEAN: the boot's first paints flow
	 * through full invalidations or response changes, which dirty what they need.
	 */
	public subscribe(renderer: SliceRenderer): void {
		this.renderers.push(renderer);
		this.dirty.push(false);
	}

	/**
	 * Request a render, coalesced into the next animation frame. With a change, only the
	 * renderers subscribed to the changed slice are marked dirty (a change no renderer subscribed
	 * to schedules nothing); without one, the whole pass is (the geometry or the configuration
	 * changed - anything could be stale).
	 */
	public request(change?: StoreChange | null): void {
		if (change === undefined || change === null) {
			this.markAllDirty();
		} else {
			this.markSliceDirty(change.slice);
			if (!this.hasDirty()) return; // nothing subscribed to this slice: nothing to render, no keys recorded
			this.collected.add(change);
		}
		this.pending = true;
		if (this.frameId === null) {
			this.frameId = scheduleFrame(() => {
				this.frameId = null;
				if (this.pending) {
					this.pending = false;
					this.runPass();
				}
			});
		}
	}

	/** Is a coalesced render still waiting for its frame. */
	public isPending(): boolean {
		return this.pending;
	}

	/**
	 * Run the render pass NOW, once. Cancels a pending frame - the DOM is current the moment this
	 * returns, so a request that arrived earlier is satisfied rather than duplicated. With
	 * nothing pending (nothing dirty) this is the FORCED pass: every renderer runs, because the
	 * staleness has no slice (the viewport moved, the layout changed).
	 */
	public renderSync(): void {
		this.cancel();
		this.pending = false;
		if (!this.hasDirty()) this.markAllDirty();
		this.runPass();
	}

	/** Run the pending pass now, if any (a no-op when the DOM is current). */
	public flush(): void {
		if (this.pending) this.renderSync();
	}

	/** Drop a pending request without rendering (the caller takes over the pass, e.g. a full reload). */
	public cancel(): void {
		if (this.frameId !== null) {
			cancelScheduledFrame(this.frameId);
			this.frameId = null;
		}
	}

	/** Run the dirty renderers, in subscription order, and clean them. */
	private runPass(): void {
		for (let i = 0; i < this.renderers.length; i++) {
			if (!this.dirty[i]) continue;
			this.dirty[i] = false;
			this.renderers[i].render(this.collected);
		}
		this.collected.clear();
	}

	private markAllDirty(): void {
		for (let i = 0; i < this.dirty.length; i++) this.dirty[i] = true;
	}

	private markSliceDirty(slice: SliceId): void {
		for (let i = 0; i < this.renderers.length; i++) {
			if (this.renderers[i].slices.indexOf(slice) >= 0) this.dirty[i] = true;
		}
	}

	private hasDirty(): boolean {
		for (let i = 0; i < this.dirty.length; i++) {
			if (this.dirty[i]) return true;
		}
		return false;
	}
}
