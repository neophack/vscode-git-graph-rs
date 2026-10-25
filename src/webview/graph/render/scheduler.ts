/**
 * The render scheduler (REFACTOR-PLAN task 5.10): every request to re-render the view funnels
 * through here, and multiple requests within one frame merge into a SINGLE render pass on the next
 * animation frame. A response - or any burst of store changes - therefore never triggers more than
 * one render, and the frame's layout work happens once, right before the paint.
 *
 * Two entry styles:
 *  - `request()` coalesces: it marks the view dirty and schedules one frame callback; further
 *    requests before the frame arrives are absorbed by the same callback.
 *  - `renderSync()` runs the pass immediately, once, and cancels a pending frame - for the paths
 *    that measure the DOM the render just wrote (viewport anchors, the find widget's row scan).
 *    Because it clears the pending flag, a sync render satisfies the requests that preceded it:
 *    a response that renders synchronously does not render a second time on the next frame.
 *
 * Frame scheduling uses `requestAnimationFrame` when it exists and falls back to a `setTimeout(0)`
 * style task otherwise (test environments without a compositor). The fallback preserves the
 * coalescing contract: one timer, one render, however many requests.
 */

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

	/**
	 * @param renderPass The one render pass of the view (CommitTable.render: the pinned row, the
	 * table, the graph and the column auto-layout, in that order).
	 */
	constructor(private readonly renderPass: () => void) { }

	/** Request a render, coalesced into the next animation frame (a no-op when one is pending). */
	public request(): void {
		this.pending = true;
		if (this.frameId === null) {
			this.frameId = scheduleFrame(() => {
				this.frameId = null;
				if (this.pending) {
					this.pending = false;
					this.renderPass();
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
	 * returns, so a request that arrived earlier is satisfied rather than duplicated.
	 */
	public renderSync(): void {
		this.cancel();
		this.pending = false;
		this.renderPass();
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
}
