/**
 * Randomised differential testing of the two backends.
 *
 * Ported from tests/fuzz.test.mjs (REFACTOR-PLAN task 7.1); assertions are unchanged.
 *
 * The fixed fixtures of the reader contract suite cover the shapes its author thought of; this
 * file builds repositories from a seeded random program of git operations — branches, merges,
 * renames, binary files, odd file names, stashes, a dirty working tree — and asserts that the
 * Rust engine and the git CLI backend answer every read identically. The seeds are fixed, so a
 * failure here reproduces by rerunning the file; the CLI side is the reference implementation.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { CliBackend, NativeBackend } from '../../../src/extension/git/read/backendIndex';
import { isAddonAvailable } from '../../../src/extension/git/read/addonLoader';
import type { LogOptions } from '../../../src/extension/git/read/types';
import { CommitOrdering } from '../../../src/shared/model/webview';

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });

// The fuzz comparison needs the native engine; environments without the prebuilt addon
// (fresh clones before the first addon build) skip the suite - the CLI leg stays covered
// by the reader contract suite, the same gate the vitest side applies.
const engineMissing = !isAddonAvailable();

/* ---------- A seeded PRNG (mulberry32), so every repository is reproducible ---------- */

function makeRng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(rand: () => number, items: T[]): T => items[Math.floor(rand() * items.length)];

/** Remove a throwaway repository, retrying while Windows holds a handle on it (EPERM/EBUSY). */
async function removeRepo(repoPath: string) {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmSync(repoPath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EBUSY') && attempt < 10) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				continue;
			}
			throw error;
		}
	}
}

/* ---------- The random repository generator ---------- */

