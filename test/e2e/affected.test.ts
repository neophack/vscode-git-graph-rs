import { describe, expect, it } from 'vitest';
import { describeTarget, normalizeChangedPath, selectAffected, targetForPath } from './affected';

/**
 * The affected selector's unit tests (task 1.10's acceptance: "correct affected selection ...
 * directories not covered by the mapping select the full tier"). Pure table logic — no git, no
 * editor; the end-to-end selection (merge-base diff) is exercised by the launcher itself.
 */

describe('affected-tier directory mapping', () => {
	it('maps dialog widget sources to the view domains', () => {
		const target = targetForPath('src/extension/graphView/widgets/dialogActions.ts');
		expect('tags' in target && target.tags).toContain('cdv');
		expect(describeTarget(target)).toMatch(/tags:/);
	});

	it('maps the write operations to the write-domain tags', () => {
		const target = targetForPath('src/extension/git/write/branch.ts');
		expect('tags' in target && target.tags).toEqual(expect.arrayContaining(['menu-branch', 'menu-commit']));
	});

	it('maps contributed-command sources to the command domains', () => {
		const target = targetForPath('src/extension/commands/view.ts');
		expect('tags' in target && target.tags).toContain('menu-vscode');
	});

	it('maps cross-cutting areas to the full tier', () => {
		expect('full' in targetForPath('src/automation/catalog/menusBranch.ts')).toBe(true);
		expect('full' in targetForPath('native/core/src/lib.rs')).toBe(true);
		expect('full' in targetForPath('src/webview/graph/widgets/dialog.ts')).toBe(true);
		expect('full' in targetForPath('src/extension/platform/vscodeCompat.ts')).toBe(true);
	});

	it('maps a git read change to the full tier (reads power every scenario)', () => {
		expect('full' in targetForPath('src/extension/git/read/reader.ts')).toBe(true);
	});

	it('maps documentation and tooling to no tags (the smoke tier still runs in CI)', () => {
		const docs = targetForPath('docs/e2e-baseline.md');
		expect('tags' in docs && docs.tags).toEqual([]);
		const scripts = targetForPath('scripts/build/build.mjs');
		expect('tags' in scripts && scripts.tags).toEqual([]);
	});

	it('selects the full tier for unmapped directories', () => {
		expect('full' in targetForPath('some/new/module.ts')).toBe(true);
		expect('full' in selectAffected(['a.txt'])).toBe(true);
	});

	it('merges tag sets across changed files', () => {
		const target = selectAffected(['src/extension/commands/view.ts', 'src/extension/repos/repoManager.ts']);
		expect('tags' in target && target.tags).toEqual(expect.arrayContaining(['menu-vscode', 'host', 'control-bar', 'settings']));
		expect('tags' in target && target.tags).not.toContain('menu-commit');
	});

	it('lets one cross-cutting file swallow the rest into the full tier', () => {
		expect('full' in selectAffected(['docs/x.md', 'src/shared/engine/protocol.ts'])).toBe(true);
	});

	it('normalizes windows separators before mapping', () => {
		expect(targetForPath(normalizeChangedPath('src\\extension\\commands\\view.ts')))
			.toEqual(targetForPath('src/extension/commands/view.ts'));
	});
});
