/**
 * The `git` command line, behind the same interface as the Rust engine.
 *
 * This exists so that the rewrite never has to be finished before it can ship. Anything the engine
 * cannot answer yet — an unusual repository layout, a platform with no prebuilt binary, a
 * capability still on the roadmap — is answered here instead, and the calling code cannot tell the
 * difference. As the engine grows, this shrinks; the interface does not move.
 *
 * It is a faithful port of how the original extension read a repository, down to the record
 * separator, because its output is what the engine is checked against.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { GitBackend } from './api';
import {
	GitAuthor,
	GitBackendError,
	GitCommitData,
	GitCommitDetails,
	GitCommitFile,
	GitCommitStash,
	GitCommitSummary,
	GitConfigSnapshot,
	GitFileChange,
	GitFileStatus,
	GitHistoryMatch,
	GitLineCounts,
	GitRef,
	GitRefData,
	GitRemoteConfig,
	GitRepoInfo,
	GitSignatureStatus,
	GitStash,
	GitTagDetails,
	GitTagRef,
	LogOptions,
	UNCOMMITTED
} from './types';

/**
 * A separator that cannot appear in a commit message, author name or path.
 *
 * The original extension uses this exact string; keeping it identical means the two
 * implementations parse the same output the same way.
 */
const SEPARATOR = 'XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb';

const EOL = /\r\n|\r|\n/;

/** How much output a single `git` call may produce before it is treated as runaway. */
const MAX_BUFFER = 100 * 1024 * 1024;

export class CliBackend implements GitBackend {
	public readonly name = 'git-cli';

	/** The whole-diff numstat counts of the last counts request, settled in batches. */
	private numStatCache: { repo: string; base: string; to: string; counts: { [path: string]: GitLineCounts } } | null = null;

	constructor(private readonly gitPath: string = 'git') {}

	/* ---------- Lifecycle ---------- */

	/**
	 * There is no handle to open: every call spawns its own process. The path is still resolved,
	 * so that the caller gets the same "which repository did I land in" answer either way.
	 */
	public async openRepository(path: string): Promise<string> {
		const root = await this.run(['rev-parse', '--show-toplevel'], path);
		return root.trim();
	}

	public closeRepository(): void {
		/* Nothing is held open. */
	}

	public closeAllRepositories(): void {
		/* Nothing is held open. */
	}

	/* ---------- Reads ---------- */

	public async getRepoInfo(repo: string, options = {}): Promise<GitRepoInfo> {
		const opts = { showRemoteBranches: true, showStashes: true, ...options };
		try {
			const [refs, remotes, stashes] = await Promise.all([
				this.readRefs(repo, opts),
				this.getRemotes(repo),
				opts.showStashes ? this.getStashes(repo) : Promise.resolve([] as GitStash[])
			]);
			return {
				branches: refs.branches,
				head: refs.refData.head,
				remotes,
				stashes,
				tags: refs.tagNames,
				error: null
			};
		} catch (error) {
			return {
				branches: [],
				head: null,
				remotes: [],
				stashes: [],
				tags: [],
				error: message(error)
			};
		}
	}

	public async getCommits(repo: string, options: LogOptions): Promise<GitCommitData> {
		try {
			// A deferred load skips the remote-tracking refs, exactly as the engine does (see
			// `LogOptions.deferRemoteRefs`): the log walks the local branches only, and the refs
			// scan leaves `refs/remotes/` alone.
			if (options.deferRemoteRefs) options = { ...options, showRemoteBranches: false };
			// The log, the refs and the working-tree scan are independent, so all three processes
			// are started before any of them is awaited.
			const logPromise = this.getLog(repo, options);
			const refsPromise = this.readRefs(repo, {
				showRemoteBranches: options.showRemoteBranches ?? true,
				showRemoteHeads: options.showRemoteHeads ?? false,
				hideRemotes: options.hideRemotes ?? [],
				showChangeRefs: options.gerritShowChangeRefs ?? false
			});
			const countPromise =
				options.showUncommittedChanges && !options.deferUncommittedChanges
					? this.getUncommittedChangeCount(repo, options.showUntrackedFiles ?? false)
					: null;
			countPromise?.catch(() => {
				/* re-thrown below if it is actually needed */
			});

			const [records, refs] = await Promise.all([logPromise, refsPromise]);
			const stashes = await this.getStashes(repo).catch(() => [] as GitStash[]);

			let commits = records;
			const moreCommitsAvailable = commits.length > options.maxCommits;
			if (moreCommitsAvailable) commits = commits.slice(0, options.maxCommits);

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
			return { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: message(error) };
		}
	}

	public async getRefs(repo: string, options = {}): Promise<GitRefData> {
		const snapshot = await this.readRefs(repo, { showRemoteBranches: true, ...options });
		return snapshot.refData;
	}

	public async getCommitDetails(repo: string, hash: string): Promise<GitCommitDetails> {
		const details = await this.getCommitDetailsBase(repo, hash);
		const from = details.parents.length > 0 ? hash + '^' : EMPTY_TREE;
		details.fileChanges = await this.getFileChanges(repo, from, hash);
		return details;
	}

