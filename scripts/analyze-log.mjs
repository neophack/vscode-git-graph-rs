/**
 * Summarise a Git Graph RS session log — the opt-in log written while
 * `git-graph-rs.enableLog` is on, and openable from the view's settings widget.
 *
 *   node scripts/analyze-log.mjs <logfile> [--top 8] [--json]
 *
 * Three questions are answered:
 *
 * - **Where did time go?** Every spawned `git` command is logged with its duration
 *   (`> git log ... (42 ms)`); the per-subcommand totals, averages and worst cases show which
 *   operations dominate a session.
 * - **How long did the open take?** The P1 trace lines (`Trace boot: T0 +0.0ms, ...` written
 *   while `git-graph-rs.enableLog` is on) are aggregated per trace and per mark into the P50/P95
 *   of each mark's offset within its own side (host vs webview) - the distribution the timing
 *   budgets of OPTIMIZATION-PLAN §3.8.1 are calibrated against (P2).
 * - **Where did the engine not answer?** Every fallback from the Rust engine to the `git` CLI is
 *   logged with the method that fell back — those are the places the extension ran at CLI speed.
 * - **What failed?** Every ERROR line, grouped by message.
 *
 * The log file path is printed by the extension's "Open Log File" command.
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArguments(argv) {
	const options = { file: null, top: 8, json: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--top') options.top = Number(argv[++i]);
		else if (argv[i] === '--json') options.json = true;
		else options.file = argv[i];
	}
	if (options.file === null) {
		throw new Error('Usage: node scripts/analyze-log.mjs <logfile> [--top N] [--json]');
	}
	return options;
}

const options = parseArguments(process.argv.slice(2));

const LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] (.*)$/;
const COMMAND = /^> (\S+) (\S+).*? \((\d+) ms\)$/;
const COMMAND_UNTIMED = /^> (\S+) (\S+)/;
const FALLBACK = /The Rust engine could not answer (\w+) \((.*?)\); falling back to the git CLI\./;
const ERROR = /^ERROR: (.*)$/;
// A P1 trace line (`Trace boot: T0 +0.0ms, T1 +8.3ms, T2 +0.0ms (webview), ...`): the trace
// name, then per mark its name and offset (from the first mark of its own origin) - the offset
// the analyser aggregates into P50/P95.
const TRACE = /^Trace (\S+): (.*)$/;
const TRACE_MARK = /(\S+) \+(\d+(?:\.\d+)?)ms( \(webview\))?/g;

/** The subcommand a logged spawn ran, with option-looking arguments folded away. */
function subcommand(program, first) {
	return first !== undefined && !first.startsWith('-') ? `${program} ${first}` : program;
}

/**
 * The P50 (or P95) of the samples, linear interpolation between the closest ranks - the same
 * estimator test/perf/lib/stats.mjs uses, kept standalone because this script ships alone.
 */
function percentile(samples, p) {
	const sorted = [...samples].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0];
	const index = (p / 100) * (sorted.length - 1);
	const low = Math.floor(index);
	const high = Math.ceil(index);
	if (low === high) return sorted[low];
	return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** One entry per trace name: how often it was recorded, and per mark (per origin) its offsets. */
function traceEntry() {
	return { count: 0, marks: new Map() };
}

/** Round to one decimal (the precision the trace offsets themselves carry). */
const round1 = (value) => Math.round(value * 10) / 10;

const summary = {
	file: null,
	lines: 0,
	firstTimestamp: null,
	lastTimestamp: null,
	spawns: { count: 0, byCommand: new Map(), totalMs: 0, worstLine: null, worstMs: 0, timed: 0 },
	fallbacks: { count: 0, byMethod: new Map() },
	errors: { count: 0, byMessage: new Map() },
	traces: { count: 0, byTrace: new Map() }
};

const lines = fs.readFileSync(options.file, 'utf8').split(/\r?\n/);
summary.file = path.resolve(options.file);

for (const line of lines) {
	const match = LINE.exec(line);
	if (match === null) continue;
	summary.lines += 1;
	if (summary.firstTimestamp === null) summary.firstTimestamp = match[1];
	summary.lastTimestamp = match[1];
	const message = match[2];

	const error = ERROR.exec(message);
	if (error !== null) {
		summary.errors.count += 1;
		summary.errors.byMessage.set(error[1], (summary.errors.byMessage.get(error[1]) ?? 0) + 1);
		continue;
	}

	const fallback = FALLBACK.exec(message);
	if (fallback !== null) {
		summary.fallbacks.count += 1;
		summary.fallbacks.byMethod.set(fallback[1], (summary.fallbacks.byMethod.get(fallback[1]) ?? 0) + 1);
		continue;
	}

	const timed = COMMAND.exec(message);
	if (timed !== null) {
		const key = subcommand(timed[1], timed[2]);
		const ms = Number(timed[3]);
		record(key, ms);
		continue;
	}
	const untimed = COMMAND_UNTIMED.exec(message);
	if (untimed !== null) {
		// Commands logged by older builds carry no duration; they still count.
		record(subcommand(untimed[1], untimed[2]), null);
		continue;
	}

	const traceLine = TRACE.exec(message);
	if (traceLine !== null) {
		summary.traces.count += 1;
		const name = traceLine[1];
		let entry = summary.traces.byTrace.get(name);
		if (entry === undefined) {
			entry = traceEntry();
			summary.traces.byTrace.set(name, entry);
		}
		entry.count += 1;
		for (const markMatch of message.matchAll(TRACE_MARK)) {
			// `host T1` / `webview T4`: origin and mark name, offsets never mixed across clocks.
			const key = `${markMatch[3] !== undefined ? 'webview' : 'host'} ${markMatch[1]}`;
			const samples = entry.marks.get(key) ?? [];
			samples.push(Number(markMatch[2]));
			entry.marks.set(key, samples);
		}
	}
}

