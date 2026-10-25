import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable } from '../../support/adapters';
import { buildStandardFixture, StandardFixture } from '../../support/repoBuilder';
import { GitCommitData, LogOptions } from '../../../src/extension/git/read/types';

/**
 * The graph load (REFACTOR-PLAN §6.1 L3): `getCommits` and the option axes the view drives it
 * with — pagination, ordering, author and path filters, first-parent walks and the deferred
 * remote-ref scan. The rows themselves (labels, stashes, the uncommitted row) are asserted
 * against the fixture's known answers; the engine-vs-git walk semantics are pinned in L1.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture: StandardFixture = buildStandardFixture('gg-contract-commits');
// One more commit by an author whose name is full of regular-expression metacharacters: the
// author filter must match it literally (as `git log --author` does), not as a pattern.
fixture.repo.git([
	'-c', 'user.name=Alice (ops)', '-c', 'user.email=alice@example.com',
	'commit', '--quiet', '--allow-empty', '-m', 'a commit by Alice (ops)'
], { authorDate: fixture.repo.nextDate(), committerDate: fixture.repo.nextDate() });
const alice = fixture.repo.revParse('HEAD');
/** The fixture's real commits in commit-date order, newest first — git guarantees this order. */
const dateOrder = [alice, fixture.head, fixture.binary, fixture.renamed, fixture.merge, fixture.main, fixture.feature, fixture.first];

const legs = adapterLegs();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.repo.dispose();
});

