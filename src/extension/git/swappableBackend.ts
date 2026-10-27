import { createBackend } from './read/backendIndex';
import type { GitBackend } from './read/gitReader';
import type { GitExecutable } from './process/gitProcess';

/**
 * The composition root's read-backend seam: the swappable handle the rest of the host holds
 * while the backend behind it is rebuilt, and the builder that decides the backend for a Git
 * situation. There is no hand-written method forwarder here at all — the proxy forwards every
 * member access, so no method table needs keeping in sync.
 */

/**
 * A `GitBackend` handle that re-resolves its target on every member access. The composition
 * root rebuilds the read backend when the Git executable changes (or a trust transition swaps
 * in an engine-only one); the facade and the prewarm reader hold this ONE handle and follow
 * the rebuilds without having to rebind anything.
 *
 * There is no method table to keep in sync: the proxy forwards every property access to the
 * current backend — methods bound to it, the `name` getter included — so a read added to the
 * `GitBackend` interface and its adapters is forwarded with no change here. Because the
 * resolution happens per access, a method must be read off the handle at call time; capturing a
 * bound method would freeze the backend it resolved to. Every consumer does (the facade holds
 * the handle, callers invoke members on it).
 */
export function swappableBackend(current: () => GitBackend): GitBackend {
	return new Proxy({} as GitBackend, {
		get(_target, property) {
			const backend = current();
			// The member is read off the current backend with itself as the receiver (getters see
			// the right `this`); functions are bound so the caller's `this` never matters.
			const value = Reflect.get(backend, property, backend);
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(backend) : value;
		},
		has(_target, property) {
			return property in current();
		}
	});
}

/**
 * Build the read backend for a Git situation: the
 * engine with the CLI fallback while a Git executable exists, the engine alone without one (the
 * whole read path is engine-served), the CLI alone without the engine. In Restricted Mode
 * (`engineOnly`) the CLI is never reached: the engine serves every read in-process, and
 * without an engine binary every call fails rather than spawning `git` in an untrusted folder.
 */
export function buildBackend(gitExecutable: GitExecutable | null, logger: { log(message: string): void }, engineOnly: boolean): GitBackend {
	const backend = createBackend({
		gitPath: gitExecutable !== null ? gitExecutable.path : null,
		engineOnly,
		onFallback: (method, error) => {
			logger.log('The Rust engine could not answer ' + method + ' (' + error.message + '); falling back to the git CLI.');
		}
	});
	logger.log('Using the ' + backend.name + ' backend.');
	return backend;
}
