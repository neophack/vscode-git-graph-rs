/**
 * Tests for the in-process automation suite runner (the "Run Automation Test" button's engine)
 * and the report page renderer: a loopback run over the real pipeline against a small fixture,
 * the fixture-clone guard, the reseed path, and the standalone report HTML.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootRealView } from './webviewRealPipelineHarness.mjs';
import { generate, seedRepo } from '../scripts/automation/fixture.mjs';

// The scratch root honours GG_AUTOMATION_TMP so two checkout sessions can run this file at once
// without stepping on each other's shared temp fixture (one run's after-hook would delete the
// repo under the other's feet).
const tmpRoot = typeof process.env.GG_AUTOMATION_TMP === 'string' && process.env.GG_AUTOMATION_TMP !== ''
	? process.env.GG_AUTOMATION_TMP : os.tmpdir();
const outDir = path.join(tmpRoot, 'gg-automation-runner-test');
const fixtureDir = path.join(outDir, 'fixture');
const silentLogger = { log() { }, logError() { } };

// A handful of fast read actions. The write suite is still ENTERED (the repository is a fixture
// clone, so the runner reseeds it and runs the mutable phase with the filter's selection) — a
// separate test exercises reseedFixtureClone directly, and the full catalog's write pass is
// covered by the scale check, so no slow dialog flows run here. One command-mode action rides
// along so the runner's mode selection covers the VS Code menu path too.
const SELECTED = new Set([
	'control-bar/refresh',
	'control-bar/find-open',
	'menu-commit/copy-hash',
	'menu-vscode/scm-view-button'
]);

let boot;

/** The same bounded removal as the suite runner's rmTreeAwaitingLocks, usable before boot exists. */
async function rmTreeBounded(target) {
	const deadline = Date.now() + 120000;
	for (;;) {
		try { fs.rmSync(target, { recursive: true, force: true }); return; }
		catch (error) { if (Date.now() >= deadline) throw error; }
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

test.before(async () => {
	// A leftover directory from an aborted run can still be held by a lingering git process or
	// a mapped engine handle for a while; the bounded removal waits that out instead of failing
	// every test at the first EPERM.
	await rmTreeBounded(outDir);
	await generate({ outDir, commits: 300, branches: 6, tags: 10, authors: 8, force: true });
	await seedRepo(fixtureDir);
	boot = await bootRealView(fixtureDir);
	for (let i = 0; i < 100; i++) {
		if (boot.GitGraphView.currentPanel.automationState().currentRepo) break;
		await boot.sleep(100);
	}
});

test.after(async () => {
	// dispose() releases the engine's warm handle, but a follow-up git child may still be
	// mid-exit holding a pack file; wait it out (through the product helper now that the module
	// is loaded) so an interrupted run does not poison the next one's before-hook cleanup.
	boot?.dispose();
	if (boot) {
		await boot.automation.suiteRunner.rmTreeAwaitingLocks(outDir);
		await boot.automation.suiteRunner.rmTreeAwaitingLocks(emptyRepoDir);
		await boot.automation.suiteRunner.rmTreeAwaitingLocks(realRepoDir);
	} else {
		await rmTreeBounded(outDir);
	}
});

test('the fixture guard recognises marker clones only', () => {
	const { isAutomationFixtureClone, readFixtureMarker } = boot.automation.suiteRunner;
	assert.equal(isAutomationFixtureClone(fixtureDir), true);
	assert.equal(readFixtureMarker(fixtureDir)?.remote, path.join(outDir, 'fixture-remote.git'));
	const notFixture = path.join(os.tmpdir(), 'gg-not-a-fixture');
	fs.rmSync(notFixture, { recursive: true, force: true });
	fs.mkdirSync(notFixture, { recursive: true });
	assert.equal(isAutomationFixtureClone(notFixture), false);
	assert.equal(readFixtureMarker(notFixture), null);
	fs.rmSync(notFixture, { recursive: true, force: true });
});

test('runAutomationSuite runs the selected actions in-process and reports them', async () => {
	const progress = [];
	// No explicit repo: the runner defaults to the view's current repository (passing the raw
	// fixture path would not match the host-normalised root and trigger a needless re-open).
	const report = await boot.automation.suiteRunner.runAutomationSuite({
		logger: silentLogger,
		filter: (action) => SELECTED.has(action.id),
		actionTimeoutMs: 60000,
		onProgress: (p) => progress.push(p)
	});

	const currentRepo = boot.GitGraphView.currentPanel.automationState().currentRepo;
	assert.equal(report.repo, currentRepo);
	assert.equal(report.fixture, true);
	assert.equal(report.writeSuiteIncluded, true);
	assert.equal(report.totals.actions, SELECTED.size);
	assert.equal(report.totals.failed, 0, JSON.stringify(report.suites.flatMap((s) => s.runs).filter((r) => !r.ok)));
	assert.equal(report.totals.passed, SELECTED.size);
	assert.equal(report.suites[0].name, 'read');
	assert.equal(report.suites[1].name, 'write');
	assert.equal(report.suites[1].runs.length, 0); // the filter selects no write actions; the phase still ran (reseed happened)
	assert.ok(report.durationMs > 0);
	// Progress was reported for every action.
	assert.equal(progress.length, SELECTED.size);
	assert.deepEqual(progress.map((p) => p.actionId).sort(), [...SELECTED].sort());
	// Timing data is present on the runs that completed.
	const refresh = report.suites[0].runs.find((r) => r.id === 'control-bar/refresh');
	assert.ok(refresh.totalMs !== null && refresh.totalMs > 0);
});

test('runAutomationSuite ends with the repository back in its seeded state', async () => {
	const { runAutomationSuite } = boot.automation.suiteRunner;
	// One real write action (the tag dialog): the run must reset the repository AFTER the write
	// phase as well, not only before it — otherwise the write actions' commits, branches and tags
	// survive the run and pile up in the user's repository.
	const report = await runAutomationSuite({
		logger: silentLogger,
		filter: (action) => action.id === 'menu-commit/add-tag',
		actionTimeoutMs: 60000
	});
	assert.equal(report.totals.failed, 0, JSON.stringify(report.suites.flatMap((s) => s.runs).filter((r) => !r.ok)));
	assert.equal(report.suites[1].runs.length, 1);
	const git = (args) => execFileSync('git', args, { cwd: fixtureDir, encoding: 'utf8' }).trim();
	assert.equal(git(['tag', '-l', 'automation-tag']), '', 'the final reseed removed the tag the write action created');
	assert.equal(git(['stash', 'list']).split('\n').filter((line) => line.includes('fixture-stash-')).length, 3, 'the seeded stashes are restored after the write phase');
	assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'the run ends checked out on main');
});

test('actions that open the editor\'s native save dialog are reported as skipped, never run', async () => {
	const { runAutomationSuite } = boot.automation.suiteRunner;
	// Create Archive confirms into vscode.window.showSaveDialog — a modal an automated run cannot
	// dismiss; in the real editor it stalls the suite until clicked away. All three variants must
	// come back skipped (not failed, not silently absent) with a reason naming the dialog.
	const report = await runAutomationSuite({
		logger: silentLogger,
		filter: (action) => action.id.endsWith('/create-archive'),
		actionTimeoutMs: 60000
	});
	assert.equal(report.suites[1].runs.length, 3);
	for (const run of report.suites[1].runs) {
		assert.equal(run.skipped, true, run.id + ' must be skipped, not run');
		assert.equal(run.ok, false);
		assert.match(run.reason, /native save dialog/);
	}
	assert.equal(report.totals.skipped, 3);
	assert.equal(report.totals.failed, 0);
});

test('reseedFixtureClone restores a mutated clone to the seeded state', async () => {
	const { reseedFixtureClone, isAutomationFixtureClone } = boot.automation.suiteRunner;
	// Mutate the clone directly — a stray branch carrying a commit, plus a stray tag — the marks a
	// write pass leaves behind; the reseed must remove all of it and restore the marker. A canary
	// inside .git proves the reset is IN PLACE: the repository directory (which may be the user's
	// workspace folder, held open by the editor on Windows) is never deleted.
	const canary = path.join(fixtureDir, '.git', 'gg-persistence-check.txt');
	fs.writeFileSync(canary, 'kept');
	const git = (args) => execFileSync('git', args, { cwd: fixtureDir, encoding: 'utf8' }).trim();
	const gitCfg = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@fixture.dev'];
	execFileSync('git', [...gitCfg, 'checkout', '-q', '-b', 'ggs-auto-branch'], { cwd: fixtureDir });
	execFileSync('git', [...gitCfg, 'commit', '--allow-empty', '-m', 'stray write-pass commit'], { cwd: fixtureDir });
	execFileSync('git', [...gitCfg, 'tag', 'ggs-auto-tag'], { cwd: fixtureDir });
	execFileSync('git', [...gitCfg, 'checkout', '-q', 'main'], { cwd: fixtureDir });
	await reseedFixtureClone(fixtureDir);
	assert.equal(fs.readFileSync(canary, 'utf8'), 'kept', 'the reseed must never delete the repository directory');
	assert.equal(isAutomationFixtureClone(fixtureDir), true);
	assert.equal(git(['branch', '--list', 'ggs-auto-branch']), '', 'the reseeded clone must not keep branches the write pass created');
	assert.equal(git(['tag', '-l', 'ggs-auto-tag']), '', 'the reseeded clone must not keep tags the write pass created');
	assert.equal(git(['stash', 'list']).split('\n').filter((line) => line.includes('fixture-stash-')).length, 3, 'the reseed restores the 3 fixture stashes');
	assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});

test('a widget a prior action left open is closed before the next action\'s cleanup completes', async () => {
	const { runAutomationSuite } = boot.automation.suiteRunner;
	// Simulate what an action that opens Settings and then fails/times out BEFORE reaching its own
	// closing step leaves behind: the widget open, independent of any specific catalog action's
	// steps (a real button click, not the shim).
	boot.window.document.getElementById('settingsBtn').click();
	assert.equal(boot.window.document.getElementById('settingsWidget').classList.contains('active'), true,
		'the settings widget is open before the suite runs');

	await runAutomationSuite({
		logger: silentLogger,
		filter: (action) => action.id === 'control-bar/refresh',
		actionTimeoutMs: 20000,
		skipWriteSuite: true
	});

	assert.equal(boot.window.document.getElementById('settingsWidget').classList.contains('active'), false,
		'the leaked settings widget is closed once an (unrelated) action runs through the suite');
});

test('renderReportHtml produces the standalone report with the save affordances', () => {
	const { renderReportHtml } = boot.automation.reportView;
	const report = {
		startedAt: '2026-09-17T00:00:00.000Z', finishedAt: '2026-09-17T00:01:00.000Z', durationMs: 60000,
		repo: 'R', fixture: false, fixtureGenerated: false, writeSuiteIncluded: false,
			suites: [{
				name: 'read', runs: [{
					id: 'control-bar/refresh', title: 'Refresh', group: 'control-bar', mode: 'ui',
					ok: true, skipped: false, reason: null, error: null, totalMs: 12.5, responses: [{ command: 'loadRepoInfo', atMs: 3 }], notifications: []
				}]
			}, { name: 'write', runs: [] }],
		totals: { actions: 1, passed: 1, failed: 0, skipped: 0 }
	};
	const html = renderReportHtml(report);
	assert.ok(html.indexOf('control-bar/refresh') !== -1);
	assert.ok(html.indexOf('Save as HTML') !== -1);
	assert.ok(html.indexOf('Save as JSON') !== -1);
	assert.ok(html.indexOf('write suite was not run') !== -1);
	// The write-suite note must be absent when the write suite ran.
	const fixtureReport = { ...report, fixture: true, writeSuiteIncluded: true };
	assert.ok(renderReportHtml(fixtureReport).indexOf('write suite was not run') === -1);
	// The generated-fixture note appears exactly when the run generated the history in place.
	assert.ok(renderReportHtml({ ...report, fixtureGenerated: true }).indexOf('had no commits') !== -1);
	assert.ok(renderReportHtml(fixtureReport).indexOf('had no commits') === -1);
});

/* ---------- The empty-repository gate: no commits -> generate the fixture and write-test it ---------- */

const emptyRepoDir = path.join(tmpRoot, 'gg-automation-runner-empty');
const realRepoDir = path.join(tmpRoot, 'gg-automation-runner-real');

test('runAutomationSuite generates the fixture into a repository with no commits and runs the write suite', async () => {
	await rmTreeBounded(emptyRepoDir);
	fs.mkdirSync(emptyRepoDir, { recursive: true });
	execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', emptyRepoDir]);

	// One read action through the real pipeline; the write phase is entered (the repository became
	// a fixture clone) but the filter selects no write actions - the reseed still happens, which is
	// what proves the generated marker/remote pair drives the between-phases rebuild too.
	const registered = [];
	const report = await boot.automation.suiteRunner.runAutomationSuite({
		logger: silentLogger,
		repo: emptyRepoDir,
		filter: (action) => action.id === 'control-bar/refresh',
		actionTimeoutMs: 60000,
		fixtureOptions: { commits: 120, branches: 4, tags: 6, authors: 5 },
		registerRepo: async (repo) => { registered.push(repo); }
	});

	const git = (args) => execFileSync('git', args, { cwd: emptyRepoDir, encoding: 'utf8' }).trim();
	assert.equal(report.fixtureGenerated, true, 'the runner reports the in-place generation');
	assert.equal(report.fixture, true);
	assert.equal(report.writeSuiteIncluded, true);
	assert.equal(report.totals.failed, 0, JSON.stringify(report.suites.flatMap((s) => s.runs).filter((r) => !r.ok)));
	assert.ok(parseInt(git(['rev-list', '--count', '--all']), 10) >= 120, 'the fixture history was written into the repository');
	assert.equal(git(['stash', 'list']).split('\n').filter((line) => line.includes('fixture-stash-')).length, 3,
		'the pre-write reseed restored the seeded state from the generated remote');
	assert.ok(git(['branch', '--list', 'local-ahead']).includes('local-ahead'), 'the seeded local-ahead branch is back after the reseed');
	assert.ok(fs.existsSync(path.join(emptyRepoDir, '.gg-fixture')), 'the marker records the generated fixture');

	// The fixture's submodule: a nested repository materialised at sub/fixture-sub, recorded as a
	// gitlink (mode 160000) whose hash matches the nested repository's HEAD, `.gitmodules` checked
	// out on main, and both still in place after the final reseed — plus the runner asking the
	// host to register the submodule as the second known repository (the Repos dropdown's need).
	const subDir = path.join(emptyRepoDir, 'sub', 'fixture-sub');
	assert.ok(fs.existsSync(path.join(subDir, '.git')), 'the fixture submodule is materialised');
	assert.ok(fs.existsSync(path.join(emptyRepoDir, '.gitmodules')), '.gitmodules is checked out on main');
	const gitlinkParts = git(['ls-files', '-s', '--', 'sub/fixture-sub']).split(/\s+/);
	assert.equal(gitlinkParts[0], '160000', 'the submodule is recorded as a gitlink');
	const subHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: subDir, encoding: 'utf8' }).trim();
	assert.equal(gitlinkParts[1], subHead, 'the gitlink matches the nested repository HEAD');
	assert.ok(registered.some((repo) => repo === subDir), 'the runner registers the fixture submodule with the host');
});