	public async getUncommittedDetails(repo: string): Promise<GitCommitDetails> {
		// `git diff HEAD` sees neither untracked files nor files deleted from the working tree, so
		// the status scan is layered on top of it — as the original extension does. An unborn HEAD
		// (a fresh repository with no commits) cannot be diffed against at all: everything the
		// status scan reports — untracked files — is then the whole difference.
		const headExists = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], repo)
			.then((out) => out.trim() !== '', () => false);
		const [changes, status] = await Promise.all([
			headExists ? this.getFileChanges(repo, 'HEAD', '') : Promise.resolve(<GitFileChange[]>[]),
			this.getStatusFiles(repo)
		]);
		return {
			hash: UNCOMMITTED,
			parents: [],
			author: '',
			authorEmail: '',
			authorDate: 0,
			committer: '',
			committerEmail: '',
			committerDate: 0,
			signature: null,
			body: '',
			fileChanges: mergeStatusFiles(changes, status)
		};
	}

	/**
	 * The untracked and deleted files of the working tree.
	 *
	 * `git status -z` terminates each entry with a NUL, and a rename spends two entries (the new
	 * path then the old one), which is why the cursor advances by two for `R` and `C`.
	 */
	private async getStatusFiles(repo: string): Promise<{ deleted: string[]; untracked: string[] }> {
		const out = await this.run(
			['status', '-s', '--untracked-files=all', '--porcelain', '-z'],
			repo
		);
		const entries = out.split('\u0000');
		const status = { deleted: [] as string[], untracked: [] as string[] };
		for (let i = 0; i < entries.length && entries[i] !== ''; ) {
			if (entries[i].length < 4) break;
			const path = entries[i].slice(3);
			const staged = entries[i][0];
			const unstaged = entries[i][1];

			if (staged === 'D' || unstaged === 'D') status.deleted.push(path);
			else if (staged === '?' || unstaged === '?') status.untracked.push(path);

			i += staged === 'R' || unstaged === 'R' || staged === 'C' || unstaged === 'C' ? 2 : 1;
		}
		return status;
	}

	public async getStashDetails(
		repo: string,
		hash: string,
		stash: GitCommitStash
	): Promise<GitCommitDetails> {
		const details = await this.getCommitDetailsBase(repo, hash);
		details.fileChanges = await this.getFileChanges(repo, stash.baseHash, hash);
		if (stash.untrackedFilesHash !== null) {
			const untracked = await this.getFileChanges(repo, EMPTY_TREE, stash.untrackedFilesHash);
			for (const change of untracked) {
				if (change.type === GitFileStatus.Added) {
					details.fileChanges.push({ ...change, type: GitFileStatus.Untracked });
				}
			}
		}
		return details;
	}

	public async compareCommits(repo: string, from: string, to: string): Promise<GitFileChange[]> {
		const againstWorktree = to === UNCOMMITTED || to === '';
		const changes = await this.getFileChanges(repo, from, againstWorktree ? '' : to);
		// Comparing against the working tree means the untracked and deleted files count too.
		return againstWorktree ? mergeStatusFiles(changes, await this.getStatusFiles(repo)) : changes;
	}

	/**
	 * The `+N/-M` line counts of the given paths, as `git diff --numstat` reports them — the
	 * deferred second half of a details load, settled a viewport at a time.
	 *
	 * The counts cannot be limited to the asked-for paths by a pathspec: a rename's old path would
	 * fall outside the limit, so the pair would never be made and a moved file would count as a
	 * wholesale addition. The whole diff is counted instead — the cost the original extension paid
	 * on every details load — and kept for the batches that follow, which settle from memory.
	 */
	public async getLineCounts(repo: string, from: string | null, to: string, paths: ReadonlyArray<string>): Promise<{ [path: string]: GitLineCounts }> {
		if (paths.length === 0) return {};
		let base = from;
		if (base === null) {
			// The commit's first parent — or the empty tree for a root commit, whose files then
			// report as added rather than being unaccounted for.
			base = await this.run(['rev-parse', '--verify', to + '^'], repo).then((out) => out.trim(), () => EMPTY_TREE);
		}

		const counts = await this.numStatCounts(repo, base, to);
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
	private async numStatCounts(repo: string, base: string, to: string): Promise<{ [path: string]: GitLineCounts }> {
		if (this.numStatCache !== null && this.numStatCache.repo === repo && this.numStatCache.base === base && this.numStatCache.to === to) {
			return this.numStatCache.counts;
		}

		const numStat = await this.run(['diff', '--numstat', '--find-renames', '-z', base, to], repo);
		const counts: { [path: string]: GitLineCounts } = {};

		const fields = numStat.split('\0');
		for (let i = 0; i < fields.length && fields[i] !== ''; ) {
			const parts = fields[i].split('\t');
			if (parts.length !== 3) break;
			// A rename's numstat record has an empty path, followed by the two paths as separate
			// NUL-terminated fields; the new path (the last one) is what the counts are keyed by.
			const path = parts[2] !== '' ? parts[2] : fields[i + 2];
			const additions = parseInt(parts[0], 10);
			const deletions = parseInt(parts[1], 10);
			counts[path] = {
				// A binary file reports a dash, which parses to NaN and is reported as "unknown".
				additions: Number.isNaN(additions) ? null : additions,
				deletions: Number.isNaN(deletions) ? null : deletions
			};
			i += parts[2] !== '' ? 1 : 3;
		}

		this.numStatCache = { repo, base, to, counts };
		return counts;
	}

	public async getUncommittedChangeCount(repo: string, includeUntracked: boolean): Promise<number> {
		const out = await this.run(
			['status', '--porcelain', `--untracked-files=${includeUntracked ? 'all' : 'no'}`],
			repo
		);
		return out.split(EOL).filter((line) => line !== '').length;
	}

	public async getStashes(repo: string): Promise<GitStash[]> {
		const format = ['%H', '%P', '%gD', '%an', '%ae', '%ct', '%s'].join(SEPARATOR);
		const out = await this.run(['reflog', `--format=${format}`, 'refs/stash', '--'], repo).catch(
			() => ''
		);
		const stashes: GitStash[] = [];
		for (const line of out.split(EOL)) {
			const fields = line.split(SEPARATOR);
			if (fields.length !== 7 || fields[1] === '') continue;
			const parents = fields[1].split(' ');
			stashes.push({
				hash: fields[0],
				baseHash: parents[0],
				untrackedFilesHash: parents.length === 3 ? parents[2] : null,
				selector: fields[2],
				author: fields[3],
				email: fields[4],
				date: parseInt(fields[5], 10),
				message: fields[6]
			});
		}
		return stashes;
	}

	/* ---------- Configuration & file contents ---------- */

	/**
	 * The configuration values the view consumes, read with a single `git config -l -z`.
	 *
	 * The `-z` output is `key\nvalue\0` per entry, which cannot be confused by embedded newlines in
	 * values. Later entries win, matching how Git resolves repeated keys.
	 */
	public async getConfig(repo: string): Promise<GitConfigSnapshot> {
		const [configOut, remotes] = await Promise.all([this.run(['config', '-l', '-z'], repo), this.getRemotes(repo)]);
		const values = new Map<string, string>();
		for (const entry of configOut.replace(/\u0000$/, '').split('\u0000')) {
			const separator = entry.indexOf('\n');
			if (separator === -1) continue;
			values.set(entry.slice(0, separator), entry.slice(separator + 1));
		}
		const get = (key: string): string | null => values.get(key) ?? null;

		const remoteConfigs: GitRemoteConfig[] = remotes.map((name) => ({
			name,
			url: get(`remote.${name}.url`),
			pushUrl: get(`remote.${name}.pushurl`)
		}));
		return {
			remotes: remoteConfigs,
			userName: get('user.name'),
			userEmail: get('user.email'),
			pushDefault: get('remote.pushdefault'),
			diffTool: get('diff.tool'),
			diffGuiTool: get('diff.guitool')
		};
	}

	/**
	 * The contents of one file at one revision, via `git show --textconv` — the same command the
	 * original extension used. A NUL byte in the first 8000 bytes marks the file as binary, and the
	 * contents are then omitted.
	 */
	public async getCommitFile(repo: string, hash: string, file: string): Promise<GitCommitFile> {
		const stdout = await new Promise<Buffer>((resolve, reject) => {
			execFile(
				this.gitPath,
				['show', '--textconv', `${hash}:${file}`],
				{ cwd: repo, maxBuffer: MAX_BUFFER, encoding: 'buffer' },
				(error, stdout, stderr) => {
					if (error) {
						const text = (stderr || stdout || error.message).toString().trim();
						const kind = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Unsupported' : 'Git';
						reject(new GitBackendError(kind, text));
					} else {
						resolve(stdout);
					}
				}
			);
		});
		const binary = stdout.subarray(0, 8000).includes(0);
		return {
			contents: binary ? null : stdout.toString('utf8'),
			binary
		};
	}

	/**
	 * The unified diff of one file in one commit (against its first parent).
	 *
	 * The diff of the whole commit is filtered down to the file, rather than passed as a pathspec,
	 * so that a rename is shown as a rename (the way the engine reports it) instead of as a new
	 * file with an unrelated deletion.
	 */
	public async getCommitFileDiff(repo: string, hash: string, file: string): Promise<string> {
		// A root commit has no first parent: git diff would fail on `hash^`, so the empty tree —
		// whose hash is fixed by the object format — stands in as the base, exactly as
		// `git show <root>` diffs against it. `core.quotepath=false` keeps non-ASCII paths raw in
		// the headers instead of C-quoted octal escapes (a pathspec could not be used instead: it
		// would exclude the old side of a rename and break its pairing), and the diff.*Prefix
		// settings pin the `a/` and `b/` header prefixes the sections are matched by, which a
		// repository's own configuration would otherwise be free to change.
		const parent = await this.run(['rev-parse', '--verify', '--quiet', `${hash}^`], repo)
			.then((out) => out.trim())
			.catch(() => '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
		const out = await this.run([
			'-c', 'core.quotepath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
			'-c', 'diff.srcPrefix=a/', '-c', 'diff.dstPrefix=b/',
			'diff', '--no-color', '--find-renames', parent, hash
		], repo);
		return out
			.split(/(?=^diff --git )/m)
			.filter((section) => diffSectionNewPath(section) === file)
			.join('')
			.replace(/\n$/m, '');
	}

	/* ---------- On-demand reads ---------- */

	/** The full commit message of each of the given commits, keyed by hash. */
	public async getCommitBodies(repo: string, hashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }> {
		// With no hashes there is nothing to ask for — and `git log --no-walk` with no revisions
		// would silently default to HEAD, answering a question nobody asked.
		if (hashes.length === 0) return {};
		const out = await this.run(
			['-c', 'log.showSignature=false', 'log', '--no-walk', '--format=%H%x1f%B%x1e', ...hashes],
			repo
		);
		const bodies: { [hash: string]: string } = {};
		for (let record of out.split('\x1e')) {
			record = record.replace(/^\n/, ''); // git terminates each formatted entry with a newline
			const sep = record.indexOf('\x1f');
			if (sep <= 0) continue;
			bodies[record.substring(0, sep)] = record.substring(sep + 1).replace(/\n$/, '');
		}
		return bodies;
	}

	/** The subject of one commit, whitespace-normalised as the extension has always shown it. */
	public async getCommitSubject(repo: string, hash: string): Promise<string> {
		const out = await this.run(
			['-c', 'log.showSignature=false', 'log', '--format=%s', '-n', '1', hash, '--'],
			repo
		);
		return out.trim().replace(/\s+/g, ' ');
	}

	/** The summary of each of the given commits, keyed by hash. */
	public async getCommitSummaries(
		repo: string,
		hashes: ReadonlyArray<string>
	): Promise<{ [hash: string]: GitCommitSummary }> {
		const out = await this.run(
			['show', '--quiet', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B%x1e', ...hashes],
			repo
		);
		const summaries: { [hash: string]: GitCommitSummary } = {};
		for (const record of out.replace(/\x1e\s*$/, '').split('\x1e')) {
			const parts = record.trim().split('\x1f');
			if (parts.length === 5) {
				summaries[parts[0]] = {
					hash: parts[0],
					author: parts[1],
					email: parts[2],
					date: parseInt(parts[3], 10),
					message: parts[4].trim()
				};
			}
		}
		return summaries;
	}

	/** The commits whose message matches a pattern, newest first. */
	public async searchHistory(repo: string, query: string): Promise<GitHistoryMatch[]> {
		// The unit separator (\x1f) is used instead of `|` so that hashes, author names and
		// subjects containing `|` don't shift the fields.
		const out = await this.run(
			['log', '--all', '-E', '-i', `--grep=${query}`, '--format=%H%x1f%an%x1f%at%x1f%s', '--max-count=100'],
			repo
		);
		const text = out.replace(/\n$/, '');
		if (text === '') return [];
		return text.split('\n').map((line) => {
			const parts = line.split('\x1f');
			return {
				hash: parts[0],
				author: parts[1],
				date: parseInt(parts[2], 10),
				message: parts.slice(3).join('|')
			};
		});
	}

	/** A tag in full, read from the ref as `for-each-ref` reports it. */
	public async getTagDetails(repo: string, tagName: string): Promise<GitTagDetails> {
		const ref = `refs/tags/${tagName}`;
		const format = [
			'%(objectname)',
			'%(taggername)',
			'%(taggeremail)',
			'%(taggerdate:unix)',
			'%(contents:signature)',
			'%(contents)'
		].join(SEPARATOR);
		const out = await this.run(['for-each-ref', ref, `--format=${format}`], repo);
		const data = out.split(SEPARATOR);
		if (data.length < 6 || data[0] === '') {
			throw new GitBackendError('NotFound', `Could not find the tag ${tagName}`);
		}
		const signed = data[4] !== '';
		const taggerDate = parseInt(data[3], 10);
		return {
			hash: data[0],
			taggerName: data[1],
			taggerEmail: data[2].substring(data[2].startsWith('<') ? 1 : 0, data[2].length - (data[2].endsWith('>') ? 1 : 0)),
			// A lightweight tag has no tagger date to parse; the epoch stands in where the
			// original's parse produced nothing.
			taggerDate: Number.isNaN(taggerDate) ? 0 : taggerDate,
			message: removeTrailingBlankLines(
				data
					.slice(5)
					.join(SEPARATOR)
					.replace(data[4], '')
					.split(EOL)
			).join('\n'),
			// As with commit signatures on this backend, presence is reported without verification.
			signature: signed
				? { key: '', signer: '', status: GitSignatureStatus.CannotBeChecked }
				: null
		};
	}

	/** The fetch URL of a remote, or NULL when it is not configured. */
	public async getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		try {
			const out = await this.run(['config', '--get', `remote.${remote}.url`], repo);
			return out.split(EOL)[0];
		} catch {
			// `git config --get` exits non-zero when the key is unset: that is the answer, not a failure.
			return null;
		}
	}

	/** Where a file was renamed to between a commit and the working tree, or NULL. */
	public async getNewPathOfRenamedFile(
		repo: string,
		commitHash: string,
		oldFilePath: string
	): Promise<string | null> {
		const out = await this.run(
			['diff', '--name-status', '--find-renames', '--diff-filter=R', '-z', commitHash],
			repo
		);
		const fields = out.split('\0');
		for (let i = 0; i < fields.length && fields[i] !== ''; ) {
			const type = fields[i][0];
			if (type === GitFileStatus.Renamed) {
				if (fields[i + 1] === oldFilePath) return fields[i + 2];
				i += 3;
			} else if (
				type === GitFileStatus.Added ||
				type === GitFileStatus.Modified ||
				type === GitFileStatus.Deleted
			) {
				i += 2;
			} else {
				break;
			}
		}
		return null;
	}

	/** The roots of the repository's initialised submodules. */
	public getSubmodules(repo: string): Promise<string[]> {
		return new Promise<string[]>((resolve) => {
			fs.readFile(path.join(repo, '.gitmodules'), { encoding: 'utf8' }, async (err, data) => {
				const submodules: string[] = [];
				if (!err) {
					const lines = data.split(/\r\n|\r|\n/);
					let inSubmoduleSection = false;
					const section = /^\s*\[.*\]\s*$/,
						submodule = /^\s*\[submodule "([^"]+)"\]\s*$/,
						pathProp = /^\s*path\s+=\s+(.*)$/;

					for (const line of lines) {
						if (line.match(section) !== null) {
							inSubmoduleSection = line.match(submodule) !== null;
							continue;
						}
						const match = inSubmoduleSection ? line.match(pathProp) : null;
						if (match === null) continue;

						// A submodule that was never initialised has no repository below its path;
						// resolving the path's root drops it, as `rev-parse` fails there.
						try {
							const root = await this.run(
								['rev-parse', '--show-toplevel'],
								path.join(repo, match[1].trim())
							);
							const normalised = path.normalize(root.trim());
							if (!submodules.includes(normalised)) submodules.push(normalised);
						} catch {
							/* not initialised (or no longer present): nothing to list */
						}
					}
				}
				resolve(submodules);
			});
		});
	}

	/** The upstream of the checked-out branch, or NULL when there is none. */
	public async getCurrentBranchUpstream(repo: string): Promise<string | null> {
		try {
			const out = await this.run(
				['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
				repo
			);
			return out.trim() || null;
		} catch {
			return null;
		}
	}

	/** How many commits are reachable from the given refs but not from `hash`. */
	public async countCommitsBefore(
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
			args.push('HEAD');
		}
		args.push(`^${hash}`);
		const out = await this.run(args, repo);
		const count = parseInt(out.trim(), 10);
		if (Number.isNaN(count)) {
			throw new GitBackendError('Git', `Could not count the commits before ${hash}`);
		}
		return count;
	}

	/** The root of the repository containing a path. */
	public async repoRoot(path: string): Promise<string> {
		const out = await this.run(['rev-parse', '--show-toplevel'], path);
		return out.trim();
	}

	/** The names of the repository's remotes. */
	public async getRemotes(repo: string): Promise<string[]> {
		const out = await this.run(['remote'], repo);
		return out.split(EOL).filter((line) => line !== '');
	}

	/**
	 * The distinct commit authors of the current branch's history: counted per (name, email)
	 * spelling over HEAD's history, de-duplicated by name (the most-prolific spelling first, then
	 * sorted by name) — the same reduce the engine performs. `git shortlog` is deliberately not
	 * used: it applies `.mailmap` by default, which would disagree with both the engine and the
	 * author names the commit rows themselves display.
	 */
	public async getAuthors(repo: string): Promise<GitAuthor[]> {
		const out = await this.run(['log', '--format=%an%x1f%ae', 'HEAD'], repo);
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

	/** The config entries of one location, last value per key. */
	public async getConfigList(repo: string, location: 'local' | 'global'): Promise<{ [key: string]: string }> {
		const out = await this.run(
			['--no-pager', 'config', '--list', '-z', '--includes', `--${location}`],
			repo
		).catch((error) => {
			const message = String(error instanceof Error ? error.message : error).toLowerCase();
			if (message.startsWith('fatal: unable to read config file') && message.endsWith('no such file or directory')) {
				return '';
			}
			throw error;
		});
		const configs: { [key: string]: string } = {};
		const pairs = out.split('\0');
		for (let i = 0; i < pairs.length - 1; i++) {
			const lines = pairs[i].split(EOL);
			const key = lines.shift()!;
			configs[key] = lines.join('\n');
		}
		return configs;
	}

	/** The checked-out branch's short name, or NULL when HEAD is detached. */
	public async currentBranchName(repo: string): Promise<string | null> {
		try {
			const out = await this.run(['symbolic-ref', '--short', 'HEAD'], repo);
			return out.trim() || null;
		} catch {
			return null;
		}
	}

	/* ---------- Internals ---------- */

	private async getLog(repo: string, options: LogOptions) {
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
			'-z'
		];
		if (options.onlyFollowFirstParent) args.push('--first-parent');
		for (const author of options.authors ?? []) args.push(`--author=${author} <`);

		if (options.branches) {
			args.push(...options.branches);
		} else {
			args.push('--branches');
			if (options.showTags && options.showCommitsOnlyReferencedByTags) args.push('--tags');
			if (options.includeCommitsMentionedByReflogs) args.push('--reflog');
			if (options.showRemoteBranches ?? true) {
				// Gerrit change refs are excluded wholesale: a Gerrit repository can hold tens of
				// thousands of them, and the ones that belong in the graph are added explicitly.
				args.push('--exclude=*/changes/*', '--remotes');
			}
			args.push('HEAD');
		}
		for (const ref of options.gerritRefs ?? []) args.push(ref);

		const paths = (options.filterPaths ?? []).filter((path) => path !== '');
		if (paths.length > 0) args.push('--full-history', '--simplify-merges');
		args.push('--', ...paths);

		const out = await this.run(args, repo);
		const records = [];
		for (const record of out.replace(/\0$/, '').split('\0')) {
			const fields = record.split(SEPARATOR);
			if (fields.length < 6) continue;
			records.push({
				hash: fields[0],
				parents: fields[1] ? fields[1].split(' ') : [],
				author: fields[2],
				email: fields[3],
				date: parseInt(fields[4], 10),
				message: fields.slice(5).join(SEPARATOR)
			});
		}
		return records;
	}

	/**
	 * Read every ref the view needs.
	 *
	 * The two calls are split the way the original extension splits them, and for the same reason:
	 * `show-ref -d` peels, which costs an object lookup per ref and is only affordable over the
	 * local branches and tags; `for-each-ref` over `refs/remotes/` does not peel, which is what
	 * makes the one unavoidably broad scan cheap.
	 */
	private async readRefs(
		repo: string,
		options: {
			showRemoteBranches?: boolean;
			showRemoteHeads?: boolean;
			hideRemotes?: ReadonlyArray<string>;
			showChangeRefs?: boolean;
		}
	) {
		const [local, remote, branchHead] = await Promise.all([
			this.run(['show-ref', '--heads', '--tags', '-d', '--head'], repo).catch(() => ''),
			options.showRemoteBranches ?? true
				? this.run(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/'], repo).catch(
						() => ''
					)
				: Promise.resolve(''),
			this.run(['symbolic-ref', '-q', '--short', 'HEAD'], repo)
				.then((out) => out.trim() || null)
				.catch(() => null)
		]);

		const refData: { head: string | null; heads: GitRef[]; tags: GitTagRef[]; remotes: GitRef[] } = {
			head: null,
			heads: [],
			tags: [],
			remotes: []
		};
		const branches: string[] = [];
		const tagNames: string[] = [];

		for (const line of local.split(EOL)) {
			const separator = line.indexOf(' ');
			if (separator === -1) continue;
			const hash = line.slice(0, separator);
			const ref = line.slice(separator + 1);

			if (ref.startsWith('refs/heads/')) {
				const name = ref.slice(11);
				refData.heads.push({ hash, name });
				branches.push(name);
			} else if (ref.startsWith('refs/tags/')) {
				const annotated = ref.endsWith('^{}');
				const name = annotated ? ref.slice(10, -3) : ref.slice(10);
				refData.tags.push({ hash, name, annotated });
				if (!annotated) tagNames.push(name);
			} else if (ref === 'HEAD') {
				refData.head = hash;
			}
		}

		const hidden = (options.hideRemotes ?? []).map((name) => `refs/remotes/${name}/`);
		for (const line of remote.split(EOL)) {
			const separator = line.indexOf(' ');
			if (separator === -1) continue;
			const hash = line.slice(0, separator);
			const ref = line.slice(separator + 1);
			if (!ref.startsWith('refs/remotes/')) continue;
			if (hidden.some((prefix) => ref.startsWith(prefix))) continue;
			if (!options.showRemoteHeads && ref.endsWith('/HEAD')) continue;

			const name = ref.slice(13);
			const tagsIndex = name.indexOf('/tags/');
			if (tagsIndex > -1) {
				refData.tags.push({
					hash,
					name: name.slice(0, tagsIndex) + '/' + name.slice(tagsIndex + 6),
					annotated: false
				});
			} else if (name.includes('/changes/')) {
				// Never offered as branches, however they are displayed.
				if (options.showChangeRefs && !name.endsWith('/meta')) refData.remotes.push({ hash, name });
			} else {
				refData.remotes.push({ hash, name });
				branches.push('remotes/' + name);
			}
		}

		/* The checked-out branch is listed first, as `git branch` lists it */
		if (branchHead !== null) {
			const index = branches.indexOf(branchHead);
			if (index > 0) branches.splice(index, 1);
			if (index !== 0) branches.unshift(branchHead);
		}

		return { refData, branches, branchHead, tagNames: tagNames.sort() };
	}

	private async getCommitDetailsBase(repo: string, hash: string) {
		const format = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join(SEPARATOR);
		const out = await this.run(
			['-c', 'log.showSignature=false', 'show', '--quiet', hash, `--format=${format}`],
			repo
		);
		const fields = out.split(SEPARATOR);
		if (fields.length < 9) {
			throw new GitBackendError('NotFound', `Could not read the commit ${hash}`);
		}
		return {
			hash: fields[0],
			parents: fields[1] !== '' ? fields[1].split(' ') : [],
			author: fields[2],
			authorEmail: fields[3],
			authorDate: parseInt(fields[4], 10),
			committer: fields[5],
			committerEmail: fields[6],
			committerDate: parseInt(fields[7], 10),
			signature: null,
			body: fields.slice(8).join(SEPARATOR).trim(),
			fileChanges: [] as GitFileChange[]
		};
	}

	/**
	 * The file list between two revisions — the statuses only, from `--name-status`.
	 *
	 * The line counts used to be merged in from a second `--numstat` run here; they are the
	 * expensive half of a details load (every file costs two blob reads), so they are now answered
	 * separately, for the paths the view asks about, by [`getLineCounts`].
	 */
	private async getFileChanges(repo: string, from: string, to: string): Promise<GitFileChange[]> {
		const base = ['diff', '--name-status', '--find-renames', '--diff-filter=AMDR', '-z', from];
		if (to !== '') base.push(to);
		const nameStatus = await this.run(base, repo);

		const changes: GitFileChange[] = [];

		const statusFields = nameStatus.split('\0');
		for (let i = 0; i < statusFields.length && statusFields[i] !== ''; ) {
			const type = statusFields[i][0] as GitFileStatus;
			if (type === GitFileStatus.Renamed) {
				changes.push({
					oldFilePath: statusFields[i + 1],
					newFilePath: statusFields[i + 2],
					type,
					additions: null,
					deletions: null
				});
				i += 3;
			} else if (
				type === GitFileStatus.Added ||
				type === GitFileStatus.Modified ||
				type === GitFileStatus.Deleted
			) {
				changes.push({
					oldFilePath: statusFields[i + 1],
					newFilePath: statusFields[i + 1],
					type,
					additions: null,
					deletions: null
				});
				i += 2;
			} else {
				break;
			}
		}

		return changes;
	}

	/** Run one `git` process and return its stdout. */
	private run(args: ReadonlyArray<string>, cwd: string): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				this.gitPath,
				args as string[],
				{ cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
				(error, stdout, stderr) => {
					if (error) {
						const text = (stderr || stdout || error.message).trim();
						// A missing `git` is the one failure worth distinguishing: it means this
						// backend cannot answer anything, not that this call failed.
						const kind = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Unsupported' : 'Git';
						reject(new GitBackendError(kind, text));
					} else {
						resolve(stdout);
					}
				}
			);
		});
	}
}

