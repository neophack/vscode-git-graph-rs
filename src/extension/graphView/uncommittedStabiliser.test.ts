import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UncommittedCountStabiliser } from './uncommittedStabiliser';

/**
 * `UncommittedCountStabiliser` gates the "Uncommitted Changes" count delivered to the webview
 * (see the CommitLoader's uncommitted follow-up). These tests pin the delivery rules that
 * follow-up depends on: immediate positive counts, zero only after the confirm window's
 * re-reads, and NULL readings delivering nothing.
 */

const CONFIRM_WINDOW_MS = 5000;
const RECHECK_MS = 1000;

function makeStabiliser() {
	return new UncommittedCountStabiliser(CONFIRM_WINDOW_MS, RECHECK_MS);
}

describe('UncommittedCountStabiliser', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it('delivers a positive count immediately, before anything was ever rendered (the row appears at once)', () => {
		const s = makeStabiliser();
		expect(s.observe(3, 1000)).toEqual({ send: 3 });
	});

	it('delivers a positive count immediately when it would only update the rendered number', () => {
		const s = makeStabiliser();
		s.observe(3, 1000);
		s.delivered(3);
		expect(s.observe(4, 2000)).toEqual({ send: 4 });
	});

	it('delivers a zero immediately when no row is rendered (nothing is on screen to stabilise)', () => {
		const s = makeStabiliser();
		expect(s.observe(0, 1000)).toEqual({ send: 0 });
	});

	it('holds a zero that would remove the rendered row until re-reads confirm it across the window', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);

		// The first zero starts the clock; re-reads within the window keep holding
		for (let elapsed = 0; elapsed < CONFIRM_WINDOW_MS; elapsed += RECHECK_MS) {
			expect(s.observe(0, 1000 + elapsed), 'held at +' + elapsed + 'ms').toEqual({ recheckAfterMs: RECHECK_MS });
		}
		// The first reading at or after the window delivers the removal: the row disappears 5s
		// after the zero was first read
		expect(s.observe(0, 1000 + CONFIRM_WINDOW_MS)).toEqual({ send: 0 });
	});

	it('delivers the count instead of the removal when a re-read inside the window sees changes again', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);

		expect(s.observe(0, 2000)).toEqual({ recheckAfterMs: RECHECK_MS });
		expect(s.observe(0, 3000)).toEqual({ recheckAfterMs: RECHECK_MS });
		// The user edited a file again while the zero was being confirmed
		expect(s.observe(2, 4000)).toEqual({ send: 2 });
		// A later zero starts a fresh window (the removal was never delivered)
		expect(s.observe(0, 4500)).toEqual({ recheckAfterMs: RECHECK_MS });
	});

	it('never delivers a failed reading: a failure neither confirms a zero nor updates the count', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);

		// Zeros are read and held across the whole window...
		for (let elapsed = 0; elapsed < CONFIRM_WINDOW_MS; elapsed += RECHECK_MS) {
			s.observe(0, 2000 + elapsed);
		}
		// ...then the status read starts failing exactly when the window would elapse: the failure
		// must deliver nothing
		expect(s.observe(null, 2000 + CONFIRM_WINDOW_MS)).toEqual({ recheckAfterMs: RECHECK_MS });
		// The zeros read before the failure already confirmed the removal: the next successful
		// zero (still at or after the window) delivers it
		expect(s.observe(0, 2000 + CONFIRM_WINDOW_MS + RECHECK_MS)).toEqual({ send: 0 });
	});

	it('a failed reading before any zero does not start the confirmation window', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);

		expect(s.observe(null, 2000)).toEqual({ recheckAfterMs: RECHECK_MS });
		expect(s.observe(null, 2000 + CONFIRM_WINDOW_MS)).toEqual({ recheckAfterMs: RECHECK_MS });
		// The first ACTUAL zero only arrives now: the window starts here, so the removal is held
		expect(s.observe(0, 2000 + CONFIRM_WINDOW_MS + RECHECK_MS)).toEqual({ recheckAfterMs: RECHECK_MS });
	});

	it('a zero delivered right after a reset (repository switch) does not wait for a window', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);
		s.reset();
		expect(s.observe(0, 2000)).toEqual({ send: 0 });
	});

	it('a removal followed by more zeros keeps delivering them directly (no second window)', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);
		for (let elapsed = 0; elapsed < CONFIRM_WINDOW_MS; elapsed += RECHECK_MS) {
			s.observe(0, 1000 + elapsed);
		}
		expect(s.observe(0, 1000 + CONFIRM_WINDOW_MS)).toEqual({ send: 0 });
		s.delivered(0);
		expect(s.observe(0, 1000 + CONFIRM_WINDOW_MS + RECHECK_MS)).toEqual({ send: 0 });
	});

	it('follows the caller\'s clock: the window elapses by the supplied time, not the wall clock', () => {
		const s = makeStabiliser();
		s.observe(5, Date.now()); // the caller passes its own notion of now (here: the fake clock's)
		s.delivered(5);

		const firstZeroAt = Date.now();
		expect(s.observe(0, Date.now())).toEqual({ recheckAfterMs: RECHECK_MS }); // the zero starts the window
		// No wall-clock time passes (fake timers): only the CALLER's supplied time advances past
		// the confirm window, and that is what delivers the removal
		vi.setSystemTime(firstZeroAt + CONFIRM_WINDOW_MS);
		expect(s.observe(0, Date.now())).toEqual({ send: 0 });
	});
});
