/**
 * The affected tier's selection (plan task 1.10, §6.8.5): map the PR's changed files to
 * scenario-domain tags via a directory-prefix table, and select every scenario carrying one of
 * those tags. Directories with no runtime effect are mapped to no tags (the affected tier runs
 * nothing beyond the always-present smoke tier); directories NOT covered by the table select the
 * FULL tier — the conservative default the acceptance criteria demand.
 *
 * The tag vocabulary is the automation catalog's groups (every catalog action is tagged with
 * its group at minimum) plus the smoke scenarios' own tags. The table is a mapping of source
 * AREAS to the user-visible domains they implement; it is deliberately coarse at this stage —
 * the plan's own example (dialog widget sources -> the 'dialog' tag) tightens per directory as
 * the scenario conversion (§6.8.3) lands.
 */

import { execFileSync } from 'child_process';

/** The catalog groups driven by each mapped source area, or 'full' for cross-cutting areas. */
export type AffectedTarget = { readonly tags: readonly string[] } | { readonly full: true };

/** Directory prefixes (POSIX-style, trailing slash = directory) → the domains they serve. */
const DIR_MAPPING: readonly { readonly dir: string; readonly target: AffectedTarget }[] = [
	// The automation subsystem and the shared protocol shape every scenario; the engine likewise.
	{ dir: 'src/extension/automation/', target: { full: true } },
	{ dir: 'src/shared/', target: { full: true } },
	{ dir: 'native/', target: { full: true } },
	{ dir: 'src/webview/', target: { full: true } },
	{ dir: 'src/extension/platform/', target: { full: true } },
	{ dir: 'src/extension/git/process/askpass/', target: { tags: ['menu-branch', 'menu-remote-branch', 'menu-tag'] } },
	{ dir: 'src/extension/commands/', target: { tags: ['menu-vscode', 'host'] } },
	{ dir: 'src/extension/git/write/', target: { tags: ['menu-commit', 'menu-branch', 'menu-tag', 'menu-stash', 'menu-uncommitted', 'menu-remote-branch', 'settings'] } },
	{ dir: 'src/extension/git/', target: { full: true } },
	{ dir: 'src/extension/graphView/', target: { tags: ['control-bar', 'row', 'cdv', 'settings', 'find', 'keyboard', 'reflog', 'worktree', 'statistics'] } },
	{ dir: 'src/extension/repos/', target: { tags: ['control-bar', 'settings'] } },
	{ dir: 'src/extension/views/', target: { tags: ['host'] } },
	{ dir: 'src/extension/statusBar.ts', target: { tags: ['host'] } },
	// The webview's old-position modules (gitGraphView.ts, dataSource.ts, commands.ts, ...) are
	// the host side of every rendered control; a change there can break anything.
	{ dir: 'src/gitGraphView.ts', target: { full: true } },
	{ dir: 'src/dataSource.ts', target: { full: true } },
	{ dir: 'src/commands.ts', target: { full: true } },
	{ dir: 'src/config.ts', target: { full: true } },
	{ dir: 'src/extensionState.ts', target: { full: true } },
	{ dir: 'src/repoManager.ts', target: { tags: ['control-bar', 'settings'] } },
	{ dir: 'src/repoFileWatcher.ts', target: { tags: ['external'] } },
	// The former src/utils drained into the layered tree (A1); the only landing spot not already
	// covered by a broader row above is the commands layer's repo-dropdown helper.
	{ dir: 'src/extension/commands/repo.ts', target: { full: true } },
	// The manifest contributes commands, menus and settings runtime behavior keys off.
	{ dir: 'package.json', target: { full: true } },
	{ dir: 'package.nls', target: { full: true } },
	{ dir: 'resources/', target: { full: true } },
	// No runtime effect inside the scenarios under test: the affected tier adds nothing (the
	// smoke tier still runs in CI — smoke and affected are two steps of the same PR gate).
	{ dir: 'docs/', target: { tags: [] } },
	{ dir: 'tests/', target: { tags: [] } },
	{ dir: 'test/', target: { tags: [] } },
	{ dir: 'scripts/', target: { tags: [] } },
	{ dir: '.github/', target: { tags: [] } },
	{ dir: 'legacy/', target: { tags: [] } },
	{ dir: 'licenses/', target: { tags: [] } }
];

/** Normalize a repo-relative path for mapping: forward slashes, backslashes are git separators too. */
export function normalizeChangedPath(file: string): string {
	return file.replace(/\\/g, '/');
}

/**
 * The affected target for one changed path: the first mapping whose dir is a prefix (a dir
 * entry matches the path itself for exact-file rows); unmapped → the full tier.
 */
export function targetForPath(file: string): AffectedTarget {
	const normalized = normalizeChangedPath(file);
	for (const entry of DIR_MAPPING) {
		if (entry.dir.endsWith('/')) {
			if (normalized.startsWith(entry.dir)) return entry.target;
		} else if (normalized === entry.dir) {
			return entry.target;
		}
	}
	return { full: true };
}

/** Merge changed paths into one affected target ('full' swallows everything). */
export function selectAffected(changedFiles: readonly string[]): AffectedTarget {
	const tags = new Set<string>();
	for (const file of changedFiles) {
		const target = targetForPath(file);
		if ('full' in target) return { full: true };
		for (const tag of target.tags) tags.add(tag);
	}
	return { tags: [...tags].sort() };
}

/**
 * List the files changed on HEAD relative to the merge base with `base` (the PR's changed set).
 * Returns null when git could not answer (unknown base ref, not a repo) — the launcher then
 * falls back to the full tier, loudly.
 */
export function listChangedFiles(base: string, cwd: string): string[] | null {
	const git = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
	try {
		const mergeBase = git(['merge-base', 'HEAD', base]).trim();
		if (mergeBase === '') return null;
		return git(['-c', 'core.quotepath=off', 'diff', '--name-only', mergeBase, 'HEAD']).split('\n').map((line) => line.trim()).filter((line) => line !== '');
	} catch {
		return null;
	}
}

/** Human-readable form for logs and reports. */
export function describeTarget(target: AffectedTarget): string {
	return 'full' in target ? 'full tier' : 'tags: ' + (target.tags.length > 0 ? target.tags.join(', ') : '(none)');
}
