/**
 * Tests for the argument-injection safety module: the validators and the `checkUnsafeGitArgs`
 * behaviour, tuple for tuple.
 */

import { describe, expect, it } from 'vitest';

import { checkUnsafeGitArgs, Localize } from './argSafety';

/** A recording fake localiser: returns the key with the parameters, so messages are assertable. */
const t: Localize = (key, ...params) => key + '{' + params.join(',') + '}';

describe('checkUnsafeGitArgs', () => {
	it('passes values that are safe for their kind', () => {
		expect(checkUnsafeGitArgs(t,
			['branchName', 'feature/x', 'ref'],
			['commitHash', '0123abcd', 'hash'],
			['selector', 'refs/stash@{2}', 'stash'],
			['url', 'https://host/repo', 'url']
		)).toBeNull();
	});

	it('skips null and undefined values', () => {
		expect(checkUnsafeGitArgs(t, ['remoteBranch', null, 'ref'], ['pushUrl', undefined, 'url'])).toBeNull();
	});

	it('rejects a ref name git could read as an option', () => {
		expect(checkUnsafeGitArgs(t, ['name', '--upload-pack', 'ref'])).toBe('invalidRefName{name}');
		expect(checkUnsafeGitArgs(t, ['name', '-oinject', 'ref'])).toBe('invalidRefName{name}');
	});

	it('rejects ref names that violate the git ref format', () => {
		expect(checkUnsafeGitArgs(t, ['name', 'a..b', 'ref'])).not.toBeNull();
		expect(checkUnsafeGitArgs(t, ['name', 'ends/', 'ref'])).not.toBeNull();
		expect(checkUnsafeGitArgs(t, ['name', 'ends.', 'ref'])).not.toBeNull();
		expect(checkUnsafeGitArgs(t, ['name', '.starts-with-dot', 'ref'])).not.toBeNull();
		expect(checkUnsafeGitArgs(t, ['name', 'contains@{brace', 'ref'])).not.toBeNull();
		expect(checkUnsafeGitArgs(t, ['name', 'ends.lock', 'ref'])).not.toBeNull();
	});

	it('rejects hashes that are not hexadecimal', () => {
		expect(checkUnsafeGitArgs(t, ['commitHash', 'main', 'hash'])).toBe('invalidCommitHash{commitHash}');
		expect(checkUnsafeGitArgs(t, ['commitHash', '--exec', 'hash'])).toBe('invalidCommitHash{commitHash}');
		expect(checkUnsafeGitArgs(t, ['commitHash', 'ABCDEF', 'hash'])).toBeNull();
	});

	it('rejects stash selectors outside the refs/stash@{N} form', () => {
		expect(checkUnsafeGitArgs(t, ['selector', 'stash@{1}', 'stash'])).toBe('invalidStashSelector{selector}');
		expect(checkUnsafeGitArgs(t, ['selector', '1', 'stash'])).toBe('invalidStashSelector{selector}');
		expect(checkUnsafeGitArgs(t, ['selector', 'refs/stash@{10}', 'stash'])).toBeNull();
	});

	it('rejects URLs with a leading dash but accepts the empty placeholder', () => {
		expect(checkUnsafeGitArgs(t, ['url', '--upload-pack', 'url'])).toBe('invalidUrl{url}');
		expect(checkUnsafeGitArgs(t, ['url', '', 'url'])).toBeNull();
		expect(checkUnsafeGitArgs(t, ['url', 'ssh://host/path', 'url'])).toBeNull();
	});

	it('reports the first failing check and localises the message with the argument name', () => {
		expect(checkUnsafeGitArgs(t, ['ok', 'fine', 'ref'], ['bad', 'nope', 'hash'], ['later', 'x', 'ref']))
			.toBe('invalidCommitHash{bad}');
	});
});
