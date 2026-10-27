/**
 * The P1 timing markers: a tiny isomorphic trace API shared by the
 * extension host and the webview.
 *
 * - `mark(name)` records one instant; `begin(name)` / `end()` bracket a named trace; `span(name, fn)`
 *   is the begin/end pair around one function (synchronous or promise-returning).
 * - The host keeps the last 20 recorded traces in a ring buffer (`traces()`), the seam the
 *   Diagnostics command reads; a sink (`onTraceRecorded`) forwards every recorded trace -
 *   the CommandManager wires it to the session log while `git-graph-rs.enableLog` is on, in the
 *   one-line shape {@link formatTrace} renders and `scripts/analyze-log.mjs` aggregates.
 * - The webview collects its marks (T2 script start, T4 data received, T5 the animation frame
 *   after the first rows) and posts them to the host ONCE, after T5, as one `webviewTraces`
 *   message; the host appends them to its open trace and records the whole thing.
 *
 * Everything is OFF by default and stays off until `setEnabled(true)`: a disabled call is one
 * boolean read and a return, well under a microsecond. When enabled, marks also go to
 * the runtime's own `performance.mark` (prefixed `gg:`) so a DevTools or `--cpu-prof` timeline
 * shows them alongside the collected traces.
 *
 * Isomorphism: no imports at all. The `performance` global is the `perf_hooks` performance on
 * any Node that has it (>= 16) and the DOM timeline in the webview; where neither exists (the
 * VS Code 1.38 artifact floor's Node 10.11), timestamps fall back to `Date.now()` - wall-clock,
 * still millisecond-accurate enough for the spans the budgets are stated in.
 */

/** The canonical marker names (the T0-T5 timeline points). */
export const MARK = {
	/** Extension activation (host). Placed by the extension entry file. */
	activation: 'ACTIVATION',
	/** T0: a view-opening command dispatched (host, CommandManager). */
	commandDispatch: 'T0',
	/** T1: the Git Graph panel created (host, GitGraphView). */
	panelCreated: 'T1',
	/** T2: the webview bundle's script started (webview, main.ts). */
	webviewStart: 'T2',
	/** T3: the host is about to post the first `loadView` payload (host, GitGraphView.pushViewLoad). */
	hostDataReady: 'T3',
	/** T4: the webview received the boot's data push (webview, response router). */
	webviewDataReceived: 'T4',
	/** T5: an animation frame ran after the first rows rendered (webview, main.ts). */
	rafAfterFirstRows: 'T5'
} as const;

/** The name traces get when marks arrive without an explicit `begin` (e.g. a panel restored without a command). */
const SESSION_TRACE_NAME = 'session';

/** One collected mark: `name`, taken at the marking clock's `t` (milliseconds). */
export interface TraceMark {
	readonly name: string;
	/**
	 * The marking clock's timestamp in milliseconds. Host and webview clocks have different
	 * epochs: only offsets between marks of the SAME origin are durations (that is what
	 * {@link formatTrace} reports and what the analyser aggregates).
	 */
	readonly t: number;
	/** Which half recorded the mark: the host marks as they happen, the webview's arrive in one batch. */
	readonly origin: 'host' | 'webview';
}

/** The wire shape of a webview mark (what a `webviewTraces` message carries; origin implied). */
export interface MarkPayload {
	readonly name: string;
	readonly t: number;
}

/** One recorded trace: an ordered mark set under the name `begin` gave it. */
export interface Trace {
	readonly name: string;
	readonly marks: ReadonlyArray<TraceMark>;
}

/** The ring buffer's capacity: the last 20 traces. */
const RING_CAPACITY = 20;

/**
 * The runtime's performance timeline, or NULL where neither Node nor the DOM provides one.
 * (The `typeof` guard is the isomorphism: the identifier is only evaluated where it exists.)
 */
function resolvePerformance(): { readonly now: () => number; readonly mark?: (name: string) => void } | null {
	if (typeof performance === 'object' && typeof performance.now === 'function') return performance;
	return null;
}

const perf = resolvePerformance();

function nowMs(): number {
	return perf !== null ? perf.now() : Date.now();
}

/** Also drop the mark onto the runtime's own timeline (DevTools / --cpu-prof visibility). */
function platformMark(name: string): void {
	if (perf !== null && typeof perf.mark === 'function') perf.mark('gg:' + name);
}

let enabled = false;
let sink: ((trace: Trace) => void) | null = null;
/** The host's ring of recorded traces, oldest first (the webview's own copy stays empty). */
const recorded: Trace[] = [];
let open: { name: string; marks: TraceMark[] } | null = null;

/** Turn the trace layer on or off (the host wires this to `git-graph-rs.enableLog`). */
export function setEnabled(value: boolean): void {
	enabled = value;
}

/** Whether the trace layer records (everything below is a no-op when it does not). */
export function isEnabled(): boolean {
	return enabled;
}

/**
 * Register the consumer of every recorded trace - the host's log wiring (the
 * Diagnostics command reads the ring buffer itself via {@link traces}). Pass NULL to detach.
 */
export function onTraceRecorded(handler: ((trace: Trace) => void) | null): void {
	sink = handler;
}

