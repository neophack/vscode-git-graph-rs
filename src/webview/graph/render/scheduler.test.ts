// @vitest-environment jsdom
/**
 * The render scheduler: every render request
 * funnels through one scheduler, and however many requests arrive before the next frame, each
 * renderer renders EXACTLY ONCE. Requests carrying a typed slice change mark only the renderers
 * subscribed to that slice, so a change of slice A never runs a renderer subscribed to B; the
 * untyped requests (the full invalidation, the geometry-driven renderSync) mark everything. The
 * synchronous entry (`renderSync`) is what makes a response render exactly once: it runs the pass
 * immediately AND satisfies the requests that arrived before it, so nothing renders a second time
 * when the frame arrives. Both frame mechanisms are covered: the animation frame (stubbed into a
 * manual queue) and the setTimeout fallback the scheduler falls back to when rAF is unavailable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SliceId } from '../state/changes';
import { RenderScheduler, SliceRenderer } from './scheduler';

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

/** A counting renderer subscribed to the given slices, recording what each frame carried. */
function countingRenderer(name: string, slices: ReadonlyArray<SliceId>, log: string[], seenFrames?: Array<Record<string, ReadonlyArray<string> | undefined>>): SliceRenderer {
	return {
		slices: slices,
		render: (changes) => {
			log.push(name);
			if (seenFrames !== undefined) {
				const snapshot: Record<string, ReadonlyArray<string> | undefined> = {};
				for (const slice of ['repos', 'refs', 'commits', 'details', 'ui', 'integrations'] as SliceId[]) {
					const keys = changes.keysOf(slice);
					if (keys !== undefined) snapshot[slice] = keys;
				}
				seenFrames.push(snapshot);
			}
		}
	};
}

describe('RenderScheduler', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

	it('coalesces any number of requests within a frame into ONE render pass (rAF)', () => {
		const frames = manualAnimationFrame();
		let renders = 0;
		const scheduler = new RenderScheduler();
		scheduler.subscribe({ slices: ['commits'], render: () => { renders++; } });

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
		const scheduler = new RenderScheduler();
		scheduler.subscribe({ slices: ['commits'], render: () => { renders++; } });

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
		const scheduler = new RenderScheduler();
		scheduler.subscribe({ slices: ['commits'], render: () => { renders++; } });

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
		const scheduler = new RenderScheduler();
		scheduler.subscribe({ slices: ['commits'], render: () => { renders++; } });

		scheduler.renderSync();
		scheduler.request();
		expect(renders).toBe(1);
		frames.fire();
		expect(renders).toBe(2);
	});

	it('flush runs a pending pass immediately, and is a no-op when the DOM is current', () => {
		const frames = manualAnimationFrame();
		let renders = 0;
		const scheduler = new RenderScheduler();
		scheduler.subscribe({ slices: ['commits'], render: () => { renders++; } });

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
		const scheduler = new RenderScheduler();
		scheduler.subscribe({ slices: ['commits'], render: () => { renders++; } });

		scheduler.request();
		scheduler.cancel();
		frames.fire();
		expect(renders).toBe(0);
		expect(scheduler.isPending()).toBe(true); // still dirty - only the frame was dropped
	});
});

