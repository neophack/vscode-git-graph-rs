/**
 * The compatibility adapter between §6.8.3 scenarios and the legacy action catalog. While the
 * catalog is being converted into scenario objects (task 6.2's follow-up), a scenario's
 * `when.legacy.actionIds` names catalog actions, and this adapter turns a batch of them into
 * ONE machine suite request (src/extension/commands/automation.ts's AutomationE2eSuiteRequest)
 * whose per-action records map back onto the scenarios. The suite runner keeps every legacy
 * mechanic — pre/post action setup, the fixture reseed between phases, per-action surface
 * cleanup, transient-lock retry — so the adapter adds selection and bookkeeping only.
 */

import { Scenario } from './scenarios';
import { FixtureTuning, SuiteReportWire, SuiteRequestWire, SuiteRunRecordWire } from './types';

/** The suite request for a batch of legacy scenarios (one runner invocation, one reseed cycle). */
export function suiteRequestFor(batch: readonly Scenario[], repo: string, options: { actionTimeoutMs: number; fixture: FixtureTuning }): SuiteRequestWire {
	const actionIds: string[] = [];
	for (const scenario of batch) {
		if (!('legacy' in scenario.when)) continue;
		for (const id of scenario.when.legacy.actionIds) {
			if (!actionIds.includes(id)) actionIds.push(id);
		}
	}
	return {
		e2eSuite: true,
		repo,
		actionIds,
		actionTimeoutMs: options.actionTimeoutMs,
		fixtureOptions: options.fixture
	};
}

/** Index a suite report's per-action records by action id (read + write phases both included). */
export function runsById(report: SuiteReportWire): Map<string, SuiteRunRecordWire> {
	const indexed = new Map<string, SuiteRunRecordWire>();
	for (const suite of report.suites) {
		for (const run of suite.runs) indexed.set(run.id, run);
	}
	return indexed;
}

/**
 * Map one legacy scenario onto its record: pass/fail/skip derive from the action records; a
 * scenario whose actions the report does not mention at all failed to even run (an unknown or
 * filtered-out action id — the catalog moved under us) and is reported as a failure with the
 * names that never ran.
 */
export function outcomeForScenario(scenario: Scenario, indexed: Map<string, SuiteRunRecordWire>): { status: 'pass' | 'fail' | 'skip'; detail: string | null; runs: SuiteRunRecordWire[] } {
	const ids = 'legacy' in scenario.when ? scenario.when.legacy.actionIds : [];
	const runs = ids.map((id) => indexed.get(id)).filter((run): run is SuiteRunRecordWire => run !== undefined);
	if (runs.length !== ids.length) {
		const missing = ids.filter((id) => !indexed.has(id));
		return { status: 'fail', detail: 'the catalog never ran: ' + missing.join(', '), runs };
	}
	const failed = runs.find((run) => !run.ok && !run.skipped);
	if (failed !== undefined) return { status: 'fail', detail: firstLine(failed.error ?? failed.reason ?? 'failed'), runs };
	const skipped = runs.find((run) => run.skipped);
	if (skipped !== undefined) return { status: 'skip', detail: firstLine(skipped.reason ?? 'skipped'), runs };
	return { status: 'pass', detail: null, runs };
}

/** First line of a multi-line error (JUnit testcase text stays readable). */
export function firstLine(text: string): string {
	const line = text.split('\n')[0].trim();
	return line.length > 400 ? line.slice(0, 400) + '…' : line;
}
