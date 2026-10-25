import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable } from '../../support/adapters';
import { buildStandardFixture, StandardFixture } from '../../support/repoBuilder';
import { GitLineCounts } from '../../../src/extension/git/read/types';

/**
 * The deferred line counts (REFACTOR-PLAN §6.1 L3): `getLineCounts` is the read the two
 * implementations most easily answer from the wrong parent — a merge diffs against its first
 * parent, a stash against its base, a root commit against the empty tree. Those three shapes,
 * the binary file's null counts, and the comparison-view spelling are the representative cases.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture: StandardFixture = buildStandardFixture('gg-contract-linecounts');

const legs = adapterLegs();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.repo.dispose();
});

/** Line counts must be settled for exactly the paths that changed, with exactly these numbers. */
function expectCounts(counts: { [path: string]: GitLineCounts }, expected: { [path: string]: GitLineCounts }): void {
	expect(Object.keys(counts).sort()).toEqual(Object.keys(expected).sort());
	for (const [path, value] of Object.entries(expected)) {
		expect(counts[path]).toEqual(value);
	}
}

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`line counts (${leg.name})`, () => {
		let root: string;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.repo.path);
		});

		it('settles a commit\'s own diff, with null counts for a binary file', async () => {
			const counts = await leg.backend.getLineCounts(root, null, fixture.binary, ['blob.bin', 'not-in-the-diff.txt']);
			expectCounts(counts, { 'blob.bin': { additions: null, deletions: null } });
		});

		it('settles a pure rename at zero and a root commit against the empty tree', async () => {
			// The rename moved the content unchanged, and the pre-rename path is consumed by the
			// rename rather than deleted.
			const renamed = await leg.backend.getLineCounts(root, null, fixture.renamed, ['renamed.txt', 'a.txt']);
			expectCounts(renamed, { 'renamed.txt': { additions: 0, deletions: 0 } });

			const rootCommit = await leg.backend.getLineCounts(root, null, fixture.first, ['a.txt']);
			expectCounts(rootCommit, { 'a.txt': { additions: 40, deletions: 0 } });
		});

		it('settles an explicit range the comparison view asks for', async () => {
			const counts = await leg.backend.getLineCounts(root, fixture.first, fixture.renamed, ['feature.txt']);
			expectCounts(counts, { 'feature.txt': { additions: 1, deletions: 0 } });
		});

		it('settles a merge\'s diff against its first parent', async () => {
			// The feature side's file is in the merge's own diff; the main side's file, which
			// the first parent already carries, is not — a backend diffing against the wrong
			// parent would swap the two answers.
			const counts = await leg.backend.getLineCounts(root, null, fixture.merge, ['feature.txt', 'main.txt']);
			expectCounts(counts, { 'feature.txt': { additions: 1, deletions: 0 } });
		});

		it('settles a stash against its base, and asks nothing for nothing', async () => {
			const stashes = await leg.backend.getStashes(root);
			const counts = await leg.backend.getLineCounts(root, stashes[0].baseHash, stashes[0].hash, ['renamed.txt']);
			expectCounts(counts, { 'renamed.txt': { additions: 1, deletions: 40 } });

			await expect(leg.backend.getLineCounts(root, null, fixture.first, [])).resolves.toEqual({});
		});
	});
}
