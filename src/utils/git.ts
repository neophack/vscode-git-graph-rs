// Git-facing primitives: the uncommitted marker, commit-hash and reference-name
// validation for untrusted input, shell quoting, and version requirements.

import { t } from '../i18n';
import type { GitExecutable } from './findGit';

export const UNCOMMITTED = '*';

/**
 * Abbreviate a commit hash to the first eight characters.
 * @param commitHash The full commit hash.
 * @returns The abbreviated commit hash.
 */
export function abbrevCommit(commitHash: string) {
	return commitHash.substring(0, 8);
}

const COMMIT_HASH_REGEX = /^[0-9a-fA-F]{4,40}$/;

/**
 * Check whether a commit hash received from an untrusted source (e.g. the webview) is a
 * hexadecimal hash, and therefore cannot be misinterpreted by git as an option (e.g. `--exec`).
 * @param commitHash The commit hash to validate.
 * @returns Whether the commit hash is valid.
 */
export function isValidCommitHash(commitHash: string): boolean {
	return typeof commitHash === 'string' && COMMIT_HASH_REGEX.test(commitHash);
}

/**
 * Check whether a reference name (branch, tag or remote name) received from an untrusted source
 * is safe to be passed to git. Rejects names that could be interpreted as git options
 * (e.g. starting with `-`), or that violate the git ref name format rules.
 * See https://git-scm.com/docs/git-check-ref-format
 * @param name The reference name to validate.
 * @returns Whether the reference name is safe.
 */
export function isSafeRefName(name: string): boolean {
	if (typeof name !== 'string' || name.length === 0) return false;
	if (name[0] === '-' || name[0] === '.') return false;
	if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
	// Reject ASCII control characters (including newlines), and characters disallowed in ref names
	if (/[\u0000-\u001f\u007f]/.test(name)) return false;
	return ['..', '@{', '\\', '^', ':', '?', '[', '*'].every((seq) => name.indexOf(seq) === -1);
}

/**
 * Quote a value so it can be safely embedded as a single-quoted argument in a POSIX shell command.
 * @param value The value to quote.
 * @returns The quoted value.
 */
export function quoteShellArg(value: string): string {
	return '\'' + value.replace(/'/g, '\'\\\'\'') + '\'';
}

const STASH_SELECTOR_REGEX = /^refs\/stash@\{\d+\}$/;

/**
 * Check whether a stash selector received from an untrusted source matches the expected
 * `stash@{N}` format, and therefore cannot be misinterpreted by git as an option.

/**
 * Check whether a stash selector received from an untrusted source matches the expected
 * `stash@{N}` format, and therefore cannot be misinterpreted by git as an option.
 * @param selector The stash selector to validate.
 * @returns Whether the stash selector is safe.
 */
export function isSafeStashSelector(selector: string): boolean {
	return typeof selector === 'string' && STASH_SELECTOR_REGEX.test(selector);
}

export const enum GitVersionRequirement {
	FetchAndPruneTags = '2.17.0',
	GpgInfo = '2.4.0',
	MergeTreeConflictPrediction = '2.40.0',
	PushStash = '2.13.2',
	TagDetails = '1.7.8'
}

export const enum VsCodeVersionRequirement {
	Codicons = '1.42.0'
}

/**
 * Checks whether a version is at least a required version.
 * @param version The version to check.
 * @param requiredVersion The minimum required version.
 * @returns TRUE => `version` is at least `requiredVersion`, FALSE => `version` is older than `requiredVersion`.
 */
export function doesVersionMeetRequirement(version: string, requiredVersion: GitVersionRequirement | VsCodeVersionRequirement) {
	const v1 = parseVersion(version);
	const v2 = parseVersion(requiredVersion);

	if (v1 === null || v2 === null) {
		// Unable to parse a version number
		return true;
	}

	if (v1.major > v2.major) return true; // Git major version is newer
	if (v1.major < v2.major) return false; // Git major version is older

	if (v1.minor > v2.minor) return true; // Git minor version is newer
	if (v1.minor < v2.minor) return false; // Git minor version is older

	if (v1.patch > v2.patch) return true; // Git patch version is newer
	if (v1.patch < v2.patch) return false; // Git patch version is older

	return true; // Versions are the same
}

/**
 * Parse a version number from a string.
 * @param version The string version number.
 * @returns The `major`.`minor`.`patch` version numbers.
 */
function parseVersion(version: string) {
	const match = version.trim().match(/^[0-9]+(\.[0-9]+|)(\.[0-9]+|)/);
	if (match === null) {
		// Unable to find a valid version number
		return null;
	}

	const comps = match[0].split('.');
	return {
		major: parseInt(comps[0], 10),
		minor: comps.length > 1 ? parseInt(comps[1], 10) : 0,
		patch: comps.length > 2 ? parseInt(comps[2], 10) : 0
	};
}

/**
 * Construct a message that explains to the user that the Git executable is not compatible with a feature.
 * @param executable The Git executable.
 * @param version The minimum required version.
 * @param feature An optional name for the feature.
 * @returns The message for the user.
 */
export function constructIncompatibleGitVersionMessage(executable: GitExecutable, version: GitVersionRequirement, feature?: string) {
	return t('incompatibleGitVersion', version, feature !== undefined ? feature : t('thisFeature'), executable.version);
}