/** The recorded traces, oldest first, at most {@link RING_CAPACITY} of them. */
export function traces(): ReadonlyArray<Trace> {
	return recorded.slice();
}

/** Whether a trace is currently open (marks would land in it). */
export function hasOpenTrace(): boolean {
	return open !== null;
}

/**
 * Begin a named trace. A still-open trace is recorded first (superseded): the open path's
 * traces are short-lived, and a boot whose webview report never arrived must not swallow the
 * next measurement.
 */
export function begin(name: string): void {
	if (!enabled) return;
	close();
	open = { name: name, marks: [] };
}

/** Record the open trace into the ring buffer (a no-op without an open trace). */
export function end(): void {
	if (!enabled) return;
	close();
}

/**
 * Record one mark into the open trace - or into an unnamed session trace when none is open
 * (a panel restored from serialization boots without a commanding T0). When disabled: one
 * boolean read and a return.
 */
export function mark(name: string): void {
	if (!enabled) return;
	if (open === null) open = { name: SESSION_TRACE_NAME, marks: [] };
	open.marks.push({ name: name, t: nowMs(), origin: 'host' });
	platformMark(name);
}

/**
 * Record one mark into the open trace under the WEBVIEW origin. Host-only in practice: the
 * webview batches its marks into one `webviewTraces` message instead of marking live.
 */
export function markWebview(name: string): void {
	if (!enabled) return;
	if (open === null) open = { name: SESSION_TRACE_NAME, marks: [] };
	open.marks.push({ name: name, t: nowMs(), origin: 'webview' });
}

/**
 * Run `fn` as one named span: its own trace, recording the elapsed time as a `<name>:start` /
 * `<name>` mark pair (so the analyser's per-mark offset aggregate IS the span's duration). A
 * promise-returning `fn` ends the span when the promise settles; a throw records `<name>:error`
 * before the trace closes. When disabled this is `fn()` and nothing else.
 */
export function span<T>(name: string, fn: () => T): T {
	if (!enabled) return fn();
	begin(name);
	mark(name + ':start');
	let result: T;
	try {
		result = fn();
	} catch (error) {
		mark(name + ':error');
		close();
		throw error;
	}
	if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as unknown as { then?: unknown }).then === 'function') {
		const promise = result as unknown as Promise<unknown>;
		return promise.then(
			(value) => { mark(name); close(); return value; },
			(error) => { mark(name + ':error'); close(); throw error; }
		) as unknown as T;
	}
	mark(name);
	close();
	return result;
}

/** Whether a mark with this name is already in the open trace (false when disabled or nothing is open). */
export function hasMark(name: string): boolean {
	if (!enabled || open === null) return false;
	return open.marks.some((m) => m.name === name);
}

/**
 * The host side of the `webviewTraces` message: append the webview's marks to the open trace
 * (or to a webview-only trace when the host's own half never opened one) and record the trace.
 */
export function mergeWebviewMarks(marks: ReadonlyArray<MarkPayload>): void {
	if (!enabled) return;
	if (open === null) open = { name: 'webview', marks: [] };
	for (const payload of marks) open.marks.push({ name: payload.name, t: payload.t, origin: 'webview' });
	close();
}

/** The open trace's marks as the `webviewTraces` payload (empty when nothing was collected). */
export function collectMarks(): ReadonlyArray<MarkPayload> {
	if (!enabled || open === null) return [];
	return open.marks.map((m) => ({ name: m.name, t: m.t }));
}

/** Drop the open trace without recording it (the webview calls this after reporting its marks). */
export function clearMarks(): void {
	if (!enabled) return;
	open = null;
}

/**
 * One-line rendering of a trace for the session log - the shape `scripts/analyze-log.mjs`
 * parses: each mark as `NAME +<offset>ms`, its offset from the FIRST mark of its own origin
 * (host offsets and webview offsets are relative to different clocks, so they never mix),
 * webview marks suffixed `(webview)`.
 */
export function formatTrace(trace: Trace): string {
	const firstOfOrigin = new Map<string, number>();
	for (const m of trace.marks) {
		if (!firstOfOrigin.has(m.origin)) firstOfOrigin.set(m.origin, m.t);
	}
	const parts = trace.marks.map((m) => {
		const first = firstOfOrigin.get(m.origin);
		const offset = m.t - (first === undefined ? m.t : first);
		const rendered = m.name + ' +' + offset.toFixed(1) + 'ms';
		return m.origin === 'webview' ? rendered + ' (webview)' : rendered;
	});
	return trace.name + ': ' + parts.join(', ');
}

/** Test seam: drop all trace state (no production module calls this). */
export function resetForTests(): void {
	enabled = false;
	sink = null;
	recorded.length = 0;
	open = null;
}

/** Move the open trace into the ring buffer (and to the sink), whether it has marks or not. */
function close(): void {
	const finished = open;
	open = null;
	if (finished === null || finished.marks.length === 0) return;
	const trace: Trace = { name: finished.name, marks: finished.marks };
	recorded.push(trace);
	if (recorded.length > RING_CAPACITY) recorded.shift();
	if (sink !== null) sink(trace);
}
