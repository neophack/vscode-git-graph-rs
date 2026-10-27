/**
 * Tests for the Git capability table: the five thresholds of `CAPABILITIES`, each with its
 * below / equal / above case, plus the version-parsing semantics (a version that cannot be
 * parsed counts as meeting the requirement).
 */

import { describe, expect, it } from 'vitest';

import { CAPABILITIES, CapabilityInfo, GitCapability, hasCapability, meetsVersion } from './capabilities';

describe('meetsVersion', () => {
	it.each([
		['2.17.0', '2.17.0', true],
		['2.17.1', '2.17.0', true],
		['2.18.0', '2.17.0', true],
		['3.0.0', '2.17.0', true],
		['2.16.9', '2.17.0', false],
		['2.16.0', '2.17.0', false],
		['2.13.2', '2.17.0', false],
		['1.2.3', '1.2.3', true],
		['1.2', '1.2.0', true],
		['2.4.0', '2.4', true]
	])('%s vs %s → %s', (have, need, expected) => {
		expect(meetsVersion(have, need)).toBe(expected);
	});

	it('parses the leading numeric parts of decorated versions', () => {
		expect(meetsVersion('2.39.2.windows.1', '2.39.2')).toBe(true);
		expect(meetsVersion('2.13.2.windows.1', '2.14.0')).toBe(false);
	});

	it('assumes an unparseable version meets the requirement (legacy behaviour)', () => {
		expect(meetsVersion('who knows', '99.0.0')).toBe(true);
		expect(meetsVersion('', '1.0.0')).toBe(true);
		expect(meetsVersion('2.40.0', 'not a version')).toBe(true);
	});
});

describe('the capability table', () => {
	it('holds the five legacy thresholds', () => {
		expect(CAPABILITIES.FetchAndPruneTags.version).toBe('2.17.0');
		expect(CAPABILITIES.GpgInfo.version).toBe('2.4.0');
		expect(CAPABILITIES.MergeTreeConflictPrediction.version).toBe('2.40.0');
		expect(CAPABILITIES.PushStash.version).toBe('2.13.2');
		expect(CAPABILITIES.TagDetails.version).toBe('1.7.8');
		expect(Object.keys(CAPABILITIES)).toHaveLength(5);
	});

	it.each([
		['FetchAndPruneTags', '2.16.9', '2.17.0', '2.17.1'],
		['GpgInfo', '2.3.9', '2.4.0', '2.4.1'],
		['MergeTreeConflictPrediction', '2.39.9', '2.40.0', '2.41.0'],
		['PushStash', '2.13.1', '2.13.2', '2.13.3'],
		['TagDetails', '1.7.7', '1.7.8', '1.7.9']
	])('%s: below / equal / above %s', (capabilityName, below, equal, above) => {
		const capability = capabilityName as GitCapability;
		expect(hasCapability(below, capability)).toBe(false);
		expect(hasCapability(equal, capability)).toBe(true);
		expect(hasCapability(above, capability)).toBe(true);
	});

	it('major-version jumps both directions', () => {
		expect(hasCapability('3.0.0', 'MergeTreeConflictPrediction')).toBe(true);
		expect(hasCapability('1.9.9', 'GpgInfo')).toBe(false);
	});

	it('only FetchAndPruneTags names its feature', () => {
		const gpgInfo: CapabilityInfo = CAPABILITIES.GpgInfo;
		const mergeTree: CapabilityInfo = CAPABILITIES.MergeTreeConflictPrediction;
		const pushStash: CapabilityInfo = CAPABILITIES.PushStash;
		const tagDetails: CapabilityInfo = CAPABILITIES.TagDetails;
		expect(CAPABILITIES.FetchAndPruneTags.featureKey).toBe('featurePruningTagsWhenFetching');
		expect(gpgInfo.featureKey).toBeUndefined();
		expect(mergeTree.featureKey).toBeUndefined();
		expect(pushStash.featureKey).toBeUndefined();
		expect(tagDetails.featureKey).toBeUndefined();
	});
});
