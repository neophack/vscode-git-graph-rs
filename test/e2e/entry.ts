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
import * as vscode from 'vscode';
import { deserializeOptions } from './options';
import { captureFailureEvidence, captureGitState } from './evidence';
import { git, delay, openView, probe, runSuite, waitForActivation, waitForViewRepo } from './inhost';
import { firstLine, outcomeForScenario, runsById, suiteRequestFor } from './legacyAdapter';
import { writeReports } from './reports';
import { PERF_SCENARIOS, Scenario } from './scenarios';
import { PROCEDURES } from './smokeProcedures';
import { E2E_AFFECTED_ENV, E2E_OPTIONS_ENV, E2E_RESULTS_DIR_ENV, E2E_WORKSPACE_ENV, E2eOptions, E2eReport, ScenarioRecord, SuiteReportWire } from './types';
import { customsForTier, smokeScenarios, suiteTagsForTarget } from './scenarios';

/** The action whose suite run doubles as the fixture bootstrap (it generates into the empty workspace). */
const BOOTSTRAP_ACTION = 'control-bar/refresh';

/**
 * The time windows the P4 collector (test/perf/collect-e2e-traces.mjs) attributes the session
 * log's `Trace` lines to: the boot open, the legacy suite call (the whole catalog batch — its
 * actions do not map 1:1 to traces, but each trace's NAME carries which operation it measured),
 * and every custom procedure. Wall-clock ISO stamps from the extension host's clock, which runs
 * TZ=UTC (the launcher pins it), exactly like the log's own timestamps.
 */
const perfWindows: { id: string; startedAt: string; finishedAt: string }[] = [];

