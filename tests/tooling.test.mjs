/**
 * Tests for the tooling around the extension: the session-log analyser and the benchmark runner.
 *
 * These are the tools a performance investigation actually uses, so they are tested like code:
 * a synthetic session log with known contents must produce the expected summary, and the bench
 * must run to completion against a small real repository in both of its modes.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(script, args) {
	return execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
	});
}

describe('the session-log analyser', () => {
	let logFile;

	before(() => {
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

	after(() => {
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

describe('the i18n parity checker', () => {
	/** Run the checker in a working directory of its own (it reads web/strings.ts and src/i18n.ts from cwd). */
	function runChecker(cwd) {
		return spawnSync(process.execPath, [path.join(root, 'scripts', 'check-i18n-parity.cjs')], {
			encoding: 'utf8', cwd: cwd
		});
	}

	it('accepts the shipped dictionaries', () => {
		const result = runChecker(root);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /web: \d+ EN keys, \d+ ZH keys, 0 problems/);
		assert.match(result.stdout, /src: \d+ EN keys, \d+ ZH keys, 0 problems/);
	});

	it('reports missing keys and placeholder mismatches, and fails the build for them', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-parity-'));
		try {
			// Entries are tab-indented single-quoted lines, the only shape the extractor reads.
			fs.mkdirSync(path.join(dir, 'web'));
			fs.mkdirSync(path.join(dir, 'src'));
			fs.writeFileSync(path.join(dir, 'web', 'strings.ts'), [
				'const STRINGS_EN = {',
				"\taa: 'x {0} {1}',",
				"\tbb: 'y'",
				'};',
				'type WebviewStrings = typeof STRINGS_EN;',
				'const STRINGS_ZH_CN = {',
				"\taa: 'x {0}',",
				"\tcc: 'z'",
				'};',
				'// The currently active string dictionary',
				'let strings = STRINGS_EN;'
			].join('\n'));
			fs.writeFileSync(path.join(dir, 'src', 'i18n.ts'), [
				'const EN = {',
				"\tone: 'a {0}'",
				'};',
				'type MessageKey = keyof typeof EN;',
				'const ZH_CN = {',
				"\tone: 'b {0}'",
				'};',
				'// Is the interface language',
				'export function isZhCn() { return false; }'
			].join('\n'));

			const result = runChecker(dir);
			assert.equal(result.status, 1, 'a parity violation must fail the check');
			assert.match(result.stdout, /web MISSING ZH key: bb/);
			assert.match(result.stdout, /web MISSING EN key: cc/);
			assert.match(result.stdout, /web PLACEHOLDER MISMATCH aa EN:\[\{0\},\{1\}\] ZH:\[\{0\}\]/);
			assert.match(result.stdout, /web: 2 EN keys, 2 ZH keys, 3 problems/);
			assert.match(result.stdout, /src: 1 EN keys, 1 ZH keys, 0 problems/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the benchmark runner', () => {
	let repoPath;
	let clock = 1_700_000_000;

	function git(args) {
		return execFileSync('git', args, {
			cwd: repoPath,
			encoding: 'utf8',
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: '1',
				HOME: repoPath,
				GIT_AUTHOR_DATE: `${clock} +0000`,
				GIT_COMMITTER_DATE: `${clock} +0000`
			}
		});
	}

	function commit(message) {
		clock += 60;
		fs.writeFileSync(path.join(repoPath, 'file.txt'), `${message}\n`);
		git(['add', '-A']);
		git(['commit', '--quiet', '--allow-empty', '-m', message]);
	}

	before(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-bench-'));
		git(['init', '--quiet', '--initial-branch=main']);
		git(['config', 'user.name', 'Bench User']);
		git(['config', 'user.email', 'bench@example.com']);
		for (let i = 0; i < 5; i++) commit(`commit number ${i}`);
	});

	after(() => {
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('compares the backends on a view load', () => {
		const output = runNode('bench.mjs', [repoPath, '--runs', '1']);
		assert.match(output, /Repository: /);
		assert.match(output, /git-cli .* median .* ms/);
		assert.match(output, /rust .* median .* ms/);
		assert.match(output, /Speedup: \d+\.\d+x/);
	});

	it('times every read operation in --all mode, and can emit JSON', () => {
		const json = JSON.parse(runNode('bench.mjs', [repoPath, '--all', '--runs', '1', '--json']));
		assert.equal(typeof json.repository, 'string');
		assert.ok(Array.isArray(json.results) && json.results.length >= 18, `expected every operation to be timed, got ${json.results?.length}`);
		for (const row of json.results) {
			assert.ok(row['git-cli'] !== undefined && row.rust !== undefined, `missing a backend column for ${row.operation}`);
			// An operation may legitimately fail on a repository without the object it needs
			// (no annotated tag, no README), but the tooling itself must never blow up.
			assert.ok(row.rust.error !== undefined || typeof row.rust.median === 'number', `${row.operation} has no measurement`);
		}
	});

	it('prints the per-operation table', () => {
		const output = runNode('bench.mjs', [repoPath, '--all', '--runs', '1']);
		assert.match(output, /operation\s+git-cli\s+engine\s+speedup/);
		assert.match(output, /getCommitDetails/);
		assert.match(output, /searchHistory/);
	});
});
