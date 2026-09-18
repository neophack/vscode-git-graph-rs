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

const outDir = path.join(os.tmpdir(), 'gg-automation-runner-test');
const fixtureDir = path.join(outDir, 'fixture');
const silentLogger = { log() { }, logError() { } };

// A handful of fast read actions. The write suite is still ENTERED (the repository is a fixture
// clone, so the runner reseeds it and runs the mutable phase with the filter's selection) — a
// separate test exercises reseedFixtureClone directly, and the full catalog's write pass is
// covered by the scale check, so no slow dialog flows run here.
const SELECTED = new Set([
	'control-bar/refresh',
	'control-bar/find-open',
	'menu-commit/copy-hash'
]);

let boot;

test.before(async () => {
	fs.rmSync(outDir, { recursive: true, force: true });
	await generate({ outDir, commits: 300, branches: 6, tags: 10, authors: 8, force: true });
	await seedRepo(fixtureDir);
	boot = await bootRealView(fixtureDir);
	for (let i = 0; i < 100; i++) {
		if (boot.GitGraphView.currentPanel.automationState().currentRepo) break;
		await boot.sleep(100);
	}
});

test.after(() => {
	boot?.dispose();
	fs.rmSync(outDir, { recursive: true, force: true });
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

test('runAutomationSuite runs the selected actions over the loopback and reports them', async () => {
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

test('reseedFixtureClone restores a mutated clone to the seeded state', async () => {
	const { reseedFixtureClone, isAutomationFixtureClone } = boot.automation.suiteRunner;
	// The write action above created a branch: the reseed must remove it and restore the marker.
	await reseedFixtureClone(fixtureDir);
	assert.equal(isAutomationFixtureClone(fixtureDir), true);
	const git = (args) => execFileSync('git', args, { cwd: fixtureDir, encoding: 'utf8' }).trim();
	assert.equal(git(['branch', '--list', 'ggs-auto-branch']), '', 'the reseeded clone must not keep branches the write pass created');
	assert.equal(git(['stash', 'list']).split('\n').filter((line) => line.includes('fixture-stash-')).length, 3, 'the reseed restores the 3 fixture stashes');
	assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
});

test('renderReportHtml produces the standalone report with the save affordances', () => {
	const { renderReportHtml } = boot.automation.reportView;
	const report = {
		startedAt: '2026-09-17T00:00:00.000Z', finishedAt: '2026-09-17T00:01:00.000Z', durationMs: 60000,
		repo: 'R', fixture: false, writeSuiteIncluded: false,
		suites: [{
			name: 'read', runs: [{
				id: 'control-bar/refresh', title: 'Refresh', group: 'control-bar', mode: 'ui',
				ok: true, skipped: false, reason: null, error: null, totalMs: 12.5, responses: [{ command: 'loadRepoInfo', atMs: 3 }]
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
});
