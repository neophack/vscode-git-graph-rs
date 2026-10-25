/**
 * The graph theme: one page of the commit log — the walk, its filters, the Gerrit change commits
 * pinned onto the page, and the uncommitted-change count that decides whether the synthetic
 * "Uncommitted Changes" row appears above HEAD.
 */

import {
	GitBackendError,
	GitCommitData,
	GitCommitStash,
	GitStash,
	LogOptions,
	UNCOMMITTED
} from '../../../../backend/types';
import type { AbortLike } from '../../process/gitProcess';
import { EOL, GitCli, message, SEPARATOR } from './process';
import { LogRecord, parseLogRecord } from './parse/log';
import { getStashes, readRefs } from './refs';

/** A page of the graph. The optional signal cancels the log walk (see {@link AbortLike}). */
export async function getCommits(cli: GitCli, repo: string, options: LogOptions, signal?: AbortLike): Promise<GitCommitData> {
	try {
		// A deferred load skips the remote-tracking refs, exactly as the engine does (see
		// `LogOptions.deferRemoteRefs`): the log walks the local branches only, and the refs
		// scan leaves `refs/remotes/` alone.
		if (options.deferRemoteRefs) options = { ...options, showRemoteBranches: false };
		// The stashes are read once and shared: the log needs them first (their bases are walk
		// tips, so a stash hanging off a commit that no branch/tag/remote reaches still
		// renders — the engine adds the same tips, see graph.rs, keeping the backends in
		// parity), and the splice below reuses the same list.
		const stashesPromise = getStashes(cli, repo).catch(() => [] as GitStash[]);
		const logPromise = stashesPromise.then((stashes) => getLog(cli, repo, options, stashes.map((stash) => stash.baseHash), signal));
		const refsPromise = readRefs(cli, repo, {
			showRemoteBranches: options.showRemoteBranches ?? true,
			showRemoteHeads: options.showRemoteHeads ?? false,
			hideRemotes: options.hideRemotes ?? [],
			showChangeRefs: options.gerritShowChangeRefs ?? false
		});
		const countPromise =
			options.showUncommittedChanges && !options.deferUncommittedChanges
				? getUncommittedChangeCount(cli, repo, options.showUntrackedFiles ?? false)
				: null;
		countPromise?.catch(() => {
			/* re-thrown below if it is actually needed */
		});

		const [records, refs, stashes] = await Promise.all([logPromise, refsPromise, stashesPromise]);

		let commits = records;
		const moreCommitsAvailable = commits.length > options.maxCommits;
		if (moreCommitsAvailable) commits = commits.slice(0, options.maxCommits);
		await pinGerritChangeCommits(cli, repo, commits, options.gerritRefs ?? []);

		const nodes = commits.map((record) => ({
			...record,
			heads: [] as string[],
			tags: [] as { name: string; annotated: boolean }[],
			remotes: [] as { name: string; remote: string | null }[],
			stash: null as GitCommitStash | null
		}));

		/* The "Uncommitted Changes" row, above HEAD */
		const head = refs.refData.head;
		if (head !== null && countPromise !== null && nodes.some((node) => node.hash === head)) {
			const count = await countPromise;
			if (count > 0) {
				nodes.unshift({
					hash: UNCOMMITTED,
					parents: [head],
					author: '*',
					email: '',
					date: Math.round(Date.now() / 1000),
					message: `Uncommitted Changes (${count})`,
					heads: [],
					tags: [],
					remotes: [],
					stash: null
				});
			}
		}

		const lookup = new Map<string, number>();
		nodes.forEach((node, index) => lookup.set(node.hash, index));

		/* Stashes */
		const toInsert: { index: number; stash: GitStash }[] = [];
		for (const stash of stashes) {
			const own = lookup.get(stash.hash);
			const base = lookup.get(stash.baseHash);
			if (own !== undefined) {
				nodes[own].stash = {
					selector: stash.selector,
					baseHash: stash.baseHash,
					untrackedFilesHash: stash.untrackedFilesHash
				};
			} else if (base !== undefined) {
				toInsert.push({ index: base, stash });
			}
		}
		toInsert.sort((a, b) => (a.index !== b.index ? a.index - b.index : b.stash.date - a.stash.date));
		for (let i = toInsert.length - 1; i >= 0; i--) {
			const { index, stash } = toInsert[i];
			nodes.splice(index, 0, {
				hash: stash.hash,
				parents: [stash.baseHash],
				author: stash.author,
				email: stash.email,
				date: stash.date,
				message: stash.message,
				heads: [],
				tags: [],
				remotes: [],
				stash: {
					selector: stash.selector,
					baseHash: stash.baseHash,
					untrackedFilesHash: stash.untrackedFilesHash
				}
			});
		}
		lookup.clear();
		nodes.forEach((node, index) => lookup.set(node.hash, index));

		/* Ref labels */
		for (const ref of refs.refData.heads) {
			const index = lookup.get(ref.hash);
			if (index !== undefined) nodes[index].heads.push(ref.name);
		}
		if (options.showTags ?? true) {
			for (const tag of refs.refData.tags) {
				const index = lookup.get(tag.hash);
				if (index !== undefined) nodes[index].tags.push({ name: tag.name, annotated: tag.annotated });
			}
		}
		for (const ref of refs.refData.remotes) {
			const index = lookup.get(ref.hash);
			if (index === undefined) continue;
			const owner = (options.remotes ?? []).find((remote) => ref.name.startsWith(remote + '/'));
			nodes[index].remotes.push({ name: ref.name, remote: owner ?? null });
		}

		return {
			commits: nodes,
			head,
			tags: unique(refs.refData.tags.map((tag) => tag.name)),
			branches: refs.branches,
			moreCommitsAvailable,
			error: null
		};
	} catch (error) {
		// A cancellation is not a graph answer: the caller cancelled the load on purpose, so it
		// must see the cancellation rather than an empty page (the engine adapter rejects with
		// the same kind).
		if (error instanceof GitBackendError && error.kind === 'Cancelled') throw error;
		return { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: message(error) };
	}
}

