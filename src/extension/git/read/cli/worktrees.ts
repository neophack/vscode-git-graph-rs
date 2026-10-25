/**
 * The worktree theme: the repository's linked working directories, as
 * `git worktree list --porcelain` reports them.
 */

import { GitWorktree } from '../../../../backend/types';
import { EOL, GitCli } from './process';

/**
 * The worktrees of a repository, in the order Git reports them (the first is always the
 * repository's own working directory). Never rejects: an unreadable list answers empty, as the
 * worktree list is an advisory panel rather than a load the view depends on.
 */
export async function getWorktrees(cli: GitCli, repo: string): Promise<GitWorktree[]> {
	let lines: string[];
	try {
		lines = (await cli.run(['worktree', 'list', '--porcelain'], repo)).split(EOL);
	} catch (_) {
		return [];
	}

	const worktrees: GitWorktree[] = [];
	let current: { path: string; hash: string; branch: string | null; detached: boolean; locked: boolean; prunable: boolean } | null = null;
	const flush = () => {
		if (current !== null) {
			worktrees.push({ ...current, isMain: worktrees.length === 0 });
		}
	};
	for (const line of lines) {
		if (line.startsWith('worktree ')) {
			flush();
			current = { path: line.substring(9), hash: '', branch: null, detached: false, locked: false, prunable: false };
		} else if (current === null) {
			continue;
		} else if (line.startsWith('HEAD ')) {
			current.hash = line.substring(5);
		} else if (line.startsWith('branch ')) {
			const ref = line.substring(7);
			current.branch = ref.startsWith('refs/heads/') ? ref.substring(11) : ref;
		} else if (line === 'detached') {
			current.detached = true;
		} else if (line === 'locked' || line.startsWith('locked ')) {
			current.locked = true;
		} else if (line === 'prunable' || line.startsWith('prunable ')) {
			current.prunable = true;
		}
	}
	flush();
	return worktrees;
}
