/**
 * Integration test for the automation engine against the REAL extension pipeline (real
 * GitGraphView + real compiled webview in jsdom, booted by test/support/realPipeline.ts):
 * status/query/invoke/eval, catalog runs in both request and UI mode (the UI mode round-trips
 * through the in-page shim), skip and fail-fast semantics, and stats aggregation.
 *
 * Ported from tests/automationServer.test.mjs (REFACTOR-PLAN task 7.1); assertions are unchanged.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { bootRealView, createRepo, sleep, type BootedPipeline } from '../../support/realPipeline';
import { CATALOG } from '../../../src/extension/automation/catalog';
import { AutomationServer } from '../../../src/extension/automation/server';
import { HostBridge } from '../../../src/extension/automation/hostBridge';

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const repo = path.join(os.tmpdir(), 'gg-automation-server-test');
let boot: BootedPipeline | null = null;
let engine: AutomationServer | null = null;

// Minimal logger: the assertions here read engine results, not log lines.
const silentLogger = { log() { /* silent */ }, logError() { /* silent */ } };

beforeAll(async () => {
	createRepo(repo);
	boot = await bootRealView(repo);
	await sleep(500); // let the initial page load settle
	engine = new AutomationServer({ logger: silentLogger as never, bridge: new HostBridge(), version: 'test' } as never);
	engine.start();
	// Under a loaded full-suite run the repo can take much longer than the fixed settle above.
	const loadDeadline = Date.now() + 60000;
	while ((!engine.status().viewLoaded || engine.status().currentRepo === null) && Date.now() < loadDeadline) {
		await sleep(100);
	}
}, 300000);

