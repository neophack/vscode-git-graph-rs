import type { AbortLike } from '../git/process/gitProcess';

/**
 * The host request scheduler.
 * Two queues, one rule each:
 *
 * - **Interactive** jobs (a user-initiated view load, a post-write impact refresh) start
 *   immediately and in parallel — they are what the user is waiting for, so they never queue
 *   behind anything.
 * - **Background** jobs (load follow-ups, prewarming, pull-request fetches, the change poll)
 *   run one at a time (FIFO) and YIELD when an interactive job arrives: the running background
 *   job is abandoned (its abort signal fires, so an engine-backed read cancels early) and the
 *   queue stays parked until no interactive job is in flight.
 *
 * Same-kind supersession: every job names a `kind` (e.g. `'load:/repo'`); starting a new job of
 * a kind abandons the previous one — its caller-facing promise rejects with a
 * {@link JobAbandonedError} and its abort signal fires, plumbed through to the engine's
 * cooperative cancellation. A superseded job's task may still be running (a task that ignores
 * its signal cannot be killed), but its result is severed: only the newest job of a kind ever
 * delivers.
 */

/** Why a job was abandoned before its result could be delivered. */
export type JobAbandonReason =
	/** A newer job of the same kind superseded it — a new request of the same kind invalidates the old one. */
	'superseded'
	/** An interactive job arrived while this background job was running or waiting. */
	| 'yielded';

/**
 * The error an abandoned job's promise rejects with. The job's own task may still settle later
 * (only its DELIVERY is severed); callers that can retry re-issue the job, callers that cannot
 * simply stop caring.
 */
export class JobAbandonedError extends Error {
	public constructor(public readonly kind: string, public readonly reason: JobAbandonReason) {
		super('The scheduled job "' + kind + '" was abandoned (' + reason + ')');
		this.name = 'JobAbandonedError';
	}
}

/** The two scheduling classes: interactive requests first, background concurrency 1. */
export type JobPriority = 'interactive' | 'background';

/** One scheduled job's bookkeeping (the maps below hold it by identity). */
interface ScheduledJob {
	readonly kind: string;
	readonly priority: JobPriority;
	readonly controller: AbortController;
	state: 'pending' | 'queued' | 'running' | 'settled';
	/** Opens the start gate; background jobs wait on it until the scheduler runs them. */
	openGate: (() => void) | null;
	/** Rejects the caller-facing promise, severing the delivery of the job's eventual result. */
	abandon: ((error: JobAbandonedError) => void) | null;
}

/**
 * The scheduler itself. Pure TypeScript over injected signals — no vscode, no timers — so the
 * priority and supersession semantics are unit-testable with plain promises (scheduler.test.ts).
 */
export class HostScheduler {
	/** The current job of each kind (abandoned jobs are removed by {@link settle}). */
	private readonly active = new Map<string, ScheduledJob>();
	/** The waiting background jobs, FIFO. */
	private readonly queue: ScheduledJob[] = [];
	/** The one background job allowed to run at a time. */
	private runningBackground: ScheduledJob | null = null;
	private interactiveInFlight = 0;

	/**
	 * Schedule one job.
	 * @param kind The job's kind: a new job of the same kind abandons the previous one.
	 * @param priority Interactive jobs start immediately and yield background work; background
	 *                 jobs queue at concurrency 1.
	 * @param task The work, receiving the job's abort signal (fires on supersession or yield).
	 * @returns The job's eventual result; rejects with {@link JobAbandonedError} when the job is
	 *          abandoned — never with the abandoned task's own late result.
	 */
	public run<T>(kind: string, priority: JobPriority, task: (signal: AbortLike) => Promise<T>): Promise<T> {
		const previous = this.active.get(kind);
		if (previous !== undefined) this.abandon(previous, 'superseded');
		const job: ScheduledJob = {
			kind: kind,
			priority: priority,
			controller: new AbortController(),
			state: 'pending',
			openGate: null,
			abandon: null
		};
		this.active.set(kind, job);
		const startGate = new Promise<void>((resolve) => { job.openGate = resolve; });
		const abandonment = new Promise<never>((_, reject) => { job.abandon = reject; });
		const outcome = Promise.race([
			priority === 'interactive'
				? this.startInteractive(job, task)
				: this.enqueueBackground(job, startGate, task),
			abandonment
		]);
		void outcome.then(() => this.settle(job), () => this.settle(job));
		return outcome;
	}