function record(key, ms) {
	const spawns = summary.spawns;
	spawns.count += 1;
	let entry = spawns.byCommand.get(key);
	if (entry === undefined) {
		entry = { count: 0, totalMs: 0, worstMs: 0, timed: 0 };
		spawns.byCommand.set(key, entry);
	}
	entry.count += 1;
	if (ms !== null) {
		spawns.totalMs += ms;
		spawns.timed += 1;
		entry.totalMs += ms;
		entry.timed += 1;
		if (ms > entry.worstMs) entry.worstMs = ms;
		if (ms > spawns.worstMs) {
			spawns.worstMs = ms;
			spawns.worstLine = key;
		}
	}
}

if (summary.lines === 0) {
	console.error(`No log lines were recognised in ${options.file}.`);
	console.error('Enable `git-graph-rs.enableLog`, use the extension, then analyse the file it writes.');
	process.exit(1);
}

if (options.json) {
	console.log(JSON.stringify({
		...summary,
		spawns: {
			count: summary.spawns.count,
			totalMs: summary.spawns.totalMs,
			worstMs: summary.spawns.worstMs,
			worstLine: summary.spawns.worstLine,
			byCommand: Object.fromEntries([...summary.spawns.byCommand].map(([key, value]) => [key, value]))
		},
		fallbacks: {
			count: summary.fallbacks.count,
			byMethod: Object.fromEntries(summary.fallbacks.byMethod)
		},
		errors: {
			count: summary.errors.count,
			byMessage: Object.fromEntries(summary.errors.byMessage)
		},
		traces: {
			count: summary.traces.count,
			byTrace: Object.fromEntries([...summary.traces.byTrace].map(([name, entry]) => [name, {
				count: entry.count,
				marks: Object.fromEntries([...entry.marks].map(([key, samples]) => [key, {
					n: samples.length,
					p50: round1(percentile(samples, 50)),
					p95: round1(percentile(samples, 95))
				}]))
			}]))
		}
	}, null, 2));
	process.exit(0);
}

const ms = (value) => (value >= 100 ? value.toFixed(0) : value.toFixed(1));

console.log(`Session log: ${summary.file}`);
console.log(`  ${summary.lines} lines, ${summary.firstTimestamp} → ${summary.lastTimestamp}\n`);

console.log(`P1 traces (P50 / P95 of each mark's offset within its trace, ms)`);
if (summary.traces.count === 0) {
	console.log('  none — no trace was recorded (every T0–T5 open below cost nothing to instrument)\n');
} else {
	for (const [name, entry] of summary.traces.byTrace) {
		console.log(`  ${name} (${entry.count} trace${entry.count === 1 ? '' : 's'})`);
		for (const [key, samples] of entry.marks) {
			console.log(`    ${key.padEnd(16)} ${String(samples.length).padStart(4)}×  +${ms(percentile(samples, 50)).padStart(8)} / +${ms(percentile(samples, 95)).padStart(8)}`);
		}
	}
	console.log('');
}

console.log('Git spawns by subcommand');
console.log(`${'command'.padEnd(24)} ${'count'.padStart(6)} ${'total ms'.padStart(10)} ${'avg ms'.padStart(8)} ${'worst ms'.padStart(9)}`);
const spawns = [...summary.spawns.byCommand.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs || b[1].count - a[1].count);
for (const [key, entry] of spawns.slice(0, options.top)) {
	const average = entry.timed > 0 ? entry.totalMs / entry.timed : null;
	console.log(
		`${key.padEnd(24)} ${String(entry.count).padStart(6)} ${ms(entry.totalMs).padStart(10)} ` +
		`${average === null ? '—' : ms(average).padStart(8)} ${ms(entry.worstMs).padStart(9)}`
	);
}
console.log(
	`${'total'.padEnd(24)} ${String(summary.spawns.count).padStart(6)} ${ms(summary.spawns.totalMs).padStart(10)}   ` +
	`(${summary.spawns.timed} timed; the worst single spawn was ${ms(summary.spawns.worstMs)} ms of ${summary.spawns.worstLine ?? '—'})\n`
);

console.log('Engine → CLI fallbacks');
if (summary.fallbacks.count === 0) {
	console.log('  none — every request the session made was answered by the Rust engine\n');
} else {
	for (const [method, count] of [...summary.fallbacks.byMethod].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${method.padEnd(28)} ${count}`);
	}
	console.log(`  total: ${summary.fallbacks.count}\n`);
}

console.log('Errors');
if (summary.errors.count === 0) {
	console.log('  none');
} else {
	for (const [message, count] of [...summary.errors.byMessage].sort((a, b) => b[1] - a[1]).slice(0, options.top)) {
		console.log(`  ${String(count).padStart(5)}× ${message.slice(0, 100)}`);
	}
}
