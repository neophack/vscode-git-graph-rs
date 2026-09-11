/**
 * `DataSource.getAuthorStatistics` (`git shortlog -sne --all --no-merges`) and
 * `getActivityHeatmap` (`git log --all --format=%aI --no-merges`, binned by weekday/hour) back
 * the Statistics Widget. The heatmap binning is deliberately computed from only the Y/M/D/H
 * digits of each commit's ISO-8601 author date - not by parsing the full string (offset
 * included) into a real Date, which would convert to the machine-running-Git-Graph's local time
 * and shift the weekday/hour for an author in a different timezone. These tests pin that
 * specific, easy-to-get-wrong behaviour against real commits with controlled author dates.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	window: {
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined
	},
	workspace: {
		getConfiguration: () => ({
			get: (_section, defaultValue) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const { DataSource } = await import('../out/dataSource.js');

function makeDataSource() {
	return new DataSource(
		{ path: 'git', version: '2.45.0' },
		() => ({ dispose() {} }),
		() => ({ dispose() {} }),
		{ log() {}, logCmd() {} }
	);
}

describe('getAuthorStatistics', () => {
	let dataSource;
	let repoPath;

	function commitAs(name, email, fileContent) {
		fs.writeFileSync(path.join(repoPath, 'file.txt'), fileContent);
		execFileSync('git', ['add', 'file.txt'], { cwd: repoPath });
		execFileSync('git', ['commit', '-m', `by ${name}`, `--author=${name} <${email}>`], { cwd: repoPath, env: { ...process.env, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
	}

	before(() => {
		dataSource = makeDataSource();
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-stats-authors-'));
		execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });

		commitAs('Alice', 'alice@example.com', '1');
		commitAs('Alice', 'alice@example.com', '2');
		commitAs('Bob', 'bob@example.com', '3');
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('counts commits per author, aggregated by Git itself (git shortlog)', async () => {
		const stats = await dataSource.getAuthorStatistics(repoPath);
		const alice = stats.find((s) => s.email === 'alice@example.com');
		const bob = stats.find((s) => s.email === 'bob@example.com');
		assert.ok(alice !== undefined && bob !== undefined);
		assert.equal(alice.name, 'Alice');
		assert.equal(alice.commits, 2);
		assert.equal(bob.name, 'Bob');
		assert.equal(bob.commits, 1);
	});

	it('resolves to an empty array (never throws) for a non-repository path', async () => {
		const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-not-a-repo-'));
		try {
			assert.deepStrictEqual(await dataSource.getAuthorStatistics(notARepo), []);
		} finally {
			fs.rmSync(notARepo, { recursive: true, force: true });
		}
	});
});

describe('getActivityHeatmap', () => {
	let dataSource;
	let repoPath;

	function commitWithAuthorDate(isoDate, fileContent) {
		fs.writeFileSync(path.join(repoPath, 'file.txt'), fileContent);
		execFileSync('git', ['add', 'file.txt'], { cwd: repoPath });
		execFileSync('git', ['commit', '-m', 'dated commit', `--date=${isoDate}`], {
			cwd: repoPath,
			env: { ...process.env, GIT_COMMITTER_DATE: isoDate }
		});
	}

	before(() => {
		dataSource = makeDataSource();
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-stats-heatmap-'));
		execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('bins two commits on the same UTC weekday/hour into one cell with count 2', async () => {
		// 2024-01-01T10:00:00Z was a Monday (weekday 1).
		commitWithAuthorDate('2024-01-01T10:15:00+00:00', 'a');
		commitWithAuthorDate('2024-01-01T10:45:00+00:00', 'b');

		const cells = await dataSource.getActivityHeatmap(repoPath);
		const monday10 = cells.find((c) => c.weekday === 1 && c.hour === 10);
		assert.ok(monday10 !== undefined);
		assert.equal(monday10.count, 2);
	});

	it('bins strictly by the Y/M/D/H digits of the author date, ignoring the UTC offset entirely', async () => {
		// The clock-face hour is 23 and the calendar date is 2024-01-01 (a Monday) in this literal
		// string, even though +05:00 means the *actual* UTC instant is already 2024-01-01T18:30Z -
		// still a Monday, but a different hour (18) if the offset were honoured. The implementation
		// must read the digits as printed, not convert through the offset.
		commitWithAuthorDate('2024-01-01T23:30:00+05:00', 'c');

		const cells = await dataSource.getActivityHeatmap(repoPath);
		const cell = cells.find((c) => c.weekday === 1 && c.hour === 23);
		assert.ok(cell !== undefined, 'expected a Monday/23:00 cell read directly from the ISO string digits');
	});

	it('never emits a zero-count cell (sparse output)', async () => {
		const cells = await dataSource.getActivityHeatmap(repoPath);
		assert.ok(cells.every((c) => c.count > 0));
	});

	it('resolves to an empty array (never throws) for a non-repository path', async () => {
		const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-not-a-repo-'));
		try {
			assert.deepStrictEqual(await dataSource.getActivityHeatmap(notARepo), []);
		} finally {
			fs.rmSync(notARepo, { recursive: true, force: true });
		}
	});
});
