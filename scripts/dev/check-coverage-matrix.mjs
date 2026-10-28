/**
 * The coverage ratchet (REFACTOR-PLAN §6.8.4 / G9): the coverage matrix may only grow.
 *
 * scripts/dev/coverage-matrix.mjs extracts the nine dimensions from the repository sources and
 * counts; THIS script turns that count into a gate. docs/coverage-baseline.json records, per
 * dimension, the item ids that are uncovered today; the gate fails when:
 *
 *   - an item is uncovered that the baseline does not list — coverage REGRESSED;
 *   - a baselined item is covered (or gone) — the baseline is stale, shrink it with --update;
 *   - an exemption covers an item that is not uncovered — stale exemption, --update drops it;
 *   - more than 5 exemptions exist (G9's cap; every exemption needs a written reason).
 *
 * The same shrink-only ratchet the depcruise baseline and the size gate's KNOWN list use: a PR
 * that adds an uncovered command, setting, protocol request, write op, UiPort method, webview
 * control or catalog entry fails until it covers the item or records a justified exemption.
 *
 * `--update` rewrites the baseline to the current state but refuses to ABSORB growth: it fails
 * on new uncovered items just like the gate does, so updating can only shrink (plus keep the
 * still-valid exemptions).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFromRepo } from './coverage-matrix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baselinePath = path.join(root, 'docs', 'coverage-baseline.json');

/** The G9 cap: exemptions with written justification, total across dimensions. */
const MAX_EXEMPTIONS = 5;

/** One dimension's verdict: what regressed, what went stale, which exemptions no longer apply. */
export function compareDimension(currentUncovered, recordedUncovered, exemptions) {
	const exempt = new Set(exemptions.map((entry) => entry.id));
	const effective = currentUncovered.filter((id) => !exempt.has(id));
	const recorded = new Set(recordedUncovered);
	return {
		regressed: effective.filter((id) => !recorded.has(id)),
		// A recorded id is stale only when it is no longer uncovered at all (covered or gone);
		// an exempted-but-still-uncovered id legitimately stays on both lists.
		stale: recordedUncovered.filter((id) => !currentUncovered.includes(id)),
		staleExemptions: [...exempt].filter((id) => !currentUncovered.includes(id))
	};
}

/**
 * Compare a full matrix ({ dimension: { uncovered: string[] } }) against a baseline
 * ({ exemptions: { [dimension]: [{ id, reason }] }, uncovered: { [dimension]: string[] } }).
 * Returns { ok, regressed, stale, staleExemptions, exemptionCount, shrunkBaseline } where the
 * maps have an entry per failing dimension and shrunkBaseline is the baseline --update writes.
 */
export function compareMatrixToBaseline(dimensions, baseline) {
	const exemptions = baseline.exemptions || {};
	const uncovered = baseline.uncovered || {};
	const regressed = {};
	const stale = {};
	const staleExemptions = {};
	const shrunk = { exemptions: {}, uncovered: {} };
	let exemptionCount = 0;
	for (const [name, cell] of Object.entries(dimensions)) {
		const dimExemptions = exemptions[name] || [];
		exemptionCount += dimExemptions.length;
		const verdict = compareDimension(cell.uncovered, uncovered[name] || [], dimExemptions);
		if (verdict.regressed.length > 0) regressed[name] = verdict.regressed;
		if (verdict.stale.length > 0) stale[name] = verdict.stale;
		if (verdict.staleExemptions.length > 0) staleExemptions[name] = verdict.staleExemptions;
		const keptExemptions = dimExemptions.filter((entry) => !verdict.staleExemptions.includes(entry.id));
		const keptIds = new Set(keptExemptions.map((entry) => entry.id));
		// The written baseline drops the still-exempted ids on purpose: removing an exemption
		// then trips the gate as a regression, which is the right amount of deliberate.
		const effectiveCurrent = cell.uncovered.filter((id) => !keptIds.has(id));
		if (keptExemptions.length > 0) shrunk.exemptions[name] = keptExemptions;
		if (effectiveCurrent.length > 0) shrunk.uncovered[name] = effectiveCurrent;
	}
	return {
		ok: Object.keys(regressed).length === 0 && Object.keys(stale).length === 0 && Object.keys(staleExemptions).length === 0 && exemptionCount <= MAX_EXEMPTIONS,
		regressed,
		stale,
		staleExemptions,
		exemptionCount,
		shrunkBaseline: shrunk
	};
}

/** Render the failure report (empty string when everything holds). */
function renderReport(result) {
	const lines = [];
	const list = (map, label) => {
		for (const [name, ids] of Object.entries(map)) {
			lines.push('  ' + label + ' [' + name + ']: ' + ids.join(', '));
		}
	};
	if (Object.keys(result.regressed).length > 0) {
		lines.push('coverage REGRESSED — items uncovered that the baseline does not list:');
		list(result.regressed, 'new');
	}
	if (Object.keys(result.stale).length > 0) {
		lines.push('baseline STALE — these items are covered (or gone); shrink the baseline:');
		list(result.stale, 'covered');
	}
	if (Object.keys(result.staleExemptions).length > 0) {
		lines.push('exemptions STALE — exempting items that are not uncovered:');
		list(result.staleExemptions, 'exempted');
	}
	if (result.exemptionCount > MAX_EXEMPTIONS) {
		lines.push('too many exemptions: ' + result.exemptionCount + ' > ' + MAX_EXEMPTIONS + ' (G9 cap; each needs a written reason)');
	}
	return lines.join('\n');
}

function loadBaseline() {
	if (!fs.existsSync(baselinePath)) {
		// An absent baseline reads as "everything is covered": the first run must create it
		// deliberately with --update, never silently absorb the current gaps.
		return { exemptions: {}, uncovered: {} };
	}
	return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

export function main(argv = process.argv.slice(2)) {
	const update = argv.includes('--update');
	const initial = !fs.existsSync(baselinePath);
	const baseline = loadBaseline();
	const { dimensions } = extractFromRepo(root);
	const result = compareMatrixToBaseline(dimensions, baseline);

	if (Object.keys(result.regressed).length > 0 && !initial) {
		process.stderr.write(renderReport(result) + '\n');
		process.stderr.write('\ncheck-coverage-matrix: coverage may only grow; cover the new items or record justified exemptions.\n');
		process.exitCode = 1;
		return;
	}
	if (update) {
		fs.writeFileSync(baselinePath, JSON.stringify(result.shrunkBaseline, null, '\t') + '\n');
		const shrunkBy = Object.values(result.stale).reduce((sum, ids) => sum + ids.length, 0);
		console.log('coverage baseline ' + (initial ? 'created (' + Object.values(dimensions).reduce((sum, cell) => sum + cell.uncovered.length, 0) + ' uncovered item(s) recorded)' : 'updated' + (shrunkBy > 0 ? ' (shrunk by ' + shrunkBy + ' covered item(s))' : '')) + '.');
		return;
	}

	const report = renderReport(result);
	if (report !== '') {
		process.stderr.write(report + '\n');
		process.stderr.write('\ncheck-coverage-matrix: ' + (result.ok ? 'the matrix holds, but the baseline needs attention (run with --update to shrink it).' : 'see above.') + '\n');
		if (!result.ok) process.exitCode = 1;
		return;
	}
	const covered = Object.values(dimensions).reduce((sum, cell) => sum + cell.covered, 0);
	const total = Object.values(dimensions).reduce((sum, cell) => sum + cell.total, 0);
	console.log('coverage matrix ratchet holds: ' + covered + ' / ' + total + ' items covered; baseline and exemptions clean.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main();
}
