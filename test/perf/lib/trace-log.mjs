/**
 * The P4 trace-log parser (OPTIMIZATION-PLAN §7 P2): reads the `Trace <name>: MARK +x.xms, ...`
 * lines the extension writes to its session log while `git-graph-rs.enableLog` is on (the P1
 * sink in CommandManager), and aggregates them into the per-mark P50/P95 the §3.8.1 timing
 * budgets are calibrated against.
 *
 * This deliberately mirrors scripts/analyze-log.mjs's parser instead of importing it: that
 * script is a standalone CLI (it parses process.argv and reads its file at module top level,
 * so importing it would execute the CLI), and it must stay shippable alone. The mirrored
 * pieces — the line grammar, the origin split (host vs webview offsets come from different
 * clocks and are never mixed), and the linear-interpolation percentile — must stay in sync
 * with it; `test/tooling/analyzeLog.test.ts` pins the script's side, the E2E collector's own
 * output is the exercise for this side.
 *
 * One extension over the script: trace lines carry a log timestamp, so a trace can be
 * attributed to a time window (`attributeToWindows`) — that is how the E2E collector maps
 * traces to the scenario that was running when they were recorded.
 */

import fs from 'node:fs';

/** The timestamped log-line prefix: `[YYYY-MM-DD HH:MM:SS.mmm] message`. */
const LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] (.*)$/;
/** One `Trace <name>: ...` message (the P1 sink's shape, CommandManager's `log(formatTrace)`). */
const TRACE = /^Trace (\S+): (.*)$/;
/** One mark inside a trace message: `NAME +12.3ms`, webview marks suffixed ` (webview)`. */
const TRACE_MARK = /(\S+) \+(\d+(?:\.\d+)?)ms( \(webview\))?/g;
/** The engine → CLI fallback line (counted next to the traces: which reads ran at CLI speed). */
const FALLBACK = /The Rust engine could not answer (\w+) \((.*?)\); falling back to the git CLI\./;

/**
 * One parsed trace: `{ timestamp: Date, name: string, hostMarks: Map<string, number>,
 * webviewMarks: Map<string, number> }` — the log line's timestamp (parsed as UTC; the E2E
 * launcher pins TZ=UTC in the editor), the trace name, and each origin's marks keyed by mark
 * name with the offset within that origin.
 */

/** Parse every trace line of a session log's content, in log order. */
export function parseTraceLines(content) {
	const traces = [];
	for (const line of content.split(/\r?\n/)) {
		const stamped = LINE.exec(line);
		if (stamped === null) continue;
		const trace = TRACE.exec(stamped[2]);
		if (trace === null) continue;
		const hostMarks = new Map();
		const webviewMarks = new Map();
		for (const mark of stamped[2].matchAll(TRACE_MARK)) {
			const target = mark[3] !== undefined ? webviewMarks : hostMarks;
			target.set(mark[1], Number(mark[2]));
		}
		traces.push({ timestamp: parseLogTimestamp(stamped[1]), name: trace[1], hostMarks, webviewMarks });
	}
	return traces;
}

/** Read a log file and parse its trace lines (and count engine fallbacks). */
export function readTraceLog(file) {
	const content = fs.readFileSync(file, 'utf8');
	let fallbacks = 0;
	for (const line of content.split(/\r?\n/)) {
		const stamped = LINE.exec(line);
		if (stamped !== null && FALLBACK.test(stamped[2])) fallbacks += 1;
	}
	return { traces: parseTraceLines(content), fallbacks };
}

/** The log's `[YYYY-MM-DD HH:MM:SS.mmm]` timestamp as a Date — UTC (the editor runs TZ=UTC). */
function parseLogTimestamp(text) {
	return new Date(text.replace(' ', 'T') + 'Z');
}

/** The P50 (or any P) of the samples: linear interpolation, the estimator analyze-log.mjs uses. */
export function percentile(samples, p) {
	const sorted = [...samples].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0];
	const index = (p / 100) * (sorted.length - 1);
	const low = Math.floor(index);
	const high = Math.ceil(index);
	if (low === high) return sorted[low];
	return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * Aggregate traces: one entry per trace name, per mark (per origin), with n / P50 / P95 of the
 * mark's offset — the same table shape analyze-log.mjs prints.
 */
export function aggregateTraces(traces) {
	const byName = new Map();
	for (const trace of traces) {
		let entry = byName.get(trace.name);
		if (entry === undefined) {
			entry = { count: 0, marks: new Map() };
			byName.set(trace.name, entry);
		}
		entry.count += 1;
		for (const origin of ['hostMarks', 'webviewMarks']) {
			const prefix = origin === 'webviewMarks' ? 'webview ' : 'host ';
			for (const [name, offset] of trace[origin]) {
				const key = prefix + name;
				const samples = entry.marks.get(key) ?? [];
				samples.push(offset);
				entry.marks.set(key, samples);
			}
		}
	}
	const result = {};
	for (const [name, entry] of byName) {
		const marks = {};
		for (const [key, samples] of entry.marks) {
			marks[key] = { n: samples.length, p50: round1(percentile(samples, 50)), p95: round1(percentile(samples, 95)) };
		}
		result[name] = { count: entry.count, marks };
	}
	return result;
}

/**
 * Attribute traces to time windows: each trace lands in the LAST window whose
 * [startedAt, finishedAt] contains its log timestamp, or `outside` when none does. Windows
 * overlap harmlessly in practice (the boot window sits inside no scenario), but when they do,
 * the narrower (later-starting) window wins because scenarios run strictly after the boot.
 */
export function attributeToWindows(traces, windows) {
	const ranges = windows
		.map((w) => ({ id: w.id, start: Date.parse(w.startedAt), end: Date.parse(w.finishedAt) }))
		.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
		.sort((a, b) => a.start - b.start);
	const attributed = new Map();
	const outside = [];
	for (const trace of traces) {
		const t = trace.timestamp.getTime();
		// The last window that started at or before the trace and had not finished yet.
		let owner = null;
		for (const range of ranges) {
			if (t >= range.start && t <= range.end) owner = range;
		}
		if (owner === null) {
			outside.push(trace);
			continue;
		}
		const list = attributed.get(owner.id) ?? [];
		list.push(trace);
		attributed.set(owner.id, list);
	}
	const result = {};
	for (const [id, list] of attributed) result[id] = aggregateTraces(list);
	result['outside'] = aggregateTraces(outside);
	return result;
}
