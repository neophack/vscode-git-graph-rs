import type { GitBackend, LogOptions, RefReadOptions } from '../git/read/backendIndex';

/**
 * Prewarming (REFACTOR-PLAN §3.8.2 D11, task 4.9): starting 2 s idle after activation, open
 * engine handles for the recently-opened repositories (at most 3) and prefetch the first page,
 * so a later open of the Git Graph View on those repositories is a hot open instead of a cold
 * one. The switch (`git-graph-rs.prewarm`, default on) changes only speed, never functionality,
 * and the controller yields to user actions at every step boundary: interactive work always
 * wins, and every handle opened here is non-current by definition, so it is closed again after
 * 10 minutes idle (respecting the memory caps of §3.8.1).
 *
 * The module has NO vscode import: every host capability (time, the reader, the recently-opened
 * list, the busy signal, logging) arrives as an injected dependency, which is what makes the
 * controller unit-testable with fake timers and a fake reader. `createPrewarmController` is the
 * extension.ts-facing factory — it fills in the host clock so the wiring one-liner stays small.
 */

/** The idle window after activation (or after a deferred attempt) before prewarming starts. */
export const PREWARM_IDLE_DELAY_MS = 2000;

/** How many recently-opened repositories one cycle covers at most (§3.8.2 D11). */
export const PREWARM_MAX_REPOS = 3;

/** How long a prewarmed handle of a non-current repository stays open before it is closed. */
export const PREWARM_HANDLE_IDLE_CLOSE_MS = 10 * 60 * 1000;

/**
 * The page size of the prefetch: the manifest default of
 * `git-graph-rs.repository.commits.initialLoad` (the view reads the configured value; a
 * user-raised page size still hits the warmed handle — only the tail of its first page is cold).
 */
export const PREWARM_MAX_COMMITS = 300;

/** A scheduled timer handle, opaque (whatever the injected clock's setTimeout returns). */
export type PrewarmTimer = unknown;

/** The millisecond scheduler the controller runs on (vitest's fake timers stand in for tests). */
export interface PrewarmClock {
	setTimeout(handler: () => void, timeoutMs: number): PrewarmTimer;
	clearTimeout(handle: PrewarmTimer): void;
}

/**
 * The slice of the Git backend the controller touches (structural, so a fake stands in for
 * tests and `createBackend(...)` satisfies it in production).
 */
export type PrewarmReader = Pick<GitBackend, 'openRepository' | 'closeRepository' | 'getRepoInfo' | 'getCommits'>;

/**
 * The read options of the prefetch: the values the Git Graph View's default first page uses
 * (`loadRepoInfo` arrives with `showRemoteBranches`/`showStashes` on and an empty hide-remotes
 * list; the commit page rides the manifest-default order, tags and remote branches on).
 * Deliberately minimal — the point of the prefetch is warming the engine handle and the first
 * page's cache entries, not guessing every option the view may later send.
 */
const PREWARM_REPO_INFO_OPTIONS: RefReadOptions = { showRemoteBranches: true, showStashes: true };
const PREWARM_LOG_OPTIONS: LogOptions = { maxCommits: PREWARM_MAX_COMMITS, showTags: true, showRemoteBranches: true };

/** Everything the controller needs from its host; nothing else is touched. */
export interface PrewarmDependencies {
	/** The scheduler (inject vitest's fake timers in tests; the factory defaults to the host's). */
	readonly clock: PrewarmClock;
	/**
	 * Build the reader used to open a repository's handle and prefetch its first page. May
	 * return one shared backend for every repo (production) or build one per repo — the
	 * controller closes each handle on the reader it opened it with.
	 */
	readonly readerFactory: (repo: string) => PrewarmReader;
	/** The recently-opened repositories, most recent first (RepoManager.getRecentRepos). */
	readonly recentRepos: () => readonly string[];
	/** The repository the Git Graph View currently shows, or NULL when no view is open. */
	readonly currentRepo: () => string | null;
	/** TRUE while a user action (an interactive request) is in flight: the controller yields. */
	readonly isBusy: () => boolean;
	/** FALSE once `git-graph-rs.prewarm` is off: `start()` becomes a no-op. */
	readonly enabled: boolean;
	/** Diagnostics sink (the extension Logger). */
	readonly log: (message: string) => void;
}

