/**
 * The P4 collector (OPTIMIZATION-PLAN §7 P2): turns an E2E run's session log into per-scenario
 * trace summaries. The E2E entry writes `perf-windows.json` (the log file's path plus a
 * [startedAt, finishedAt] window per scenario it executed); this script parses the log's
 * `Trace` lines (lib/trace-log.mjs, the grammar scripts/analyze-log.mjs aggregates), attributes
 * every trace to the window that was open when it was logged, and writes:
 *
 *   <out>/traces.json        per-window and overall aggregates (per mark: n / P50 / P95)
 *   <out>/traces.md          the same, human-readable
 *   <perf-out>/e2e-traces.jsonl   one appended line per run — the history P4's nightly reads
 *
 * Best effort by design: a run whose log or windows file is missing reports why on stderr and
 * exits 3, and the LAUNCHER IGNORES the exit code — trace collection must never fail an E2E
 * run. The engine → CLI fallback count rides along, so a calibration run can state which read
 * path its numbers actually exercised.
 *
 *   node test/perf/collect-e2e-traces.mjs --windows <dir>/perf-windows.json --out <dir>
 *       [--perf-out test/perf/results] [--profile <e2e profile dir>] [--log <logfile>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { commitStamp, parseArguments } from './lib/env.mjs';
import { aggregateTraces, attributeToWindows, readTraceLog } from './lib/trace-log.mjs';

function fail(message) {
	process.stderr.write('[collect-traces] ' + message + '\n');
	process.exit(3);
}

const args = parseArguments(process.argv.slice(2));
const windowsFile = args.options.windows;
const outDir = args.options.out;
const perfOutDir = args.options['perf-out'];
if (windowsFile === undefined || outDir === undefined) {
	fail('usage: node test/perf/collect-e2e-traces.mjs --windows <dir>/perf-windows.json --out <dir> [--perf-out <dir>] [--profile <dir>] [--log <file>]');
}

/** The log file: the windows file records it (the entry reads it off the activation probe);
 * the profile dir is the fallback glob when the entry died before it could write the file. */
let logFile = args.options.log ?? null;
let windows = null;
if (fs.existsSync(windowsFile)) {
	try {
		windows = JSON.parse(fs.readFileSync(windowsFile, 'utf8'));
		if (logFile === null && typeof windows.logFile === 'string' && windows.logFile !== '') logFile = windows.logFile;
	} catch (error) {
		fail('the windows file is not valid JSON: ' + windowsFile + ' (' + error.message + ')');
	}
}
if (logFile === null && args.options.profile !== undefined) {
	const storage = path.join(args.options.profile, 'user-data', 'User', 'globalStorage');
	try {
		for (const entry of fs.readdirSync(storage)) {
			const candidate = path.join(storage, entry, 'git-graph-rs.log');
			if (fs.existsSync(candidate)) logFile = candidate;
		}
	} catch { /* the profile is gone — reported below */ }
}
if (logFile === null || !fs.existsSync(logFile)) {
	fail('no session log found (windows file: ' + windowsFile + (fs.existsSync(windowsFile) ? ', logFile: ' + String(logFile) : ' [missing]') + ') — was git-graph-rs.enableLog on?');
}

let parsed;
try {
	parsed = readTraceLog(logFile);
} catch (error) {
	fail('could not read the session log ' + logFile + ': ' + error.message);
}
if (parsed.traces.length === 0) {
	fail('the session log ' + logFile + ' holds no Trace lines — was git-graph-rs.enableLog on for the whole run?');
}

const windowsList = Array.isArray(windows?.windows) ? windows.windows : [];
const overall = aggregateTraces(parsed.traces);
const perWindow = attributeToWindows(parsed.traces, windowsList);

const result = {
	logFile: logFile,
	traces: parsed.traces.length,
	fallbacks: parsed.fallbacks,
	run: windows === null ? null : {
		tier: windows.tier ?? null,
		backend: windows.backend ?? null,
		startedAt: windows.startedAt ?? null,
		finishedAt: windows.finishedAt ?? null,
		logFile: windows.logFile ?? null
	},
	windows: perWindow,
	overall: overall
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'traces.json'), JSON.stringify(result, null, '\t') + '\n');
fs.writeFileSync(path.join(outDir, 'traces.md'), renderMarkdown(result));

// The perf results history: one line per run, the file the nightly's trend read consumes.
if (perfOutDir !== undefined) {
	fs.mkdirSync(perfOutDir, { recursive: true });
	const line = JSON.stringify({
		commit: commitStampSafe(),
		date: new Date().toISOString(),
		tier: windows?.tier ?? null,
		backend: windows?.backend ?? null,
		fallbacks: parsed.fallbacks,
		traces: parsed.traces.length,
		overall: overall
	});
	fs.appendFileSync(path.join(perfOutDir, 'e2e-traces.jsonl'), line + '\n');
}

process.stdout.write('[collect-traces] ' + parsed.traces.length + ' traces (' + parsed.fallbacks + ' engine fallbacks in the log) -> '
	+ path.join(outDir, 'traces.json') + '\n');
process.exit(0);

function commitStampSafe() {
	try {
		return commitStamp();
	} catch {
		return null; // a detached/shallow checkout must not fail the collection
	}
}

function renderMarkdown(result) {
	const lines = [];
	lines.push('# E2E perf traces (P4)');
	lines.push('');
	lines.push('- Log: `' + result.logFile + '` — ' + result.traces + ' traces, ' + result.fallbacks + ' engine→CLI fallbacks');
	if (result.run !== null) {
		lines.push('- Tier: ' + (result.run.tier ?? '?') + ', backend option: ' + (result.run.backend ?? '?'));
	}
	lines.push('');
	const table = (title, aggregate) => {
		lines.push('## ' + title);
		lines.push('');
		lines.push('| trace | n | mark | P50 ms | P95 ms |');
		lines.push('|---|---:|---|---:|---:|');
		for (const [name, entry] of Object.entries(aggregate)) {
			for (const [mark, stats] of Object.entries(entry.marks)) {
				lines.push('| `' + name + '` | ' + entry.count + ' | ' + mark + ' | ' + stats.p50 + ' | ' + stats.p95 + ' |');
			}
		}
		lines.push('');
	};
	table('Overall', result.overall);
	for (const [id, aggregate] of Object.entries(result.windows)) {
		if (Object.keys(aggregate).length > 0) table('Window: ' + id, aggregate);
	}
	lines.push('_Offsets are within one origin (host marks relative to the trace\'s first host mark, webview marks to its');
	lines.push('first webview mark) — host and webview clocks are not synchronised, so host T0→T3 and webview T2→T5 are');
	lines.push('the honest durations; a full T0→T5 needs both halves summed or the P3 gate\'s synchronized measurement._');
	return lines.join('\n') + '\n';
}
