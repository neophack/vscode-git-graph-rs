/**
 * Tests for the coverage ratchet gate (scripts/dev/check-coverage-matrix.mjs).
 *
 * Hermetic: the pure comparison functions run against fixture matrices and baselines only; the
 * real repository is never read (the CLI wrapper over extractFromRepo is not a test dependency).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { compareDimension, compareMatrixToBaseline } from '../../scripts/dev/check-coverage-matrix.mjs';

describe('compareDimension', () => {
	it('holds when the uncovered set matches the baseline', () => {
		const verdict = compareDimension(['a', 'b'], ['b', 'a'], []);
		assert.deepEqual(verdict, { regressed: [], stale: [], staleExemptions: [] });
	});

	it('flags an uncovered item the baseline does not list as a regression', () => {
		const verdict = compareDimension(['a', 'new'], ['a'], []);
		assert.deepEqual(verdict.regressed, ['new']);
		assert.deepEqual(verdict.stale, []);
	});

	it('flags a baseline entry that is covered now as stale', () => {
		const verdict = compareDimension(['a'], ['a', 'gone'], []);
		assert.deepEqual(verdict.regressed, []);
		assert.deepEqual(verdict.stale, ['gone']);
	});

	it('treats an exempted uncovered item as covered, without staleness anywhere', () => {
		const verdict = compareDimension(['a', 'ex'], ['a', 'ex'], [{ id: 'ex', reason: 'lifecycle handshake' }]);
		assert.deepEqual(verdict, { regressed: [], stale: [], staleExemptions: [] });
	});

	it('flags an exemption whose item is no longer uncovered as stale', () => {
		const verdict = compareDimension(['a'], ['a'], [{ id: 'ex', reason: 'x' }]);
		assert.deepEqual(verdict.staleExemptions, ['ex']);
	});

	it('flags an uncovered item that is neither baselined nor exempted even when exemptions exist', () => {
		const verdict = compareDimension(['ex', 'new'], [], [{ id: 'ex', reason: 'x' }]);
		assert.deepEqual(verdict.regressed, ['new']);
	});
});

describe('compareMatrixToBaseline', () => {
	const matrix = {
		'contributed-commands': { total: 3, covered: 1, uncovered: ['cmd-a', 'cmd-b'] },
		'settings': { total: 2, covered: 2, uncovered: [] }
	};

	it('is ok for a matching baseline and counts no exemptions', () => {
		const result = compareMatrixToBaseline(matrix, { exemptions: {}, uncovered: { 'contributed-commands': ['cmd-a', 'cmd-b'], settings: [] } });
		assert.equal(result.ok, true);
		assert.equal(result.exemptionCount, 0);
	});

	it('reports per-dimension regressions and missing baseline dimensions count as empty', () => {
		const result = compareMatrixToBaseline(matrix, { exemptions: {}, uncovered: {} });
		assert.equal(result.ok, false);
		assert.deepEqual(result.regressed['contributed-commands'], ['cmd-a', 'cmd-b']);
	});

	it('reports stale entries per dimension', () => {
		const result = compareMatrixToBaseline(matrix, {
			exemptions: {},
			uncovered: { 'contributed-commands': ['cmd-a', 'cmd-b', 'cmd-c'], settings: ['gone-setting'] }
		});
		assert.equal(result.ok, false);
		assert.deepEqual(result.stale['contributed-commands'], ['cmd-c']);
		assert.deepEqual(result.stale.settings, ['gone-setting']);
	});

	it('keeps valid exemptions in the shrunk baseline and drops covered ids and stale exemptions', () => {
		const result = compareMatrixToBaseline(matrix, {
			exemptions: { 'contributed-commands': [{ id: 'cmd-a', reason: 'debug-only command' }, { id: 'dead', reason: 'gone' }] },
			uncovered: { 'contributed-commands': ['cmd-a', 'cmd-b', 'cmd-c'] }
		});
		assert.equal(result.ok, false); // cmd-c is stale, dead's exemption is stale
		assert.deepEqual(result.shrunkBaseline.exemptions['contributed-commands'], [{ id: 'cmd-a', reason: 'debug-only command' }]);
		// cmd-a stays exempt, so the written baseline records only cmd-b
		assert.deepEqual(result.shrunkBaseline.uncovered['contributed-commands'], ['cmd-b']);
	});

	it('counts exemptions across dimensions against the G9 cap', () => {
		const six = [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'item-' + n, reason: 'r' + n }));
		const result = compareMatrixToBaseline(
			{ d: { total: 6, covered: 0, uncovered: six.map((e) => e.id) } },
			{ exemptions: { d: six }, uncovered: {} }
		);
		assert.equal(result.ok, false);
		assert.equal(result.exemptionCount, 6);
	});
});
