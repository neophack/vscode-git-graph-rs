/**
 * The Git-facing primitives of src/utils/git.ts (ported from tests/utils.test.mjs): untrusted
 * input validation for commit hashes, reference names and stash selectors, and the version
 * comparison behind every feature's minimum-Git check.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
	Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	env: { language: 'en' },
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
}));

import { t } from '../i18n';
import { abbrevCommit, constructIncompatibleGitVersionMessage, doesVersionMeetRequirement, GitVersionRequirement, isSafeRefName, isSafeStashSelector, isValidCommitHash } from './git';

describe('git helpers', () => {
	it('abbreviates commit hashes to the first eight characters', () => {
		expect(abbrevCommit('0123456789abcdef')).toBe('01234567');
	});

	it('validates untrusted commit hashes, ref names and stash selectors', () => {
		expect(isValidCommitHash('abcd')).toBe(true);
		expect(isValidCommitHash('a'.repeat(40))).toBe(true);
		expect(isValidCommitHash('a'.repeat(64))).toBe(true); // SHA-256 repository hashes
		expect(isValidCommitHash('abc')).toBe(false);
		expect(isValidCommitHash('--exec=rm')).toBe(false);
		expect(isValidCommitHash(<never>42)).toBe(false);

		expect(isSafeRefName('feature/thing')).toBe(true);
		for (const bad of ['', '-x', '.hidden', 'a/', 'a.', 'a.lock', 'a\nb', 'a..b', 'a@{b', 'a\\b', 'a^b', 'a:b', 'a?b', 'a[b', 'a*b', <never>42]) {
			expect(isSafeRefName(bad), JSON.stringify(bad)).toBe(false);
		}

		expect(isSafeStashSelector('refs/stash@{0}')).toBe(true);
		expect(isSafeStashSelector('stash@{0}')).toBe(false);
		expect(isSafeStashSelector('refs/stash@{x}')).toBe(false);
	});

	/* The requirement argument is one of the declared GitVersionRequirement values; versions
	 * beyond the declared set exercise the same comparison and are cast in. */
	const requirement = (version: string) => version as GitVersionRequirement;

	it('doesVersionMeetRequirement compares major, minor and patch', () => {
		expect(doesVersionMeetRequirement('2.17.0', requirement('2.17.0'))).toBe(true);
		expect(doesVersionMeetRequirement('2.17.1', requirement('2.17.0'))).toBe(true);
		expect(doesVersionMeetRequirement('2.16.9', requirement('2.17.0'))).toBe(false);
		expect(doesVersionMeetRequirement('3.0.0', requirement('2.17.0'))).toBe(true);
		expect(doesVersionMeetRequirement('1.99.99', requirement('2.17.0'))).toBe(false);
		expect(doesVersionMeetRequirement('2.18', requirement('2.17.0'))).toBe(true);
		expect(doesVersionMeetRequirement('2', requirement('2.17.0'))).toBe(false);
		expect(doesVersionMeetRequirement('2.17.0.windows.1', requirement('2.17.0'))).toBe(true);
		expect(doesVersionMeetRequirement('2.17.0', requirement('2.17.1'))).toBe(false);
		expect(doesVersionMeetRequirement('2.18.0', requirement('2.17.5'))).toBe(true);
		expect(doesVersionMeetRequirement('2.16.0', requirement('2.17.5'))).toBe(false);
		// Unparseable versions are assumed compatible
		expect(doesVersionMeetRequirement('unknown', requirement('2.17.0'))).toBe(true);
	});

	it('constructIncompatibleGitVersionMessage names the feature when given', () => {
		const executable = { path: 'git', version: '2.10.0' };
		expect(constructIncompatibleGitVersionMessage(executable, requirement('2.17.0'))).toBe(t('incompatibleGitVersion', '2.17.0', t('thisFeature'), '2.10.0'));
		expect(constructIncompatibleGitVersionMessage(executable, requirement('2.17.0'), 'Fetch')).toBe(t('incompatibleGitVersion', '2.17.0', 'Fetch', '2.10.0'));
	});
});
