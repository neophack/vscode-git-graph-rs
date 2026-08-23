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

/** The subcommand a logged spawn ran, with option-looking arguments folded away. */
function subcommand(program, first) {
	return first !== undefined && !first.startsWith('-') ? `${program} ${first}` : program;
}

const lines = fs.readFileSync(options.file, 'utf8').split(/\r?\n/);

const summary = {
	file: path.resolve(options.file),
	lines: 0,
	firstTimestamp: null,
	lastTimestamp: null,
	spawns: { count: 0, byCommand: new Map(), totalMs: 0, worstLine: null, worstMs: 0 },
	fallbacks: { count: 0, byMethod: new Map() },
	errors: { count: 0, byMessage: new Map() }
};

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
		}
	}, null, 2));
	process.exit(0);
}

const ms = (value) => (value >= 100 ? value.toFixed(0) : value.toFixed(1));

console.log(`Session log: ${summary.file}`);
console.log(`  ${summary.lines} lines, ${summary.firstTimestamp} → ${summary.lastTimestamp}\n`);

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