/** The graph rows that are real commits: neither the uncommitted row nor a stash entry. */
function realCommits(data: GitCommitData): GitCommitData['commits'] {
	return data.commits.filter((commit) => commit.stash === null && commit.hash !== '*');
}

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`graph reads (${leg.name})`, () => {
		let root: string;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.repo.path);
		});

		it('builds the whole graph with its labels', async () => {
			const options: LogOptions = {
				maxCommits: 100,
				showTags: true,
				showRemoteBranches: true,
				showUncommittedChanges: true,
				showUntrackedFiles: true,
				remotes: ['origin'],
				commitOrdering: 'date'
			};
			const data = await leg.backend.getCommits(root, options);

			expect(data.error).toBeNull();
			// Alice's empty commit was made on main after the fixture's own HEAD, so it is HEAD.
			expect(data.head).toBe(alice);
			expect(data.moreCommitsAvailable).toBe(false);

			expect(realCommits(data).map((commit) => commit.hash)).toEqual(dateOrder);

			// The two stashes ride the graph as rows of their own, newest first, and the
			// uncommitted working tree is one row with the synthetic hash.
			const stashes = await leg.backend.getStashes(root);
			expect(data.commits.filter((commit) => commit.stash !== null).map((commit) => commit.hash))
				.toEqual(stashes.map((stash) => stash.hash));
			expect(data.commits.filter((commit) => commit.hash === '*')).toHaveLength(1);

			// Labels: parents, tags (with their kind) and the remote-tracking branch heads.
			const byHash = new Map(data.commits.map((commit) => [commit.hash, commit]));
			const merge = byHash.get(fixture.merge);
			expect(merge !== undefined && [...merge.parents]).toEqual([fixture.main, fixture.feature]);

			const renamed = byHash.get(fixture.renamed);
			expect(renamed !== undefined && renamed.tags.map((tag) => `${tag.name}:${tag.annotated}`).sort())
				.toEqual(['release/v2.1:false', 'v2.0:true']);
			// The symbolic origin/HEAD is not offered as a label by either adapter.
			expect(renamed !== undefined && renamed.remotes.map((remote) => remote.name).sort())
				.toEqual(['origin/main']);
			const first = byHash.get(fixture.first);
			expect(first !== undefined && first.tags.map((tag) => tag.name)).toEqual(['v1.0']);
			// The annotated tag a remote carries under refs/remotes/origin/tags/ must attach to
			// its commit, dereferenced and marked annotated, not be dropped or misread.
			const feature = byHash.get(fixture.feature);
			expect(feature !== undefined && feature.tags.some((tag) => tag.name.endsWith('v-remote') && tag.annotated))
				.toBe(true);

			// The complete load carries the complete branch list, remote branches included.
			expect(data.branches).toEqual(expect.arrayContaining(['main', 'feature', 'remotes/origin/main']));
			expect(data.tags).toEqual(expect.arrayContaining(['v1.0', 'v2.0', 'release/v2.1']));
		});

		it('cuts a page and reports that more are available', async () => {
			const data = await leg.backend.getCommits(root, {
				maxCommits: 2,
				showTags: true,
				showRemoteBranches: true,
				remotes: ['origin'],
				commitOrdering: 'date'
			});

			expect(data.moreCommitsAvailable).toBe(true);
			// The page holds the requested number of REAL commits; stash rows are spliced in
			// after the trim, so the page may come back longer than two.
			expect(realCommits(data).map((commit) => commit.hash)).toEqual([alice, fixture.head]);
		});

		it('never shows a parent before its child, in either ordering', async () => {
			for (const commitOrdering of ['date', 'topo'] as const) {
				const data = await leg.backend.getCommits(root, {
					maxCommits: 100,
					showRemoteBranches: true,
					remotes: ['origin'],
					commitOrdering
				});

				expect(realCommits(data).map((commit) => commit.hash).sort()).toEqual([...dateOrder].sort());
				const position = new Map(data.commits.map((commit, index) => [commit.hash, index]));
				for (const commit of data.commits) {
					for (const parent of commit.parents) {
						const parentPosition = position.get(parent);
						if (parentPosition !== undefined) {
							expect(parentPosition).toBeGreaterThan(position.get(commit.hash) as number);
						}
					}
				}
			}
		});

		it('filters the graph by author, literally and case-insensitively', async () => {
			// A name full of metacharacters must match literally, the way `--author` does, and
			// the match is case-insensitive.
			for (const name of ['Alice (ops)', 'ALICE (OPS)']) {
				const byAlice = await leg.backend.getCommits(root, {
					maxCommits: 100,
					authors: [name],
					showRemoteBranches: true,
					commitOrdering: 'date'
				});
				expect(realCommits(byAlice).map((commit) => commit.hash)).toEqual([alice]);
			}

			const byNobody = await leg.backend.getCommits(root, {
				maxCommits: 100,
				authors: ['Nobody Else <nobody@example.com>'],
				showRemoteBranches: true,
				commitOrdering: 'date'
			});
			expect(realCommits(byNobody)).toHaveLength(0);
		});

		it('filters the graph by path, the way history simplification works', async () => {
			const byPath = await leg.backend.getCommits(root, {
				maxCommits: 100,
				filterPaths: ['feature.txt'],
				showRemoteBranches: true,
				commitOrdering: 'date'
			});

			// The merge carries feature.txt in unchanged, so only the commit that created it
			// remains on the filtered graph.
			expect(realCommits(byPath).map((commit) => commit.hash)).toEqual([fixture.feature]);
		});

		it('walks only the first parent when the view asks for it', async () => {
			const data = await leg.backend.getCommits(root, {
				maxCommits: 100,
				branches: ['main'],
				onlyFollowFirstParent: true,
				showRemoteBranches: true,
				remotes: ['origin'],
				commitOrdering: 'date'
			});

			const hashes = realCommits(data).map((commit) => commit.hash);
			expect(hashes).not.toContain(fixture.feature);
			expect(hashes.sort()).toEqual(
				[alice, fixture.head, fixture.binary, fixture.renamed, fixture.merge, fixture.main, fixture.first].sort()
			);
		});

		it('defers the remote refs without dropping the local labels', async () => {
			const data = await leg.backend.getCommits(root, {
				maxCommits: 100,
				showTags: true,
				showRemoteBranches: true,
				showUncommittedChanges: true,
				remotes: ['origin'],
				commitOrdering: 'date',
				deferRemoteRefs: true
			});

			expect(data.error).toBeNull();
			expect(data.commits.every((commit) => commit.remotes.length === 0)).toBe(true);
			expect(data.commits.some((commit) => commit.heads.length > 0)).toBe(true);
			// The deferred response carries the LOCAL branch list only.
			expect(data.branches?.some((branch) => branch.startsWith('remotes/'))).toBe(false);
		});
	});
}
