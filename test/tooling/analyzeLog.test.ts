/**
 * Tests for the session-log analyser (scripts/analyze-log.mjs): the tool a performance
 * investigation actually uses, so it is tested like code - a synthetic session log with known
 * contents must produce the expected summary.
 *
 * Ported from the session-log analyser describe of tests/tooling.test.mjs (REFACTOR-PLAN task
 * 7.1); assertions are unchanged. The former "source packager" describe tested
 * scripts/package-src.js, deleted with the out/ pipeline; the benchmark runner and the
 * shipped-backend comparison moved out of the legacy tree earlier (task 3.6/P2):
 * scripts/bench.mjs is superseded by test/perf/p2-host.mjs, and the engine-vs-CLI parity
 * question is owned by the reader contract suite plus the Rust git_parity tests.
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
			'[2026-08-23 10:00:05.000] a line that is neither a command nor an error'
		];
		fs.writeFileSync(logFile, lines.join('\n') + '\n');
	});

	afterAll(() => {
		fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
	});

	it('summarises spawns, fallbacks and errors', () => {
		const summary = JSON.parse(runNode('analyze-log.mjs', [logFile, '--json']));

		assert.equal(summary.lines, 9);
		assert.equal(summary.firstTimestamp, '2026-08-23 10:00:00.000');
		assert.equal(summary.lastTimestamp, '2026-08-23 10:00:05.000');

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
	});

	it('prints a human-readable report', () => {
		const report = runNode('analyze-log.mjs', [logFile]);
		assert.match(report, /Git spawns by subcommand/);
		assert.match(report, /git rev-list/);
		assert.match(report, /Engine → CLI fallbacks/);
		assert.match(report, /countCommitsBefore\s+2/);
		assert.match(report, /Errors/);
	});
});
