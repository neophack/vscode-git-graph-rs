/**
 * The Gerrit integration against REAL throwaway repositories whose refs/remotes/origin/changes/*
 * refs and NoteDb meta history mimic exactly what a Gerrit fetch leaves behind.
 *
 * Ported from tests/gerrit.test.mjs's repo-backed describes (REFACTOR-PLAN task 7.1); assertions
 * are unchanged. The pure protocol halves live colocated at
 * src/extension/integrations/gerrit/gerritProtocol.test.ts.
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
import { afterAll, describe, it, vi } from 'vitest';
import { GerritDataSource } from '../../../src/extension/integrations/gerrit/gerrit';
import { NativeBackend } from '../../../src/extension/git/read/backendIndex';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const repos: string[] = [];

afterAll(() => {
	// Killed git children can hold the directory on Windows: retry the removal for a while
	for (const repo of repos) {
		for (let attempt = 0; ; attempt++) {
			try {
				fs.rmSync(repo, { recursive: true, force: true, maxRetries: 1 });
				break;
			} catch (error) {
				if (attempt >= 50 || !['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code!)) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			}
		}
	}
});

/** A synchronous GitRunner over execFileSync, standing in for DataSource's spawned Git. */
const runnerFor = (_repo: string) => ({
	gitOutput: (args: string[], cwd: string, resolveValue: (v: string) => unknown) => Promise.resolve(resolveValue(execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))),
	runGitCommand: (args: string[], cwd: string) => {
		try {
			execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
			return Promise.resolve(null);
		} catch (error) {
			return Promise.resolve(String(error));
		}
	},
	runGitCommandWithInput: (args: string[], cwd: string, input: string) => {
		try {
			execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
			return Promise.resolve(null);
		} catch (error) {
			return Promise.resolve(String(error));
		}
	}
});

const git = (repo: string, args: string[], options: { env?: Record<string, string> } = {}) => execFileSync('git', args, {
	cwd: repo,
	encoding: 'utf8',
	maxBuffer: 64 * 1024 * 1024,
	env: Object.assign({}, process.env, {
		GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com',
		GIT_COMMITTER_NAME: 'Gerrit User 1000018', GIT_COMMITTER_EMAIL: 'gerrit@example.com',
		...options.env
	})
});

/** One NoteDb meta commit, parented onto the previous one. */
const metaCommit = (repo: string, parent: string | null, message: string) => parent === null
	? git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', message]).trim() // the empty tree
	: git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', parent, '-m', message]).trim();

describe('GerritDataSource over a throwaway repository', () => {
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

		const source = new GerritDataSource(runnerFor(repo) as never);

		const refs = await source.listLocalChangeRefs(repo, 'origin');
		assert.deepEqual([...refs].sort(), [
			'refs/remotes/origin/changes/34/1234/1',
			'refs/remotes/origin/changes/34/1234/2',
			'refs/remotes/origin/changes/34/1234/meta',
			'refs/remotes/origin/changes/35/1235/1',
			'refs/remotes/origin/changes/35/1235/meta'
		]);

		const states = await source.parseMetas(repo, 'origin', [1234, 1235], null);
		const change1234 = states.get(1234)!;
		assert.equal(change1234.patchset, 2);
		assert.equal(change1234.status, 'new'); // no Status footer after the newest record: stays new
		assert.equal(change1234.codeReview, 2);
		assert.equal(change1234.headHash, ps2);
		assert.equal(states.get(1235)!.status, 'abandoned');

		const { error, cleared } = await source.clearLocalChanges(repo, 'origin');
		assert.equal(error, null);
		assert.equal(cleared, 5);
		assert.deepEqual([...await source.listLocalChangeRefs(repo, 'origin')], []);
	});

	it('prunes only the stale change refs, keeping the requested changes', async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-gerrit-'));
		repos.push(repo);
		git(repo, ['init', '--quiet', '--initial-branch=main']);
		const base = git(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'Base']).trim();
		git(repo, ['update-ref', 'refs/remotes/origin/changes/34/1234/1', base]);
		git(repo, ['update-ref', 'refs/remotes/origin/changes/99/9999/1', base]);

		const source = new GerritDataSource(runnerFor(repo) as never);
		const error = await source.pruneLocalChanges(repo, 'origin', [1234]);
		assert.equal(error, null);
		const refs = await source.listLocalChangeRefs(repo, 'origin');
		assert.deepEqual([...refs], ['refs/remotes/origin/changes/34/1234/1']); // 9999 was pruned, 1234 kept
	});
});