/** Run `fn` as one named perf window: its wall-clock span lands in perf-windows.json even when `fn` throws. */
async function inWindow<T>(id: string, fn: () => Promise<T>): Promise<T> {
	const startedAt = new Date().toISOString();
	try {
		return await fn();
	} finally {
		perfWindows.push({ id, startedAt, finishedAt: new Date().toISOString() });
	}
}

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
	let logFile: string | null = null;
	// Activate via the automation probe FIRST (it triggers activation without opening a view),
	// then re-assert the logging setting, THEN open the view. Reason: VS Code's startup fires
	// configuration events for the extension's settings section while the configuration model
	// is still settling, and main.ts's listener re-reads `enableLog` on any such event — the
	// transient read comes back false and the session's logging is switched off for good (the
	// session log then holds only the activation lines; no Trace line ever reaches the file,
	// which is what broke the first smoke run of the P4 wave). A real value change after
	// startup re-runs the same listener against the settled configuration — which reads true —
	// and both the logger and the trace layer come back on before the view, and with them the
	// boot trace this harness exists to measure.
	const activated = await waitForActivation(120000);
	await reassertLogging();
	const runtime = { editorVersion: activated.editorVersion, backend: options.backend };
	logFile = (await probe()).logFile;
	await inWindow('boot', async () => {
		await openView(workspace);
		await waitForViewRepo(workspace, 120000);
	});
	// P4 diagnostics: why a run's session log can hold only its activation lines. The inspect
	// shows every scope's value of enableLog AS THE EXTENSION HOST SEES IT at boot end, and the
	// byte size (now, and again when the windows file is written) shows whether the log grew
	// after activation — logger-disabled and file-mirror-stalled are different failures and
	// this is how to tell them apart.
	let enableLogScopes: Record<string, unknown> | null = null;
	try {
		const section = vscode.workspace.getConfiguration('git-graph-rs');
		const inspect = section.inspect('enableLog');
		enableLogScopes = inspect === undefined ? null : {
			value: section.get('enableLog'),
			// The extension's own read (platform/config.ts passes the scope argument explicitly).
			valueWithExplicitUndefinedScope: vscode.workspace.getConfiguration('git-graph-rs', undefined).get('enableLog'),
			globalValue: inspect.globalValue, workspaceValue: inspect.workspaceValue,
			workspaceFolderValue: inspect.workspaceFolderValue
		};
	} catch { /* diagnostics only */ }
	const logSizeAtBoot = logFile !== null && fs.existsSync(logFile) ? fs.statSync(logFile).size : null;

	const composed = composeScenarios(options);
	const legacyBatch = composed.filter((scenario) => 'legacy' in scenario.when);
	const customs = composed.filter((scenario) => 'procedure' in scenario.when);

	// The legacy batch: ONE suite call for every legacy scenario of the tier (plus the bootstrap
	// action, whose run generates the fixture into the empty workspace on the first call).
	if (legacyBatch.length > 0) {
		const gitBefore = await safeGitState(workspace);
		// One window for the whole catalog batch: its actions run sequentially inside ONE suite
		// call, so per-action windows are not recoverable here — the trace NAMES (op:loadCommits,
		// op:commitDetails, ...) carry which operation a trace measured.
		const report = await inWindow('legacy-suite', () => runLegacyBatch(legacyBatch, workspace, options));
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

	// Tiers (or --grep selections) with no legacy scenario never run the bootstrap action, so
	// the workspace would still be the empty repository and every procedure would wait on a
	// repository with no history. One bootstrap-only suite call generates the fixture in place.
	if (legacyBatch.length === 0 && composed.length > 0) {
		const bootstrap = await inWindow('fixture-bootstrap', () => runSuite({
			e2eSuite: true, repo: workspace, actionIds: [BOOTSTRAP_ACTION],
			actionTimeoutMs: options.actionTimeoutMs, fixtureOptions: options.fixture
		}));
		const failedRun = bootstrap.suites.flatMap((suite) => suite.runs).find((run) => !run.ok && !run.skipped);
		if (failedRun !== undefined) {
			throw new Error('the fixture bootstrap failed: ' + firstLine(failedRun.error ?? failedRun.reason ?? 'failed') + ' (' + failedRun.id + ')');
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
			const outcome = await inWindow(scenario.id, () => PROCEDURES['procedure' in scenario.when ? scenario.when.procedure : '']({ repo: workspace, options }));
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
	// The P4 collector's input (test/perf/collect-e2e-traces.mjs, spawned by the launcher):
	// the log file's path plus the time window of every scenario unit this run executed.
	// Written even for a failing run (its traces matter most), and never allowed to break
	// the reports above.
	try {
		fs.writeFileSync(path.join(resultsDir, 'perf-windows.json'), JSON.stringify({
			logFile,
			tier: options.tier,
			backend: options.backend,
			startedAt: startedAt,
			finishedAt: new Date().toISOString(),
			windows: perfWindows,
			diagnostics: {
				enableLogScopes: enableLogScopes,
				logSizeAtBoot: logSizeAtBoot,
				logSizeAtEnd: logFile !== null && fs.existsSync(logFile) ? fs.statSync(logFile).size : null,
				loggingRepair: loggingDiagnostics
			}
		}, null, '\t') + '\n');
	} catch { /* trace collection is best effort; the reports stand */ }

	if (report.totals.failed > 0 && options.keepOpen) {
		// --keep-open: hold the window open for debugging (the launcher's exit code is meaningless
		// for this run; the reports on disk are the outcome). Resolves only when the user closes.
		await new Promise<void>(() => undefined);
	}
	if (report.totals.failed > 0) {
		throw new Error(report.totals.failed + ' of ' + report.totals.scenarios + ' scenarios failed; reports: ' + paths.junit);
	}
}

/**
 * Re-assert `git-graph-rs.enableLog` until the extension itself reports the log file live: the
 * extension's configuration listener re-runs on every real value change, and the probe's
 * `logFile` (the logger's own "enabled and mirroring" answer) is the condition — never a fixed
 * wait (§6.8.6). A no-op when logging is already live or the run asked for none.
 */
async function reassertLogging(): Promise<void> {
	const config = vscode.workspace.getConfiguration('git-graph-rs');
	if (config.get<boolean>('enableLog', false) !== true) return;
	let events = 0;
	const watched = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('git-graph-rs.enableLog')) events += 1;
	});
	try {
		for (let attempt = 0; attempt < 30; attempt++) {
			const live = await probe().then((state) => state.logFile, () => null);
			if (live !== null) return;
			// One real off→on change: the listener's re-read runs against the configuration as it
			// is NOW, which repairs the startup transient (see the boot comment). The re-checks
			// space out because the settling window of a starting workbench is seconds, not
			// milliseconds.
			await config.update('enableLog', false, vscode.ConfigurationTarget.Workspace);
			await delay(250);
			await config.update('enableLog', true, vscode.ConfigurationTarget.Workspace);
			await delay(750);
		}
	} finally {
		watched.dispose();
		loggingDiagnostics.configurationEventsDuringRepair = events;
	}
}

/** What the logging repair observed (diagnostics, written with the windows file). */
const loggingDiagnostics: { configurationEventsDuringRepair?: number } = {};

/* ---------------- Composition (which scenarios this tier runs) ---------------- */

/** The tier's scenario list (S-checklist + picks for smoke; synthetic suite + customs otherwise). */
function composeScenarios(options: E2eOptions): readonly Scenario[] {
	if (options.tier === 'smoke') {
		return [...smokeScenarios(options.grep)];
	}
	if (options.tier === 'perf') {
		// The measurement tier (not a gate): the D-2 hidden→visible restore measurement, run
		// under `--tier perf` (nightly / calibration) so the blocking tiers stay untouched.
		return [...PERF_SCENARIOS];
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
