import { describe, expect, it } from 'vitest';
import { HostScheduler, JobAbandonedError } from './scheduler';

/**
 * HostScheduler tests (REFACTOR-PLAN task 4.8, §3.8.3 "Cancellation and priority"): the two
 * priority classes, background concurrency 1, the yield-on-interactive rule, and same-kind
 * supersession — including the rapid-switch acceptance (10 same-kind requests: 9 cancelled,
 * only the last result delivered, within ~1.5x a single request's time).
 */

/** A task that resolves after `ms` unless its signal fires first (the cooperative shape of an engine read). */
function cancellableTask(ms: number): (signal: { readonly aborted: boolean }) => Promise<string> {
	return (signal) => new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => resolve('done'), ms);
		const check = setInterval(() => {
			if (signal.aborted) {
				clearTimeout(timer);
				clearInterval(check);
				reject(new Error('cancelled'));
			}
		}, 1);
	});
}

/** Resolve after `ms` milliseconds of real time (the tests use real timers and short delays). */
function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('HostScheduler priority', () => {
	it('runs background jobs one at a time, in FIFO order', async () => {
		const scheduler = new HostScheduler();
		const order: string[] = [];
		const job = (name: string, ms: number) => scheduler.run(name, 'background', async () => {
			order.push('start:' + name);
			await delay(ms);
			order.push('end:' + name);
			return name;
		});
		const a = job('a', 15);
		const b = job('b', 10);
		const c = job('c', 5);
		await Promise.all([a, b, c]);
		expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
	});

	it('an interactive arrival yields the running background job and defers the queue until it finishes', async () => {
		const scheduler = new HostScheduler();
		const order: string[] = [];
		const taskSettled = new Promise<void>((resolve) => {
			void scheduler.run('bg', 'background', async (signal) => {
				order.push('bg:start');
				await delay(120); // long enough that no realistic timer slack ends it first
				order.push(signal.aborted ? 'bg:abandoned' : 'bg:end');
				resolve();
				return 'bg';
			}).catch(() => undefined);
		});
		const queued = scheduler.run('queued', 'background', async () => {
			order.push('queued:start');
			await delay(5);
			order.push('queued:end');
			return 'queued';
		});
		await delay(5); // the first background job is running now
		const interactive = scheduler.run('inter', 'interactive', async () => {
			order.push('inter:start');
			await delay(10);
			order.push('inter:end');
			return 'inter';
		});
		await interactive;
		await queued;
		await taskSettled; // the yielded task observed its abort signal
		// The interactive job ran THROUGH the yielded background work; the queue resumed right
		// after it, while the yielded task only noticed its abort when its own delay elapsed
		expect(order).toEqual(['bg:start', 'inter:start', 'inter:end', 'queued:start', 'queued:end', 'bg:abandoned']);
	});

	it('interactive jobs of different kinds run in parallel (they are what the user waits for)', async () => {
		const scheduler = new HostScheduler();
		const order: string[] = [];
		const a = scheduler.run('load:A', 'interactive', async () => {
			order.push('a:start');
			await delay(10);
			order.push('a:end');
			return 'a';
		});
		const b = scheduler.run('refresh:B', 'interactive', async () => {
			order.push('b:start');
			await delay(10);
			order.push('b:end');
			return 'b';
		});
		await Promise.all([a, b]);
		expect(order.indexOf('b:start')).toBeLessThan(order.indexOf('a:end'));
	});
});

describe('HostScheduler same-kind supersession', () => {
	it('a new job of a kind rejects the previous one with JobAbandonedError and fires its signal', async () => {
		const scheduler = new HostScheduler();
		let observedAbort = false;
		const first = scheduler.run('load:/repo', 'interactive', (signal) => new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => resolve('first'), 50);
			signal.addEventListener('abort', () => {
				observedAbort = true;
				clearTimeout(timer);
				reject(new Error('cancelled'));
			});
		}));
		await delay(5);
		const second = scheduler.run('load:/repo', 'interactive', () => Promise.resolve('second'));
		await expect(first).rejects.toBeInstanceOf(JobAbandonedError);
		expect(observedAbort).toBe(true); // the engine-cancel seam fired
		await expect(second).resolves.toBe('second');
	});

	it('a superseded task that ignores its signal still never delivers its late result', async () => {
		const scheduler = new HostScheduler();
		let releaseFirst!: (value: string) => void;
		const first = scheduler.run('load:/repo', 'interactive', () => new Promise<string>((resolve) => { releaseFirst = resolve; }));
		const second = scheduler.run('load:/repo', 'interactive', () => Promise.resolve('second'));
		releaseFirst('late-first'); // settles AFTER the supersession
		await expect(first).rejects.toBeInstanceOf(JobAbandonedError); // severed regardless
		await expect(second).resolves.toBe('second');
	});

	it('rapid switching: 10 same-kind requests cancel 9 and deliver only the last, within ~1.5x a single request', async () => {
		const scheduler = new HostScheduler();
		const SINGLE_MS = 60;
		// The single-request baseline
		const singleStart = Date.now();
		await scheduler.run('baseline', 'interactive', cancellableTask(SINGLE_MS));
		const singleDuration = Date.now() - singleStart;

		const cancellations: unknown[] = [];
		const started = Date.now();
		const requests = [];
		for (let i = 0; i < 10; i++) {
			requests.push(scheduler.run('switch', 'interactive', cancellableTask(SINGLE_MS)).catch((error) => {
				cancellations.push(error);
				return 'abandoned';
			}));
			await delay(2); // the next switch arrives while the previous read is in flight
		}
		const results = await Promise.all(requests);
		const duration = Date.now() - started;
		expect(cancellations.length).toBe(9); // the first 9 were superseded
		expect(results.slice(0, 9).every((result) => result === 'abandoned')).toBe(true); // their deliveries were severed
		expect(results[9]).toBe('done'); // only the last request's result was delivered
		// ~1.5x a single request (the constant slack absorbs timer coalescing under load)
		expect(duration).toBeLessThan(singleDuration * 1.5 + 100);
	});
});
