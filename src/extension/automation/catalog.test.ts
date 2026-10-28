import { describe, expect, it } from 'vitest';
import { CATALOG, validateCatalog } from './catalog';
import { CATALOG_SNAPSHOT } from './catalog/snapshot';

/**
 * The catalog split's zero-change proof: the domain files under
 * ./catalog/ reassemble into EXACTLY the pre-split single-file catalog (the committed snapshot
 * holds the ordered { id, group, title } triples captured from it before the split), the count
 * is still 178 (146 pre-split actions plus the post-split coverage additions), and every action
 * carries at least one tag — the invariant the load-time assertion in catalog.ts enforces and
 * the affected-tier selection relies on.
 */

describe('the split automation catalog', () => {
	it('assembles to exactly the snapshot sequence (order included)', () => {
		expect(CATALOG.map((action) => ({ id: action.id, group: action.group, title: action.title })))
			.toEqual([...CATALOG_SNAPSHOT]);
	});

	it('still holds 178 actions across the 18 original groups', () => {
		expect(CATALOG).toHaveLength(178);
		const groups = new Set(CATALOG.map((action) => action.group));
		expect([...groups].sort()).toEqual([
			'cdv', 'control-bar', 'external', 'find', 'host', 'keyboard', 'menu-branch', 'menu-commit',
			'menu-remote-branch', 'menu-stash', 'menu-tag', 'menu-uncommitted', 'menu-vscode', 'reflog',
			'row', 'settings', 'statistics', 'worktree'
		]);
	});

	it('gives every action at least one tag, its group first', () => {
		for (const action of CATALOG) {
			expect(action.tags.length, action.id).toBeGreaterThan(0);
			expect(action.tags[0], action.id).toBe(action.group);
			expect(action.tags.every((tag) => typeof tag === 'string' && tag.trim() !== ''), action.id).toBe(true);
		}
	});

	it('passes validateCatalog including the tags rules', () => {
		expect(validateCatalog(CATALOG)).toEqual([]);
	});

	it('rejects a scenario without tags (the validation check)', () => {
		const untagged = [{ ...CATALOG[0], tags: [] }];
		expect(validateCatalog(untagged as typeof CATALOG)).toContainEqual(
			`action "${CATALOG[0].id}": missing tags (the group at minimum)`
		);
		const withoutOwnGroup = [{ ...CATALOG[0], tags: ['dialog'] }];
		expect(validateCatalog(withoutOwnGroup as typeof CATALOG)).toContainEqual(
			`action "${CATALOG[0].id}": tags must include the action's own group "${CATALOG[0].group}"`
		);
	});
});