/** {@link PrewarmDependencies} with the host defaults applied by {@link createPrewarmController}. */
export type PrewarmDependencyOptions = Omit<PrewarmDependencies, 'clock'> & Partial<Pick<PrewarmDependencies, 'clock'>>;

/** The host millisecond timers, wrapped behind {@link PrewarmClock}. */
function createHostClock(): PrewarmClock {
	return {
		// unref: prewarming is a background optimization and must never hold a process open.
		// Irrelevant inside the extension host (its loop is always busy), but a bare script that
		// activates the extension (the C2 runtime smoke) must still exit on schedule.
		setTimeout: (handler, timeoutMs) => {
			const handle = setTimeout(handler, timeoutMs);
			(handle as NodeJS.Timeout).unref?.();
			return handle;
		},
		clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Turns cold opens into hot opens without ever getting in the way: after `start()` the
 * controller waits 2 s of idle, then opens a handle and prefetches the first page for up to 3
 * recently-opened repositories, one at a time, checking the yield signal between steps. Every
 * prewarmed handle (non-current by definition) is scheduled to close after 10 minutes idle, or
 * immediately by `dispose()`.
 */
export class PrewarmController {
	private readonly deps: PrewarmDependencies;
	/** The handles this controller opened and has not handed to the view or closed yet. */
	private readonly handles: Set<string> = new Set();
	/** The reader each handle was opened with (closed handles are removed). */
	private readonly readers: Map<string, PrewarmReader> = new Map();
	/** The pending 10-minute idle-close timer per handle. */
	private readonly closeTimers: Map<string, PrewarmTimer> = new Map();
	private idleTimer: PrewarmTimer = null;
	private disposed = false;
	private running = false;

	constructor(deps: PrewarmDependencies) {
		this.deps = deps;
	}

	/**
	 * Begin prewarming: schedule the first cycle after the idle window. A no-op when the setting
	 * is off, when the controller is disposed, or when a cycle is already pending/running (so
	 * calling it twice never doubles the work). Safe to call again after a cycle completed.
	 */
	public start(): void {
		if (this.disposed) return;
		if (!this.deps.enabled) {
			this.deps.log('Prewarm: disabled by git-graph-rs.prewarm, skipping');
			return;
		}
		if (this.idleTimer !== null || this.running) return;
		this.scheduleCycle(PREWARM_IDLE_DELAY_MS);
	}

	/** Cancel everything and close every handle this controller still owns. Idempotent. */
	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.idleTimer !== null) {
			this.deps.clock.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		for (const timer of this.closeTimers.values()) this.deps.clock.clearTimeout(timer);
		this.closeTimers.clear();
		for (const [repo, reader] of this.readers) {
			// A handle the view adopted in the meantime is the view's to keep: closing it would
			// slow down exactly the repository the user is looking at
			if (this.deps.currentRepo() === repo) continue;
			reader.closeRepository(repo);
		}
		this.readers.clear();
		this.handles.clear();
		this.deps.log('Prewarm: disposed');
	}

	/** Schedule one cycle after `delayMs`, clearing any pending schedule first. */
	private scheduleCycle(delayMs: number): void {
		if (this.idleTimer !== null) this.deps.clock.clearTimeout(this.idleTimer);
		this.idleTimer = this.deps.clock.setTimeout(() => {
			this.idleTimer = null;
			void this.run();
		}, delayMs);
	}

	/**
	 * Run one prewarm cycle. Never rejects (every failure is logged), so the fire-and-forget
	 * call from the timer cannot produce an unhandled rejection.
	 */
	private async run(): Promise<void> {
		if (this.disposed || this.running) return;
		this.running = true;
		try {
			// The idle gate: prewarming only ever BEGINS on idle. A user action in flight when the
			// window elapses reschedules the whole cycle rather than racing it.
			if (this.deps.isBusy()) {
				this.deps.log('Prewarm: a user action is in flight, retrying in ' + PREWARM_IDLE_DELAY_MS + ' ms');
				this.scheduleCycle(PREWARM_IDLE_DELAY_MS);
				return;
			}
			// The repository the view currently shows is already hot; the rest are capped at 3
			const candidates = this.deps.recentRepos()
				.filter((repo) => repo !== this.deps.currentRepo())
				.slice(0, PREWARM_MAX_REPOS);
			if (candidates.length === 0) {
				this.deps.log('Prewarm: no recently-opened repositories to prewarm');
				return;
			}
			this.deps.log('Prewarm: opening up to ' + candidates.length + ' recently-opened repositories');
			for (const repo of candidates) {
				// Yield at every repo boundary: interactive work always wins, and the cycle simply
				// ends early — the remaining candidates stay for a future start() (cold, not broken)
				if (this.disposed) return;
				if (this.deps.isBusy()) {
					this.deps.log('Prewarm: yielded to a user action after ' + this.handles.size + ' repositories');
					return;
				}
				if (this.handles.has(repo)) continue; // already warm from an earlier cycle
				await this.prewarmRepository(repo);
			}
		} catch (error) {
			this.deps.log('Prewarm: cycle failed: ' + errorMessage(error));
		} finally {
			this.running = false;
		}
	}

	/**
	 * Open one repository's handle and prefetch its first page. The handle is scheduled to close
	 * after 10 minutes idle the moment it exists, so even a disposed controller's dangling open
	 * cannot leak it (dispose re-checks and closes what it can see).
	 */
	private async prewarmRepository(repo: string): Promise<void> {
		const reader = this.deps.readerFactory(repo);
		try {
			await reader.openRepository(repo);
		} catch (error) {
			this.deps.log('Prewarm: could not open ' + repo + ': ' + errorMessage(error));
			return;
		}
		if (this.disposed) {
			// dispose() ran while the open was in flight and could not have known this handle
			reader.closeRepository(repo);
			return;
		}
		this.handles.add(repo);
		this.readers.set(repo, reader);
		this.scheduleIdleClose(repo, reader);
		this.deps.log('Prewarm: opened ' + repo);
		try {
			await reader.getRepoInfo(repo, PREWARM_REPO_INFO_OPTIONS);
			if (this.disposed || this.deps.isBusy()) return;
			await reader.getCommits(repo, PREWARM_LOG_OPTIONS);
			this.deps.log('Prewarm: prefetched the first page of ' + repo);
		} catch (error) {
			// A failed prefetch never fails the cycle: the handle stays warm (and still closes on
			// idle), and the view's own load simply runs cold, as it would without prewarming
			this.deps.log('Prewarm: prefetch failed for ' + repo + ': ' + errorMessage(error));
		}
	}

	/** Close the handle `PREWARM_HANDLE_IDLE_CLOSE_MS` after it was opened, unless the view adopted it. */
	private scheduleIdleClose(repo: string, reader: PrewarmReader): void {
		const timer = this.deps.clock.setTimeout(() => {
			this.closeTimers.delete(repo);
			if (this.disposed) return; // dispose() owns the handles from here on
			if (this.deps.currentRepo() === repo) return; // the view adopted the handle: it stays
			this.handles.delete(repo);
			this.readers.delete(repo);
			reader.closeRepository(repo);
			this.deps.log('Prewarm: closed the idle handle of ' + repo);
		}, PREWARM_HANDLE_IDLE_CLOSE_MS);
		this.closeTimers.set(repo, timer);
	}
}

/**
 * Build the prewarm controller for extension.ts: the wiring one-liner passes the host-facing
 * dependencies and, through `ctx.subscriptions.add(...)`, the dispose.
 * @param deps The host-facing dependencies; `clock` defaults to the host timers.
 */
export function createPrewarmController(deps: PrewarmDependencyOptions): PrewarmController {
	const { clock = createHostClock(), ...rest } = deps;
	return new PrewarmController({ ...rest, clock });
}
