/**
 * The Gerrit integration: the pure parsing/filtering logic of src/gerrit.ts, and its
 * GitRunner-backed reads against a throwaway repository whose refs/remotes/origin/changes/*
 * refs and NoteDb meta history mimic exactly what a Gerrit fetch leaves behind.
 *
 * The meta history is built with git commit-tree plumbing (the same record shape Gerrit's NoteDb
 * writes: "Create change" / "Uploaded patch set N" subjects with Patch-set, Status, Commit and
 * Label footers), so parseMetas runs the real `git log --format=%cN%x1f%ct%x1f%B%x1e` pipeline
 * over it, and clearLocalChanges runs the real batched update-ref deletion.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The stand-in for the extension host (src/gerrit.ts only transitively requires 'vscode'). */
const settings = { interfaceLanguage: 'en' };
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	workspace: {
		getConfiguration: () => ({
			get: (section, defaultValue) => section in settings ? settings[section] : defaultValue,
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

const {
	parseChangeRef, changeShard, parseLsRemoteChanges, limitChanges, buildFetchRefspecs, buildKeepPatterns,
	parseMetaCommit, parseMetaHistory, filterChangeStates, GerritDataSource
} = await import('../out/gerrit.js');

describe('change ref parsing', () => {
	it('parses remote change refs and NoteDb meta refs', () => {
		assert.deepEqual(parseChangeRef('refs/changes/24/41466/1'), { change: 41466, patchset: 1, meta: false });
		assert.deepEqual(parseChangeRef('refs/remotes/origin/changes/66/41466/2'), { change: 41466, patchset: 2, meta: false });
		assert.deepEqual(parseChangeRef('refs/remotes/origin/changes/66/41466/meta'), { change: 41466, meta: true });
	});

	it('rejects non-change refs', () => {
		assert.equal(parseChangeRef('refs/heads/main'), null);
		assert.equal(parseChangeRef('refs/tags/v1.0'), null);
		assert.equal(parseChangeRef('refs/remotes/origin/master'), null);
	});

	it('shards change numbers to two digits', () => {
		assert.equal(changeShard(41466), '66');
		assert.equal(changeShard(5), '05');
		assert.equal(changeShard(100), '00');
	});
});

describe('ls-remote output parsing', () => {
	it('collects and sorts the patchsets of each change, skipping meta refs', () => {
		const changes = parseLsRemoteChanges([
			'c1\trefs/changes/34/1234/2',
			'c2\trefs/changes/34/1234/1',
			'c3\trefs/changes/34/1234/meta',
			'c4\trefs/changes/34/1234/1', // duplicate patchset
			'c5\trefs/changes/35/1235/1'
		].join('\n'));
		assert.deepEqual([...changes.entries()], [[1234, [1, 2]], [1235, [1]]]);
	});

	it('keeps only the most recent changes up to the limit', () => {
		const changes = new Map([[1, [1]], [5, [1, 2]], [9, [1]], [3, [1]]]);
		assert.deepEqual([...limitChanges(changes, 2).keys()], [9, 5]);
		assert.equal(limitChanges(changes, 0), changes); // <= 0 => keep all
	});
});

describe('fetch refspecs', () => {
	it('fetch the latest patchset and the meta ref per change', () => {
		assert.deepEqual(buildFetchRefspecs(new Map([[1234, [1, 2]]]), 'origin', 'latest'), [
			'+refs/changes/34/1234/2:refs/remotes/origin/changes/34/1234/2',
			'+refs/changes/34/1234/meta:refs/remotes/origin/changes/34/1234/meta'
		]);
	});

	it('fetch every patchset in the all mode', () => {
		assert.deepEqual(buildFetchRefspecs(new Map([[5, [1, 2]]]), 'origin', 'all'), [
			'+refs/changes/05/5/1:refs/remotes/origin/changes/05/5/1',
			'+refs/changes/05/5/2:refs/remotes/origin/changes/05/5/2',
			'+refs/changes/05/5/meta:refs/remotes/origin/changes/05/5/meta'
		]);
	});

	it('computes the local keep prefixes of a set of changes', () => {
		assert.deepEqual(buildKeepPatterns([41466, 5], 'origin'), [
			'refs/remotes/origin/changes/66/41466/',
			'refs/remotes/origin/changes/05/5/'
		]);
	});
});

describe('NoteDb meta commit parsing', () => {
	const record = (message, committer = 'Gerrit User 1000018', timestamp = 1700000000) => ({ committer, timestamp, message });

	it('recognises the create change event', () => {
		const parsed = parseMetaCommit(record('Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\n'));
		assert.equal(parsed.event.type, 'created');
		assert.equal(parsed.patchset, 1);
	});

	it('collects Label footers into votes', () => {
		const parsed = parseMetaCommit(record('Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\n'));
		assert.equal(parsed.event.type, 'vote');
		assert.deepEqual(parsed.event.labels, [{ name: 'Code-Review', value: 2 }]);
	});

	it('resolves the submitter of a merge from the body', () => {
		const parsed = parseMetaCommit(record('Update patch set 3\n\nChange has been successfully merged by Alice Developer <alice@example.com>\n\nPatch-set: 3\nStatus: merged\n'));
		assert.equal(parsed.event.type, 'merged');
		assert.equal(parsed.status, 'merged');
		assert.equal(parsed.event.reviewer, 'Alice Developer');
	});

	it('maps an Abandoned header to the abandoned status', () => {
		const parsed = parseMetaCommit(record('Abandoned\n\nPatch-set: 2\n'));
		assert.equal(parsed.event.type, 'abandoned');
		assert.equal(parsed.status, 'abandoned');
	});

	it('recognises work-in-progress transitions', () => {
		assert.equal(parseMetaCommit(record('Start Work In Progress\n\nPatch-set: 1\n'))?.event.type, 'wip');
		assert.equal(parseMetaCommit(record('Remove WIP\n\nPatch-set: 1\nWork-in-progress: false\n'))?.event.type, 'ready');
	});

	it('rejects records without any patchset reference', () => {
		// No "Patch-set:" footer and no recognised header: the event cannot be anchored to a patchset
		assert.equal(parseMetaCommit(record('Status: new\n')), null);
	});
});

describe('NoteDb meta history parsing', () => {
	it('derives the state from the newest-first records: status, votes, head hash', () => {
		// Newest first, as git log outputs them
		const state = parseMetaHistory(41466, [
			{ committer: 'Gerrit User 1', timestamp: 3, message: 'Update patch set 2\n\nChange has been successfully merged by Bob\n\nPatch-set: 2\nStatus: merged\nCommit: ' + 'b'.repeat(40) + '\n' },
			{ committer: 'Gerrit User 2', timestamp: 2, message: 'Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\nLabel: Verified=+1\n' },
			{ committer: 'Gerrit User 3', timestamp: 1, message: 'Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nStatus: new\nCommit: ' + 'a'.repeat(40) + '\n' }
		]);
		assert.equal(state.change, 41466);
		assert.equal(state.patchset, 2);
		assert.equal(state.status, 'merged'); // the most recent Status footer wins
		assert.equal(state.wip, false);
		assert.equal(state.codeReview, 2); // the strongest vote by absolute value
		assert.equal(state.verified, 1);
		assert.equal(state.headHash, 'b'.repeat(40)); // the Commit of the newest record of the latest patchset
		assert.equal(state.events.length, 3);
	});

	it('keeps a new change new and prefers the strongest vote even when recorded earlier', () => {
		const state = parseMetaHistory(2, [
			{ committer: 'U', timestamp: 3, message: 'Patch Set 2: Code-Review+1\n\nPatch-set: 2\nLabel: Code-Review=+1\nCommit: ' + 'd'.repeat(40) + '\n' },
			{ committer: 'U', timestamp: 2, message: 'Patch Set 1: Code-Review-2\n\nPatch-set: 1\nLabel: Code-Review=-2\n' },
			{ committer: 'U', timestamp: 1, message: 'Create change\n\nPatch-set: 1\n' }
		]);
		assert.equal(state.status, 'new');
		assert.equal(state.codeReview, -2); // |-2| > |+1|
	});

	it('falls back to any Commit footer when the latest patchset has none', () => {
		const state = parseMetaHistory(3, [
			{ committer: 'U', timestamp: 2, message: 'Patch Set 2: Rebase\n\nPatch-set: 2\n' },
			{ committer: 'U', timestamp: 1, message: 'Create change\n\nPatch-set: 1\nCommit: ' + 'c'.repeat(40) + '\n' }
		]);
		assert.equal(state.headHash, 'c'.repeat(40));
	});

	it('returns null when no record carries a commit hash', () => {
		assert.equal(parseMetaHistory(4, [{ committer: 'U', timestamp: 1, message: 'Create change\n\nPatch-set: 1\n' }]), null);
	});
});

describe('status filtering', () => {
	const state = (status, wip = false) => ({ change: 1, patchset: 1, codeReview: 0, verified: 0, status, wip, headHash: 'h', events: [], url: null });
	const filter = { new: true, merged: false, abandoned: false, wip: false };

	it('keeps open changes and drops merged, abandoned and WIP ones by default', () => {
		const kept = filterChangeStates([state('new'), state('merged'), state('abandoned'), state('new', true)], filter);
		assert.deepEqual(kept.map((s) => s.status), ['new']);
	});

	it('shows WIP changes only under the WIP flag, whatever their status', () => {
		const wip = state('new', true);
		assert.equal(filterChangeStates([wip], { ...filter, wip: true }).length, 1);
		assert.equal(filterChangeStates([wip], { ...filter, new: true, wip: false }).length, 0);
	});

	it('shows merged and abandoned changes when their flags are on', () => {
		const kept = filterChangeStates([state('merged'), state('abandoned')], { ...filter, merged: true, abandoned: true });
		assert.deepEqual(kept.map((s) => s.status), ['merged', 'abandoned']);
	});
});

describe('GerritDataSource over a throwaway repository', () => {
	const repos = [];

	/** A synchronous GitRunner over execFileSync, standing in for DataSource's spawned Git. */
	const runnerFor = (repo) => ({
		gitOutput: (args, cwd, resolveValue) => Promise.resolve(resolveValue(execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))),
		runGitCommand: (args, cwd) => {
			try {
				execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
				return Promise.resolve(null);
			} catch (error) {
				return Promise.resolve(String(error));
			}
		},
		runGitCommandWithInput: (args, cwd, input) => {
			try {
				execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
				return Promise.resolve(null);
			} catch (error) {
				return Promise.resolve(String(error));
			}
		}
	});

	const git = (repo, args, options = {}) => execFileSync('git', args, {
		cwd: repo,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		env: Object.assign({}, process.env, {
			GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com',
			GIT_COMMITTER_NAME: 'Gerrit User 1000018', GIT_COMMITTER_EMAIL: 'gerrit@example.com',
			...options.env
		}),
		...options.exec
	});

	/** One NoteDb meta commit, parented onto the previous one. */
	const metaCommit = (repo, parent, message) => parent === null
		? git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', message]).trim() // the empty tree
		: git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', parent, '-m', message]).trim();

	after(() => {
		// Killed git children can hold the directory on Windows: retry the removal for a while
		for (const repo of repos) {
			for (let attempt = 0; ; attempt++) {
				try {
					fs.rmSync(repo, { recursive: true, force: true, maxRetries: 1 });
					break;
				} catch (error) {
					if (attempt >= 50 || !['EBUSY', 'EPERM'].includes(error.code)) throw error;
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
				}
			}
		}
	});

	it('lists the local change refs, parses the meta history and clears the refs', async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-gerrit-'));
		repos.push(repo);
		git(repo, ['init', '--quiet', '--initial-branch=main']);
		git(repo, ['config', 'user.name', 'Dev']);
		git(repo, ['config', 'user.email', 'dev@example.com']);

		// The base commit, two patchsets of change 1234, and a second (abandoned) change 1235
		const base = git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'Base']).trim();
		const ps1 = git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', base, '-m', 'Change 1234 ps1\n\nChange-Id: I' + '1'.repeat(40)]).trim();
		const ps2 = git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', base, '-m', 'Change 1234 ps2\n\nChange-Id: I' + '1'.repeat(40)]).trim();
		const other = git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', base, '-m', 'Change 1235 ps1\n\nChange-Id: I' + '2'.repeat(40)]).trim();
		git(repo, ['update-ref', 'refs/remotes/origin/changes/34/1234/1', ps1]);
		git(repo, ['update-ref', 'refs/remotes/origin/changes/34/1234/2', ps2]);
		git(repo, ['update-ref', 'refs/remotes/origin/changes/35/1235/1', other]);

		// The NoteDb meta history of change 1234 (oldest first, as Gerrit appends)
		let meta = metaCommit(repo, null, 'Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nStatus: new\nCommit: ' + ps1 + '\n');
		meta = metaCommit(repo, meta, 'Patch Set 1: Code-Review+2\n\nPatch-set: 1\nLabel: Code-Review=+2\n');
		meta = metaCommit(repo, meta, 'Uploaded patch set 2.\n\nPatch-set: 2\nCommit: ' + ps2 + '\n');
		git(repo, ['update-ref', 'refs/remotes/origin/changes/34/1234/meta', meta]);

		let meta2 = metaCommit(repo, null, 'Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nStatus: new\nCommit: ' + other + '\n');
		meta2 = metaCommit(repo, meta2, 'Abandoned\n\nPatch-set: 1\nStatus: abandoned\n');
		git(repo, ['update-ref', 'refs/remotes/origin/changes/35/1235/meta', meta2]);

		const source = new GerritDataSource(runnerFor(repo));

		const refs = await source.listLocalChangeRefs(repo, 'origin');
		assert.deepEqual(refs.sort(), [
			'refs/remotes/origin/changes/34/1234/1',
			'refs/remotes/origin/changes/34/1234/2',
			'refs/remotes/origin/changes/34/1234/meta',
			'refs/remotes/origin/changes/35/1235/1',
			'refs/remotes/origin/changes/35/1235/meta'
		]);

		const states = await source.parseMetas(repo, 'origin', [1234, 1235], null);
		const change1234 = states.get(1234);
		assert.equal(change1234.patchset, 2);
		assert.equal(change1234.status, 'new'); // no Status footer after the newest record: stays new
		assert.equal(change1234.codeReview, 2);
		assert.equal(change1234.headHash, ps2);
		assert.equal(states.get(1235).status, 'abandoned');

		const { error, cleared } = await source.clearLocalChanges(repo, 'origin');
		assert.equal(error, null);
		assert.equal(cleared, 5);
		assert.deepEqual(await source.listLocalChangeRefs(repo, 'origin'), []);
	});

	it('prunes only the stale change refs, keeping the requested changes', async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-gerrit-'));
		repos.push(repo);
		git(repo, ['init', '--quiet', '--initial-branch=main']);
		const base = git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'Base']).trim();
		git(repo, ['update-ref', 'refs/remotes/origin/changes/34/1234/1', base]);
		git(repo, ['update-ref', 'refs/remotes/origin/changes/99/9999/1', base]);

		const source = new GerritDataSource(runnerFor(repo));
		const error = await source.pruneLocalChanges(repo, 'origin', [1234]);
		assert.equal(error, null);
		const refs = await source.listLocalChangeRefs(repo, 'origin');
		assert.deepEqual(refs, ['refs/remotes/origin/changes/34/1234/1']); // 9999 was pruned, 1234 kept
	});
});
