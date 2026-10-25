/**
 * The counting theme: the deferred `+N/-M` line counts of a details load, the commits-reachable
 * count of the loss warnings, and the Statistics view's author aggregations and activity heatmap.
 */

import {
	GitActivityCell,
	GitAuthor,
	GitAuthorStat,
	GitBackendError,
	GitLineCounts
} from '../types';
import { EOL, GitCli } from './process';
import { parseNumStat } from './parse/numStat';

/**
 * The `+N/-M` line counts of the given paths, as `git diff --numstat` reports them — the
 * deferred second half of a details load, settled a viewport at a time.
 *
 * The counts cannot be limited to the asked-for paths by a pathspec: a rename's old path would
 * fall outside the limit, so the pair would never be made and a moved file would count as a
 * wholesale addition. The whole diff is counted instead — the cost the original extension paid
 * on every details load — and kept for the batches that follow, which settle from memory.
 */
export async function getLineCounts(cli: GitCli, repo: string, from: string | null, to: string, paths: ReadonlyArray<string>): Promise<{ [path: string]: GitLineCounts }> {
	if (paths.length === 0) return {};
	let base = from;
	if (base === null) {
		// The commit's first parent — or the empty tree for a root commit, whose files then
		// report as added rather than being unaccounted for.
		base = await cli.run(['rev-parse', '--verify', to + '^'], repo).then((out) => out.trim(), () => cli.getEmptyTree(repo));
	}

	const counts = await numStatCounts(cli, repo, base, to);
	const wanted: { [path: string]: GitLineCounts } = {};
	for (let i = 0; i < paths.length; i++) {
		const counted = counts[paths[i]];
		if (typeof counted !== 'undefined') wanted[paths[i]] = counted;
	}
	return wanted;
}

/**
 * The numstat counts of a whole diff, keyed by each file's new path. Cached for the last
 * (repo, base, to): the callers settle one commit's file list in batches, and a diff between
 * two fixed revisions cannot change under the cache.
 */
async function numStatCounts(cli: GitCli, repo: string, base: string, to: string): Promise<{ [path: string]: GitLineCounts }> {
	if (cli.numStatCache !== null && cli.numStatCache.repo === repo && cli.numStatCache.base === base && cli.numStatCache.to === to) {
		return cli.numStatCache.counts;
	}

	const numStat = await cli.run(['diff', '--numstat', '--find-renames', '-z', base, to], repo);
	const counts = parseNumStat(numStat);

	cli.numStatCache = { repo, base, to, counts };
	return counts;
}

/** How many commits are reachable from the given refs but not from `hash`. */
export async function countCommitsBefore(
	cli: GitCli,
	repo: string,
	branches: ReadonlyArray<string> | null,
	hash: string,
	showRemoteBranches: boolean,
	includeCommitsMentionedByReflogs: boolean
): Promise<number> {
	const args = ['rev-list', '--count'];
	if (branches !== null) {
		args.push(...branches);
	} else {
		args.push('--branches', '--tags');
		if (showRemoteBranches) args.push('--remotes');
		if (includeCommitsMentionedByReflogs) args.push('--reflog');
		// HEAD is only a tip when it resolves: on an orphan branch it names no commit, and
		// passing it would fail the whole count (the engine skips it the same way).
		const headExists = await cli.run(['rev-parse', '--verify', '--quiet', 'HEAD'], repo)
			.then((out) => out.trim() !== '', () => false);
		if (headExists) args.push('HEAD');
	}
	args.push(`^${hash}`);
	const out = await cli.run(args, repo);
	const count = parseInt(out.trim(), 10);
	if (Number.isNaN(count)) {
		throw new GitBackendError('Git', `Could not count the commits before ${hash}`);
	}
	return count;
}

/**
 * The distinct commit authors of the current branch's history: counted per (name, email)
 * spelling over HEAD's history, de-duplicated by name (the most-prolific spelling first, then
 * sorted by name) — the same reduce the engine performs. `git shortlog` is deliberately not
 * used: it applies `.mailmap` by default, which would disagree with both the engine and the
 * author names the commit rows themselves display.
 */
export async function getAuthors(cli: GitCli, repo: string): Promise<GitAuthor[]> {
	const out = await cli.run(['log', '--format=%an%x1f%ae', 'HEAD'], repo);
	const counts = new Map<string, { name: string; email: string; count: number }>();
	for (const line of out.split(EOL)) {
		const separator = line.indexOf('\x1f');
		if (line === '' || separator === -1) continue;
		const name = line.slice(0, separator), email = line.slice(separator + 1);
		const entry = counts.get(name + '\x00' + email);
		if (entry === undefined) counts.set(name + '\x00' + email, { name, email, count: 1 });
		else entry.count++;
	}
	const ordered = [...counts.values()].sort(
		(a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.email < b.email ? -1 : 1)
	);
	const seen = new Set<string>();
	const authors: GitAuthor[] = [];
	for (const entry of ordered) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		authors.push({ name: entry.name, email: entry.email });
	}
	// The list itself is sorted by name; the count ordering only decided which spelling of a
	// repeated name wins.
	authors.sort((a, b) => (a.name > b.name ? 1 : -1));
	return authors;
}

/** Commit counts per author, across all refs (branches, tags, remote-tracking, the stash), merge commits excluded. */
export async function getAuthorStatistics(cli: GitCli, repo: string): Promise<GitAuthorStat[]> {
	let lines: string[];
	try {
		lines = (await cli.run(['shortlog', '-sne', '--all', '--no-merges'], repo)).split(EOL).filter((line) => line !== '');
	} catch (_) {
		return [];
	}

	const stats: GitAuthorStat[] = [];
	for (const line of lines) {
		const match = line.match(/^\s*(\d+)\s+(.+?)\s+<(.*?)>$/);
		if (match !== null) {
			stats.push({ commits: parseInt(match[1], 10), name: match[2], email: match[3] });
		}
	}
	return stats;
}

/**
 * The commit-activity heatmap of a repository, binned by the author's local weekday and hour
 * (i.e. `%aI`'s own UTC offset, not the machine running Git Graph's timezone).
 */
export async function getActivityHeatmap(cli: GitCli, repo: string): Promise<GitActivityCell[]> {
	let lines: string[];
	try {
		lines = (await cli.run(['log', '--all', '--format=%aI', '--no-merges'], repo)).split(EOL).filter((line) => line !== '');
	} catch (_) {
		return [];
	}

	const counts = new Map<string, number>();
	for (const line of lines) {
		// %aI is strict ISO 8601 (author date), e.g. 2026-05-02T10:00:00+09:00. The weekday is
		// deliberately computed from ONLY the Y/M/D digits (as a UTC midnight), not by parsing
		// the full string with its offset into a real Date: `new Date(iso)` would convert to
		// the *local* time of the machine running Git Graph, shifting the weekday/hour near
		// midnight for an author in a different timezone than whoever is viewing the graph.
		const match = line.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
		if (match === null) continue;
		const weekday = new Date(Date.UTC(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10))).getUTCDay();
		const hour = parseInt(match[4], 10);
		const key = weekday + '-' + hour;
		counts.set(key, (counts.get(key) || 0) + 1);
	}

	const cells: GitActivityCell[] = [];
	counts.forEach((count, key) => {
		const [weekday, hour] = key.split('-').map((n) => parseInt(n, 10));
		cells.push({ weekday, hour, count });
	});
	return cells;
}