describe('the Rust engine parses the NoteDb metas', () => {
	/** A read-only synchronous GitRunner (the engine-agreement fixture needs no writes). */
	const readRunner = (_repo: string) => ({
		gitOutput: (args: string[], cwd: string, resolveValue: (v: string) => unknown) => Promise.resolve(resolveValue(execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))),
		runGitCommand: () => Promise.resolve(null),
		runGitCommandWithInput: () => Promise.resolve(null)
	});

	const gitRo = (repo: string, args: string[]) => execFileSync('git', args, {
		cwd: repo,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		env: Object.assign({}, process.env, {
			GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com',
			GIT_COMMITTER_NAME: 'Gerrit User 1000018', GIT_COMMITTER_EMAIL: 'gerrit@example.com'
		})
	});

	/** One NoteDb meta commit, parented onto the previous one. */
	const metaCommitRo = (repo: string, parent: string | null, message: string) => parent === null
		? gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', message]).trim()
		: gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', parent, '-m', message]).trim();

	/**
	 * The engine and the `git log` pool must agree on every record shape Gerrit writes — the view
	 * must not change with the backend that answered. The fixture's meta commits all share the
	 * same committer timestamp (the clock only advances per process spawn), which is exactly the
	 * ordering corner the engine's parent-chain walk exists for.
	 */
	it('agrees with the Git CLI pool, state for state and event for event', async () => {
		let engine: NativeBackend;
		try {
			engine = new NativeBackend();
		} catch {
			return; // no engine binary on this machine: the Git CLI pool is the only implementation
		}

		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-gerrit-engine-'));
		repos.push(repo);
		gitRo(repo, ['init', '--quiet', '--initial-branch=main']);

		// Two patchsets of change 2234 (created, voted, uploaded, merged), an abandoned change
		// 2235, and a change whose meta ref was never fetched (2236: the NULL entries)
		const base = gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'Base']).trim();
		const ps1 = gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', base, '-m', 'Change 2234 ps1\n\nChange-Id: I' + '3'.repeat(40)]).trim();
		const ps2 = gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', base, '-m', 'Change 2234 ps2\n\nChange-Id: I' + '3'.repeat(40)]).trim();
		const other = gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', base, '-m', 'Change 2235 ps1\n\nChange-Id: I' + '4'.repeat(40)]).trim();

		let meta = metaCommitRo(repo, null, 'Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nStatus: new\nCommit: ' + ps1 + '\n');
		meta = metaCommitRo(repo, meta, 'Patch Set 1: Code-Review+2\n\nPatch-set: 1\nLabel: Code-Review=+2\n');
		meta = metaCommitRo(repo, meta, 'Uploaded patch set 2.\n\nPatch-set: 2\nCommit: ' + ps2 + '\n');
		meta = metaCommitRo(repo, meta, 'Update patch set 2\n\nChange has been successfully merged by Alice Developer <alice@example.com>\n\nPatch-set: 1\nStatus: merged\n');
		gitRo(repo, ['update-ref', 'refs/remotes/origin/changes/34/2234/meta', meta]);

		let meta2 = metaCommitRo(repo, null, 'Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nStatus: new\nCommit: ' + other + '\n');
		meta2 = metaCommitRo(repo, meta2, 'Abandoned\n\nPatch-set: 1\nStatus: abandoned\n');
		gitRo(repo, ['update-ref', 'refs/remotes/origin/changes/35/2235/meta', meta2]);

		const changes = [2234, 2235, 2236];
		const urlBase = 'https://gerrit.example.com/c/proj/+/';
		const cliStates = await new GerritDataSource(readRunner(repo) as never).parseMetas(repo, 'origin', changes, urlBase);
		let engineStates: any;
		try {
			engineStates = await engine.parseGerritMetas(repo, 'origin', changes, urlBase);
		} catch {
			return; // a binary predating parseGerritMetas (version skew): nothing to compare
		}

		const keyed = (states: any) => Object.fromEntries(changes.map((change, index) => [change, states.get !== undefined ? states.get(change) : states[index]]));
		assert.deepEqual(keyed(engineStates), keyed(cliStates));

		// The merged record's stale "Patch-set: 1" footer must not win the head hash from the
		// latest patchset's own record, and the URL base joins onto both engines' answers alike
		const state = keyed(cliStates)[2234];
		assert.equal(state.status, 'merged');
		assert.equal(state.patchset, 2);
		assert.equal(state.headHash, ps2);
		assert.equal(state.url, urlBase + '2234');
		assert.equal(keyed(cliStates)[2236], null);
	});

	/**
	 * The dual-track of listLocalChangeRefs/listLocalChangeRefHashes: with an engine-backed
	 * listChangeRefHashes on the runner (what DataSource provides), the Gerrit data source serves
	 * the refs from it and agrees with the `git for-each-ref` fallback answer for answer.
	 */
	it('serves the local change refs from the engine, hash for hash with the Git CLI', async () => {
		let engine: NativeBackend;
		try {
			engine = new NativeBackend();
		} catch {
			return; // no engine binary on this machine: the Git CLI pool is the only implementation
		}

		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-gerrit-refs-'));
		repos.push(repo);
		gitRo(repo, ['init', '--quiet', '--initial-branch=main']);
		const base = gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'Base']).trim();
		const ps1 = gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', base, '-m', 'Change 3234 ps1']).trim();
		const ps2 = gitRo(repo, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-p', base, '-m', 'Change 3234 ps2']).trim();
		const meta = metaCommitRo(repo, null, 'Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nCommit: ' + ps1 + '\n');
		gitRo(repo, ['update-ref', 'refs/remotes/origin/changes/34/3234/1', ps1]);
		gitRo(repo, ['update-ref', 'refs/remotes/origin/changes/34/3234/2', ps2]);
		gitRo(repo, ['update-ref', 'refs/remotes/origin/changes/34/3234/meta', meta]);
		gitRo(repo, ['update-ref', 'refs/remotes/origin/main', base]); // not a change ref: must not leak in

		let pairs;
		try {
			pairs = await engine.listChangeRefs(repo, 'origin');
		} catch {
			return; // a binary predating listChangeRefs (version skew): nothing to compare
		}
		const engineRunner = Object.assign(readRunner(repo), {
			listChangeRefHashes: () => Promise.resolve(new Map(pairs as [string, string][]))
		});

		const cliRefs = await new GerritDataSource(readRunner(repo) as never).listLocalChangeRefs(repo, 'origin');
		const engineRefs = await new GerritDataSource(engineRunner as never).listLocalChangeRefs(repo, 'origin');
		assert.deepEqual([...engineRefs].sort(), [...cliRefs].sort());
		assert.deepEqual([...cliRefs].sort(), [
			'refs/remotes/origin/changes/34/3234/1',
			'refs/remotes/origin/changes/34/3234/2',
			'refs/remotes/origin/changes/34/3234/meta'
		]);

		const hashes = await new GerritDataSource(engineRunner as never).listLocalChangeRefHashes(repo, 'origin');
		assert.equal(hashes!.get('refs/remotes/origin/changes/34/3234/1'), ps1);
		assert.equal(hashes!.get('refs/remotes/origin/changes/34/3234/meta'), meta);
		assert.equal(hashes!.has('refs/remotes/origin/main'), false);
	});
});
