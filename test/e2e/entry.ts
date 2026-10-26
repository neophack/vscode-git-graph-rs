/**
 * The E2E entry (§6.8.1's test/e2e/entry.ts) — runs INSIDE the extension host of the real VS
 * Code the launcher started, against the extensionDevelopmentPath staging of the AUTOMATION
 * build. Responsibilities, and nothing else: generate the fixture (through the existing suite
 * runner's empty-repository path — one library call, no second module copy), select the tier's
 * scenarios, execute them (legacy actions through the compatibility adapter, S-checklist items
 * through procedures), capture failure evidence, write the JUnit/JSON/HTML reports, and make
 * the run's outcome the process exit code (a failing run throws; @vscode/test-electron turns
 * that into exit code 1).
 */

import * as fs from 'fs';
import * as path from 'path';
import { deserializeOptions } from './options';
import { captureFailureEvidence, captureGitState } from './evidence';
import { git, openView, runSuite, waitForActivation, waitForViewRepo } from './inhost';
import { firstLine, outcomeForScenario, runsById, suiteRequestFor } from './legacyAdapter';
import { writeReports } from './reports';
import { Scenario } from './scenarios';
import { PROCEDURES } from './smokeProcedures';
import { E2E_AFFECTED_ENV, E2E_OPTIONS_ENV, E2E_RESULTS_DIR_ENV, E2E_WORKSPACE_ENV, E2eOptions, E2eReport, ScenarioRecord, SuiteReportWire } from './types';
import { customsForTier, smokeScenarios, suiteTagsForTarget } from './scenarios';

/** The action whose suite run doubles as the fixture bootstrap (it generates into the empty workspace). */
const BOOTSTRAP_ACTION = 'control-bar/refresh';

/**
 * The test runner contract: exported `run()`, resolved on a green run, rejected on any failure
 * (which the launcher observes as VS Code's exit code).
 */
