/**
 * The process adapter every CLI read theme is written against.
 *
 * Each call spawns its own `git` process — there is no handle to keep open — and the state the
 * readers share (the resolved empty tree of each repository, the last whole-diff numstat counts)
 * lives on this object, so each theme module stays a set of functions over one `GitCli`.
 *
 * Every run goes through the write layer's {@link GitProcess} (the one process
 * seam): the buffered `run` (optionally cancellable through an `AbortLike` that kills the child —
 * the long log walk), `collect` (the raw stdout bytes — the `--textconv` contents read),
 * `runDetailed`'s exit code and both streams separately (the merge-tree probe, whose conflict
 * report is on stdout), and a populated stdin (the batch object check of the reflog read).
 */

import { GitBackendError, GitLineCounts } from '../types';
import { GitError } from '../../process/errors';
import { GitProcess } from '../../process/gitProcess';
import type { AbortLike, GitSpawnFn } from '../../process/gitProcess';

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

	/** The process adapter every run goes through (the one process seam). */
	private readonly process: GitProcess;

	constructor(
		public readonly gitPath: string = 'git',
		/** The spawn implementation behind {@link process}; injected so tests fake the child. */
		private readonly spawnFn?: GitSpawnFn
	) {
		// No askpass provider is wired for the read path: the reads run with the plain
		// inherited environment.
		this.process = new GitProcess(() => ({ path: this.gitPath, version: '' }), this.spawnFn);
	}

	/** Run one `git` process and return its stdout. */
	public run(args: ReadonlyArray<string>, cwd: string, signal?: AbortLike): Promise<string> {
		// i18n.logOutputEncoding is pinned so commit metadata (subjects, bodies, author names,
		// reflog messages) always arrives as UTF-8 for the `utf8` decode below, whatever the
		// repository's `i18n.commitEncoding` says — matching the engine, which reads the objects
		// directly. Commands that never re-encode ignore it.
		return this.runProcess(args, cwd, { signal: signal }).then(
			(result) => {
				if (result.code !== 0) {
					throw new GitBackendError('Git', (result.stderr || result.stdout.toString('utf8') || `git exited with code ${result.code}`).trim());
				}
				return result.stdout.toString('utf8');
			},
			(error) => {
				throw toBackendProcessError(error, this.gitPath);
			}
		);
	}

	/**
	 * Run one `git` process, resolving its raw stdout bytes (the binary-content reads); a failing
	 * run rejects with the backend's error contract, like {@link run}.
	 */
	public collect(args: ReadonlyArray<string>, cwd: string, signal?: AbortLike): Promise<Buffer> {
		return this.process.collect(['-c', 'i18n.logOutputEncoding=UTF-8', ...args], { cwd: cwd, maxBuffer: MAX_BUFFER, signal: signal }).then(
			(stdout) => stdout,
			(error) => {
				throw toBackendProcessError(error, this.gitPath);
			}
		);
	}

	/**
	 * Run one `git` process, resolving with its exit code and both streams separately. Nothing
	 * rejects on a non-zero exit: the callers that probe a command whose failure IS the answer
	 * (the merge-tree conflict prediction) branch on the code and read the streams themselves.
	 */
	public runDetailed(args: ReadonlyArray<string>, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
		return this.runProcess(args, cwd, {}).then(
			(result) => ({
				code: result.code,
				stdout: result.stdout.toString('utf8'),
				stderr: result.stderr
			}),
			(error) => {
				throw toBackendProcessError(error, this.gitPath);
			}
		);
	}

	/**
	 * Run one `git` process that reads its input from standard input (e.g.
	 * `git cat-file --batch-check`, which reports which of a batch of hashes are still present
	 * in the object database). A broken pipe on the write side is ignored: the command already
	 * answered through its exit (the adapter swallows it, so an unhandled stream error cannot
	 * take the host down).
	 */
	public runWithInput(args: ReadonlyArray<string>, cwd: string, input: string): Promise<string> {
		return this.runProcess(args, cwd, { input: input }).then(
			(result) => {
				if (result.code !== 0) {
					throw new GitBackendError('Git', (result.stderr || result.stdout.toString('utf8') || `git exited with code ${result.code}`).trim());
				}
				return result.stdout.toString('utf8');
			},
			(error) => {
				throw toBackendProcessError(error, this.gitPath);
			}
		);
	}

	/** Run through {@link GitProcess} with the encoding pin prepended to the argv. */
	private runProcess(args: ReadonlyArray<string>, cwd: string, options: { signal?: AbortLike; input?: string }): ReturnType<GitProcess['run']> {
		return this.process.run(['-c', 'i18n.logOutputEncoding=UTF-8', ...args], { cwd, maxBuffer: MAX_BUFFER, signal: options.signal, input: options.input });
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
		// No encoding pin here: `verify-tag` does not re-encode, and the GnuPG status-fd output
		// rides along whatever the exit code is.
		return this.process.run(args, { cwd, maxBuffer: MAX_BUFFER }).then(
			(result) => result.stdout.toString('utf8') + result.stderr,
			(error) => {
				if (error instanceof GitError && error.kind === 'noGit') {
					throw new GitBackendError('Unsupported', `Git executable not found: ${this.gitPath}`);
				}
				throw toBackendProcessError(error, this.gitPath);
			}
		);
	}
}

/** The message of an unknown thrown value, the way the original extension surfaced it. */
export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Map a {@link GitProcess} failure onto the CLI backend's error contract: the process layer's
 * kinds name the process conditions (no executable found, cancelled, over the output limit),
 * while the backend's kinds name the fallback decision (a missing `git` is `Unsupported`, a
 * cancelled run is `Cancelled`, everything else is a plain Git failure).
 */
export function toBackendProcessError(error: unknown, gitPath: string): GitBackendError {
	if (error instanceof GitBackendError) return error;
	if (error instanceof GitError) {
		if (error.kind === 'cancelled') return new GitBackendError('Cancelled', error.message);
		if (error.kind === 'noGit') return new GitBackendError('Unsupported', `Git executable not found: ${gitPath}`);
		return new GitBackendError('Git', error.message);
	}
	return new GitBackendError('Git', message(error));
}