/**
 * Layer the untracked and deleted files of the working tree onto a diff.
 *
 * A file deleted in the working tree but still in the index shows as deleted rather than
 * unchanged, and untracked files are appended — neither is visible to `git diff`.
 */
/**
 * The new path of one `diff --git` section: the file the section belongs to, matched exactly so
 * that a file whose name is a prefix of another's cannot catch its section.
 *
 * Git C-quotes a path containing quotes, backslashes or control characters (spaces and, with
 * `core.quotepath=false`, non-ASCII stay raw), and quotes each side of the header on its own — so
 * a header carries any of the four combinations of quoted and raw sides. A raw path may itself
 * contain " b/", which leaves the header line genuinely ambiguous (`a/x b/y b/x b/y` is one file
 * named `x b/y`, not the file `y`); the extended header lines below it name the sides one per
 * line, so they resolve what the header alone cannot.
 */
function diffSectionNewPath(section: string): string | null {
	const end = section.indexOf('\n');
	const candidates = diffHeaderPaths(end === -1 ? section : section.substring(0, end));
	if (candidates.length === 1) return candidates[0].newPath;
	if (candidates.length === 0) return null;
	const named = diffSectionNamedNewPath(section);
	if (named !== null) return named;
	// Nothing named the sides (a mode-only change of an ambiguous path): the split that gives both
	// sides the same name is the one Git itself prefers when re-reading its own headers.
	const same = candidates.find((candidate) => candidate.oldPath === candidate.newPath);
	return (same !== undefined ? same : candidates[0]).newPath;
}

