/**
 * The single process adapter of `extension/git/**`: the one place a `git` child process is
 * started. Both the write layer (`write/gitWriter.ts`), the guard reads (`write/lossGuard.ts`)
 * and the CLI read backend (`read/cli/process.ts`) come through its three verbs — `run`
 * (buffered, with `maxBuffer` and an `AbortLike`), `collect` (the stdout as raw bytes) and
 * `stream` (a `Readable` plus an exit promise; `spawnStream` is its view-layer name) — so
 * environment assembly (askpass injection), cancellation, output limits, `windowsHide` and the
 * error shape are decided once.
 *
 * The executable is spawned as `spawn(gitPath, args, { cwd, env })` with
 * `env = Object.assign({}, process.env, askpassEnv, extraEnv)`; there are no `-c` preamble
 * arguments.
 */

import * as cp from 'child_process';

import { GitError } from './errors';

/** A located Git executable, as discovered by the host (`executable/findGit.ts`). */
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

/** The writable side of {@link AbortLike}: what a load run's owner holds and aborts. */
export interface AbortControllerLike {
	readonly signal: AbortLike;
	abort(): void;
}

/**
 * A run token for the read pipeline: the real `AbortController` where the runtime has one
 * (Node 15+), the structural minimum where it does not — the VS Code 1.38 floor's extension
 * host is Node 10.11, whose global scope predates the class, and `new AbortController()` there
 * is a ReferenceError that kills every read. Consumers read the signal structurally (the
 * {@link AbortLike} reads in `run`/`collect`/`stream`), so either form satisfies them.
 */
export function createAbortController(): AbortControllerLike {
	return typeof AbortController === 'function' ? new AbortController() : createStructuralAbortController();
}

/**
 * The no-`AbortController` form of {@link createAbortController}: an `aborted` flag and a
 * listener list with the real class's contract — `abort` fires each listener once, a listener
 * registered after the abort never fires, re-aborting is a no-op. Exported so the fallback is
 * testable on a runtime that has the global.
 */
export function createStructuralAbortController(): AbortControllerLike {
	let aborted = false;
	const listeners: Array<() => void> = [];
	const signal: AbortLike = {
		get aborted() { return aborted; },
		addEventListener(_type: 'abort', listener: () => void): void {
			if (!aborted) listeners.push(listener);
		},
		removeEventListener(_type: 'abort', listener: () => void): void {
			const at = listeners.indexOf(listener);
			if (at >= 0) listeners.splice(at, 1);
		}
	};
	return {
		signal,
		abort(): void {
			if (aborted) return;
			aborted = true;
			for (const listener of listeners.splice(0)) listener();
		}
	};
}

/** The slice of `child_process.ChildProcess` the adapter consumes, so fakes stay small. */
export interface SpawnedGit {
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	stdin: {
		end(data?: string): void;
		/** The stdin write may fail (EPIPE) after the child exited; the adapter ignores it. */
		on?(type: 'error', listener: (error: Error) => void): unknown;
	};
	kill(): void;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'close', listener: (code: number | null) => void): unknown;
}

/** The outcome of a streamed child: how it ended, and what it wrote to stderr while alive. */
export interface StreamExit {
	/** The exit code; -1 when the child failed to spawn or was killed before it closed. */
	readonly code: number;
	/** The spawn failure, when the child could not be started at all. */
	readonly error: Error | null;
	/** Everything the child wrote to stderr up to the point it ended. */
	readonly stderr: string;
}

/**
 * A spawned child reduced to the surface the streaming consumers need: the two output streams,
 * an exit that never rejects (a stream a consumer stopped listening to cannot crash the host
 * with an unhandled rejection), and the kill switch its owner calls on dispose.
 */
export interface SpawnedStream {
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	/** Settles once the child closes (or fails to spawn). Never rejects. */
	readonly exit: Promise<StreamExit>;
	kill(): void;
}

