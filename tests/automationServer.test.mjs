/**
 * Integration test for the automation engine against the REAL extension pipeline (real
 * GitGraphView + real compiled webview in jsdom, booted by webviewRealPipelineHarness):
 * status/query/invoke/eval, catalog runs in both request and UI mode (the UI mode round-trips
 * through the in-page shim), skip and fail-fast semantics, and stats aggregation.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bootRealView, createRepo, sleep } from './webviewRealPipelineHarness.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const repo = path.join(os.tmpdir(), 'gg-automation-server-test');
let boot, engine;

// Minimal logger: the assertions here read engine results, not log lines.
const silentLogger = { log() { }, logError() { } };

test.before(async () => {
	createRepo(repo);
	boot = await bootRealView(repo);
	await sleep(500); // let the initial page load settle
	engine = new boot.automation.AutomationServer({ logger: silentLogger, bridge: new boot.automation.HostBridge(), version: 'test' });
	engine.start();
});

test.after(async () => {
	engine?.stop();
	boot?.dispose();
	fs.rmSync(repo, { recursive: true, force: true });
});

test('status reports the loaded view and repository', async () => {
	const status = engine.status();
	assert.equal(status.viewLoaded, true);
	const normalise = (p) => p.replace(/\\/g, '/');
	assert.equal(normalise(status.currentRepo), normalise(repo));
	assert.ok(status.repos.map(normalise).includes(normalise(repo)));
});

test('query repoInfo reads through the real pipeline', async () => {
	const repoInfo = await engine.query({ kind: 'repoInfo' });
	assert.equal(repoInfo.command, 'loadRepoInfo');
	assert.equal(repoInfo.head, 'main');
	assert.ok(repoInfo.branches.includes('main'));
});

test('query rejects unknown kinds and invoke validates its message', async () => {
	await assert.rejects(() => engine.query({ kind: 'nope' }), /Unknown query kind/);
	await assert.rejects(() => engine.invoke({}), /invoke requires/);
});

test('invoke returns the response payload', async () => {
	const outcome = await engine.invoke({
		message: { command: 'loadRepoInfo', repo, refreshId: 0, showRemoteBranches: true, showStashes: true, hideRemotes: [] }
	});
	assert.equal(outcome.ok, true);
	assert.equal(outcome.response.head, 'main');
	assert.ok(outcome.timings.totalMs >= 0);
});

test('run refresh in request mode times the host round trip', async () => {
	const outcome = await engine.run({ id: 'control-bar/refresh', mode: 'request' });
	assert.equal(outcome.ok, true, outcome.error);
	assert.ok(outcome.timings.totalMs > 0);
	const commands = outcome.timings.responses.map((r) => r.command);
	assert.ok(commands.includes('loadRepoInfo'));
	assert.ok(commands.includes('loadCommits'));
});

test('run refresh in UI mode drives the real webview button', async () => {
	const outcome = await engine.run({ id: 'control-bar/refresh', mode: 'ui' });
	assert.equal(outcome.ok, true, outcome.error);
	assert.ok(outcome.timings.totalMs > 0);
	assert.deepEqual(outcome.timings.responses.map((r) => r.command), ['loadRepoInfo', 'loadCommits']);
});

test('run rejects unknown actions and modes', async () => {
	await assert.rejects(() => engine.run({ id: 'control-bar/does-not-exist' }), /Unknown action/);
	await assert.rejects(() => engine.run({ id: 'control-bar/refresh', mode: 'nope' }), /mode must be/);
});

test('eval executes in the page and returns the value', async () => {
	const outcome = await engine.eval({ expr: '({ rows: document.querySelectorAll("#commitTable tr.commit").length })' });
	assert.equal(outcome.ok, true, outcome.error);
	assert.ok(outcome.value.rows > 0);
});

test('a failing page step ends the run immediately instead of burning the timeout', async () => {
	// Remove a control button the next action clicks: the click step fails within milliseconds.
	// The run must report that step error at once — waiting the whole timeout for the expected
	// response hid the real cause and slowed the suite by 30 s per such failure.
	await engine.eval({ expr: '(document.getElementById("terminalBtn").remove(), "removed")' });
	const startedAt = Date.now();
	const outcome = await engine.run({ id: 'control-bar/terminal', mode: 'ui', timeoutMs: 20000 });
	const elapsed = Date.now() - startedAt;
	assert.equal(outcome.ok, false);
	assert.ok(outcome.error.includes('no element matches'), outcome.error);
	assert.ok(elapsed < 10000, 'a failed page step must fail fast (took ' + elapsed + ' ms)');
});

test('actions whose view precondition is absent are skipped, not failed', async () => {
	// The harness repository is clean, so the Uncommitted Changes row never renders: the
	// skipIfAbsent precondition turns the action into a skip with the reason recorded.
	const outcome = await engine.run({ id: 'menu-uncommitted/open-source-control', mode: 'ui' });
	assert.equal(outcome.skipped, true, JSON.stringify(outcome));
	assert.equal(outcome.ok, false);
	assert.ok((outcome.reason ?? '').includes('uncommittedChanges'), outcome.reason);
});

test('stats aggregates the runs', async () => {
	const stats = engine.stats();
	const refreshUi = stats.find((s) => s.id === 'control-bar/refresh' && s.mode === 'ui');
	assert.ok(refreshUi, 'stats must contain control-bar/refresh ui');
	assert.ok(refreshUi.runs >= 1);
	assert.ok(refreshUi.p50Ms >= refreshUi.minMs && refreshUi.p50Ms <= refreshUi.maxMs);
});

/* ---------- controls the loaded view offers only after scrolling (real-repository shapes) ---------- */

