// @vitest-environment jsdom
/**
 * The render scheduler (REFACTOR-PLAN task 5.10): every render request funnels through one
 * scheduler, and however many requests arrive before the next frame, exactly ONE render pass
 * runs. The synchronous entry (`renderSync`) is what makes a response render exactly once: it
 * runs the pass immediately AND satisfies the requests that arrived before it, so nothing renders
 * a second time when the frame arrives. Both frame mechanisms are covered: the animation frame
 * (stubbed into a manual queue) and the setTimeout fallback the scheduler falls back to when rAF
 * is unavailable (test environments, and per the plan's compatibility notes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RenderScheduler } from './scheduler';

/** A rAF stub the tests drive by hand: queued callbacks run only when the test fires the frame. */
function manualAnimationFrame() {
	const queue = new Map<number, FrameRequestCallback>();
	let next = 1;
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		const id = next++;
		queue.set(id, callback);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue.delete(id); });
	return {
		fire() {
			// Copy: a callback may schedule or cancel while it runs
			for (const callback of Array.from(queue.values())) callback(0);
			queue.clear();
		},
		pending() { return queue.size; }
	};
}

describe('RenderScheduler (task 5.10)', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

	it('coalesces any number of requests within a frame into ONE render pass (rAF)', () => {
		const frames = manualAnimationFrame();
		let renders = 0;
		const scheduler = new RenderScheduler(() => { renders++; });

		scheduler.request();
		scheduler.request();
		scheduler.request();
		expect(frames.pending()).toBe(1); // one frame callback, not three
		expect(renders).toBe(0); // nothing renders before the frame
		expect(scheduler.isPending()).toBe(true);

		frames.fire();
		expect(renders).toBe(1);
		expect(scheduler.isPending()).toBe(false);
	});

	it('falls back to a setTimeout(0)-style task when rAF is unavailable, with the same coalescing', () => {
		vi.stubGlobal('requestAnimationFrame', undefined); // the test environment without a compositor
		let renders = 0;
		const scheduler = new RenderScheduler(() => { renders++; });

		scheduler.request();
		scheduler.request();
		expect(renders).toBe(0);
		vi.advanceTimersByTime(0);
		expect(renders).toBe(1);

		// A request after the fallback task ran schedules a fresh one
		scheduler.request();
		vi.advanceTimersByTime(0);
		expect(renders).toBe(2);
	});

	it('renderSync runs the pass once NOW and satisfies the requests that arrived before it', () => {
		const frames = manualAnimationFrame();
		let renders = 0;
		const scheduler = new RenderScheduler(() => { renders++; });

		scheduler.request();
		scheduler.renderSync(); // the response path: render immediately, measure afterwards
		expect(renders).toBe(1);
		expect(scheduler.isPending()).toBe(false);

		frames.fire(); // the coalesced frame the request scheduled
		expect(renders).toBe(1); // satisfied by the sync render - not run again
	});

	it('a request made AFTER a sync render still renders (the store changed again)', () => {
		const frames = manualAnimationFrame();
		let renders = 0;
		const scheduler = new RenderScheduler(() => { renders++; });

		scheduler.renderSync();
		scheduler.request();
		expect(renders).toBe(1);
		frames.fire();
		expect(renders).toBe(2);
	});

	it('flush runs a pending pass immediately, and is a no-op when the DOM is current', () => {
		const frames = manualAnimationFrame();
		let renders = 0;
		const scheduler = new RenderScheduler(() => { renders++; });

		scheduler.flush();
		expect(renders).toBe(0);

		scheduler.request();
		scheduler.flush();
		expect(renders).toBe(1);
		expect(frames.pending()).toBe(0); // the flushed callback was cancelled, not left armed
	});

	it('cancel drops a pending request without rendering', () => {
		const frames = manualAnimationFrame();
		let renders = 0;
		const scheduler = new RenderScheduler(() => { renders++; });

		scheduler.request();
		scheduler.cancel();
		frames.fire();
		expect(renders).toBe(0);
		expect(scheduler.isPending()).toBe(true); // still dirty - only the frame was dropped
	});
});