/** Reduce a spawned child to the {@link SpawnedStream} surface (the stderr text is accumulated here). */
function spawnedToStream(child: SpawnedGit): SpawnedStream {
	return {
		stdout: child.stdout,
		stderr: child.stderr,
		exit: new Promise<StreamExit>((resolve) => {
			let stderr = '';
			let spawnError: Error | null = null;
			child.stderr.on('data', (chunk: Buffer | string) => {
				stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			});
			child.on('error', (error: Error) => {
				spawnError = error;
			});
			child.on('close', (code: number | null) => {
				resolve({ code: spawnError !== null || code === null ? -1 : code, error: spawnError, stderr: stderr });
			});
		}),
		kill: () => {
			child.kill();
		}
	};
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
		private readonly askpass: AskpassEnvProvider = () => ({}),
		/**
		 * Awaited before every {@link run}: the background Git resolution,
		 * so a write or CLI read issued while the `git --version` validation is still in flight
		 * waits for it instead of failing with "no Git" (undefined keeps runs immediate).
		 */
		private readonly awaitReady?: () => Promise<unknown>
	) {}

	/** The Git being run, or `null` when none was found. */
	get git(): GitExecutable | null {
		return this.executable();
	}

	/**
	 * The `stream` verb: spawn Git and hand the caller its stdout as a `Readable` plus an exit
	 * promise, for the consumers that must consume the bytes as they arrive (the hex
	 * comparison's chunked blob reads). The environment is assembled exactly like a `run` spawn
	 * (askpass included); with no Git executable the no-Git error is thrown for the caller to
	 * surface. Nothing here bounds the output: the caller decides when it has read enough and
	 * kills the child.
	 */
	stream(args: ReadonlyArray<string>, cwd: string): SpawnedStream {
		const git = this.executable();
		if (git === null) throw new GitError('noGit', 'No Git executable was found');
		const env: { [name: string]: string } = Object.assign({}, process.env, this.askpass());
		return spawnedToStream(this.spawnFn(git.path, args, { cwd: cwd, env: env, windowsHide: true }));
	}

	/**
	 * Spawn Git for a streaming read, the entry the composition root wires into the views'
	 * `GitStreamSpawner` port (same behaviour as {@link stream}, exposed under the port-facing
	 * name so the wiring stays stable).
	 */
	spawnStream(args: ReadonlyArray<string>, cwd: string): SpawnedStream {
		return this.stream(args, cwd);
	}

	/**
	 * The `collect` verb: run Git and resolve its stdout as raw bytes — the buffered {@link run}
	 * for callers that consume BINARY output (the `--textconv` contents read). The stdout only
	 * resolves on exit code 0; a failing run rejects with the failure text a failed `run` would
	 * report (stderr, else stdout, else the exit code), and the process-condition failures
	 * (no Git, cancelled, over the output limit, spawn failure) reject exactly as `run` does.
	 */
	async collect(args: ReadonlyArray<string>, options: RunOptions): Promise<Buffer> {
		const result = await this.run(args, options);
		if (result.code !== 0) {
			const text = (result.stderr || result.stdout.toString('utf8') || `git exited with code ${result.code}`).trim();
			throw new GitError('git', text, text);
		}
		return result.stdout;
	}

	/**
	 * Run Git and collect its output. Resolves with the exit code whatever it is; rejects only
	 * when no Git executable is available (`noGit`), the spawn itself failed (`noGit`/`io`),
	 * the run was cancelled (`cancelled`), or the output exceeded `maxBuffer` (`tooLarge`).
	 */
	async run(args: ReadonlyArray<string>, options: RunOptions): Promise<RunResult> {
		// Git-CLI-dependent paths await the background resolution first:
		// a run issued while the executable is still being validated waits for it here rather
		// than reporting "no Git" for the few dozen milliseconds the validation takes.
		if (this.awaitReady !== undefined) await this.awaitReady();
		const git = this.executable();
		if (git === null) {
			throw new GitError('noGit', 'No Git executable was found');
		}
		const signal = options.signal;
		if (signal !== undefined && signal.aborted) {
			return Promise.reject(new GitError('cancelled', 'The operation was cancelled'));
		}
		const maxBuffer = options.maxBuffer !== undefined ? options.maxBuffer : DEFAULT_MAX_BUFFER;

		return new Promise<RunResult>((resolve, reject) => {
			// Environment assembly: the process environment,
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

			// stdin is always closed (with the input when there is one):
			// a Git command waiting on an editor or an unclosed stdin must not hang. The
			// write may still fail (EPIPE) when the command exits before consuming its input —
			// the batched object checks read their answer from the exit — so that error is
			// ignored (an unhandled stream 'error' would take the host down).
			child.stdin.on?.('error', () => { /* EPIPE: the command already answered */ });
			if (options.input !== undefined) child.stdin.end(options.input);
			else child.stdin.end();
		});
	}
}