/** Every way the two sides of a `diff --git` header line can be split (see {@link diffSectionNewPath}). */
function diffHeaderPaths(header: string): { oldPath: string; newPath: string }[] {
	const prefix = 'diff --git ';
	if (!header.startsWith(prefix)) return [];
	const body = header.substring(prefix.length);
	const paths: { oldPath: string; newPath: string }[] = [];
	if (body.charAt(0) === '"') {
		// A quoted old side ends at its own closing quote, so the split isn't ambiguous
		const closing = diffClosingQuote(body);
		if (closing === -1 || body.charAt(closing + 1) !== ' ') return [];
		const oldPath = diffSidePath(body.substring(0, closing + 1), 'a/');
		const newPath = diffSidePath(body.substring(closing + 2), 'b/');
		return oldPath !== null && newPath !== null ? [{ oldPath: oldPath, newPath: newPath }] : [];
	}
	for (let space = body.indexOf(' '); space !== -1; space = body.indexOf(' ', space + 1)) {
		const oldPath = diffSidePath(body.substring(0, space), 'a/');
		const newPath = diffSidePath(body.substring(space + 1), 'b/');
		if (oldPath !== null && newPath !== null) paths.push({ oldPath: oldPath, newPath: newPath });
	}
	return paths;
}

/**
 * The new path as named by the extended header lines of a section (`rename to` / `copy to`, or the
 * `+++` line), each of which carries one path that runs to the end of its line.
 * @returns The path, or NULL if no line named it.
 */
