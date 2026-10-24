/**
 * Argument-injection safety: the port of the legacy `DataSource.checkUnsafeGitArgs`
 * (`src/dataSource.ts`), plus the three value validators it consults. The validators are copied
 * verbatim from `src/utils/git.ts` (they live in a module that transitively imports vscode, which
 * this tree must not depend on); the localisation is injected so the function stays pure.
 *
 * The GitWriter is the single intended call site: it feeds every op's `checks` through here
 * before any argv runs.
 */

import type { ArgCheck } from './ops/op';

/** Localisation, injected: `(key, ...params) => message`, the legacy `t` signature. */
export type Localize = (key: string, ...params: Array<string | number>) => string;

// 4-64 hex characters: full hashes of SHA-1 (40) and SHA-256 (64) repositories, and
// abbreviations of either.
const COMMIT_HASH_REGEX = /^[0-9a-fA-F]{4,64}$/;

/** Whether a commit hash from an untrusted source is hexadecimal (copied from `utils/git.ts`). */
export function isValidCommitHash(commitHash: string): boolean {
	return typeof commitHash === 'string' && COMMIT_HASH_REGEX.test(commitHash);
}

/** Whether a reference name from an untrusted source is safe for git (copied from `utils/git.ts`,
 * following https://git-scm.com/docs/git-check-ref-format). */
export function isSafeRefName(name: string): boolean {
	if (typeof name !== 'string' || name.length === 0) return false;
	if (name[0] === '-' || name[0] === '.') return false;
	if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
	// Reject ASCII control characters (including newlines), and characters disallowed in ref names
	if (/[\u0000-\u001f\u007f]/.test(name)) return false;
	return ['..', '@{', '\\', '^', ':', '?', '[', '*'].every((seq) => name.indexOf(seq) === -1);
}

const STASH_SELECTOR_REGEX = /^refs\/stash@\{\d+\}$/;

/** Whether a stash selector from an untrusted source is the expected `stash@{N}` form (copied
 * from `utils/git.ts`). */
export function isSafeStashSelector(selector: string): boolean {
	return typeof selector === 'string' && STASH_SELECTOR_REGEX.test(selector);
}

/**
 * Check that values received from an untrusted source (the webview) are safe to be passed to
 * git, i.e. they cannot be misinterpreted as git options (argument injection).
 * @param t The localiser for the error message.
 * @param checks Tuples of [argument name, value, kind] to validate. Values that are null or
 * undefined are skipped.
 * @returns An error message if any value is unsafe, otherwise null.
 */
export function checkUnsafeGitArgs(t: Localize, ...checks: ReadonlyArray<ArgCheck>): string | null {
	for (const [name, value, kind] of checks) {
		if (value === null || value === undefined) continue;
		let valid: boolean;
		if (kind === 'hash') {
			valid = isValidCommitHash(value);
		} else if (kind === 'stash') {
			valid = isSafeStashSelector(value);
		} else if (kind === 'url') {
			// URLs (including the "" placeholder used when no URL is set) can't be validated as
			// strictly as a ref name, but a leading '-' would still let the value be misinterpreted
			// as a git option instead of a positional argument
			valid = value[0] !== '-';
		} else {
			valid = isSafeRefName(value);
		}
		if (!valid) {
			const key = kind === 'hash' ? 'invalidCommitHash' : (kind === 'stash' ? 'invalidStashSelector' : (kind === 'url' ? 'invalidUrl' : 'invalidRefName'));
			return t(key, name);
		}
	}
	return null;
}
