/**
 * The BufferedQueue (ported from legacy/tests/utils.test.mjs): buffering,
 * de-duplication, the single onChanges notification, re-entrant enqueues and disposal. Runs on
 * real timers with polling waits (fixed sleeps are flaky on loaded machines).
 */

import { describe, expect, it } from 'vitest';

import { BufferedQueue } from './bufferedQueue';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* These tests run on real timers: on a loaded machine (the full suite runs many test files in
 * parallel) the buffer and processing timers can fire tens of milliseconds late, so a FIXED wait
 * would assert before the queue settled. Poll for the settled result instead; a genuine
 * regression still fails the assertion after the timeout. */
const waitFor = async (condition: () => boolean, timeoutMs = 2000) => {
	for (let elapsed = 0; !condition() && elapsed < timeoutMs; elapsed += 10) await tick(10);
};

describe('BufferedQueue', () => {
	it('buffers items, de-duplicates them, and calls onChanges once when any item changed', async () => {
		const processed: string[] = [];
		let changes = 0;
		const queue = new BufferedQueue(async (item: string) => {
			processed.push(item);
			return item !== 'b';
		}, () => changes++, 20);
		queue.enqueue('a');
		queue.enqueue('b');
		queue.enqueue('a'); // moves 'a' to the back rather than duplicating it
		queue.enqueue(''); // falsy items must still be processed
		await waitFor(() => processed.length === 3);
		expect(processed).toEqual(['b', 'a', '']);
		expect(changes).toBe(1);
		queue.dispose();
	});

	it('does not call onChanges when nothing changed', async () => {
		let changes = 0;
		const queue = new BufferedQueue(async () => false, () => changes++, 10);
		queue.enqueue(1);
		await tick(40);
		expect(changes).toBe(0);
		queue.dispose();
	});

	it('handles items enqueued while processing in the same run', async () => {
		const processed: number[] = [];
		const queue = new BufferedQueue<number>(async (item) => {
			processed.push(item);
			if (item === 1) queue.enqueue(2);
			await tick(5);
			return true;
		}, () => {}, 10);
		queue.enqueue(1);
		await waitFor(() => processed.length === 2);
		expect(processed).toEqual([1, 2]);
		queue.dispose();
	});

	it('dispose cancels a pending buffer timeout', async () => {
		const processed: string[] = [];
		const queue = new BufferedQueue(async (item: string) => {
			processed.push(item);
			return true;
		}, () => {}, 10);
		queue.enqueue('x');
		queue.dispose();
		await tick(40);
		expect(processed).toEqual([]);
	});
});

	it('dispose on an idle queue with a drained buffer is a clean no-op', async () => {
		// The dispose callback's no-pending-timer side: everything flushed, the timeout fired
		// and nulled, and the queue torn down afterwards.
		const processed: string[] = [];
		const queue = new BufferedQueue(async (item: string) => {
			processed.push(item);
			return true;
		}, () => {}, 10);
		queue.enqueue('x');
		await waitFor(() => processed.length === 1);
		queue.dispose();
		expect(processed).toEqual(['x']);
	});