afterAll(async () => {
	engine?.stop();
	boot?.dispose();
	/* Disposing the panel does not wait for the extension's in-flight git spawns, which can
	 * still hold the repository's pack files open: on Windows that makes rmSync fail with
	 * EPERM (the same race the real-pipeline tests retry through). Retry for a while until
	 * every git child has exited and the files are unlocked. */
	const deadline = Date.now() + 120000;
	for (;;) {
		try {
			fs.rmSync(repo, { recursive: true, force: true });
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}, 300000);

describe('the automation engine over the real pipeline', () => {
	it('status reports the loaded view and repository', async () => {
		const status = engine!.status();
		assert.equal(status.viewLoaded, true);
		// os.tmpdir() reports the 8.3 short form on this machine while the repo manager resolves
		// the real long path, and realpathSync's 8.3 expansion is not deterministic here - compare
		// by file identity (same dev+ino) instead of path spelling.
		const samePath = (a: string, b: string) => {
			try {
				const sa = fs.statSync(a), sb = fs.statSync(b);
				return sa.ino === sb.ino && sa.dev === sb.dev;
			} catch {
				return a === b;
			}
		};
		assert.ok(samePath(status.currentRepo!, repo));
		assert.ok(status.repos.some((r) => samePath(r, repo)));
	});

	it('query repoInfo reads through the real pipeline', async () => {
		const repoInfo = await engine!.query({ kind: 'repoInfo' }) as { command: string; head: string; branches: string[] };
		assert.equal(repoInfo.command, 'loadRepoInfo');
		assert.equal(repoInfo.head, 'main');
		assert.ok(repoInfo.branches.includes('main'));
	});

	it('query rejects unknown kinds and invoke validates its message', async () => {
		await assert.rejects(() => engine!.query({ kind: 'nope' } as never), /Unknown query kind/);
		await assert.rejects(() => engine!.invoke({} as never), /invoke requires/);
	});

	it('invoke returns the response payload', async () => {
		const outcome = await engine!.invoke({
			message: { command: 'loadRepoInfo', repo, refreshId: 0, showRemoteBranches: true, showStashes: true, hideRemotes: [] }
		});
		assert.equal(outcome.ok, true);
		assert.equal((outcome.response as { head: string }).head, 'main');
		assert.ok(outcome.timings);
		assert.ok(outcome.timings.totalMs >= 0);
	});

	it('run refresh in request mode times the host round trip', async () => {
		const outcome = await engine!.run({ id: 'control-bar/refresh', mode: 'request' });
		assert.equal(outcome.ok, true, outcome.error);
		assert.ok(outcome.timings);
		assert.ok(outcome.timings.totalMs > 0);
		const commands = outcome.timings.responses.map((r) => r.command);
		assert.ok(commands.includes('loadRepoInfo'));
		assert.ok(commands.includes('loadCommits'));
	});

	it('run refresh in UI mode drives the real webview button', async () => {
		const outcome = await engine!.run({ id: 'control-bar/refresh', mode: 'ui' });
		assert.equal(outcome.ok, true, outcome.error);
		assert.ok(outcome.timings);
		assert.ok(outcome.timings.totalMs > 0);
		assert.deepEqual(outcome.timings.responses.map((r) => r.command), ['loadRepoInfo', 'loadCommits']);
	});

	it('run rejects unknown actions and modes', async () => {
		await assert.rejects(() => engine!.run({ id: 'control-bar/does-not-exist' } as never), /Unknown action/);
		await assert.rejects(() => engine!.run({ id: 'control-bar/refresh', mode: 'nope' } as never), /mode must be/);
	});

	it('command mode executes the VS Code command behind a menu item (Source Control view title)', async () => {
		const outcome = await engine!.run({ id: 'menu-vscode/scm-view-button', mode: 'command' });
		assert.equal(outcome.ok, true, outcome.error);
	});

	it('command mode drives Show File History through the real command and restores the filter', async () => {
		// The harness repository's bulk is empty commits: give the context probe one commit with a
		// file change near HEAD, exactly what a real repository offers the Explorer menu.
		fs.appendFileSync(path.join(repo, 'tracked.txt'), '\nfile-history change\n');
		execFileSync('git', ['commit', '-am', 'change tracked for file history'], { cwd: repo });
		const outcome = await engine!.run({ id: 'menu-vscode/filter-by-file-explorer', mode: 'command', timeoutMs: 30000 });
		assert.equal(outcome.ok, true, outcome.error);
		assert.ok(outcome.timings);
		assert.deepEqual(outcome.timings.responses.map((r) => r.command), ['loadCommits']);
		// The post steps cleared the file filter again: the unfiltered graph is rendered.
		const rows = await engine!.eval({ expr: 'document.querySelectorAll("#commitTable tr.commit").length' });
		assert.equal(rows.ok, true, rows.error);
		assert.ok((rows.value as number) > 1, 'the filter must be cleared after the run (saw ' + rows.value + ' rows)');
	}, 120000);

	it('command mode executes the diff editor title Open File command', async () => {
		const outcome = await engine!.run({ id: 'menu-vscode/diff-open-file-button', mode: 'command' });
		assert.equal(outcome.ok, true, outcome.error ?? outcome.reason);
	});

	it('command mode captures the notification a refusal-only command raises (and asserts it)', async () => {
		// The harness repository has no remotes, so the hook fetch takes its deterministic "no Gerrit
		// server" refusal — an error notification is the command's whole observable outcome. The run
		// must span the handler (the notification arrives after the command's git probes), capture and
		// suppress the toast, and pass the catalog's expectNotifications assertion on its text.
		const outcome = await engine!.run({ id: 'menu-vscode/scm-gerrit-fetch-commit-msg-hook', mode: 'command' });
		assert.equal(outcome.ok, true, outcome.error);
		assert.ok(outcome.notifications);
		assert.ok(outcome.notifications.length > 0, 'the refusal notification must be captured');
		assert.ok(outcome.notifications.some((message: string) => message.includes('commit-msg')), JSON.stringify(outcome.notifications));
	});

	it('an error-bearing expected response FAILS the run (the payload gate)', async () => {
		// A response that arrives carrying an error payload must FAIL the run even though the
		// command itself was expected — "a response arrived" is not success. Driven with a
		// test-only action (no requires to satisfy, and deliberately no allowErrorOn tolerance)
		// whose request opens a file the harness repository does not contain: the host answers
		// with the SAME response command carrying its error, and the run has to fail with the
		// host's own text. (The catalogued host/open-file lists openFile in allowErrorOn — the
		// working-tree refusal is a designed outcome there — so it cannot demonstrate the gate.)
		const probe = {
			id: 'test/payload-gate-probe',
			title: 'Payload Gate Probe',
			group: 'test',
			mutable: false,
			request: [{ command: 'openFile', repo: '{{repo}}', hash: '{{commit}}', filePath: 'no/such/file.txt' }],
			expect: { responses: ['openFile'] }
		};
		(CATALOG as unknown[]).push(probe);
		try {
			const outcome = await engine!.run({ id: probe.id, mode: 'request' });
			assert.equal(outcome.ok, false);
			assert.ok((outcome.error ?? '').includes('the host reported an error for "openFile"'), outcome.error);
			assert.ok((outcome.error ?? '').length > 'the host reported an error for "openFile": '.length, 'the failure must carry the host\'s error text');
		} finally {
			const index = (CATALOG as unknown[]).indexOf(probe);
			if (index > -1) (CATALOG as unknown[]).splice(index, 1);
		}
	});

	it('allowErrorOn accepts the designed refusal without weakening anything else', async () => {
		// host/open-log-file answers with an error whenever session logging is disabled (the
		// documented, designed outcome): the entry lists openLogFile in allowErrorOn, so the error
		// payload is accepted and the action passes (with logging enabled the same run simply
		// succeeds — both outcomes are the designed pair).
		const outcome = await engine!.run({ id: 'host/open-log-file', mode: 'ui', timeoutMs: 30000 });
		assert.equal(outcome.ok, true, outcome.error);
	}, 120000);

	it('eval executes in the page and returns the value', async () => {
		const outcome = await engine!.eval({ expr: '({ rows: document.querySelectorAll("#commitTable tr.commit").length })' });
		assert.equal(outcome.ok, true, outcome.error);
		assert.ok((outcome.value as { rows: number }).rows > 0);
	});

	it('a failing page step ends the run immediately instead of burning the timeout', async () => {
		// Remove a control button the next action clicks: the click step fails within milliseconds.
		// The run must report that step error at once — waiting the whole timeout for the expected
		// response hid the real cause and slowed the suite by 30 s per such failure.
		await engine!.eval({ expr: '(document.getElementById("terminalBtn").remove(), "removed")' });
		const startedAt = Date.now();
		const outcome = await engine!.run({ id: 'control-bar/terminal', mode: 'ui', timeoutMs: 20000 });
		const elapsed = Date.now() - startedAt;
		assert.equal(outcome.ok, false);
		assert.ok(outcome.error!.includes('no element matches'), outcome.error);
		assert.ok(elapsed < 10000, 'a failed page step must fail fast (took ' + elapsed + ' ms)');
	});

	it('actions whose view precondition is absent are skipped, not failed', async () => {
		// The harness repository is clean, so the Uncommitted Changes row never renders: the
		// skipIfAbsent precondition turns the action into a skip with the reason recorded.
		const outcome = await engine!.run({ id: 'menu-uncommitted/open-source-control', mode: 'ui' });
		assert.equal(outcome.skipped, true, JSON.stringify(outcome));
		assert.equal(outcome.ok, false);
		assert.ok((outcome.reason ?? '').includes('uncommittedChanges'), outcome.reason);
	});

	it('the archive actions reach the flow (the engine no longer refuses them)', async () => {
		// The former engine-side refusal is gone (task 4.10): the save dialog is answered by a
		// ScriptedUiPort the SUITE RUNNER installs, so a direct engine.run caller without one takes
		// the flow's own cancel path (the stubbed window resolves the dialog undefined, the flow
		// answers its "no file name" error) — the run records whatever the flow really did, never a
		// pre-flight skip.
		const outcome = await engine!.run({ id: 'menu-branch/create-archive', mode: 'request' });
		assert.notEqual(outcome.skipped, true, 'the engine must not pre-flight skip: ' + JSON.stringify(outcome));
		assert.equal(outcome.ok, false); // no scripted port installed: the flow's cancel path
	});

	it('stats aggregates the runs', async () => {
		const stats = engine!.stats();
		const refreshUi = stats.find((s) => s.id === 'control-bar/refresh' && s.mode === 'ui');
		assert.ok(refreshUi, 'stats must contain control-bar/refresh ui');
		assert.ok(refreshUi!.runs >= 1);
		assert.ok(refreshUi!.p50Ms >= refreshUi!.minMs && refreshUi!.p50Ms <= refreshUi!.maxMs);
	});
});

/* ---------- controls the loaded view offers only after scrolling (real-repository shapes) ---------- */

const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

/** Refresh the view so freshly created refs/stashes render, then run the action in UI mode. */
async function runAfterRefresh(id: string) {
	const refresh = await engine!.run({ id: 'control-bar/refresh', mode: 'ui' });
	assert.equal(refresh.ok, true, 'refresh failed: ' + refresh.error);
	return engine!.run({ id, mode: 'ui', timeoutMs: 60000 });
}

describe('the automation engine over the real pipeline (deep-scrolled controls)', () => {
	it('pin toggles a branch whose label renders far below the viewport', async () => {
		// Real repositories carry branches whose tips are old history: the flow scrolls the label
		// into view first, and the pin/unpin barriers must observe the pinned-controls chip — the
		// first table row a deep-scrolled windowed view never renders (the reported failure).
		git(['branch', 'old-branch', 'main~100']);
		const outcome = await runAfterRefresh('menu-branch/pin');
		assert.equal(outcome.ok, true, outcome.error);
		// The round-trip restores the pin state: no chip for old-branch may remain.
		const chips = await engine!.eval({
			expr: 'document.querySelectorAll(".pinnedChip[data-type=\\"branch\\"][data-value=\\"old-branch\\"]").length'
		});
		assert.equal(chips.ok, true, chips.error);
		assert.equal(chips.value, 0, 'the pin/unpin round-trip must leave the branch unpinned');
	}, { timeout: 180000, retry: 1 }); // deep-scroll + windowed rendering: one load-flake retry

	it('a stash outside the loaded graph skips instead of failing', async () => {
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
	}, { timeout: 180000, retry: 1 }); // same windowed-render patience

	it('stash copy actions scroll to a label far below the viewport', async () => {
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
	}, { timeout: 180000, retry: 1 }); // the second action re-runs after the first's menu round-trip
});
