/**
 * The generic (non-Git) spawn of the process seam (OPTIMIZATION-PLAN A3): the ONE place outside
 * {@link ./gitProcess.ts} that starts a child process. It exists for the probes that must run
 * before a Git executable is resolved (`git --version` validation, the platform `which` search)
 * and for the executables that are not Git at all — still with `windowsHide`, the environment
 * assembly, an output cap and cancellation decided in one place.
 *
 * The output is fully buffered and the result never rejects: a spawn failure is reported
 * through `error` with code -1, the way `resolveSpawnOutput` (whose place this takes) reported
 * it to the discovery code.
 */

import * as cp from 'child_process';

import type { AbortLike } from './gitProcess';

/** The outcome of a fully-buffered spawn of an arbitrary executable. */
export interface ProcessOutput {
	/** The exit code; -1 when the process could not be started (see {@link error}). */
	readonly code: number;
	/** The spawn failure, or NULL when the process ran. */
	readonly error: Error | null;
	readonly stdout: Buffer;
	readonly stderr: string;
}

export interface SpawnOutputOptions {
	readonly cwd?: string;
	/** Added over the inherited process environment (the caller's values win). */
	readonly env?: { readonly [name: string]: string };
	/** Output beyond this is dropped, the child killed, and `error` set. Default 10 MB. */
	readonly maxBuffer?: number;
	readonly signal?: AbortLike;
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Spawn an arbitrary executable and collect its output. Resolves whatever happened; never
 * rejects (a failed spawn carries `error` with code -1, a cancelled one a `cancelled` error).
 */
export function spawnOutput(command: string, args: ReadonlyArray<string>, options: SpawnOutputOptions = {}): Promise<ProcessOutput> {
	return new Promise((resolve) => {
		const maxBuffer = options.maxBuffer !== undefined ? options.maxBuffer : DEFAULT_MAX_BUFFER;
		const env = options.env !== undefined ? Object.assign({}, process.env, options.env) : undefined;
		// windowsHide is the seam's policy (a probing spawn must not flash a console window).
		const child = cp.spawn(command, args, { cwd: options.cwd, env: env, windowsHide: true });

		const signal = options.signal;
		const stdout: Buffer[] = [];
		let stdoutSize = 0;
		let stderr = '';
		let spawnError: Error | null = null;
		let settled = false;
		let exitCode: number | null = null;
		let onAbort: (() => void) | null = null;

		const finish = () => {
			if (settled) return;
			settled = true;
			if (signal !== undefined && onAbort !== null) signal.removeEventListener('abort', onAbort);
			resolve({
				code: spawnError !== null || exitCode === null ? -1 : exitCode,
				error: spawnError,
				stdout: Buffer.concat(stdout.map((chunk) => new Uint8Array(chunk))),
				stderr: stderr
			});
		};

		if (signal !== undefined) {
			onAbort = () => {
				spawnError = new Error('cancelled');
				child.kill();
				finish();
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener('abort', onAbort);
		}

		child.stdout?.on('data', (chunk: Buffer) => {
			if (settled) return;
			stdoutSize += chunk.length;
			if (stdoutSize > maxBuffer) {
				spawnError = new Error(`the output exceeded the ${maxBuffer} byte limit`);
				child.kill();
				finish();
				return;
			}
			stdout.push(chunk);
		});
		child.stderr?.on('data', (chunk: Buffer | string) => {
			stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
		});
		child.on('error', (error: Error) => {
			spawnError = error;
		});
		child.on('close', (code: number | null) => {
			exitCode = code;
			finish();
		});
	});
}
