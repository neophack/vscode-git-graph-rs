/**
 * The unified error format of `extension/git/**`: every layer under the git tree rejects with
 * (or reports through) a `GitError`, so callers map one shape instead of one per spawn site.
 *
 * The `kind`s are the Rust engine's own `ErrorKind`s (see the generated
 * `src/shared/engine/protocol.ts`), plus the process layer's additions: `noGit` (no Git
 * executable was found) and `tooLarge` (a process produced more output than its limit).
 */

import type { ErrorKind } from '../../../shared/engine/protocol';

export type GitErrorKind = ErrorKind | 'noGit' | 'tooLarge';

/** The single error type of `extension/git/**`: both readers and the writer reject with it. */
export class GitError extends Error {
	constructor(
		readonly kind: GitErrorKind,
		message: string,
		/** Git's own output, when a process ran and failed. */
		readonly stderr: string = ''
	) {
		super(message);
		this.name = 'GitError';
		// Restore the prototype for down-level compilation targets, so `instanceof` also holds
		// for code paths compiled with a different class transform.
		Object.setPrototypeOf(this, GitError.prototype);
	}
}

/** Wrap an unknown thrown value as a `GitError` (a non-`GitError` becomes `internal`). */
export function toGitError(error: unknown): GitError {
	if (error instanceof GitError) return error;
	return new GitError('internal', error instanceof Error ? error.message : String(error));
}
