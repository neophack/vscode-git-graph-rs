/**
 * The performance gate runner (REFACTOR-PLAN §6.7 + U9): runs the requested gates, writes the
 * JSON results and a markdown summary, and — the actual GATE — compares the fresh run against
 * a recorded baseline and exits 1 when an item regressed beyond the U9 thresholds:
 *
 *   timing items (P2, P3)   median worse by more than 5%, AND the one-sided Mann-Whitney U
 *                           test confirms the shift is significant (p < 0.05) — a > 5% delta
 *                           that is not significant is machine noise and passes
 *   size items (P5)         median larger by more than 2% (single-sample: no significance
 *                           test possible; the measurement itself is deterministic)
 *   count items             treated like timing (5% + significance); an all-zero baseline
 *                           skips the check (a percentage of zero is meaningless)
 *   absolute budgets        P5's §3.8.1 budgets are recorded on every run and FAIL the gate
 *                           with --enforce-budgets (today's un-split webview exceeds them by
 *                           design — flip the flag on once the §3.8.2 slimming lands)
 *
 * Usage:
 *   node test/perf/run.mjs --gate p2,p3,p5 [--samples 21] [--tier s] [--channel msedge]
 *   node test/perf/run.mjs --record                 # run + write test/perf/results/baseline.json
 *   node test/perf/run.mjs --compare-to <file>      # run + gate against a baseline JSON
 *   node test/perf/run.mjs --compare-to <file> --artifacts-dir <tree>   # P5 over another tree
 *
 * SAME-MACHINE COMPARISON (the only honest timing comparison): always produce the baseline and
 * the candidate in the SAME environment — on a dev machine that means one session back to
 * back; in CI it means one job that checks out and builds base and PR side by side, records
 * the base run, then runs the PR tree against it (see .github/workflows/perf.yml). Numbers
 * recorded on different machines are not comparable: process starts, the disk and the browser
 * differ far more than the regressions the gate is hunting.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitStamp, ensureResultsDir, parseArguments, perfDir, readJson, resultsDir, writeJson } from './lib/env.mjs';
import { mannWhitneyPValueLarger, median } from './lib/stats.mjs';
import { runP2 } from './p2-host.mjs';
import { runP3 } from './p3-webview.mjs';
import { runP5 } from './p5-size.mjs';

/** U9's thresholds. */
const TIME_THRESHOLD = 0.05;
const SIZE_THRESHOLD = 0.02;
const SIGNIFICANCE = 0.05;

export async function main(argv) {
	const args = parseArguments(argv);
	if (args.positional.length > 0) {
		usage('unexpected argument: ' + args.positional[0]);
		return 2;
	}
	const gates = (args.options.gate ?? 'p2,p3,p5').split(',').map((g) => g.trim());
	for (const gate of gates) {
		if (!['p2', 'p3', 'p5'].includes(gate)) {
			usage('unknown gate: ' + gate);
			return 2;
		}
	}
	const samples = Number(args.options.samples ?? 21);
	const tier = args.options.tier ?? 's';
	const options = {
		tier: tier,
		samples: samples,
		channel: args.options.channel,
		workDir: args.options.workDir,
		artifactsDir: args.options['artifacts-dir']
	};
	const baselinePath = args.options['compare-to'] !== undefined ? path.resolve(args.options['compare-to']) : null;
	if (baselinePath !== null && !fs_exists(baselinePath)) {
		console.error('Baseline not found: ' + baselinePath);
		return 2;
	}

	const started = Date.now();
	// One fixture work dir for every gate: ensureFixturePair is idempotent, so P3's data comes
	// from the same deterministic repository P2 measured, generated once.
	const workDir = options.workDir ?? path.join(os.tmpdir(), 'gg-perf-' + tier);
	const runs = [];
	if (gates.includes('p2')) runs.push(await runP2({ ...options, workDir: workDir }));
	if (gates.includes('p3')) runs.push(await runP3({ ...options, workDir: workDir }));
	if (gates.includes('p5')) runs.push(await runP5({ artifactsDir: options.artifactsDir }));

	const host = { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model ?? 'unknown', machine: os.arch() };
	const result = {
		commit: commitStamp(),
		date: new Date().toISOString(),
		host: host,
		tier: tier,
		samples: samples,
		gates: gates,
		runs: runs
	};

	ensureResultsDir();
	writeJson(path.join(resultsDir, 'perf-results.json'), result);
	for (const run of runs) {
		// Also as per-gate files, so a single gate's numbers are easy to attach to an issue.
		writeJson(path.join(resultsDir, run.gate + (run.gate === 'p5' ? '' : '-' + tier) + '.json'), run);
	}

	const comparisons = baselinePath !== null ? compare(result, readJson(baselinePath)) : [];
	const budgetFailures = args.flags.has('enforce-budgets')
		? runs.filter((r) => r.gate === 'p5').flatMap((r) => r.items.filter((i) => i.overBudget === true))
		: [];
	const summary = renderMarkdown(result, baselinePath, comparisons, budgetFailures, args.flags.has('enforce-budgets'));
	writeSummary(summary);

	console.log('\n' + '='.repeat(70));
	console.log(summary);
	const failed = comparisons.filter((c) => c.verdict === 'regression');
	if (failed.length > 0 || budgetFailures.length > 0) {
		console.log('FAILED: ' + failed.length + ' regression(s)' + (budgetFailures.length > 0 ? ', ' + budgetFailures.length + ' budget violation(s)' : ''));
		return 1;
	}
	console.log('PASSED (' + ((Date.now() - started) / 1000).toFixed(0) + 's)' + (baselinePath === null ? ' — no baseline compared (use --compare-to to gate)' : ''));
	if (args.flags.has('record') && baselinePath !== null) {
		console.log('Note: --record and --compare-to in one invocation compared the run against itself; record separately.');
	}
	return 0;
}

