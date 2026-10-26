/**
 * The deferred Git resolution (OPTIMIZATION-PLAN V1): activation must never wait for the
 * `git --version` spawn that validates a Git executable. This module holds the resolution cell
 * the composition root wires everything else to:
 *
 * - `current()` answers the best value known WITHOUT waiting — the last good record persisted in
 *   globalState, and then the validated result once the background check lands.
 * - `ready()` is the promise every Git-CLI-dependent path awaits (write commands, the runner's
 *   spawns); engine reads never call it.
 * - `start()` kicks off the background validation, and the `onResolved` callback feeds the
 *   existing Git-executable change event, so every consumer keeps following Git changes exactly
 *   as it did when the same value was awaited at activation.
 *
 * While the workspace is untrusted (Workspace Trust, V2) the resolution answers NULL and never
 * spawns: no `git` child process may run in an untrusted folder, so there is nothing to resolve.
 */

import * as fs from 'fs';
import type { GitExecutable } from './findGit';

/**
 * The globalState slice the resolution persists its cache through. Structural, so tests inject a
 * plain record (`ExtensionState` satisfies it in production).
 */
export interface GitExecutableCache {
	getLastKnownGit(): { readonly path: string, readonly version: string, readonly mtimeMs: number | null } | null;
	setLastKnownGit(record: { readonly path: string, readonly version: string, readonly mtimeMs: number | null }): void;
}

/** The read side of the resolution the rest of the host wires to (see the module comment). */
export interface GitResolution {
	/**
	 * The best Git executable known without waiting: the persisted last-good record until the
	 * background validation answers, then its result. NULL while none is known — and always NULL
	 * while the workspace is untrusted, whatever the cache says.
	 */
	current(): GitExecutable | null;
	/** TRUE while the workspace is untrusted: Git operations are disabled (Workspace Trust). */
	restricted(): boolean;
	/**
	 * Resolves when the background validation has answered (NULL when no usable Git exists, and
	 * immediately with NULL while the workspace is untrusted). Git-CLI-dependent paths await
	 * this; engine reads must not.
	 */
	ready(): Promise<GitExecutable | null>;
}

/** {@link GitResolution} plus the background start (kept apart so consumers cannot re-start it). */
export interface GitResolutionHandle extends GitResolution {
	/** Begin the background validation. A no-op while untrusted (retry on trust being granted). */
	start(): void;
}

/** Everything the resolution needs from its host; every dependency is injectable for tests. */
export interface GitResolutionOptions {
	readonly cache: GitExecutableCache;
	/** The Workspace Trust gate: TRUE while untrusted (Git must not be spawned then). */
	readonly restricted: () => boolean;
	/** Fired with each validated result (NULL when validation found no usable Git). */
	readonly onResolved: (executable: GitExecutable | null) => void;
	/** Diagnostics sink (the extension Logger). */
	readonly log: (message: string) => void;
	/** The discovery/validation spawn (`findGit` in production — closing over the host's state —, a stub in tests). */
	readonly find: (cache: GitExecutableCache) => Promise<GitExecutable>;
}

/** The binary's modification time, or NULL when the path cannot be stated. */
async function mtimeMsOf(path: string): Promise<number | null> {
	try {
		const stats = await fs.promises.stat(path);
		return stats.mtimeMs;
	} catch (_) {
		return null;
	}
}

/**
 * Build the deferred Git resolution. Nothing is spawned until {@link GitResolutionHandle.start}
 * is called — the composition root registers every command first and starts the validation after.
 */
export function createGitResolution(options: GitResolutionOptions): GitResolutionHandle {
	const find = options.find;
	/** The cached record as the executable the rest of the host sees (its mtime is bookkeeping). */
	const executableOf = (record: { readonly path: string, readonly version: string }): GitExecutable => ({ path: record.path, version: record.version });
	/** The best value known so far (the persisted cache until validation replaces it). */
	let newest: GitExecutable | null = null;
	{
		const cached = options.cache.getLastKnownGit();
		if (cached !== null) newest = executableOf(cached);
	}
	let pending: Promise<GitExecutable | null> | null = null;
	let started = false;

	const validate = async (): Promise<GitExecutable | null> => {
		// The persisted record is trusted while its binary is unchanged: a `git --version` spawn on
		// a file with the same modification time would answer the same version, so the spawn is
		// skipped and activation has a resolved Git without ever waiting for one.
		const cached = options.cache.getLastKnownGit();
		if (cached !== null) {
			const mtimeMs = await mtimeMsOf(cached.path);
			if (mtimeMs !== null && mtimeMs === cached.mtimeMs) {
				newest = executableOf(cached);
				options.log('Using the cached Git executable ' + cached.path + ' (version: ' + cached.version + ', unchanged since the last validation)');
				options.onResolved(newest);
				return newest;
			}
		}

		try {
			const found = await find(options.cache);			newest = found;
			persist(found);
			options.log('Using ' + found.path + ' (version: ' + found.version + ')');
			options.onResolved(found);
			return found;
		} catch (_) {
			newest = null;
			options.onResolved(null);
			return null;
		}
	};

	/** Record the last good executable (path, version, mtime) for the next activation. */
	const persist = (found: GitExecutable): void => {
		void mtimeMsOf(found.path).then((mtimeMs) => {
			options.cache.setLastKnownGit({ path: found.path, version: found.version, mtimeMs: mtimeMs });
		});
	};

	const begin = (): Promise<GitExecutable | null> => {
		started = true;
		if (pending === null) pending = validate();
		return pending;
	};

	return {
		current: () => options.restricted() ? null : newest,
		restricted: () => options.restricted(),
		ready: () => options.restricted() ? Promise.resolve(null) : begin(),
		start: () => {
			if (options.restricted()) {
				// No `git` process may run while the workspace is untrusted; the trust listener
				// calls start() again when trust is granted.
				options.log('Git resolution deferred: the workspace is not trusted');
				return;
			}
			if (started) return;
			void begin();
		}
	};
}