export async function run(): Promise<void> {
	const options = readOptions();
	const resultsDir = requiredEnv(E2E_RESULTS_DIR_ENV);
	// Normalize the workspace path (fs.realpathSync.native resolves the 8.3 short names Windows
	// hands out when TMP is long — e.g. C:\Users\PENGHO~1\...). The extension host's repo registry
	// holds the long form, and every path comparison in this entry and the suite runner is textual:
	// comparing the short form against the long one never matches (the first run on such a machine
	// timed out at exactly that, "waiting for the view to load", for two minutes).
	const workspace = fs.realpathSync.native(requiredEnv(E2E_WORKSPACE_ENV));
	fs.mkdirSync(resultsDir, { recursive: true });
	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	const records: ScenarioRecord[] = [];

	// Boot: the workspace becomes an empty git repository (the suite's in-place fixture
	// generation path requires one), the extension activates, the view loads it.
	await ensureEmptyGitRepo(workspace);
	await openView(workspace);
	const activated = await waitForActivation(120000);
	const runtime = { editorVersion: activated.editorVersion, backend: options.backend };
	await waitForViewRepo(workspace, 120000);

	const composed = composeScenarios(options);
	const legacyBatch = composed.filter((scenario) => 'legacy' in scenario.when);
	const customs = composed.filter((scenario) => 'procedure' in scenario.when);

	// The legacy batch: ONE suite call for every legacy scenario of the tier (plus the bootstrap
	// action, whose run generates the fixture into the empty workspace on the first call).
	if (legacyBatch.length > 0) {
		const gitBefore = await safeGitState(workspace);
		const report = await runLegacyBatch(legacyBatch, workspace, options);
		// The raw suite report (both phases' per-action records incl. the write-suite reseed/cleanup
		// pseudo-entries, which no scenario record carries): the first artifact to read when the
		// scenario mapping reports "the catalog never ran".
		fs.writeFileSync(path.join(resultsDir, 'suite-report.json'), JSON.stringify(report, null, '\t') + '\n');
		const indexed = runsById(report);
		const synthetic = legacyBatch.find((scenario) => scenario.id.startsWith('legacy-suite/'));
		for (const scenario of legacyBatch) {
			if (scenario === synthetic) {
				const failedRun = report.suites.flatMap((suite) => suite.runs).find((run) => !run.ok && !run.skipped);
				records.push({
					id: scenario.id, title: scenario.title, tags: scenario.tags,
					status: report.totals.failed > 0 ? 'fail' : report.totals.actions === 0 ? 'skip' : 'pass',
					detail: failedRun !== undefined ? firstLine(failedRun.error ?? failedRun.reason ?? 'failed') + ' (' + failedRun.id + ')'
						: report.totals.actions === 0 ? 'the catalog selected no actions' : null,
					durationMs: report.durationMs,
					evidence: report.totals.failed > 0 ? await captureFailureEvidence(resultsDir, scenario.id, workspace, gitBefore) : [],
					legacyRuns: report.suites.flatMap((suite) => suite.runs)
				});
				continue;
			}
			const outcome = outcomeForScenario(scenario, indexed);
			records.push({
				id: scenario.id, title: scenario.title, tags: scenario.tags,
				status: outcome.status, detail: outcome.detail,
				durationMs: sumDurations(outcome.runs),
				evidence: outcome.status === 'fail' ? await captureFailureEvidence(resultsDir, scenario.id, workspace, gitBefore) : [],
				legacyRuns: outcome.runs
			});
		}
	}

	// The customs (S-checklist procedures), each isolated by a git-state snapshot for evidence.
	for (const scenario of customs) {
		const skipReason = scenario.availability?.(options) ?? null;
		if (skipReason !== null) {
			records.push({ id: scenario.id, title: scenario.title, tags: scenario.tags, status: 'skip', detail: skipReason, durationMs: null, evidence: [] });
			continue;
		}
		const gitBefore = await safeGitState(workspace);
		const started = Date.now();
		try {
			const outcome = await PROCEDURES['procedure' in scenario.when ? scenario.when.procedure : '']({ repo: workspace, options });
			records.push({
				id: scenario.id, title: scenario.title, tags: scenario.tags,
				status: outcome.status, detail: outcome.detail, durationMs: outcome.durationMs,
				evidence: outcome.status === 'fail' ? await captureFailureEvidence(resultsDir, scenario.id, workspace, gitBefore) : []
			});
		} catch (error) {
			const message = firstLine(error instanceof Error ? error.message : String(error));
			records.push({
				id: scenario.id, title: scenario.title, tags: scenario.tags,
				status: 'fail', detail: message, durationMs: Date.now() - started,
				evidence: await captureFailureEvidence(resultsDir, scenario.id, workspace, gitBefore)
			});
		}
	}

	const finishedMs = Date.now();
	const ordered = orderRecords(records);
	const report: E2eReport = {
		startedAt, finishedAt: new Date(finishedMs).toISOString(), durationMs: finishedMs - startedMs,
		options, runtime,
		totals: {
			scenarios: ordered.length,
			passed: ordered.filter((r) => r.status === 'pass').length,
			failed: ordered.filter((r) => r.status === 'fail').length,
			skipped: ordered.filter((r) => r.status === 'skip').length
		},
		scenarios: ordered
	};
	const paths = writeReports(report, resultsDir);
	fs.writeFileSync(path.join(resultsDir, 'summary.txt'), summaryText(report));

	if (report.totals.failed > 0 && options.keepOpen) {
		// --keep-open: hold the window open for debugging (the launcher's exit code is meaningless
		// for this run; the reports on disk are the outcome). Resolves only when the user closes.
		await new Promise<void>(() => undefined);
	}
	if (report.totals.failed > 0) {
		throw new Error(report.totals.failed + ' of ' + report.totals.scenarios + ' scenarios failed; reports: ' + paths.junit);
	}
}

/* ---------------- Composition (which scenarios this tier runs) ---------------- */

/** The tier's scenario list (S-checklist + picks for smoke; synthetic suite + customs otherwise). */
function composeScenarios(options: E2eOptions): readonly Scenario[] {
	if (options.tier === 'smoke') {
		return [...smokeScenarios(options.grep)];
	}
	// affected/full: the S-checklist customs matching the affected tags (grep applies to them),
	// plus the whole catalog as ONE synthetic legacy scenario (tag-filtered by the runner in
	// host — the entry never needs the catalog's data). A grep narrows the checklist only.
	const affected = readAffectedSelection();
	const customs = customsForTier(options.tier, affected, options.grep);
	if (options.grep !== null) {
		return customs;
	}
	const synthetic: Scenario = {
		id: 'legacy-suite/' + options.tier,
		title: 'Legacy catalog suite (' + options.tier + ' tier)',
		tags: ['legacy'],
		when: { legacy: { actionIds: [] } } // marker: executed as a whole-catalog (tag-filtered) call
	};
	return [synthetic, ...customs];
}

