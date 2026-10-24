/**
 * The single process adapter of `extension/git/**`: the one place a `git` child process is
 * started. Both the write layer (`write/gitWriter.ts`) and the guard reads (`write/lossGuard.ts`)
 * come through here, so environment assembly (askpass injection), cancellation, output limits and
 * the error shape are decided once.
 *
 * Behaviour parity with the legacy `DataSource` spawns (`src/dataSource.ts`): the executable is
 * spawned as `spawn(gitPath, args, { cwd, env })` with `env = Object.assign({}, process.env,
 * askpassEnv, extraEnv)`; there are no `-c` preamble arguments (dev1.1's `COMMON_CONFIG` is not
 * part of this tree's legacy behaviour, so it is not reproduced here).
 */

import * as cp from 'child_process';

import { GitError } from './errors';

/** A located Git executable, as discovered by the host (legacy `utils/findGit.ts`). */
export interface GitExecutable {
	readonly path: string;
	readonly version: string;
}

/**
 * Cancellation, structurally: any `AbortSignal` fits, and tests can pass a minimal object.
 * Kept structural because `src/tsconfig.json` compiles against `lib: ["es6"]` only.
 */
export interface AbortLike {
	readonly aborted: boolean;
	addEventListener(type: 'abort', listener: () => void): void;
	removeEventListener(type: 'abort', listener: () => void): void;
}

/** The slice of `child_process.ChildProcess` the adapter consumes, so fakes stay small. */
export interface SpawnedGit {
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	stdin: { end(data?: string): void };
	kill(): void;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'close', listener: (code: number | null) => void): unknown;
}

/** The spawn function the adapter uses; `child_process.spawn` by default, a fake in tests. */
export type GitSpawnFn = (
	command: string,
	args: ReadonlyArray<string>,
	options: { cwd: string; env: { [name: string]: string }; windowsHide: boolean }
) => SpawnedGit;

export interface RunOptions {
	readonly cwd: string;
	/** Written to stdin, which is then closed. */
	readonly input?: string;
	/** Added over the inherited process environment and the askpass environment. */
	readonly env?: { readonly [name: string]: string };
	readonly signal?: AbortLike;
	/** Output beyond this is a failure rather than an unbounded allocation. Default 100 MB. */
	readonly maxBuffer?: number;
}

export interface RunResult {
	/** The exit code, whatever it is: a non-zero exit resolves, it does not reject. */
	readonly code: number;
	readonly stdout: Buffer;
	readonly stderr: string;
}

/** Provides the askpass environment variables every credential-prompting spawn carries. */
export type AskpassEnvProvider = () => { readonly [name: string]: string };

const DEFAULT_MAX_BUFFER = 100 * 1024 * 1024;

export class GitProcess {
	constructor(
		/** The Git executable to run, or `null` when none was found. */
		private readonly executable: () => GitExecutable | null,
		/** The spawn implementation (injected so unit tests need no real child process). */
		private readonly spawnFn: GitSpawnFn = cp.spawn as unknown as GitSpawnFn,
		private readonly askpass: AskpassEnvProvider = () => ({})
	) {}

	/** The Git being run, or `null` when none was found. */
	get git(): GitExecutable | null {
		return this.executable();
	}

	/**
	 * Run Git and collect its output. Resolves with the exit code whatever it is; rejects only
	 * when no Git executable is available (`noGit`), the spawn itself failed (`noGit`/`io`),
	 * the run was cancelled (`cancelled`), or the output exceeded `maxBuffer` (`tooLarge`).
	 */
	run(args: ReadonlyArray<string>, options: RunOptions): Promise<RunResult> {
		const git = this.executable();
		if (git === null) {
			return Promise.reject(new GitError('noGit', 'No Git executable was found'));
		}
		const signal = options.signal;
		if (signal !== undefined && signal.aborted) {
			return Promise.reject(new GitError('cancelled', 'The operation was cancelled'));
		}
		const maxBuffer = options.maxBuffer !== undefined ? options.maxBuffer : DEFAULT_MAX_BUFFER;

		return new Promise<RunResult>((resolve, reject) => {
			// Same environment assembly as the legacy DataSource spawns: the process environment,
			// then the askpass variables, then the caller's extras last (they win).
			const env: { [name: string]: string } = Object.assign({}, process.env, this.askpass());
			if (options.env !== undefined) Object.assign(env, options.env);

			const child = this.spawnFn(git.path, args, { cwd: options.cwd, env, windowsHide: true });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let size = 0;
			let settled = false;
			let onAbort: (() => void) | null = null;

			const finish = (outcome: () => void) => {
				if (settled) return;
				settled = true;
				if (signal !== undefined && onAbort !== null) signal.removeEventListener('abort', onAbort);
				outcome();
			};

			onAbort = () => {
				child.kill();
				finish(() => reject(new GitError('cancelled', 'The operation was cancelled')));
			};
			if (signal !== undefined) signal.addEventListener('abort', onAbort);

			child.stdout.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBuffer) {
					child.kill();
					finish(() => reject(new GitError('tooLarge', 'git produced more output than the ' + maxBuffer + ' byte limit')));
					return;
				}
				stdout.push(chunk);
			});
			child.stderr.on('data', (chunk: Buffer) => {
				stderr.push(chunk);
			});
			child.on('error', (error: NodeJS.ErrnoException) => {
				finish(() => reject(error.code === 'ENOENT'
					? new GitError('noGit', 'Could not run ' + git.path)
					: new GitError('io', error.message)));
			});
			child.on('close', (code: number | null) => {
				finish(() => resolve({
					code: code === null ? -1 : code,
					stdout: Buffer.concat(stdout.map((chunk) => new Uint8Array(chunk))),
					stderr: Buffer.concat(stderr.map((chunk) => new Uint8Array(chunk))).toString('utf8')
				}));
			});

			// stdin is always closed (with the input when there is one), exactly like the legacy
			// spawns: a Git command waiting on an editor or an unclosed stdin must not hang.
			if (options.input !== undefined) child.stdin.end(options.input);
			else child.stdin.end();
		});
	}
}
