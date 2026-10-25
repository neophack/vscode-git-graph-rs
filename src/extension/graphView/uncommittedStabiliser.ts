import type { UncommittedReading, UncommittedStabiliser } from './commitLoader';

/**
 * Decides when a reading of the "Uncommitted Changes" count may be delivered to the webview
 * (REFACTOR-PLAN task 4.3), ported verbatim from GitGraphView's `UncommittedCountStabiliser`
 * (src/gitGraphView.ts; the live class stays there until the Panel cutover deletes it). The row
 * it gates must never disappear and reappear on a momentary reading (a `git status` that failed
 * or raced a concurrent index write reports 0, not the real count - delivering that 0 removes
 * the rendered row, and the next refresh brings it straight back):
 *  - a positive count is delivered immediately, whatever the row currently shows: the row appears
 *    at once when the user starts editing, and a count-only change just updates its number;
 *  - a zero that would REMOVE the row is delivered only once it has been confirmed by re-reads
 *    spanning the confirm window (5 seconds), so a momentarily wrong zero can never land;
 *  - a failed reading (NULL) delivers nothing: the failure neither confirms nor denies anything,
 *    and the next refresh reads the status again.
 *
 * The clock is injectable: `observe` receives the reading's time instead of reading the system
 * clock itself, which is what lets the tests (and the CommitLoader pipeline) drive it
 * deterministically. The class satisfies the loader's structural `UncommittedStabiliser` port.
 */
export class UncommittedCountStabiliser implements UncommittedStabiliser {
	/** The count the view last rendered (NULL => unknown: nothing was delivered since the last reset). */
	private renderedCount: number | null = null;
	/** When the current streak of zero readings started (NULL => the latest reading wasn't a zero). */
	private zeroSince: number | null = null;

	constructor(private readonly confirmWindowMs: number, private readonly recheckIntervalMs: number) {}

	/**
	 * Observe one reading of the count.
	 * @param count The reading (number of uncommitted changes), or NULL when it could not be read.
	 * @param now The time of the reading (epoch milliseconds).
	 * @returns Whether to deliver a count now, or re-read after a delay.
	 */
	public observe(count: number | null, now: number): UncommittedReading {
		if (count === null) return { recheckAfterMs: this.recheckIntervalMs };
		if (count > 0) {
			this.zeroSince = null;
			return { send: count };
		}
		if (this.renderedCount === null || this.renderedCount === 0) {
			// No row is rendered: delivering 0 changes nothing on screen, so there is nothing to stabilise
			return { send: 0 };
		}
		if (this.zeroSince === null) this.zeroSince = now;
		if (now - this.zeroSince < this.confirmWindowMs) return { recheckAfterMs: this.recheckIntervalMs };
		this.zeroSince = null;
		return { send: 0 };
	}

	/**
	 * Record the count a delivered response rendered in the view (call only after actually sending).
	 * @param count The delivered count.
	 */
	public delivered(count: number): void {
		this.renderedCount = count;
		if (count > 0) this.zeroSince = null;
	}

	/** Forget what the view renders (the view switched repository or was reset). */
	public reset(): void {
		this.renderedCount = null;
		this.zeroSince = null;
	}
}
