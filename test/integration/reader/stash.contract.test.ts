import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable } from '../../support/adapters';
import { buildStandardFixture, StandardFixture } from '../../support/repoBuilder';

/**
 * The stash reads (REFACTOR-PLAN §6.1 L3): the stash list the view shows and the full detail of
 * one entry. The fixture carries TWO stashes from the start, so the newest-first order is
 * observable without any case mutating the repository mid-suite.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture: StandardFixture = buildStandardFixture('gg-contract-stash');

const legs = adapterLegs();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.repo.dispose();
});

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`stash reads (${leg.name})`, () => {
		let root: string;
		let stashes: ReadonlyArray<{ hash: string; baseHash: string; selector: string; author: string; email: string; message: string }>;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.repo.path);
			stashes = await leg.backend.getStashes(root);
		});

		it('lists the stashes newest first', async () => {
			expect(stashes).toHaveLength(2);
			expect(stashes[0].message).toContain('a second stashed change');
			expect(stashes[1].message).toContain('the stashed work');
			// Both stashes were taken on the fixture's HEAD commit.
			expect(stashes[0].baseHash).toBe(fixture.head);
			expect(stashes[0].author).toBe('Test User');
			expect(stashes[0].email).toBe('test@example.com');
			expect(stashes[0].selector).toBeTruthy();
		});

		it('reads one stash entry in full', async () => {
			const details = await leg.backend.getStashDetails(root, stashes[0].hash, {
				selector: stashes[0].selector,
				baseHash: stashes[0].baseHash,
				untrackedFilesHash: null
			});

			expect(details.hash).toBe(stashes[0].hash);
			// The second stash replaced renamed.txt's 40 lines with a single one.
			const changes = details.fileChanges.map((change) => `${change.type} ${change.newFilePath}`);
			expect(changes).toEqual(['M renamed.txt']);
		});
	});
}