function buildRandomRepo(seed: number) {
	const rand = makeRng(seed);
	const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `git-graph-rs-fuzz-${seed}-`));
	let clock = 1_700_000_000;

	const git = (args: string[]) =>
		execFileSync('git', args, {
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

	git(['init', '--quiet', '--initial-branch=main']);
	git(['config', 'user.name', 'Fuzz User']);
	git(['config', 'user.email', 'fuzz@example.com']);
	git(['config', 'commit.gpgsign', 'false']);

	// File names that stress the parsers: spaces, unicode, dots, near-duplicates
	const fileNames = ['a.txt', 'b.txt', 'with space.txt', 'ünïcode.txt', 'notes.txt', 'notes.txt.bak', 'src/code.js'];
	const text = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of ${n}\n`).join('');
	const branches = ['main'];
	let fileCounter = 0;

	const write = (file: string, contents: string) => {
		const full = path.join(repoPath, file);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	};

	const commit = (message: string) => {
		clock += Math.floor(rand() * 600);
		git(['add', '-A']);
		if (rand() < 0.2) {
			// A different author than committer: the two identity pairs must survive both parsers
			git(['-c', 'user.name=Second Author', '-c', 'user.email=second@example.com', 'commit', '--quiet', '--allow-empty', '-m', message]);
		} else {
			git(['commit', '--quiet', '--allow-empty', '-m', message]);
		}
		return git(['rev-parse', 'HEAD']).trim();
	};

	const hashes: string[] = [];
	for (let step = 0; step < 34; step++) {
		const action = pick(rand, ['write', 'write', 'write', 'modify', 'delete', 'rename', 'branch', 'checkout', 'merge', 'tag', 'empty', 'binary', 'detach']);
		try {
			if (action === 'write') {
				const name = fileCounter++ % 2 === 0 ? pick(rand, fileNames) : `generated/file${fileCounter}.txt`;
				write(name, text(1 + Math.floor(rand() * 40)));
				hashes.push(commit(`write ${name} (step ${step})`));
			} else if (action === 'modify') {
				const name = pick(rand, fileNames);
				write(name, text(1 + Math.floor(rand() * 40)));
				hashes.push(commit(`modify ${name} (step ${step})`));
			} else if (action === 'delete') {
				const name = pick(rand, fileNames);
				if (fs.existsSync(path.join(repoPath, name))) {
					fs.rmSync(path.join(repoPath, name));
					hashes.push(commit(`delete ${name} (step ${step})`));
				}
			} else if (action === 'rename') {
				const from = pick(rand, fileNames);
				if (fs.existsSync(path.join(repoPath, from))) {
					const to = `renamed/${from}`;
					fs.mkdirSync(path.join(repoPath, 'renamed'), { recursive: true });
					git(['mv', from, to]);
					if (rand() < 0.4) write(to, text(20)); // sometimes rewrites most of it: an add+delete, not a rename
					hashes.push(commit(`rename ${from} (step ${step})`));
				}
			} else if (action === 'branch') {
				const name = rand() < 0.4 ? `feature/dev${branches.length}` : `dev${branches.length}`;
				git(['checkout', '--quiet', '-b', name]);
				branches.push(name);
			} else if (action === 'checkout') {
				git(['checkout', '--quiet', pick(rand, branches)]);
			} else if (action === 'merge' && branches.length > 1) {
				const other = pick(rand, branches);
				const merged = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() !== other;
				clock += 60;
				try {
					git(['merge', '--quiet', '--no-edit', other]);
				} catch {
					// A conflicting merge, resolved by taking whichever side exists: a merge commit
					// with a hand-resolved tree is a shape the fixed fixture never builds
					git(['checkout', '--theirs', '.']);
					git(['add', '-A']);
					git(['commit', '--quiet', '--no-edit']);
				}
				if (merged) hashes.push(git(['rev-parse', 'HEAD']).trim());
			} else if (action === 'detach' && hashes.length > 0) {
				git(['checkout', '--quiet', '--detach', pick(rand, hashes)]);
			} else if (action === 'tag') {
				const style = pick(rand, ['lightweight', 'annotated', 'nested']);
				const name = `v${step}`;
				if (style === 'lightweight') git(['tag', name]);
				else if (style === 'annotated') git(['tag', '-a', name, '-m', `tag ${step}`]);
				else {
					// A tag pointing at a previously created tag: both backends must peel it to a commit
					const previous = git(['tag', '--list']).trim().split('\n').filter((t) => t !== '');
					if (previous.length > 0) git(['tag', '-a', name, '-m', `nested ${step}`, pick(rand, previous)]);
				}
			} else if (action === 'binary') {
				const name = pick(rand, ['blob.bin', 'image.png']);
				write(name, Buffer.from([0, 1, 2, 0, 255, 254, 0, 3]).toString('latin1'));
				hashes.push(commit(`binary ${name} (step ${step})`));
			} else {
				hashes.push(commit(`empty (step ${step})`));
			}
		} catch {
			// An operation the random program happens to make impossible (e.g. merging an
			// ancestor); skip it and carry on — the repository shape stays valid either way.
		}
	}

	// Sometimes a stash (sometimes with untracked files), sometimes a dirty tree, sometimes both
	if (rand() < 0.7) {
		write(pick(rand, fileNames), text(5));
		if (rand() < 0.5) write('stashed-untracked.txt', text(4));
		const stashArgs = ['stash', 'push', '--quiet'];
		if (rand() < 0.5) stashArgs.push('--include-untracked');
		stashArgs.push('-m', 'a fuzz stash');
		execFileSync('git', stashArgs, {
			cwd: repoPath,
			encoding: 'utf8',
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoPath }
		});
	}
	write(pick(rand, fileNames), text(7));
	write('untracked-fuzz.txt', text(3));

	return { repoPath, hashes };
}

/* ---------- The comparisons ---------- */

/** Compare the commits field-by-field, keyed by hash (the two backends may break order ties differently). */
function assertSameCommitsByKey(actual: any[], expected: any[], context: string) {
	assert.equal(actual.length, expected.length, `${context}: different number of commits`);
	const byHash = new Map(expected.map((commit) => [commit.hash, commit]));
	for (const commit of actual) {
		const other = byHash.get(commit.hash);
		assert.ok(other !== undefined, `${context}: commit ${commit.hash} only reported by one backend`);
		assert.deepEqual([...commit.parents], [...other.parents], `${context}: ${commit.hash} parents`);
		assert.equal(commit.author, other.author, `${context}: ${commit.hash} author`);
		assert.equal(commit.email, other.email, `${context}: ${commit.hash} email`);
		assert.equal(commit.message, other.message, `${context}: ${commit.hash} message`);
		assert.deepEqual([...commit.heads].sort(), [...other.heads].sort(), `${context}: ${commit.hash} heads`);
		assert.deepEqual([...commit.tags].map((t) => t.name).sort(), [...other.tags].map((t) => t.name).sort(), `${context}: ${commit.hash} tags`);
		assert.deepEqual([...commit.remotes].map((r) => r.name).sort(), [...other.remotes].map((r) => r.name).sort(), `${context}: ${commit.hash} remotes`);
	}
}

const sortedChanges = (changes: any[]) =>
	[...changes]
		.map((change) => ({ oldFilePath: change.oldFilePath, newFilePath: change.newFilePath, type: change.type, additions: change.additions, deletions: change.deletions }))
		.sort((a, b) => `${a.newFilePath}|${a.oldFilePath}`.localeCompare(`${b.newFilePath}|${b.oldFilePath}`));

describe('the backends agree on randomly generated repositories', () => {
	const seeds = [1, 2, 3, 4, 5, 6];
	for (const seed of seeds) {
		describe.skipIf(engineMissing)(`seed ${seed}`, () => {
			let rust: NativeBackend;
			let cli: CliBackend;
			let root: string;
			let fixture: { repoPath: string, hashes: string[] };
			let repoPath: string;

			beforeAll(async () => {
				fixture = buildRandomRepo(seed);
				repoPath = fixture.repoPath;
				rust = new NativeBackend();
				cli = new CliBackend();
				root = (await rust.openRepository(repoPath)) as never as string;
				await cli.openRepository(repoPath);
			}, 300000);

			afterAll(async () => {
				rust?.closeAllRepositories();
				return repoPath ? removeRepo(repoPath) : undefined;
			}, 300000);

			it('reports the same repository info', async () => {
				const options = { showRemoteBranches: true, showStashes: true };
				const [a, b] = await Promise.all([rust.getRepoInfo(root as never, options), cli.getRepoInfo(root as never, options)]);
				assert.equal(a.error, null);
				assert.equal(b.error, null);
				assert.equal(a.head, b.head);
				assert.deepEqual([...a.branches].sort(), [...b.branches].sort());
				assert.deepEqual([...a.tags].sort(), [...b.tags].sort());
				assert.deepEqual([...a.stashes], [...b.stashes]);
			});

			it('builds the same graph', async () => {
				const options: LogOptions = { maxCommits: 500, showTags: true, showRemoteBranches: true, showUncommittedChanges: true, showUntrackedFiles: true, commitOrdering: CommitOrdering.Date };
				const [a, b] = await Promise.all([rust.getCommits(root as never, options), cli.getCommits(root as never, options)]);
				assert.equal(a.error, null, `the engine failed: ${a.error}`);
				assert.equal(b.error, null, `the CLI failed: ${b.error}`);
				assert.equal(a.head, b.head);
				assertSameCommitsByKey(a.commits as never, b.commits as never, 'getCommits');
			});

			it('builds the same graph in the author-date and topological orderings', async () => {
				for (const commitOrdering of ['author-date', 'topo'] as const) {
					const options = { maxCommits: 500, showTags: true, showRemoteBranches: true, commitOrdering };
					const [a, b] = await Promise.all([rust.getCommits(root as never, options), cli.getCommits(root as never, options)]);
					assert.equal(a.error, null, `${commitOrdering}: the engine failed: ${a.error}`);
					assert.equal(b.error, null, `${commitOrdering}: the CLI failed: ${b.error}`);
					assertSameCommitsByKey(a.commits as never, b.commits as never, commitOrdering);
				}
			});

			it('reports the same details and deferred counts for every second commit', async () => {
				const hashes = fixture.hashes.filter((_, index) => index % 2 === 0);
				for (const hash of hashes) {
					const [a, b] = await Promise.all([rust.getCommitDetails(root as never, hash), cli.getCommitDetails(root as never, hash)]);
					assert.deepEqual(sortedChanges(a.fileChanges as never), sortedChanges(b.fileChanges as never), `details of ${hash}`);

					// The deferred counts of every path the details list (old rename paths included,
					// which must settle nothing), as the view would ask for them
					const paths = (a.fileChanges as any[]).map((change) => change.newFilePath);
					if (paths.length > 0) {
						const [x, y] = await Promise.all([rust.getLineCounts(root as never, null, hash, paths), cli.getLineCounts(root as never, null, hash, paths)]);
						assert.deepEqual(x, y, `counts of ${hash}`);
					}
				}
			}, 300000);

			it('compares random pairs of commits the same way', async () => {
				const hashes = fixture.hashes;
				for (let attempt = 0; attempt < 6 && hashes.length >= 2; attempt++) {
					const from = hashes[Math.floor(Math.random() * hashes.length)];
					const to = hashes[Math.floor(Math.random() * hashes.length)];
					const [a, b] = await Promise.all([rust.compareCommits(root as never, from, to), cli.compareCommits(root as never, from, to)]);
					assert.deepEqual(sortedChanges(a as never), sortedChanges(b as never), `compare ${from.slice(0, 8)}..${to.slice(0, 8)}`);

					const paths = (a as any[]).map((change) => change.newFilePath);
					if (paths.length > 0) {
						const [x, y] = await Promise.all([rust.getLineCounts(root as never, from, to, paths), cli.getLineCounts(root as never, from, to, paths)]);
						assert.deepEqual(x, y, `counts of compare ${from.slice(0, 8)}..${to.slice(0, 8)}`);
					}
				}
			});

			it('reports the same stash details and their deferred counts', async () => {
				const stashes = await rust.getStashes(root as never);
				assert.deepEqual([...stashes], [...(await cli.getStashes(root as never))]);
				for (const stash of stashes) {
					const commitStash = { selector: stash.selector, baseHash: stash.baseHash, untrackedFilesHash: stash.untrackedFilesHash };
					const [a, b] = await Promise.all([
						rust.getStashDetails(root as never, stash.hash, commitStash),
						cli.getStashDetails(root as never, stash.hash, commitStash)
					]);
					assert.deepEqual(sortedChanges(a.fileChanges as never), sortedChanges(b.fileChanges as never), `stash ${stash.selector} details`);
					const paths = (a.fileChanges as any[]).map((change) => change.newFilePath);
					if (paths.length > 0) {
						const [x, y] = await Promise.all([
							rust.getLineCounts(root as never, stash.baseHash, stash.hash, paths),
							cli.getLineCounts(root as never, stash.baseHash, stash.hash, paths)
						]);
						assert.deepEqual(x, y, `stash ${stash.selector} counts`);
					}
				}
			});

			it('serves the same summaries, subjects, bodies and counting', async () => {
				const sampled = fixture.hashes.filter((_, index) => index % 3 === 0).slice(0, 8);
				if (sampled.length === 0) return;
				for (const field of ['summaries', 'bodies'] as const) {
					const [a, b] = await Promise.all([
						field === 'summaries' ? rust.getCommitSummaries(root as never, sampled) : rust.getCommitBodies(root as never, sampled),
						field === 'summaries' ? cli.getCommitSummaries(root as never, sampled) : cli.getCommitBodies(root as never, sampled)
					]);
					assert.deepEqual(a, b, field);
				}
				const hash = sampled[0];
				assert.equal(await rust.getCommitSubject(root as never, hash), await cli.getCommitSubject(root as never, hash));
				assert.equal(
					await rust.countCommitsBefore(root as never, null, hash, true, false),
					await cli.countCommitsBefore(root as never, null, hash, true, false)
				);
			});

			it('reports the same working tree state', async () => {
				for (const includeUntracked of [true, false]) {
					const [a, b] = await Promise.all([
						rust.getUncommittedChangeCount(root as never, includeUntracked),
						cli.getUncommittedChangeCount(root as never, includeUntracked)
					]);
					assert.equal(a, b, `untracked=${includeUntracked}`);
				}
				const [a, b] = await Promise.all([rust.getUncommittedDetails(root as never), cli.getUncommittedDetails(root as never)]);
				assert.deepEqual(
					[...(a.fileChanges as any[])].map((c) => `${c.newFilePath}:${c.type}`).sort(),
					[...(b.fileChanges as any[])].map((c) => `${c.newFilePath}:${c.type}`).sort()
				);
			});

			it('answers the same history searches', async () => {
				for (const needle of ['step', 'rename', 'zzz-no-such-message']) {
					const [a, b] = await Promise.all([rust.searchHistory(root as never, needle), cli.searchHistory(root as never, needle)]);
					assert.deepEqual([...a], [...b], `search "${needle}"`);
				}
			});

			it('returns the same file contents at a revision', async () => {
				const hash = fixture.hashes[fixture.hashes.length - 1];
				for (const file of ['a.txt', 'with space.txt', 'ünïcode.txt']) {
					const read = async (backend: NativeBackend | CliBackend) => {
						try {
							return await backend.getCommitFile(root as never, hash, file);
						} catch {
							return 'missing';
						}
					};
					assert.deepEqual(await read(rust), await read(cli), `getCommitFile ${file}`);
				}
			});
		});
	}

	describe.skipIf(engineMissing)('the empty repository', () => {
		it('agree on a repository with no commits at all (the first open of a fresh clone of an empty project)', async () => {
			const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-fuzz-empty-'));
			const rust = new NativeBackend();
			const cli = new CliBackend();
			try {
				execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
					cwd: repoPath,
					env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoPath }
				});
				const root = await rust.openRepository(repoPath);
				await cli.openRepository(repoPath);

				const [infoA, infoB] = await Promise.all([
					rust.getRepoInfo(root as never, { showRemoteBranches: true, showStashes: true }),
					cli.getRepoInfo(root as never, { showRemoteBranches: true, showStashes: true })
				]);
				assert.equal(infoA.head, infoB.head);
				// The unborn branch (no commits yet): both list its name, as `git status` reports it
				assert.deepEqual([...infoA.branches], [...infoB.branches]);
				assert.deepEqual([...infoA.branches], ['main']);

				const [refsA, refsB] = await Promise.all([
					rust.getRefs(root as never, { showRemoteBranches: true }),
					cli.getRefs(root as never, { showRemoteBranches: true })
				]);
				assert.equal(refsA.head, refsB.head);
				assert.deepEqual([...refsA.heads], [...refsB.heads]);

				const [graphA, graphB] = await Promise.all([
					rust.getCommits(root as never, { maxCommits: 100, showUncommittedChanges: true, showUntrackedFiles: true }),
					cli.getCommits(root as never, { maxCommits: 100, showUncommittedChanges: true, showUntrackedFiles: true })
				]);
				assert.equal((graphA.commits as unknown[]).length, (graphB.commits as unknown[]).length);

				assert.deepEqual([...(await rust.getStashes(root as never))], [...(await cli.getStashes(root as never))]);
				const [uncommittedA, uncommittedB] = await Promise.all([rust.getUncommittedDetails(root as never), cli.getUncommittedDetails(root as never)]);
				assert.deepEqual(
					[...(uncommittedA.fileChanges as any[])].map((c) => `${c.newFilePath}:${c.type}`).sort(),
					[...(uncommittedB.fileChanges as any[])].map((c) => `${c.newFilePath}:${c.type}`).sort()
				);
			} finally {
				rust.closeAllRepositories();
				await removeRepo(repoPath);
			}
		});
	});
});
