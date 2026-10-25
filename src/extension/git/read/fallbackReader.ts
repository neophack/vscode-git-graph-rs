/**
 * A reader that prefers one backend and falls back over its declines to another, without a
 * hand-written forwarding method per read.
 *
 * The method-name table is derived from the two readers themselves — every function both
 * implement, minus the release calls (which both always get) — so adding a read method to the
 * `GitBackend` interface and its two adapters makes it fallback-aware the moment both implement
 * it: nothing in this module changes.
 */

import { GitBackend } from './gitReader';
import { GitBackendError } from './types';

/** One read call, whichever reader answers it: the arguments travel through untouched. */
type ReaderCall = (...args: unknown[]) => Promise<unknown>;

/** The member of `reader` named `method`, as a callable that forwards arguments verbatim. */
function readerCall(reader: GitBackend, method: string): ReaderCall {
	// The name comes from the readers' own prototypes, so the member exists; the `unknown`
	// parameter list only carries the caller's arguments through to it unchanged.
	return ((reader as unknown as Record<string, unknown>)[method] as ReaderCall).bind(reader);
}

/** Every function-valued member of `reader`'s prototype chain, getters excluded. */
function ownMethodNames(reader: GitBackend): Set<string> {
	const names = new Set<string>();
	for (let prototype: object | null = Object.getPrototypeOf(reader); prototype !== null && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
		for (const name of Object.getOwnPropertyNames(prototype)) {
			if (name === 'constructor') continue;
			// The descriptor is read rather than the value, so deriving the table never runs
			// reader code (a getter would otherwise fire with the wrong receiver).
			const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
			if (descriptor === undefined || typeof descriptor.value !== 'function') continue;
			names.add(name);
		}
	}
	return names;
}

/**
 * The method-name table: every read method, i.e. every function-valued member on BOTH readers'
 * prototype chains, minus the constructor and the release calls (which both readers always get,
 * declined or not). A method only one reader implements has nothing to fall back to, so it stays
 * that reader's own.
 */
function readerMethodNames(primary: GitBackend, secondary: GitBackend): Set<string> {
	const secondaryNames = ownMethodNames(secondary);
	const shared = new Set<string>();
	for (const name of ownMethodNames(primary)) {
		if (name !== 'closeRepository' && name !== 'closeAllRepositories' && secondaryNames.has(name)) {
			shared.add(name);
		}
	}
	return shared;
}

/**
 * Build a `GitBackend` that prefers `primary` and falls back to `secondary` over its declines.
 *
 * Only two kinds of failure are fallen back over: "this is not a repository I can open" and "I do
 * not implement this" (`GitBackendError.isFallbackWorthy`). A genuine Git failure — a bad
 * revision, a corrupt object — is the answer, and re-running it through `git` would only produce
 * the same failure more slowly.
 */
export function createFallbackReader(
	primary: GitBackend,
	secondary: GitBackend,
	onFallback?: (method: string, error: GitBackendError) => void
): GitBackend {
	const methods = readerMethodNames(primary, secondary);

	/** Try the primary; when it declines in a fallback-worthy way, the secondary answers. */
	const dispatch = async (method: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
		try {
			return await readerCall(primary, method)(...args);
		} catch (error) {
			if (error instanceof GitBackendError && error.isFallbackWorthy) {
				onFallback?.(method, error);
				return readerCall(secondary, method)(...args);
			}
			throw error;
		}
	};

	const both = {
		name: `${primary.name} (falling back to ${secondary.name})`,
		closeRepository(path: string): void {
			primary.closeRepository(path);
			secondary.closeRepository(path);
		},
		closeAllRepositories(): void {
			primary.closeAllRepositories();
			secondary.closeAllRepositories();
		}
	};

	return new Proxy(both, {
		get(target, property, receiver) {
			if (typeof property === 'string' && methods.has(property)) {
				return (...args: unknown[]) => dispatch(property, args);
			}
			return Reflect.get(target, property, receiver);
		}
	}) as GitBackend;
}