/** How many uncommitted changes there are. */
export async function getUncommittedChangeCount(cli: GitCli, repo: string, includeUntracked: boolean): Promise<number> {
	const out = await cli.run(
		['status', '--porcelain', `--untracked-files=${includeUntracked ? 'all' : 'no'}`],
		repo
	);
	return out.split(EOL).filter((line) => line !== '').length;
}

async function getLog(cli: GitCli, repo: string, options: LogOptions, stashBaseTips: ReadonlyArray<string> = [], signal?: AbortLike): Promise<LogRecord[]> {
	const order = options.commitOrdering ?? 'date';
	const format = ['%H', '%P', '%an', '%ae', '%ct', '%s'].join(SEPARATOR);
	// One extra commit, so that the caller can tell whether the page was truncated.
	const args = [
		'-c',
		'log.showSignature=false',
		'log',
		`--max-count=${options.maxCommits + 1}`,
		`--format=${format}`,
		`--${order}-order`,
		'-z',
		// A tip that does not resolve is skipped, as the engine skips it: `HEAD` on an orphan
		// branch (no commit yet, other branches still there) or a stale branch name from the
		// view's saved state would otherwise fail the whole log with "bad revision".
		'--ignore-missing'
	];
	// `log.mailmap` (and not `--use-mailmap`, whose availability varies) maps %an/%ae through
	// the work tree's `.mailmap`, matching the engine's decline of the same request.
	if (options.useMailmap) args.splice(1, 0, '-c', 'log.mailmap=true');
	if (options.onlyFollowFirstParent) args.push('--first-parent');
	const authors = options.authors ?? [];
	// --fixed-strings so an author name with regex metacharacters (e.g. "dependabot[bot]")
	// still matches literally, and --regexp-ignore-case to mirror the native engine's
	// case-insensitive comparison (see log.rs's matches_author).
	if (authors.length > 0) args.push('--regexp-ignore-case', '--fixed-strings');
	for (const author of authors) args.push(`--author=${author} <`);

	if (options.branches) {
		args.push(...options.branches);
	} else {
		args.push('--branches');
		if (options.showTags && options.showCommitsOnlyReferencedByTags) args.push('--tags');
		if (options.includeCommitsMentionedByReflogs) args.push('--reflog');
		if (options.showRemoteBranches ?? true) {
			// Gerrit change refs are excluded wholesale: a Gerrit repository can hold tens of
			// thousands of them, and the ones that belong in the graph are added explicitly.
			args.push('--exclude=*/changes/*');
			// Hidden remotes are excluded from the walk itself, as the engine does (it drops
			// their refs before resolving the walk's tips): their commits must not appear in
			// the graph unlabeled — the two backends have to draw the same commit set.
			for (const remote of options.hideRemotes ?? []) args.push(`--exclude=${remote}/*`);
			args.push('--remotes');
		}
		args.push('HEAD');
	}
	// Stashes hang off commits that may not be reachable from any of the refs above, so their
	// bases are walk tips too (a tip that no longer resolves is skipped via --ignore-missing).
	for (const tip of stashBaseTips) args.push(tip);
	for (const ref of options.gerritRefs ?? []) args.push(ref);

	const paths = (options.filterPaths ?? []).filter((path) => path !== '');
	if (paths.length > 0) args.push('--full-history', '--simplify-merges');
	args.push('--', ...paths);

	const out = await cli.run(args, repo, signal);
	const records: LogRecord[] = [];
	for (const record of out.replace(/\0$/, '').split('\0')) {
		const parsed = parseLogRecord(record);
		if (parsed !== null) records.push(parsed);
	}
	return records;
}

/**
 * Keep the commits of the injected Gerrit change refs on the page, exactly as the engine does
 * (see `log::pin_commits`): the log keeps the newest `maxCommits` commits only, so a change
 * whose patchset is older than the page's last commit would lose its row — and with it the
 * badge the fetch limit promised. Each missing patchset commit is read and inserted at its
 * date position (below every newer commit, above every older one). A ref that does not
 * resolve is skipped rather than failing the load.
 */
async function pinGerritChangeCommits(cli: GitCli, repo: string, commits: LogRecord[], gerritRefs: ReadonlyArray<string>) {
	if (gerritRefs.length === 0) return;
	const present = new Set(commits.map((commit) => commit.hash));
	const missing: string[] = [];
	for (const ref of gerritRefs) {
		const hash = await cli.run(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], repo).then((out) => out.trim()).catch(() => '');
		if (hash !== '' && !present.has(hash)) {
			present.add(hash);
			missing.push(hash);
		}
	}
	if (missing.length === 0) return;
	const format = ['%H', '%P', '%an', '%ae', '%ct', '%s'].join(SEPARATOR);
	const out = await cli.run(['-c', 'log.showSignature=false', 'log', '--no-walk=unsorted', `--format=${format}`, '-z', ...missing], repo);
	for (const record of out.replace(/\0$/, '').split('\0')) {
		const pinned = parseLogRecord(record);
		if (pinned === null) continue;
		let position = commits.findIndex((commit) => commit.date < pinned.date);
		if (position === -1) position = commits.length;
		commits.splice(position, 0, pinned);
	}
}

function unique(values: ReadonlyArray<string>): string[] {
	return Array.from(new Set(values));
}
