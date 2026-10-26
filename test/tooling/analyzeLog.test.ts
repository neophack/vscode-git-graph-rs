/**
 * Tests for the session-log analyser (scripts/analyze-log.mjs): the tool a performance
 * investigation actually uses, so it is tested like code - a synthetic session log with known
 * contents must produce the expected summary.
 *
 * Ported from the session-log analyser describe of tests/tooling.test.mjs (REFACTOR-PLAN task
 * 7.1). The former "source packager" describe tested scripts/package-src.js, deleted with the
 * out/ pipeline; the benchmark runner and the shipped-backend comparison moved out of the
 * legacy tree earlier (task 3.6/P2): scripts/bench.mjs is superseded by test/perf/p2-host.mjs,
 * and the engine-vs-CLI parity question is owned by the reader contract suite plus the Rust
 * git_parity tests.
 *
 * Extended by P1 (OPTIMIZATION-PLAN §7 P1): the analyser also aggregates the trace lines the
 * instrumentation writes (src/shared/perf/trace.ts) into per-mark P50/P95, asserted here
 * against a synthetic log with known offsets.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runNode(script: string, args: string[]) {
	return execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
	});
}

describe('the session-log analyser', () => {
	let logFile: string;

	beforeAll(() => {
		logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-log-')), 'session.log');
		const lines = [
			'[2026-08-23 10:00:00.000] > git log --format=... -z (42 ms)',
			'[2026-08-23 10:00:00.100] > git config -l -z (8 ms)',
			'[2026-08-23 10:00:00.200] > git config -l -z (11 ms)',
			'[2026-08-23 10:00:01.000] The Rust engine could not answer countCommitsBefore (Unsupported: Custom branch glob patterns are not resolved by the engine); falling back to the git CLI.',
			'[2026-08-23 10:00:01.100] > git rev-list --count --glob=refs/heads/** ^abc (25 ms)',
			'[2026-08-23 10:00:02.000] The Rust engine could not answer countCommitsBefore (Unsupported: Commits mentioned by reflogs are not counted by the engine); falling back to the git CLI.',
			'[2026-08-23 10:00:03.000] ERROR: Something went wrong',
			'[2026-08-23 10:00:04.000] ERROR: Something went wrong',
			'[2026-08-23 10:00:05.000] a line that is neither a command nor an error',
			// Three P1 boot traces with known offsets (host marks and webview marks live on
			// different clocks; the analyser never mixes their offsets).
			'[2026-08-23 10:00:06.000] Trace boot: T0 +0.0ms, T1 +10.0ms, T3 +30.0ms, T2 +0.0ms (webview), T4 +100.0ms (webview), T5 +150.0ms (webview)',
			'[2026-08-23 10:00:07.000] Trace boot: T0 +0.0ms, T1 +20.0ms, T3 +40.0ms, T2 +0.0ms (webview), T4 +110.0ms (webview), T5 +160.0ms (webview)',
			'[2026-08-23 10:00:08.000] Trace boot: T0 +0.0ms, T1 +30.0ms, T3 +50.0ms, T2 +0.0ms (webview), T4 +120.0ms (webview), T5 +170.0ms (webview)'
		];
		fs.writeFileSync(logFile, lines.join('\n') + '\n');
	});

	afterAll(() => {
		fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
	});

	it('summarises spawns, fallbacks, errors and traces', () => {
		const summary = JSON.parse(runNode('analyze-log.mjs', [logFile, '--json']));

		assert.equal(summary.lines, 12);
		assert.equal(summary.firstTimestamp, '2026-08-23 10:00:00.000');
		assert.equal(summary.lastTimestamp, '2026-08-23 10:00:08.000');

		assert.equal(summary.spawns.count, 4);
		assert.equal(summary.spawns.totalMs, 86);
		assert.equal(summary.spawns.worstMs, 42);
		assert.equal(summary.spawns.worstLine, 'git log');
		assert.equal(summary.spawns.byCommand['git config'].count, 2);
		assert.equal(summary.spawns.byCommand['git config'].totalMs, 19);
		assert.equal(summary.spawns.byCommand['git rev-list'].worstMs, 25);
		assert.equal(summary.spawns.byCommand['git log'].count, 1);

		assert.equal(summary.fallbacks.count, 2);
		assert.deepEqual(summary.fallbacks.byMethod, { countCommitsBefore: 2 });

		assert.equal(summary.errors.count, 2);
		assert.deepEqual(summary.errors.byMessage, { 'Something went wrong': 2 });

		// The P1 traces: per mark (per origin), the P50/P95 of its offset within the trace -
		// T1's offsets [10, 20, 30] give P50 20 and P95 29 (linear interpolation), and the
		// webview's offsets never mix with the host's.
		assert.equal(summary.traces.count, 3);
		assert.deepEqual(summary.traces.byTrace.boot.marks, {
			'host T0': { n: 3, p50: 0, p95: 0 },
			'host T1': { n: 3, p50: 20, p95: 29 },
			'host T3': { n: 3, p50: 40, p95: 49 },
			'webview T2': { n: 3, p50: 0, p95: 0 },
			'webview T4': { n: 3, p50: 110, p95: 119 },
			'webview T5': { n: 3, p50: 160, p95: 169 }
		});
	});

	it('prints a human-readable report', () => {
		const report = runNode('analyze-log.mjs', [logFile]);
		assert.match(report, /Git spawns by subcommand/);
		assert.match(report, /git rev-list/);
		assert.match(report, /Engine → CLI fallbacks/);
		assert.match(report, /countCommitsBefore\s+2/);
		assert.match(report, /Errors/);
		assert.match(report, /\(4 timed;/);

		assert.match(report, /P1 traces/);
		assert.match(report, /boot \(3 traces\)/);
				assert.match(report, /host T1\s+3×\s+\+\s*20\.0 \/ \+\s*29\.0/);
		assert.match(report, /webview T4\s+3×\s+\+\s*110 \/ \+\s*119/);
	});
});
