/**
 * Git version → capability, in one table: the five thresholds the legacy tree kept in
 * `GitVersionRequirement` (`src/utils/git.ts`), centralised here so no code under
 * `extension/git/**` compares versions anywhere else (REFACTOR-PLAN task 3.8).
 *
 * `meetsVersion` reproduces the legacy `doesVersionMeetRequirement` / `parseVersion` exactly,
 * including the "a version we cannot parse is assumed recent" fallback.
 */

/** One capability's minimum Git version, and the i18n key naming the feature (when there is one). */
export interface CapabilityInfo {
	readonly version: string;
	/** The i18n key of the feature name shown in the "incompatible Git version" message. */
	readonly featureKey?: string;
}

export const CAPABILITIES = {
	/** `git fetch --prune-tags`. */
	FetchAndPruneTags: { version: '2.17.0', featureKey: 'featurePruningTagsWhenFetching' },
	/** `git log --show-signature` etc. GPG information fields. */
	GpgInfo: { version: '2.4.0' },
	/** `git merge-tree --write-tree` conflict prediction. */
	MergeTreeConflictPrediction: { version: '2.40.0' },
	/** `git stash push` (older Gits only have `stash save`). */
	PushStash: { version: '2.13.2' },
	/** `git for-each-ref` tagger fields used by tag details. */
	TagDetails: { version: '1.7.8' }
} as const;

export type GitCapability = keyof typeof CAPABILITIES;

/**
 * Parse the leading `major[.minor[.patch]]` out of a version string.
 * @returns The three numbers, or `null` when the string does not start with one.
 */
function parseVersion(version: string): [number, number, number] | null {
	const match = version.trim().match(/^[0-9]+(\.[0-9]+|)(\.[0-9]+|)/);
	if (match === null) return null;
	const comps = match[0].split('.');
	return [
		parseInt(comps[0], 10),
		comps.length > 1 ? parseInt(comps[1], 10) : 0,
		comps.length > 2 ? parseInt(comps[2], 10) : 0
	];
}

/**
 * Whether `version` is at least `required`. A version that cannot be parsed is assumed to meet
 * the requirement (legacy behaviour: an unreadable version must not disable features).
 */
export function meetsVersion(version: string, required: string): boolean {
	const have = parseVersion(version);
	const need = parseVersion(required);
	if (have === null || need === null) return true;
	for (let i = 0; i < 3; i++) {
		if (have[i] > need[i]) return true;
		if (have[i] < need[i]) return false;
	}
	return true;
}

/** Whether a Git version has a capability from the table. */
export function hasCapability(version: string, capability: GitCapability): boolean {
	return meetsVersion(version, CAPABILITIES[capability].version);
}
