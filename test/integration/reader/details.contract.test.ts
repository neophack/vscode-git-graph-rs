import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable, changesByPath, changePaths } from '../../support/adapters';
import { buildStandardFixture, RepoBuilder, StandardFixture } from '../../support/repoBuilder';

/**
 * The per-commit and working-tree detail reads (REFACTOR-PLAN §6.1 L3): `getCommitDetails`,
 * `getUncommittedDetails`, `getUncommittedChangeCount` and `compareCommits`. Representative
 * cases against the shared fixture; the conflicted-merge state builds its own repository.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture: StandardFixture = buildStandardFixture('gg-contract-details');

const legs = adapterLegs();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.repo.dispose();
});

/**
 * A repository stopped in the middle of a conflicting merge: `other` deleted a file that `main`
 * went on to modify. git reports the pair `UD`; the uncommitted list must keep the file as a
 * modification, not a deletion.
 */
function buildConflictedRepo(): RepoBuilder {
	const repo = RepoBuilder.create('gg-contract-conflict');
	repo.write('d.txt', 'd\n');
	repo.commit('base');
	repo.branch('other');
	repo.checkout('other');
	repo.git(['rm', '--quiet', 'd.txt']);
	repo.commit('delete it');
	repo.checkout('main');
	repo.write('d.txt', 'changed on main\n');
	repo.commit('change it');
	try {
		repo.git(['merge', '--quiet', 'other']);
	} catch {
		// The conflict is the point.
	}
	return repo;
}

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`detail reads (${leg.name})`, () => {
		let root: string;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.repo.path);
		});

		it('reads a rename commit as one rename, with statuses only', async () => {
			const details = await leg.backend.getCommitDetails(root, fixture.renamed);

			expect(details.hash).toBe(fixture.renamed);
			expect(details.author).toBe('Test User');
			expect(details.authorEmail).toBe('test@example.com');
			expect(details.committer).toBe('Test User');
			expect(details.body).toContain('rename a file');
			// The rename is the point: one change, not an add plus a delete, and no line
			// counts — those are the deferred second load (getLineCounts).
			expect(changesByPath(details.fileChanges)).toEqual([
				{ oldFilePath: 'a.txt', newFilePath: 'renamed.txt', type: 'R' }
			]);
			for (const change of details.fileChanges) {
				expect(change.additions).toBeNull();
				expect(change.deletions).toBeNull();
			}
		});

		it('shows the first commit as adding its files', async () => {
			const details = await leg.backend.getCommitDetails(root, fixture.first);
			const paths = details.fileChanges.map((change) => `${change.type} ${change.newFilePath}`);
			expect(paths).toEqual(['A a.txt']);
		});

		it('lists the uncommitted working tree, statuses only', async () => {
			const details = await leg.backend.getUncommittedDetails(root);

			expect(details.hash).toBe('*');
			expect(changePaths(details.fileChanges)).toEqual(['renamed.txt', 'untracked.txt']);
			for (const change of details.fileChanges) {
				expect(change.additions).toBeNull();
				expect(change.deletions).toBeNull();
			}
		});

		it('counts the uncommitted changes, with and without untracked files', async () => {
			await expect(leg.backend.getUncommittedChangeCount(root, false)).resolves.toBe(1);
			await expect(leg.backend.getUncommittedChangeCount(root, true)).resolves.toBe(2);
		});

		it('compares a commit with the working tree, without counts there either', async () => {
			const changes = await leg.backend.compareCommits(root, fixture.binary, '');

			// Against the binary commit the working tree adds the untracked file and modifies
			// renamed.txt.
			expect(changePaths(changes)).toEqual(['renamed.txt', 'untracked.txt']);
			for (const change of changes) {
				expect(change.additions).toBeNull();
				expect(change.deletions).toBeNull();
			}
		});

		it('compares two commits across the merge', async () => {
			const changes = await leg.backend.compareCommits(root, fixture.first, fixture.renamed);
			const described = changes
				.map((change) => ({ type: String(change.type), newFilePath: change.newFilePath }))
				.sort((a, b) => a.newFilePath.localeCompare(b.newFilePath));
			expect(described).toEqual([
				{ type: 'A', newFilePath: 'feature.txt' },
				{ type: 'A', newFilePath: 'main.txt' },
				{ type: 'R', newFilePath: 'renamed.txt' }
			]);
		});

		it('keeps a conflicted file the other side deleted in the uncommitted list', async () => {
			const repo = buildConflictedRepo();
			try {
				const conflictedRoot = await leg.backend.openRepository(repo.path);
				try {
					const details = await leg.backend.getUncommittedDetails(conflictedRoot);
					const paths = details.fileChanges.map((change) => `${change.type} ${change.newFilePath}`);
					expect(paths).toEqual(['M d.txt']);
					await expect(leg.backend.getUncommittedChangeCount(conflictedRoot, true)).resolves.toBe(1);
				} finally {
					leg.backend.closeRepository(conflictedRoot);
				}
			} finally {
				repo.dispose();
			}
		});
	});
}
