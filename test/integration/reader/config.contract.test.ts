import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable } from '../../support/adapters';
import { buildStandardFixture, RepoBuilder, StandardFixture } from '../../support/repoBuilder';

/**
 * The configuration reads (REFACTOR-PLAN §6.1 L3): the snapshot the view consumes (identity,
 * push default, diff tools, remotes) and the raw `git config --list` spelling of both
 * locations, whose section/key/subsection case rules the hand-edited fixture lines pin.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture: StandardFixture = buildStandardFixture('gg-contract-config');

const legs = adapterLegs();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.repo.dispose();
});

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`configuration reads (${leg.name})`, () => {
		let root: string;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.repo.path);
		});

		it('reads the values the view consumes', async () => {
			const config = await leg.backend.getConfig(root);

			expect(config.userName).toBe('Test User');
			expect(config.userEmail).toBe('test@example.com');
			expect(config.pushDefault).toBe('origin');
			expect(config.diffTool).toBe('gitgraph-test-tool');
			expect(config.diffGuiTool).toBe('gitgraph-test-gui');
			const remotes = [...config.remotes].sort((a, b) => a.name.localeCompare(b.name));
			expect(remotes).toHaveLength(1);
			expect(remotes[0].name).toBe('origin');
			expect(remotes[0].url).toBe('https://example.invalid/repo.git');
		});

		it('lists local configuration the way `git config --list` spells it', async () => {
			const list = await leg.backend.getConfigList(root, 'local');

			expect(list['user.name']).toBe('Test User');
			expect(list['branch.main.remote']).toBe('origin');
			expect(list['remote.origin.url']).toBe('https://example.invalid/repo.git');
			// Section and key names are lower-cased however the file spells them; a
			// subsection's case is kept. The fixture wrote them case-mixed on purpose.
			expect(list['advice.amworkdir']).toBe('false');
			expect(list['somesection.CamelCase.somekey']).toBe('mixed case');
		});

		it('answers the global location without depending on this machine', async () => {
			const list = await leg.backend.getConfigList(root, 'global');
			expect(list).toBeTypeOf('object');
		});

		it('reads a hand-edited remote whose name a `git remote add` would refuse', async () => {
			// Remote names with spaces only reach a repository by hand-editing .git/config,
			// and the URL lookup must read them exactly as `git config` does.
			const handEdited = RepoBuilder.create('gg-contract-oddremote');
			try {
				handEdited.config('remote.up stream.url', 'https://example.invalid/spaced.git');
				const opened = await leg.backend.openRepository(handEdited.path);
				await expect(leg.backend.getRemoteUrl(opened, 'up stream')).resolves.toBe('https://example.invalid/spaced.git');
				leg.backend.closeRepository(opened);
			} finally {
				handEdited.dispose();
			}
		});
	});
}