describe('RenderScheduler routing by slice (F1)', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

	it('routes a typed change only to the renderers subscribed to its slice, handing each the collected frame', () => {
		const frames = manualAnimationFrame();
		const scheduler = new RenderScheduler();
		const ran: string[] = [];
		const tableFrames: Array<Record<string, ReadonlyArray<string> | undefined>> = [];
		scheduler.subscribe(countingRenderer('table', ['repos', 'refs', 'commits', 'details', 'integrations'], ran, tableFrames));
		scheduler.subscribe(countingRenderer('graph', ['repos', 'refs', 'commits', 'details'], ran));
		scheduler.subscribe(countingRenderer('pinned', ['repos', 'refs', 'commits'], ran));

		// A pull-request response: an integrations-only change - only the table shows the badges,
		// and it is handed the frame's merged change (the keyed patcher's input)
		scheduler.request({ slice: 'integrations', keys: ['pullRequests'] });
		frames.fire();
		expect(ran).toEqual(['table']);
		// The pass handed the table the frame's merged change: the keyed patcher's input
		expect(tableFrames[tableFrames.length - 1]).toEqual({ integrations: ['pullRequests'] });

		// A refs-only change: the table (labels), the graph (muted lanes) and the pinned row
		// (branch chips), in subscription order
		ran.length = 0;
		scheduler.request({ slice: 'refs', keys: ['branches'] });
		frames.fire();
		expect(ran).toEqual(['table', 'graph', 'pinned']);

		// A commits change: everything subscribed to it, in subscription order
		ran.length = 0;
		scheduler.request({ slice: 'commits', keys: ['page'] });
		frames.fire();
		expect(ran).toEqual(['table', 'graph', 'pinned']);
	});

	it('a change no renderer subscribes to schedules no frame at all', () => {
		const frames = manualAnimationFrame();
		const scheduler = new RenderScheduler();
		let renders = 0;
		scheduler.subscribe({ slices: ['commits'], render: () => { renders++; } });

		scheduler.request({ slice: 'ui', keys: ['scrollTop'] }); // nobody renders for the scroll record
		expect(frames.pending()).toBe(0);
		expect(scheduler.isPending()).toBe(false);
		vi.advanceTimersByTime(50);
		expect(renders).toBe(0);
	});

	it('the untyped request (the full invalidation) marks EVERY renderer, whatever it subscribed to', () => {
		const frames = manualAnimationFrame();
		const scheduler = new RenderScheduler();
		const ran: string[] = [];
		scheduler.subscribe(countingRenderer('table', ['repos', 'refs', 'commits', 'details', 'integrations'], ran));
		scheduler.subscribe(countingRenderer('graph', ['commits', 'details'], ran));

		scheduler.request(); // invalidateRender() and the geometry paths: anything could be stale
		frames.fire();
		expect(ran).toEqual(['table', 'graph']);
	});

	it('one frame renders each dirty renderer once, however many changes arrived', () => {
		const frames = manualAnimationFrame();
		const scheduler = new RenderScheduler();
		const ran: string[] = [];
		scheduler.subscribe(countingRenderer('table', ['commits', 'integrations'], ran));
		scheduler.subscribe(countingRenderer('graph', ['commits'], ran));

		// A response touching two slices: each renderer merges its dirtiness into one run
		scheduler.request({ slice: 'commits', keys: ['page'] });
		scheduler.request({ slice: 'integrations', keys: ['gerritStates'] });
		scheduler.request({ slice: 'commits', keys: ['lookup'] });
		frames.fire();
		expect(ran).toEqual(['table', 'graph']);
	});

	it('renderSync with pending changes runs exactly the dirty renderers; with none, everything', () => {
		const scheduler = new RenderScheduler();
		const ran: string[] = [];
		scheduler.subscribe(countingRenderer('table', ['commits', 'integrations'], ran));
		scheduler.subscribe(countingRenderer('graph', ['commits'], ran));
		scheduler.subscribe(countingRenderer('pinned', ['repos', 'refs', 'commits'], ran));

		// The response path: the page actions already emitted - the pass runs the dirty set only.
		// An integrations-only burst dirties the table, and the sync satisfies it without dragging
		// the graph or the pinned row along.
		scheduler.request({ slice: 'integrations', keys: ['pullRequests'] });
		scheduler.renderSync();
		expect(ran).toEqual(['table']);

		// The geometry path (a scroll re-windowing): nothing pending - everything runs
		ran.length = 0;
		scheduler.renderSync();
		expect(ran).toEqual(['table', 'graph', 'pinned']);
	});
});
