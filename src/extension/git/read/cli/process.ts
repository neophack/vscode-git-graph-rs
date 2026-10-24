/**
 * The process adapter every CLI read theme is written against.
 *
 * Each call spawns its own `git` process — there is no handle to keep open — and the state the
 * readers share (the resolved empty tree of each repository, the last whole-diff numstat counts)
 * lives on this object, so each theme module stays a set of functions over one `GitCli`.
 */

import { execFile } from 'child_process';

import { GitBackendError, GitLineCounts } from '../../../../backend/types';

/**
 * A separator that cannot appear in a commit message, author name or path.
 *
 * The original extension uses this exact string; keeping it identical means the two
 * implementations parse the same output the same way.
 */
export const SEPARATOR = 'XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb';

export const EOL = /\r\n|\r|\n/;

/** How much output a single `git` call may produce before it is treated as runaway. */
export const MAX_BUFFER = 100 * 1024 * 1024;

/** Git's hash for the empty tree in a SHA-1 repository (the historical constant). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Git's hash for the empty tree in a SHA-256 repository. */
export const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

/** The whole-diff numstat counts of the last counts request, settled in batches. */
export interface NumStatCache {
	repo: string;
	base: string;
	to: string;
	counts: { [path: string]: GitLineCounts };
}

/** One `git` process per call, plus the per-instance caches the read themes share. */
export class GitCli {
	/** The whole-diff numstat counts of the last counts request, settled in batches. */
	public numStatCache: NumStatCache | null = null;

	/** The resolved empty tree of each repository, keyed by repo path (its hash is format-dependent). */
	private readonly emptyTrees = new Map<string, Promise<string>>();

	constructor(public readonly gitPath: string = 'git') {}

	/** Run one `git` process and return its stdout. */
	public run(args: ReadonlyArray<string>, cwd: string): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				this.gitPath,
				// i18n.logOutputEncoding is pinned so commit metadata (subjects, bodies, author
				// names, reflog messages) always arrives as UTF-8 for the `utf8` decode below,
				// whatever the repository's `i18n.commitEncoding` says — matching the engine,
				// which reads the objects directly. Commands that never re-encode ignore it.
				['-c', 'i18n.logOutputEncoding=UTF-8', ...args] as string[],
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

	/**
	 * The repository's empty tree, to diff a root commit (or an unborn `HEAD`) against "nothing".
	 *
	 * Its hash depends on the repository's object format: the historical constant is SHA-1 only
	 * and fails to resolve on SHA-256 repositories, so the constant is verified per repository
	 * (git resolves the empty tree intrinsically — no object needs to exist) and the SHA-256
	 * constant substituted where it doesn't. Cached per repository: the object format is fixed
	 * when the repository is created.
	 */
	public getEmptyTree(repo: string): Promise<string> {
		let emptyTree = this.emptyTrees.get(repo);
		if (emptyTree === undefined) {
			emptyTree = this.run(['rev-parse', '--verify', '--quiet', EMPTY_TREE + '^{tree}'], repo)
				.then(() => EMPTY_TREE)
				.catch(() =>
					this.run(['rev-parse', '--verify', '--quiet', EMPTY_TREE_SHA256 + '^{tree}'], repo)
						.then(() => EMPTY_TREE_SHA256)
						.catch(() => EMPTY_TREE)
				);
			this.emptyTrees.set(repo, emptyTree);
		}
		return emptyTree;
	}

	/** Run a signature verification command, retaining GnuPG status output on non-zero exits. */
	public runRaw(args: ReadonlyArray<string>, cwd: string): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				this.gitPath,
				args as string[],
				{ cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
				(error, stdout, stderr) => {
					if (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === 'ENOENT') {
							reject(new GitBackendError('Unsupported', `Git executable not found: ${this.gitPath}`));
							return;
						}
						if (typeof code !== 'number') {
							reject(new GitBackendError('Git', (stderr || stdout || error.message).trim()));
							return;
						}
					}
					resolve(stdout + stderr);
				}
			);
		});
	}
}

/** The message of an unknown thrown value, the way the original extension surfaced it. */
export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