/** Compare a fresh result against a baseline: one row per item present in both. */
function compare(result, baseline) {
	const oldItems = new Map();
	for (const run of baseline.runs ?? []) {
		for (const item of run.items) oldItems.set(run.gate + ':' + item.id + ':' + (item.backend ?? ''), item);
	}
	const rows = [];
	for (const run of result.runs) {
		for (const item of run.items) {
			const key = run.gate + ':' + item.id + ':' + (item.backend ?? '');
			const old = oldItems.get(key);
			if (old === undefined) {
				rows.push({ key: key, verdict: 'new', note: 'no baseline entry' });
				continue;
			}
			const oldMedian = old.median;
			const isSize = run.gate === 'p5';
			const delta = oldMedian === 0 ? null : (item.median - oldMedian) / oldMedian;
			const threshold = isSize ? SIZE_THRESHOLD : TIME_THRESHOLD;
			if (delta === null) {
				rows.push({ key: key, verdict: 'ok', note: 'baseline median is 0 — percentage undefined, check the raw numbers' });
				continue;
			}
			let verdict = 'ok';
			let note = '';
			if (item.gating === false) {
				// Informational metrics (the single-sample heap reading): reported, never failing —
				// one GC timing away from a 50% swing that no threshold would survive.
				rows.push({ key: key, verdict: 'info', oldMedian: oldMedian, newMedian: item.median, delta: delta, unit: item.unit, note: 'informational (single sample)' });
				continue;
			}
			if (delta > threshold) {
				if (isSize) {
					verdict = 'regression';
					note = 'size growth ' + (delta * 100).toFixed(1) + '% > ' + (SIZE_THRESHOLD * 100) + '% (U9: justification required)';
				} else if (!Array.isArray(item.samples) || !Array.isArray(old.samples) || item.samples.length < 8 || old.samples.length < 8) {
					// Single-sample metrics (e.g. the heap): no significance test possible.
					verdict = 'regression';
					note = 'median worse by ' + (delta * 100).toFixed(1) + '% (single-sample metric)';
				} else {
					const p = mannWhitneyPValueLarger(old.samples, item.samples);
					if (p < SIGNIFICANCE) {
						// Count metrics with tiny integers (1 vs 2 long tasks) swing 100% on
						// scheduler jitter alone: demand an absolute shift of at least 2 as well.
						if (item.unit === 'count' && Math.abs(item.median - oldMedian) < 2) {
							verdict = 'ok';
							note = 'count moved ' + oldMedian + ' -> ' + item.median + ' (below the +/-2 absolute-count guard)';
						} else {
							verdict = 'regression';
							note = 'median worse by ' + (delta * 100).toFixed(1) + '%, Mann-Whitney p=' + p.toPrecision(2) + ' (significant)';
						}
					} else {
						verdict = 'ok';
						note = 'median worse by ' + (delta * 100).toFixed(1) + '% but NOT significant (p=' + p.toPrecision(2) + ') — machine noise';
					}
				}
			} else if (delta < -threshold) {
				verdict = 'improved';
				note = (delta * 100).toFixed(1) + '% better';
			}
			rows.push({
				key: key, verdict: verdict, oldMedian: oldMedian, newMedian: item.median,
				delta: delta, unit: item.unit,
				p: verdict === 'regression' && !isSize && Array.isArray(item.samples) && Array.isArray(old.samples)
					? mannWhitneyPValueLarger(old.samples, item.samples)
					: undefined,
				note: note
			});
		}
	}
	return rows;
}