test('runAutomationSuite skips the write suite on a repository that already has commits', async () => {
	await rmTreeBounded(realRepoDir);
	fs.mkdirSync(realRepoDir, { recursive: true });
	const id = ['-c', 'user.name=Real', '-c', 'user.email=real@real.dev'];
	execFileSync('git', [...id, '-c', 'init.defaultBranch=main', 'init', realRepoDir]);
	fs.writeFileSync(path.join(realRepoDir, 'work.txt'), 'real work\n');
	execFileSync('git', ['-C', realRepoDir, ...id, 'add', 'work.txt']);
	execFileSync('git', ['-C', realRepoDir, ...id, 'commit', '-m', 'a real commit']);

	const report = await boot.automation.suiteRunner.runAutomationSuite({
		logger: silentLogger,
		repo: realRepoDir,
		filter: () => false, // nothing to run: only the gate behaviour is under test
		actionTimeoutMs: 20000
	});

	const git = (args) => execFileSync('git', args, { cwd: realRepoDir, encoding: 'utf8' }).trim();
	assert.equal(report.fixture, false);
	assert.equal(report.fixtureGenerated, false);
	assert.equal(report.writeSuiteIncluded, false);
	assert.equal(report.totals.actions, 0);
	assert.equal(git(['rev-list', '--count', 'HEAD']), '1', 'the repository was left untouched');
	assert.equal(fs.existsSync(path.join(realRepoDir, '.gg-fixture')), false, 'no marker was written into a real repository');
	assert.equal(fs.existsSync(path.join(realRepoDir, 'sub')), false, 'no submodule is seeded into a real repository');
	assert.equal(fs.existsSync(path.join(realRepoDir, '.gitmodules')), false, 'no .gitmodules is written into a real repository');
});