/**
 * The affected selection the launcher computed (E2E_AFFECTED: {"full":true} or {"tags":[...]}).
 * Null for the full tier and when absent/malformed (treated as full — conservative).
 */
function readAffectedSelection(): { tags: string[] } | null {
	const raw = process.env[E2E_AFFECTED_ENV];
	if (raw === undefined || raw === '') return null;
	try {
		const parsed = JSON.parse(raw) as { full?: boolean; tags?: unknown };
		if (parsed.full === true) return null;
		if (Array.isArray(parsed.tags)) return { tags: parsed.tags.filter((tag): tag is string => typeof tag === 'string') };
	} catch {
		// malformed: fall through to full
	}
	return null;
}

/** Run the legacy batch (or the whole/tag-filtered catalog for the synthetic scenario). */
async function runLegacyBatch(batch: readonly Scenario[], workspace: string, options: E2eOptions): Promise<SuiteReportWire> {
	const synthetic = batch.find((scenario) => scenario.id.startsWith('legacy-suite/'));
	if (synthetic !== undefined) {
		const tags = suiteTagsForTarget(readAffectedSelection());
		return runSuite({
			e2eSuite: true, repo: workspace, actionTimeoutMs: options.actionTimeoutMs,
			fixtureOptions: options.fixture,
			includeTags: tags === null ? undefined : tags
		});
	}
	const request = suiteRequestFor(batch, workspace, options);
	const actionIds = [...request.actionIds ?? []];
	if (!actionIds.includes(BOOTSTRAP_ACTION)) {
		// No read action of this batch generates the fixture on its own — make sure the bootstrap
		// action's run does (the suite's empty-repository path writes the whole history first).
		actionIds.push(BOOTSTRAP_ACTION);
	}
	return runSuite({ ...request, actionIds });
}

/* ---------------- Ordering, summaries and small helpers ---------------- */

/** Report order: the S-checklist, then the domain picks, then the synthetic legacy suite. */
function orderRecords(records: readonly ScenarioRecord[]): ScenarioRecord[] {
	const rank = (id: string): number => {
		if (id.startsWith('smoke/S')) return 0;
		if (id.startsWith('legacy-suite/')) return 2;
		return 1;
	};
	return [...records].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

function sumDurations(runs: readonly { totalMs: number | null }[]): number | null {
	const times = runs.map((run) => run.totalMs).filter((ms): ms is number => ms !== null);
	return times.length > 0 ? times.reduce((a, b) => a + b, 0) : null;
}

function summaryText(report: E2eReport): string {
	const lines = ['E2E ' + report.options.tier + ' tier — ' + report.totals.passed + ' passed, '
		+ report.totals.failed + ' failed, ' + report.totals.skipped + ' skipped ('
		+ report.totals.scenarios + ' scenarios, ' + (report.durationMs / 1000).toFixed(1) + 's)',
		'VS Code ' + (report.runtime?.editorVersion ?? '?') + ', backend ' + (report.runtime?.backend ?? report.options.backend)];
	for (const scenario of report.scenarios) {
		lines.push((scenario.status === 'pass' ? 'ok  ' : scenario.status === 'skip' ? 'skip' : 'FAIL')
			+ '  ' + scenario.id + (scenario.detail === null ? '' : '  ' + firstLine(scenario.detail)));
	}
	return lines.join('\n') + '\n';
}

/** A git repository with no commits anywhere (the suite's fixture generation precondition). */
async function ensureEmptyGitRepo(workspace: string): Promise<void> {
	const isRepo = await git(['rev-parse', '--git-dir'], workspace).then(() => true).catch(() => false);
	if (!isRepo) {
		await git(['-c', 'init.defaultBranch=main', 'init'], workspace);
		return;
	}
	if (fs.existsSync(path.join(workspace, '.gg-fixture'))) return; // a reused fixture workspace: the suite reseeds it in place
	const count = await git(['rev-list', '--count', '--all'], workspace).then((out) => parseInt(out.trim(), 10)).catch(() => 0);
	if (count > 0) {
		throw new Error('the E2E workspace ' + workspace + ' already holds ' + count + ' commits and no fixture marker — refusing to run against it');
	}
}

async function safeGitState(repo: string): Promise<string | null> {
	try {
		return await captureGitState(repo);
	} catch {
		return null;
	}
}

function readOptions(): E2eOptions {
	return deserializeOptions(process.env[E2E_OPTIONS_ENV]);
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error('the E2E entry requires $' + name + ' (set by the launcher)');
	}
	return value;
}