/** The markdown summary CI appends to the run and the PR report. */
function renderMarkdown(result, baselinePath, comparisons, budgetFailures, enforceBudgets) {
	const lines = [];
	lines.push('# Performance gate report');
	lines.push('');
	lines.push('- Commit: `' + result.commit + '`');
	lines.push('- Host: ' + result.host.platform + ' ' + result.host.release + ' (' + result.host.cpus + ')');
	lines.push('- Tier: ' + result.tier + ', ' + result.samples + ' samples per item');
	if (baselinePath !== null) lines.push('- Baseline: `' + path.basename(baselinePath) + '`');
	lines.push('');
	for (const run of result.runs) {
		lines.push('## ' + run.gate.toUpperCase() + (run.gate === 'p2' ? ' — host pipeline (' + (run.items[0]?.backend ?? '') + ' items below)' : run.gate === 'p3' ? ' — webview rendering' : ' — artifact size'));
		lines.push('');
		lines.push('| item | backend | median | p95 | unit | vs baseline |');
		lines.push('|---|---|---:|---:|---|---|');
		for (const item of run.items) {
			const key = run.gate + ':' + item.id + ':' + (item.backend ?? '');
			const row = comparisons.find((c) => c.key === key);
			const comparison = row !== undefined && row.delta !== undefined
				? ((row.delta * 100).toFixed(1) + '% ' + (row.verdict === 'regression' ? '**REGRESSED**' : row.verdict === 'improved' ? 'better' : ''))
				: (row?.note ?? '');
			const budget = item.budget !== null && item.budget !== undefined ? ' (budget ' + Math.round(item.budget / 1024) + ' KB' + (item.overBudget ? ', **over**)' : ')') : '';
			lines.push('| `' + item.id + '`' + budget + ' | ' + (item.backend ?? '') + ' | ' + fmt(item.median, item.unit) + ' | ' + fmt(item.p95, item.unit) + ' | ' + item.unit + ' | ' + comparison + ' |');
		}
		lines.push('');
	}
	if (comparisons.some((c) => c.verdict === 'regression')) {
		lines.push('**Regressions (U9)**:');
		for (const row of comparisons.filter((c) => c.verdict === 'regression')) {
			lines.push('- `' + row.key + '`: ' + row.note);
		}
		lines.push('');
	}
	if (budgetFailures.length > 0) {
		lines.push('**Budget violations (§3.8.1)**: ' + budgetFailures.map((i) => '`' + i.id + '`').join(', '));
		lines.push('');
	} else if (enforceBudgets && result.runs.some((r) => r.gate === 'p5')) {
		lines.push('Budget check enforced: no §3.8.1 size budget is exceeded.');
		lines.push('');
	}
	lines.push('_Noise policy: medians over >= 20 samples; a timing regression must exceed +5% AND pass a Mann-Whitney significance test (p < 0.05). Size: +2%. Always compare runs produced on the same machine._');
	return lines.join('\n');
}

function fmt(value, unit) {
	if (unit === 'bytes') return (value / 1024).toFixed(1) + ' KB';
	if (unit === 'MB') return value.toFixed(1) + ' MB';
	return value.toFixed(1);
}

function writeSummary(summary) {
	writeJson(path.join(resultsDir, 'perf-summary.json'), { markdown: summary });
	fs.writeFileSync(path.join(resultsDir, 'perf-summary.md'), summary + '\n');
}

function fs_exists(file) {
	try {
		fs.accessSync(file);
		return true;
	} catch (_) {
		return false;
	}
}

function usage(message) {
	console.error((message !== undefined ? message + '\n' : '') +
		'Usage: node test/perf/run.mjs --gate p2,p3,p5 [--samples 21] [--tier s|m] [--channel msedge|chrome|chromium]\n' +
		'       node test/perf/run.mjs --record [--gate ...]\n' +
		'       node test/perf/run.mjs --compare-to test/perf/results/baseline.json [--gate ...] [--enforce-budgets]');
}

/* --record: write the baseline after a successful run (its own flag handling). */
export async function recordBaseline(result) {
	const baseline = { ...result, recordedAt: new Date().toISOString(), note: 'Recorded with --record; compare against this on the SAME machine only.' };
	writeJson(path.join(resultsDir, 'baseline.json'), baseline);
	console.log('Baseline written: ' + path.join(resultsDir, 'baseline.json') + ' (commit ' + baseline.commit + ')');
}

if (process.argv[1] && process.argv[1].endsWith(path.join('test', 'perf', 'run.mjs'))) {
	const args = parseArguments(process.argv.slice(2));
	const exit = await main(process.argv.slice(2));
	if (exit === 0 && args.flags.has('record') && args.options['compare-to'] === undefined) {
		// Recording re-reads the results main() just wrote (the runner owns the file layout).
		const result = readJson(path.join(resultsDir, 'perf-results.json'));
		await recordBaseline(result);
	}
	process.exit(exit);
}