function diffSectionNamedNewPath(section: string): string | null {
	const lines = section.split('\n');
	let oldPath: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('@@')) break; // the hunks: every extended header line is above them
		if (line.startsWith('rename to ')) return diffNamedPath(line.substring(10));
		if (line.startsWith('copy to ')) return diffNamedPath(line.substring(8));
		if (line.startsWith('--- ')) {
			oldPath = diffSidePath(diffTrimTerminator(line.substring(4)), 'a/');
		} else if (line.startsWith('+++ ')) {
			// `+++ /dev/null` — the file was deleted, so both sides of the header name it
			const newPath = diffSidePath(diffTrimTerminator(line.substring(4)), 'b/');
			return newPath !== null ? newPath : oldPath;
		}
	}
	return null;
}

/**
 * Strip the tab Git terminates a raw `---`/`+++` path with when the path contains a space (so
 * that the end of the path is still findable). A path containing a tab is C-quoted instead — a
 * tab is a control character — so a trailing tab on a raw path is always Git's terminator.
 */
function diffTrimTerminator(side: string): string {
	return side.charAt(0) !== '"' && side.endsWith('\t') ? side.substring(0, side.length - 1) : side;
}

/** One `a/`- or `b/`-prefixed side of a header or `---`/`+++` line, unquoted. NULL => not that side. */
function diffSidePath(side: string, prefix: string): string | null {
	if (side.charAt(0) === '"') {
		if (diffClosingQuote(side) !== side.length - 1) return null;
		const path = unquoteCPath(side.substring(1, side.length - 1));
		return path.startsWith(prefix) ? path.substring(prefix.length) : null;
	}
	// Git quotes every path containing a quote, a backslash or a control character, so a raw
	// side that contains one is not a path at all — it is a mis-split of an ambiguous header
	if (/["\\\x00-\x1f\x7f]/.test(side)) return null;
	return side.startsWith(prefix) ? side.substring(prefix.length) : null;
}

/** One unprefixed path naming a whole line (`rename to <path>`), unquoted. */
function diffNamedPath(text: string): string | null {
	if (text.charAt(0) !== '"') return text;
	return diffClosingQuote(text) === text.length - 1 ? unquoteCPath(text.substring(1, text.length - 1)) : null;
}

/** The index of the quote closing the one opened at index 0 of `text` (-1 => unterminated). */
function diffClosingQuote(text: string): number {
	for (let i = 1; i < text.length; i++) {
		const char = text.charAt(i);
		if (char === '\\') i++;
		else if (char === '"') return i;
	}
	return -1;
}

const C_ESCAPES: { [escape: string]: string } = {
	'a': '\x07', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v', '\\': '\\', '"': '"'
};

/**
 * Undo Git's C-quoting of a path (the contents of the quotes, prefix included).
 *
 * Octal escapes are the individual bytes of one UTF-8 sequence, so consecutive ones are decoded
 * together rather than each becoming its own character.
 */
function unquoteCPath(quoted: string): string {
	const parts = quoted.match(/\\(?:[0-7]{1,3}|[\s\S])|[^\\]+/g);
	if (parts === null) return quoted;
	let out = '';
	let bytes: number[] = [];
	const flush = () => {
		if (bytes.length > 0) {
			out += Buffer.from(bytes).toString('utf8');
			bytes = [];
		}
	};
	for (const part of parts) {
		if (part.charAt(0) !== '\\') {
			flush();
			out += part;
		} else if (/^\\[0-7]{1,3}$/.test(part)) {
			bytes.push(parseInt(part.substring(1), 8) & 0xff);
		} else {
			flush();
			const escape = part.substring(1);
			out += typeof C_ESCAPES[escape] === 'string' ? C_ESCAPES[escape] : escape;
		}
	}
	flush();
	return out;
}

function mergeStatusFiles(changes: ReadonlyArray<GitFileChange>,
	status: { deleted: ReadonlyArray<string>; untracked: ReadonlyArray<string> }
): GitFileChange[] {
	const merged = [...changes];
	for (const path of status.deleted) {
		const index = merged.findIndex((change) => change.newFilePath === path);
		if (index !== -1) {
			merged[index] = { ...merged[index], type: GitFileStatus.Deleted };
		} else {
			merged.push({
				oldFilePath: path,
				newFilePath: path,
				type: GitFileStatus.Deleted,
				additions: null,
				deletions: null
			});
		}
	}
	for (const path of status.untracked) {
		merged.push({
			oldFilePath: path,
			newFilePath: path,
			type: GitFileStatus.Untracked,
			additions: null,
			deletions: null
		});
	}
	return merged;
}

/** Git's hash for the empty tree, used to diff a root commit against "nothing". */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function unique(values: ReadonlyArray<string>): string[] {
	return Array.from(new Set(values));
}

/** Remove the trailing blank lines of a message before showing it, as the original did. */
function removeTrailingBlankLines(lines: string[]): string[] {
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