	/** How many jobs are running or waiting (a diagnostic for tests and logs). */
	public get pendingCount(): number {
		return this.active.size;
	}

	/** Start an interactive job now, yielding the running background job first. */
	private startInteractive<T>(job: ScheduledJob, task: (signal: AbortLike) => Promise<T>): Promise<T> {
		this.interactiveInFlight++;
		this.yieldBackground();
		job.state = 'running';
		try {
			return task(job.controller.signal);
		} catch (error) {
			// A task that throws synchronously must still flow through the job's settle bookkeeping
			// below (the increment above would otherwise leak and park the background lane forever).
			return Promise.reject(error);
		}
	}

	/** Queue a background job; it runs once the scheduler pumps it (never while interactive work is in flight). */
	private enqueueBackground<T>(job: ScheduledJob, startGate: Promise<void>, task: (signal: AbortLike) => Promise<T>): Promise<T> {
		job.state = 'queued';
		this.queue.push(job);
		this.pump();
		return startGate.then(() => task(job.controller.signal));
	}

	/** Abandon a job: sever its delivery, drop it from the queue, then fire its signal. */
	private abandon(job: ScheduledJob, reason: JobAbandonReason): void {
		if (job.state === 'settled') return;
		if (this.active.get(job.kind) === job) this.active.delete(job.kind);
		job.state = 'settled';
		// The caller-facing rejection goes FIRST: a task whose own cancellation error (the
		// engine's `Cancelled`, a killed child process) would race this settle must lose it —
		// the scheduler's abandonment is the one deterministic outcome of a superseded job.
		job.abandon!(new JobAbandonedError(job.kind, reason));
		job.controller.abort();
		const queued = this.queue.indexOf(job);
		if (queued >= 0) this.queue.splice(queued, 1);
		if (this.runningBackground === job) this.runningBackground = null;
	}

	/** Yield the one background slot to interactive work (the plan's "yield when interactive requests arrive"). */
	private yieldBackground(): void {
		if (this.runningBackground !== null) this.abandon(this.runningBackground, 'yielded');
	}

	/** Start the next background job when the slot and the interactive sky are both clear. */
	private pump(): void {
		if (this.runningBackground !== null || this.interactiveInFlight > 0) return;
		const next = this.queue.shift();
		if (next === undefined || next.state === 'settled') return;
		this.runningBackground = next;
		next.state = 'running';
		next.openGate!();
	}

	/** Record a job's completion and free its slot (the pump resumes the background queue). */
	private settle(job: ScheduledJob): void {
		// The bookkeeping runs even for an ABANDONED job: abandon() marks the state settled and
		// rejects the caller-facing promise, and this settle (wired to that promise) then arrives
		// with the state already settled. Returning early there — the former shape — leaked the
		// slot bookkeeping of every superseded interactive job (interactiveInFlight crept upward,
		// and the background lane, the change poll included, parked forever after the first leak:
		// watcher-missed repository changes stopped appearing in the view). The state guard only
		// keeps the map/slot transitions idempotent; the counters are balanced by job identity.
		const firstSettle = job.state !== 'settled';
		if (firstSettle) {
			job.state = 'settled';
			if (this.active.get(job.kind) === job) this.active.delete(job.kind);
		}
		if (this.runningBackground === job) {
			this.runningBackground = null;
			this.pump();
		} else if (job.priority === 'interactive') {
			this.interactiveInFlight--;
			this.pump();
		}
	}
}

/**
 * The session-wide scheduler instance: the panel's view loads, the load follow-ups, the change
 * poll and the write-path impact refresh run through it, and so do the prewarming reads the
 * extension host drives at activation (extension.ts) — one scheduler is what makes prewarming
 * yield to the panel's loads. A module-level instance because those callers live on both sides
 * of the panel/extension composition; tests construct their own instead of touching this one.
 */
export const hostScheduler = new HostScheduler();