const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

/** Refresh the view so freshly created refs/stashes render, then run the action in UI mode. */
async function runAfterRefresh(id) {
	const refresh = await engine.run({ id: 'control-bar/refresh', mode: 'ui' });
	assert.equal(refresh.ok, true, 'refresh failed: ' + refresh.error);
	return engine.run({ id, mode: 'ui', timeoutMs: 60000 });
}

test('pin toggles a branch whose label renders far below the viewport', async () => {
	// Real repositories carry branches whose tips are old history: the flow scrolls the label
	// into view first, and the pin/unpin barriers must observe the pinned-controls chip — the
	// first table row a deep-scrolled windowed view never renders (the reported failure).
	git(['branch', 'old-branch', 'main~100']);
	const outcome = await runAfterRefresh('menu-branch/pin');
	assert.equal(outcome.ok, true, outcome.error);
	// The round-trip restores the pin state: no chip for old-branch may remain.
	const chips = await engine.eval({
		expr: 'document.querySelectorAll(".pinnedChip[data-type=\\"branch\\"][data-value=\\"old-branch\\"]").length'
	});
	assert.equal(chips.ok, true, chips.error);
	assert.equal(chips.value, 0, 'the pin/unpin round-trip must leave the branch unpinned');
});

test('a stash outside the loaded graph skips instead of failing', async () => {
	// The stash reflog can hold entries far older than the loaded page (the view's first 300
	// commits): no stash row ever renders, and the action must skip with that reason rather
	// than fail on the absent label.
	git(['checkout', '-q', 'main~380']);
	fs.appendFileSync(path.join(repo, 'tracked.txt'), '\nancient\n');
	git(['stash', 'push', '-m', 'ancient-stash']);
	git(['checkout', '-q', 'main']);
	const outcome = await runAfterRefresh('menu-stash/copy-hash');
	assert.equal(outcome.skipped, true, JSON.stringify(outcome));
	assert.ok((outcome.reason ?? '').includes('loaded graph'), outcome.reason);
});

test('stash copy actions scroll to a label far below the viewport', async () => {
	// A stash made on old (but loaded) history renders far below the viewport: the flow must
	// scroll the label into view before right-clicking it.
	git(['checkout', '-q', 'main~100']);
	fs.appendFileSync(path.join(repo, 'tracked.txt'), '\ndeep\n');
	git(['stash', 'push', '-m', 'deep-stash']);
	git(['checkout', '-q', 'main']);
	for (const id of ['menu-stash/copy-hash', 'menu-stash/copy-name']) {
		const outcome = await runAfterRefresh(id);
		assert.equal(outcome.ok, true, id + ': ' + (outcome.error ?? outcome.reason ?? 'failed'));
	}
});
