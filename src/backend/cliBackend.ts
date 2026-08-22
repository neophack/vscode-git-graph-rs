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

import { GitBackend } from './api';
import {
	GitBackendError,
	GitCommitData,
	GitCommitDetails,
	GitCommitFile,
	GitCommitStash,
	GitConfigSnapshot,
	GitFileChange,
	GitFileStatus,
	GitRef,
	GitRefData,
	GitRemoteConfig,
	GitRepoInfo,
	GitStash,
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
		// the status scan is layered on top of it — as the original extension does.
		const [changes, status] = await Promise.all([
			this.getFileChanges(repo, 'HEAD', ''),
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
		// `git show <root>` diffs against it.
		const parent = await this.run(['rev-parse', '--verify', '--quiet', `${hash}^`], repo)
			.then((out) => out.trim())
			.catch(() => '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
		const out = await this.run(['diff', '--no-color', '--find-renames', parent, hash], repo);
		const wanted = `b/${file}`;
		return out
			.split(/(?=^diff --git )/m)
			.filter((section) => {
				const header = section.slice(0, section.indexOf('\n'));
				return header.includes(` ${wanted}`) || header.endsWith(wanted);
			})
			.join('')
			.replace(/\n$/m, '');
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

	private async getRemotes(repo: string): Promise<string[]> {
		const out = await this.run(['remote'], repo);
		return out.split(EOL).filter((line) => line !== '');
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
	 * The file list between two revisions.
	 *
	 * `--name-status` gives the statuses and `--numstat` the line counts; they are merged by path,
	 * which is how the original extension produced this list.
	 */
	private async getFileChanges(repo: string, from: string, to: string): Promise<GitFileChange[]> {
		const args = (kind: string) => {
			const base = ['diff', kind, '--find-renames', '--diff-filter=AMDR', '-z', from];
			if (to !== '') base.push(to);
			return base;
		};

		const [nameStatus, numStat] = await Promise.all([
			this.run(args('--name-status'), repo),
			this.run(args('--numstat'), repo)
		]);

		const changes: GitFileChange[] = [];
		const byPath = new Map<string, number>();

		const statusFields = nameStatus.split('\0');
		for (let i = 0; i < statusFields.length && statusFields[i] !== ''; ) {
			const type = statusFields[i][0] as GitFileStatus;
			if (type === GitFileStatus.Renamed) {
				byPath.set(statusFields[i + 2], changes.length);
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
				byPath.set(statusFields[i + 1], changes.length);
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

		const numFields = numStat.split('\0');
		for (let i = 0; i < numFields.length && numFields[i] !== ''; ) {
			const parts = numFields[i].split('\t');
			if (parts.length !== 3) break;
			// A rename's numstat record has an empty path, followed by the two paths as separate
			// NUL-terminated fields.
			const path = parts[2] !== '' ? parts[2] : numFields[i + 2];
			const index = byPath.get(path);
			if (index !== undefined) {
				const additions = parseInt(parts[0], 10);
				const deletions = parseInt(parts[1], 10);
				// A binary file reports a dash, which parses to NaN and is reported as "unknown".
				changes[index] = {
					...changes[index],
					additions: Number.isNaN(additions) ? null : additions,
					deletions: Number.isNaN(deletions) ? null : deletions
				};
			}
			i += parts[2] !== '' ? 1 : 3;
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
function mergeStatusFiles(
	changes: ReadonlyArray<GitFileChange>,
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

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
