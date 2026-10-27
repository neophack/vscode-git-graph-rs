import { performance } from 'perf_hooks';
import { Logger } from '../platform/logger';
import { RequestMessage, ResponseMessage } from '../../shared/protocol/messages';
import { AutomationMode } from './catalog';
import { HostBridge, ShimResult } from './hostBridge';

/**
 * The automation engine's run state machine: exactly one ActiveRun at a time, the refresh-id
 * baseline that separates a run's own responses from a previous load cycle's stragglers, and the
 * wait mechanics (waiter + timeout timer) the timed methods resolve on. It also owns the view
 * tap half — onHostMessage/onShimResult — the server registers once for its lifetime, so every
 * observation (traffic, run expectations, loss-warning confirmations, query payloads) flows
 * through one place, decoupled from the request routing in server.ts.
 */

export interface ActiveRun {
	readonly runId: number;
	readonly mode: AutomationMode;
	readonly t0: number;
	/** Expected response commands still awaited. */
	readonly pending: Set<string>;
	/** Highest refresh id per command observed BEFORE this run started (stale-response guard). */
	readonly baseline: ReadonlyMap<string, number>;
	/** Refresh ids this run injected itself (request mode and invoke echo them back unchanged). */
	readonly injectedRefreshIds: Map<string, number>;
	/** Responses observed so far, with their arrival time relative to t0 and error payload (NULL when the operation succeeded). */
	readonly seen: { command: string; atMs: number; error: string | null }[];
	/** TRUE once the page-side steps have completed (UI mode only). */
	shimComplete: boolean;
	shimResult: ShimResult | null;
	/** For invoke / query: the command whose payload is captured, and the payload. */
	invokeCommand: string | null;
	payload: unknown;
	waiter: (() => void) | null;
	timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The error payload a response carries (NULL when the operation succeeded). The host answers a
 * failed operation with the SAME response command — the git error sits in `error` (single) or
 * `errors` (multi, e.g. addTag's tag-then-push pair) — so "a response arrived" alone says nothing
 * about whether the operation worked. This is what separates a passing run from a recorded one.
 */
export function errorPayloadOf(msg: ResponseMessage): string | null {
	const single = (msg as { error?: unknown }).error;
	if (typeof single === 'string' && single !== '') return single;
	const multi = (msg as { errors?: unknown }).errors;
	if (Array.isArray(multi)) {
		const texts = multi.filter((e): e is string => typeof e === 'string' && e !== '');
		if (texts.length > 0) return texts.join('; ');
	}
	return null;
}

/** The per-run init `beginRun` accepts; everything else on ActiveRun starts empty. */
export interface BeginRunInit {
	readonly mode: AutomationMode;
	readonly pending: readonly string[] | ReadonlySet<string>;
	/**
	 * The stale-response baseline: pass `baselineSnapshot()`'s value (a run inside the live
	 * refresh-id stream) or an empty map (a shim batch, which observes no refresh ids).
	 */
	readonly baseline: ReadonlyMap<string, number>;
	/** Refresh ids the run injects itself (request mode / invoke pin them, so echoes count as fresh). */
	readonly injectedRefreshIds?: Map<string, number>;
	/** The command whose response payload is captured verbatim (invoke mode), if any. */
	readonly invokeCommand?: string | null;
	/** TRUE when the run has no page-side step batch to wait for (request / command mode). */
	readonly shimComplete: boolean;
}

export class RunTracker {
	private activeRun: ActiveRun | null = null;
	private runIdSeq = 1;
	/**
	 * Highest refresh id observed per command across the engine's lifetime. The webview increments
	 * the id of every NEW loadRepoInfo/loadCommits request, while the load pipeline's follow-up
	 * responses (remote refs, "Uncommitted Changes") reuse the id of the request they complete —
	 * and can arrive seconds later, during a LATER run. A response belongs to the current run only
	 * when its id exceeds the baseline snapshot taken at the run's start (or it echoes an id the
	 * run itself injected, which request mode and invoke pin to 0).
	 */
	private readonly maxRefreshIds = new Map<string, number>();

	public constructor(private readonly bridge: HostBridge, private readonly logger: Logger) {}

	/** The run currently in flight, if any. */
	public get active(): ActiveRun | null {
		return this.activeRun;
	}

	/** The refresh-id baseline a new run starts from (see {@link maxRefreshIds}). */
	public baselineSnapshot(): ReadonlyMap<string, number> {
		return new Map(this.maxRefreshIds);
	}

	/** Install a freshly built run as the active one. */
	public beginRun(init: BeginRunInit): ActiveRun {
		const run: ActiveRun = {
			runId: this.runIdSeq++, mode: init.mode, t0: performance.now(),
			pending: new Set(init.pending),
			baseline: init.baseline, injectedRefreshIds: init.injectedRefreshIds ?? new Map(),
			seen: [],
			shimComplete: init.shimComplete, shimResult: null,
			invokeCommand: init.invokeCommand ?? null, payload: null, waiter: null, timer: null
		};
		this.activeRun = run;
		return run;
	}

	/** Clear the active run (the owning method's finally). */
	public endRun(): void {
		this.activeRun = null;
	}

	/** Host→webview traffic: refresh-id tracking, payload capture, run expectation matching. */
	public onHostMessage(msg: ResponseMessage): void {
		const run = this.activeRun;
		const refreshId = (msg as { refreshId?: unknown }).refreshId;
		if (typeof refreshId === 'number') {
			const known = this.maxRefreshIds.get(msg.command);
			if (known === undefined || refreshId > known) this.maxRefreshIds.set(msg.command, refreshId);
		}

		if (run !== null && msg.command === run.invokeCommand) {
			run.payload = msg;
		}

		// Request-mode loss-warning flow: the webview would show a dialog and re-send with
		// `confirmed`; the runner is not interactive, so confirm on its behalf.
		if (msg.command === 'lossWarning' && run !== null && run.mode === 'request') {
			const retry = (msg as unknown as { retry?: RequestMessage }).retry;
			if (retry !== undefined) {
				this.logger.log('Automation confirmed a data-loss warning for "' + retry.command + '"');
				this.bridge.inject(retry);
			}
		}

		if (run === null || !run.pending.has(msg.command)) return;
		// The final "Uncommitted Changes" follow-up of a previous load cycle is identifiable by its
		// `uncommittedCount` payload (the main response never carries it) and can arrive seconds
		// later — never let it satisfy a run's expectation.
		if (msg.command === 'loadCommits' && typeof (msg as { uncommittedCount?: unknown }).uncommittedCount === 'number') return;
		// Stale-response guard: a follow-up of a PREVIOUS load cycle reuses that cycle's refresh id,
		// which never exceeds the ids already observed when this run started. Matching by command
		// alone let such a follow-up satisfy the run's expectation before its own responses arrived,
		// flipping the recorded order and completing the run before the view had re-rendered.
		if (typeof refreshId === 'number'
			&& refreshId <= (run.baseline.get(msg.command) ?? -1)
			&& run.injectedRefreshIds.get(msg.command) !== refreshId) return;
		run.pending.delete(msg.command);
		run.seen.push({ command: msg.command, atMs: this.relative(run.t0), error: errorPayloadOf(msg) });
		if (run.pending.size === 0 && run.shimComplete) this.completeRun();
	}

	/** Page shim result: completes a UI-mode run (a failed or skipped batch is final). */
	public onShimResult(result: ShimResult): void {
		const run = this.activeRun;
		if (run === null || run.runId !== result.runId) return;
		run.shimComplete = true;
		run.shimResult = result;
		// A failed step batch is final: the responses it never triggered cannot arrive anymore,
		// so end the run immediately with the step error instead of burning the whole timeout.
		// A skipped batch is final too: the control this action drives is not offered in this
		// view state, so its expected responses will not arrive either.
		if (!result.ok || result.skipped === true || run.pending.size === 0) this.completeRun();
	}

	/** Milliseconds since `t0` (a run's start), rounded to hundredths — the timing unit of every run record. */
	public relative(t0: number): number {
		return Math.round((performance.now() - t0) * 100) / 100;
	}

	/** Resolve the active run's waiter, if any is waiting. */
	private completeRun(): void {
		const run = this.activeRun;
		if (run !== null && run.waiter !== null) {
			const waiter = run.waiter;
			run.waiter = null;
			waiter();
		}
	}

	/** Force-fail the active run (engine stop). */
	public forceFinish(error: Error): void {
		const run = this.activeRun;
		if (run === null) return;
		if (run.timer !== null) clearTimeout(run.timer);
		run.timer = null;
		run.shimComplete = true;
		run.shimResult = { runId: run.runId, ok: false, results: [], error: error.message };
		this.completeRun();
	}

	/** Wait until the run's expectations are met, or the timeout elapses. */
	public waitForRun(run: ActiveRun, timeoutMs: number): Promise<'completed' | 'timeout'> {
		if (run.pending.size === 0 && run.shimComplete) return Promise.resolve('completed');
		return new Promise<'completed' | 'timeout'>((resolve) => {
			run.waiter = () => {
				if (run.timer !== null) clearTimeout(run.timer);
				run.timer = null;
				resolve('completed');
			};
			run.timer = setTimeout(() => {
				run.waiter = null;
				resolve('timeout');
			}, timeoutMs);
		});
	}
}
