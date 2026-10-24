/* Pure helpers shared by the webview (no DOM, no state). */

import * as GG from './protocol';

/** The hash standing for the "Uncommitted Changes" row. */
export const UNCOMMITTED = '*';

/** The value of the "Show All" option of the branch and author dropdowns. */
export const SHOW_ALL_BRANCHES = '';

/** Matches the characters and sequences a Git reference name may not contain. */
export const REF_INVALID_REGEX = /^[-\/].*|[\\" ><~^:?*[]|\.\.|\/\/|\/\.|@{|[.\/]$|\.lock$|^@$/g;

/**
 * Are two arrays equal, comparing the elements at each index with `equalElements`.
 */
export function arraysEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>, equalElements: (a: T, b: T) => boolean) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!equalElements(a[i], b[i])) return false;
	}
	return true;
}

/** Are two arrays equal, with strictly equal elements at each index. */
export function arraysStrictlyEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** Are two arrays equal ignoring the order of their (strictly compared) elements. */
export function arraysStrictlyEqualIgnoringOrder<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (b.indexOf(a[i]) === -1) return false;
	}
	return true;
}

/**
 * Multiply the opacity of an RGB / RGBA / HEX colour.
 * @param colour The colour to modify.
 * @param opacity The multiplier for the opacity (between 0 & 1).
 * @returns An equivalent RGBA colour with the applied opacity.
 */
export function modifyColourOpacity(colour: string, opacity: number) {
	let fadedCol = 'rgba(0,0,0,0)', match;
	if ((match = colour.match(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)) !== null) {
		fadedCol = 'rgba(' + match[1] + ',' + match[2] + ',' + match[3] + ',' + (parseFloat(match[4]) * opacity).toFixed(2) + ')';
	} else if ((match = colour.match(/#\s*([0-9a-fA-F]+)/)) !== null) {
		const hex = match[1];
		const length = hex.length;
		if (length === 3 || length === 4 || length === 6 || length === 8) {
			const col = length < 5
				? { r: hex[0] + hex[0], g: hex[1] + hex[1], b: hex[2] + hex[2], a: length === 4 ? hex[3] + hex[3] : 'ff' }
				: { r: hex[0] + hex[1], g: hex[2] + hex[3], b: hex[4] + hex[5], a: length === 8 ? hex[6] + hex[7] : 'ff' };
			fadedCol = 'rgba(' + parseInt(col.r, 16) + ',' + parseInt(col.g, 16) + ',' + parseInt(col.b, 16) + ',' + (parseInt(col.a, 16) * opacity / 255).toFixed(2) + ')';
		}
	} else if ((match = colour.match(/rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)) !== null) {
		fadedCol = 'rgba(' + match[1] + ',' + match[2] + ',' + match[3] + ',' + opacity + ')';
	}
	return fadedCol;
}

/** The first 8 characters of a commit hash. */
export function abbrevCommit(commitHash: string) {
	return commitHash.substring(0, 8);
}

/**
 * Format an array of strings as a list ("A, B & C").
 */
export function formatCommaSeparatedList(items: ReadonlyArray<string>) {
	let str = '';
	for (let i = 0; i < items.length; i++) {
		str += (i > 0 ? (i < items.length - 1 ? ', ' : ' & ') : '') + items[i];
	}
	return str;
}

/**
 * The short name of a repository: the last segment of its path.
 */
export function getRepoName(path: string) {
	const firstSep = path.indexOf('/');
	if (firstSep === path.length - 1 || firstSep === -1) {
		return path; // Path has no slashes, or a single trailing slash ==> use the path
	} else {
		const p = path.endsWith('/') ? path.substring(0, path.length - 1) : path; // Remove trailing slash if it exists
		return p.substring(p.lastIndexOf('/') + 1);
	}
}

/**
 * The path of a repository relative to the closest known repository containing it (a submodule
 * or a nested repository), or NULL when no known repository contains it. Drive-letter paths are
 * compared case-insensitively (canonicalised Windows paths may differ in casing).
 */
export function getSubRepoPath(path: string, repos: GG.GitRepoSet): string | null {
	const caseInsensitive = /^[a-zA-Z]:/.test(path);
	const repoPaths = Object.keys(repos);
	let parent: string | null = null;
	for (let i = 0; i < repoPaths.length; i++) {
		if (repoPaths[i].length >= path.length) continue;
		const contained = caseInsensitive
			? path.substring(0, repoPaths[i].length + 1).toLowerCase() === (repoPaths[i] + '/').toLowerCase()
			: path.startsWith(repoPaths[i] + '/');
		if (contained && (parent === null || repoPaths[i].length > parent.length)) parent = repoPaths[i];
	}
	return parent === null ? null : path.substring(parent.length + 1);
}

/**
 * The repository paths of a set, in the configured dropdown order.
 */
export function getSortedRepositoryPaths(repos: GG.GitRepoSet, order: GG.RepoDropdownOrder): ReadonlyArray<string> {
	const repoPaths = Object.keys(repos);
	if (order === GG.RepoDropdownOrder.WorkspaceFullPath) {
		return repoPaths.sort((a, b) => repos[a].workspaceFolderIndex === repos[b].workspaceFolderIndex
			? a.localeCompare(b)
			: repos[a].workspaceFolderIndex === null
				? 1
				: repos[b].workspaceFolderIndex === null
					? -1
					: repos[a].workspaceFolderIndex! - repos[b].workspaceFolderIndex!
		);
	} else if (order === GG.RepoDropdownOrder.FullPath) {
		return repoPaths.sort((a, b) => a.localeCompare(b));
	} else {
		return repoPaths.map((path) => ({ name: repos[path].name || getRepoName(path), path: path }))
			.sort((a, b) => a.name !== b.name ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path))
			.map((x) => x.path);
	}
}

/**
 * Does an ErrorInfo carry an ErrorInfoExtensionPrefix.
 */
export function isExtensionErrorInfo(error: GG.ErrorInfo, prefix: GG.ErrorInfoExtensionPrefix) {
	return error !== null && error.startsWith(prefix);
}

/**
 * Parse the JSON data of an ErrorInfo carrying an ErrorInfoExtensionPrefix.
 */
export function parseExtensionErrorInfo(error: string, prefix: GG.ErrorInfoExtensionPrefix) {
	return JSON.parse(error.substring(prefix.length));
}

/**
 * Reduce the errors of a multi-step action: the combined error message (NULL if every step
 * succeeded), and whether at least one step succeeded.
 */
export function reduceErrorInfos(errors: ReadonlyArray<GG.ErrorInfo>) {
	let error: GG.ErrorInfo = null, partialOrCompleteSuccess = false;
	for (let i = 0; i < errors.length; i++) {
		if (errors[i] !== null) {
			error = error !== null ? error + '\n\n' + errors[i] : errors[i];
		} else {
			partialOrCompleteSuccess = true;
		}
	}
	return { error: error, partialOrCompleteSuccess: partialOrCompleteSuccess };
}
