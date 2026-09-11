/**
 * `DataSource.getReflog` backs the Reflog Widget: `git reflog show --format=... --date=unix`,
 * with the selector rebuilt from each entry's position in the page (not trusted from `%gd`, which
 * switches to a date-based form once `--date` is given - see the comment in dataSource.ts) and
 * dangling (unreachable-from-anywhere) commits flagged via a `git cat-file --batch-check` batch.
 * These tests drive it against a REAL repository, including a real `reset --hard` that strands a
 * commit, since dangling detection is the one property that can't be trusted from a synthetic
 * fixture - it has to agree with what Git itself still considers reachable.
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

describe('getReflog', () => {
	let dataSource;
	let repoPath;

	function git(args) {
		return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' });
	}

	function commit(message) {
		fs.writeFileSync(path.join(repoPath, 'file.txt'), message);
		git(['add', 'file.txt']);
		git(['commit', '-m', message]);
	}

	before(() => {
		dataSource = makeDataSource();
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-reflog-'));
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'user.name', 'Test']);
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('lists reflog entries newest-first, with index-based selectors and readable messages', async () => {
		commit('first');
		commit('second');
		commit('third');

		const { entries, moreAvailable, error } = await dataSource.getReflog(repoPath, 'HEAD', 200);
		assert.equal(error, null);
		assert.equal(moreAvailable, false);
		assert.ok(entries.length >= 3, `expected at least 3 entries, got ${entries.length}`);

		// Newest first: the most recent commit is entry 0.
		assert.equal(entries[0].selector, 'HEAD@{0}');
		assert.match(entries[0].message, /^commit:/);
		assert.equal(entries[1].selector, 'HEAD@{1}');
		assert.equal(entries[2].selector, 'HEAD@{2}');

		const thirdHash = git(['rev-parse', 'HEAD']).trim();
		assert.equal(entries[0].hash, thirdHash);
		assert.equal(entries[0].abbrevHash, thirdHash.substring(0, 7));

		// A fresh, still-reachable history: nothing should be flagged dangling.
		for (const entry of entries) {
			assert.equal(entry.dangling, false, `entry "${entry.message}" should not be dangling yet`);
		}
	});

	it('never flags an entry dangling merely for being unreachable from a branch (reset does not delete objects)', async () => {
		// Dangling detection here is a cheap existence check (`git cat-file --batch-check`), not a
		// full reachability walk (see the comment on getReflog: this deliberately avoids walking
		// history for performance). Verified by hand before writing this test: neither a plain
		// `reset --hard` nor a follow-up `git prune --expire=now` makes the stranded object read as
		// "missing" - `git prune` treats "referenced by this ref's own reflog" as a reachability
		// root just like a branch, so the object stays present. `git reflog show` itself goes
		// further: an entry whose object cannot be resolved is silently dropped from its own
		// output rather than surfaced with a broken hash (confirmed by manually deleting a loose
		// object and observing it vanish from `git reflog show`'s output entirely) - so in
		// practice, by the time getReflog's own `git reflog show` call has produced a list of
		// entries at all, every hash in it necessarily still resolves, and `dangling: true` is a
		// defensive branch for a same-process TOCTOU race against an external prune between that
		// call and the follow-up `cat-file --batch-check`, not something reachable through any
		// sequence of git porcelain commands - hence this test pins the on-the-happy-path
		// guarantee (never a false positive) rather than forcing the unreachable branch.
		const strandedHash = git(['rev-parse', 'HEAD']).trim();
		git(['reset', '--hard', 'HEAD~1']); // "third" is now unreachable from any branch, but still a real object
		git(['prune', '--expire=now']);

		const { entries } = await dataSource.getReflog(repoPath, 'HEAD', 200);
		const strandedEntry = entries.find((e) => e.hash === strandedHash);
		assert.ok(strandedEntry !== undefined, 'the stranded commit is still listed (its object is still present)');
		assert.equal(strandedEntry.dangling, false, 'merely unreachable-from-a-branch is not the same as "missing" - must not false-positive');

		const currentHeadEntry = entries.find((e) => e.hash === git(['rev-parse', 'HEAD']).trim());
		assert.equal(currentHeadEntry.dangling, false);
	});

	it('respects the limit and reports moreAvailable when there are more entries than the page size', async () => {
		const page = await dataSource.getReflog(repoPath, 'HEAD', 2);
		assert.equal(page.entries.length, 2);
		assert.equal(page.moreAvailable, true);
	});

	it('returns an error (not a throw) for an invalid ref name', async () => {
		const result = await dataSource.getReflog(repoPath, '--upload-pack=evil', 50);
		assert.notEqual(result.error, null);
		assert.deepStrictEqual(result.entries, []);
	});
});
