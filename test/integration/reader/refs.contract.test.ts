import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable } from '../../support/adapters';
import { buildStandardFixture, StandardFixture } from '../../support/repoBuilder';

/**
 * The ref-scan reads (REFACTOR-PLAN §6.1 L3): `getRepoInfo` (the view's opening payload),
 * `getRefs` with its view options, and the tag details behind the Tag Details dialogue.
 * Representative cases only — which refs exist and how the engine's scan compares with git is
 * pinned in L1; the contract here is that both adapters answer the same fixture alike.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture: StandardFixture = buildStandardFixture('gg-contract-refs');
// A multi-paragraph tag message with trailing blank lines, written through a file so the bytes
// are exact — both adapters must trim it the way the Tag Details dialogue expects.
fixture.repo.write('tag-message.txt', 'line one\n\nline two\n\n\n');
fixture.repo.git(['tag', '-a', 'v3.0', '-F', 'tag-message.txt', fixture.renamed]);
fixture.repo.remove('tag-message.txt');

const legs = adapterLegs();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.repo.dispose();
});

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`ref reads (${leg.name})`, () => {
		let root: string;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.repo.path);
		});

		it('opens with the branches, remotes, tags and stashes the view needs', async () => {
			const info = await leg.backend.getRepoInfo(root, { showRemoteBranches: true, showStashes: true });

			expect(info.error).toBeNull();
			expect(info.head).toBe('main');
			expect(info.branches).toEqual(expect.arrayContaining(['main', 'feature', 'remotes/origin/main']));
			expect(info.remotes).toEqual(['origin']);
			expect(info.tags).toEqual(expect.arrayContaining(['release/v2.1', 'v1.0', 'v2.0', 'v3.0']));
			expect(info.stashes).toHaveLength(2);
			expect(info.stashes[0].message).toContain('a second stashed change');
			expect(info.stashes[1].message).toContain('the stashed work');
			expect(info.stashes[0].baseHash).toBe(fixture.head);
		});

		it('scans the refs with their kind and target', async () => {
			const refs = await leg.backend.getRefs(root, { showRemoteBranches: true });

			expect(refs.head).toBe(fixture.head);
			const heads = refs.heads.map((ref) => `${ref.name}@${ref.hash}`).sort();
			expect(heads).toEqual([`feature@${fixture.feature}`, `main@${fixture.head}`]);

			const remoteNames = refs.remotes.map((ref) => ref.name);
			// The symbolic origin/HEAD is not offered as a branch ref by either adapter.
			expect(remoteNames).toEqual(expect.arrayContaining(['origin/main']));
			expect(remoteNames.some((name) => name.includes('changes/'))).toBe(false);

			// Each annotated tag is reported twice, both adapters alike: the tag object itself
			// (annotated: false) and the commit it dereferences to (annotated: true).
			const entriesFor = (name: string): string[] =>
				refs.tags
					.filter((tag) => tag.name === name)
					.map((tag) => `${tag.hash}:${tag.annotated}`)
					.sort();
			const tagObject = (name: string): string => fixture.repo.revParse(`refs/tags/${name}`);

			expect(entriesFor('v1.0')).toEqual([`${fixture.first}:false`]);
			expect(entriesFor('release/v2.1')).toEqual([`${fixture.renamed}:false`]);
			expect(entriesFor('v2.0')).toEqual([`${fixture.renamed}:true`, `${tagObject('v2.0')}:false`].sort());
			expect(entriesFor('v3.0')).toEqual([`${fixture.renamed}:true`, `${tagObject('v3.0')}:false`].sort());
			// v-remote is the fixture's local annotated tag on the feature commit, later copied to
			// the remote; its LOCAL entries follow the same dual shape.
			expect(entriesFor('v-remote')).toEqual(
				[`${fixture.feature}:true`, `${tagObject('v-remote')}:false`].sort()
			);
			// That is every non-origin tag entry (a remote's tags/ ref is offered by the adapters
			// with different completeness; the graph labels it identically either way, which the
			// commits contract pins).
			expect(refs.tags.filter((tag) => !tag.name.startsWith('origin/'))).toHaveLength(8);
		});

		it('hides a remote on request and shows Gerrit change refs only when asked', async () => {
			const hidden = await leg.backend.getRefs(root, { showRemoteBranches: true, hideRemotes: ['origin'] });
			expect(hidden.remotes).toEqual([]);

			const shown = await leg.backend.getRefs(root, { showRemoteBranches: true, showChangeRefs: true });
			const names = shown.remotes.map((ref) => ref.name);
			expect(names).toContain('origin/changes/45/12345/1');
			expect(names.some((name) => name.endsWith('/meta'))).toBe(false);
		});

		it('reads an annotated tag in full', async () => {
			const details = await leg.backend.getTagDetails(root, 'v2.0');

			expect(details.taggerName).toBe('Test User');
			expect(details.taggerEmail).toBe('test@example.com');
			expect(details.message).toBe('an annotated tag');
			// The tag is unsigned: the adapters either report no signature or the "cannot be
			// checked" verdict an unsigned tag produces when a keyring is consulted at all.
			expect(details.signature === null || details.signature.status === 'E').toBe(true);
		});

		it('answers a lightweight tag with its commit', async () => {
			const details = await leg.backend.getTagDetails(root, 'v1.0');

			expect(details.hash).toBe(fixture.first);
			expect(details.message).toBe('the first commit');
			expect(details.signature).toBeNull();
		});

		it('reads a tag below a hierarchical name and trims a multi-paragraph message', async () => {
			const hierarchical = await leg.backend.getTagDetails(root, 'release/v2.1');
			expect(hierarchical.hash).toBe(fixture.renamed);
			expect(hierarchical.message).toBe('rename a file');

			const multiParagraph = await leg.backend.getTagDetails(root, 'v3.0');
			expect(multiParagraph.message).toBe('line one\n\nline two');
		});

		it('fails a tag that does not exist', async () => {
			await expect(leg.backend.getTagDetails(root, 'no-such-tag')).rejects.toThrow();
		});

		it('verifies an unsigned tag to no signature', async () => {
			await expect(leg.backend.getTagSignature(root, 'v2.0')).resolves.toBeNull();
		});
	});
}
