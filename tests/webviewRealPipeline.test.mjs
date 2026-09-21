/**
 * End-to-end reproduction of the "viewport jumps while viewing the middle of the history": the
 * REAL compiled extension against a REAL throwaway git repository (400+ commits, so the
 * 300-commit loading window is truncated), wired to the REAL compiled webview inside jsdom -
 * the exact message pipeline of the editor, including the deferred "Uncommitted Changes" and
 * remote-refs follow-up responses.
 *
 * While the user is scrolled to the middle of the history, real `git` operations run in the
 * repository (a tracked file is modified, then everything is committed) and the webview is
 * refreshed the way the extension's background poll refreshes it. The on-screen Y coordinate of
 * every rendered row is re-measured after EVERY pipeline response: nothing the user is looking
 * at may move by a single pixel, not even transiently between two responses.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';
import { VIEWPORT_HEIGHT, measureRowCoordinates } from './webviewHarness.mjs';
import { createRepo, bootRealView, setAfterDeliver, setOnExtensionMessage, fireRepoFileEvent, setGraphPanelVisible, sleep } from './webviewRealPipelineHarness.mjs';

const repoDir = path.join(os.tmpdir(), 'git-graph-rs-jump-repro');
const git = (...args) => execFileSync('git', args, { cwd: repoDir });

describe('the real extension pipeline keeps the viewport still in a long repository', () => {
	let context = null;

	it('file modifications and commits in the repository never move the row the user is looking at', async () => {
		createRepo(repoDir);
		const h = await bootRealView(repoDir);
		context = h;
		for (let i = 0; i < 200 && h.rows().length === 0; i++) await sleep(100);
		assert.ok(h.rows().length > 0, 'commits were rendered');

		await h.scrollTo(150);
		const anchor = h.rows().find((row) => row.dataset.id === '151');
		assert.ok(anchor !== undefined, 'the anchor row is rendered');
		const anchorKey = anchor.querySelector('.description .text').textContent; // e.g. 'commit 250'
		const anchorYStart = measureRowCoordinates(h).get(anchorKey);

		// Re-measured after EVERY extension response: transient jumps between two responses are
		// exactly as visible (and as unacceptable) as permanent ones.
		let reference = measureRowCoordinates(h);
		setAfterDeliver((message) => {
			if (message.command !== 'loadCommits') return;
			const now = measureRowCoordinates(h);
			const visible = [...reference].filter(([, y]) => y >= 0 && y < VIEWPORT_HEIGHT);
			for (const [key, y] of visible) {
				assert.ok(now.has(key), 'loadCommits response: ' + key + ' is still rendered');
				assert.equal(now.get(key), y, 'loadCommits response: ' + key + ' stays at on-screen y=' + y);
			}
		});

		/* The extension refreshes the webview exactly like its background poll / file watcher:
		 * a 'refresh' message, answered by the full multi-stage loadCommits pipeline. */
		const repositoryChange = async (label, mutate) => {
			reference = measureRowCoordinates(h);
			mutate();
			h.window.dispatchEvent(new h.window.MessageEvent('message', { data: { command: 'refresh' } }));
			// wait for the pipeline (loadRepoInfo -> loadCommits -> follow-ups) to fall quiet
			for (let i = 0; i < 80; i++) await sleep(100);
			reference = measureRowCoordinates(h); // the settled state becomes the new reference
		};

		await repositoryChange('a tracked file is modified', () => {
			fs.appendFileSync(path.join(repoDir, 'tracked.txt'), 'more\n');
		});
		await repositoryChange('another edit', () => {
			fs.appendFileSync(path.join(repoDir, 'tracked.txt'), 'even more\n');
		});
		await repositoryChange('everything is committed', () => {
			git('add', '-A');
			git('commit', '-q', '-m', 'work');
		});
		await repositoryChange('idle refresh', () => {});

		const coords = measureRowCoordinates(h);
		assert.equal(coords.get(anchorKey), anchorYStart, anchorKey + ' ends exactly where the user scrolled it');
	}, 180000);

	after(async () => {
		if (context !== null) {
			context.dispose();
			context.window.close(); // drop the jsdom timers so the test process can exit
		}
		/* Disposing the panel does not wait for the extension's in-flight git spawns, which can
		 * still hold the repository's pack files open: on Windows that makes rmSync fail with
		 * EPERM. Retry for a while until every git child has exited and the files are unlocked. */
		let lastError = null;
		for (let i = 0; i < 40; i++) {
			try {
				fs.rmSync(repoDir, { recursive: true, force: true });
				lastError = null;
				break;
			} catch (error) {
				lastError = error;
				await sleep(250);
			}
		}
		if (lastError !== null) throw lastError;
	});
});

describe('a commit made while the view is a background tab still refreshes the view', () => {
	let context = null;
	const repoDir = path.join(os.tmpdir(), 'git-graph-rs-hidden-commit');
	const git = (...args) => execFileSync('git', args, { cwd: repoDir });

	it('the hidden view invalidates its commit cache and serves the commit on show', async () => {
		// The viewport test above leaves its message hook installed for the rest of the process;
		// clear it so its assertions cannot fire against this test's repository.
		setAfterDeliver(null);
		setOnExtensionMessage(null);
		createRepo(repoDir);
		const h = await bootRealView(repoDir);
		context = h;
		for (let i = 0; i < 200 && h.rows().length === 0; i++) await sleep(100);
		assert.ok(h.rows().length > 0, 'commits were rendered');

		// The repository key the extension actually watches (the resolved, forward-slash path).
		const repoKey = h.GitGraphView.currentPanel.automationState().currentRepo;
		assert.ok(repoKey !== null, 'the view has a current repository');

		// Everything the extension pushes to the page while the tab is hidden.
		const commandsWhileHidden = [];
		let hidden = false;
		setOnExtensionMessage((message) => { if (hidden) commandsWhileHidden.push(message.command); });

		// The tab loses the foreground - a background tab in its group, or an inactive editor
		// group the graph is still on screen in: panel.visible goes FALSE.
		hidden = true;
		setGraphPanelVisible(false);

		// A commit lands from outside this view (another tab's Source Control, a terminal),
		// producing exactly the .git events the watcher classifies as commit-affecting.
		git('commit', '-q', '--allow-empty', '-m', 'committed while hidden');
		fireRepoFileEvent('change', repoKey + '/.git/refs/heads/main');
		fireRepoFileEvent('change', repoKey + '/.git/index');

		// The watcher's 750 ms debounce must fire while STILL hidden: the refresh goes out and
		// the commit cache is invalidated. (The regression: both used to stop at the visibility
		// gate - the watcher was disposed on hide, the poll returned early - so the commit only
		// ever appeared after a manual refresh.)
		await sleep(2500);
		assert.ok(commandsWhileHidden.includes('refresh'), 'the file watcher delivered a refresh while the view was hidden, got: ' + JSON.stringify(commandsWhileHidden));

		// Back on the tab: the soft refresh serves the invalidated cache - the new commit is
		// rendered immediately, not after the background poll's next tick.
		hidden = false;
		setGraphPanelVisible(true);
		let appeared = false;
		for (let i = 0; i < 100 && !appeared; i++) {
			appeared = h.rows().some((row) => row.textContent.includes('committed while hidden'));
			if (!appeared) await sleep(100);
		}
		assert.ok(appeared, 'the commit made while hidden is rendered after the view is shown');
	}, 120000);

	after(async () => {
		setOnExtensionMessage(null);
		if (context !== null) {
			context.dispose();
			context.window.close();
		}
		let lastError = null;
		for (let i = 0; i < 40; i++) {
			try {
				fs.rmSync(repoDir, { recursive: true, force: true });
				lastError = null;
				break;
			} catch (error) {
				lastError = error;
				await sleep(250);
			}
		}
		if (lastError !== null) throw lastError;
	});
});

describe('a change the file watcher never reports is still caught by the background poll while hidden', () => {
	let context = null;
	const repoDir = path.join(os.tmpdir(), 'git-graph-rs-poll-hidden-commit');
	const git = (...args) => execFileSync('git', args, { cwd: repoDir });

	it('the poll invalidates the cache and refreshes the view while hidden, from a change no watcher event ever fired for', async () => {
		// The regression this pins is distinct from the file-watcher one above: before the fix,
		// checkForBackgroundChanges() itself returned early on `!panel.visible`, so even a repo
		// change the poll's own signature comparison would otherwise have caught stayed invisible
		// until a manual refresh, on top of the watcher being torn down on hide.
		setAfterDeliver(null);
		setOnExtensionMessage(null);
		createRepo(repoDir);
		const h = await bootRealView(repoDir);
		context = h;
		for (let i = 0; i < 200 && h.rows().length === 0; i++) await sleep(100);
		assert.ok(h.rows().length > 0, 'commits were rendered');

		// checkForBackgroundChanges is TypeScript-`private` only (no runtime enforcement): called
		// directly so the test does not have to wait out the real 5s poll interval. Its first call
		// records the baseline signature only - a NULL baseline never triggers a refresh.
		const view = h.GitGraphView.currentPanel;
		await view.checkForBackgroundChanges();

		const commandsWhileHidden = [];
		let hidden = false;
		setOnExtensionMessage((message) => { if (hidden) commandsWhileHidden.push(message.command); });

		hidden = true;
		setGraphPanelVisible(false);

		// A commit from outside this view, with no filesystem event fired for it at all: nothing
		// but the poll's own signature comparison can notice this change.
		git('commit', '-q', '--allow-empty', '-m', 'committed while hidden, no watcher event');

		await view.checkForBackgroundChanges();
		assert.ok(commandsWhileHidden.includes('refresh'), 'the background poll delivered a refresh while the view was hidden, got: ' + JSON.stringify(commandsWhileHidden));

		// Back on the tab: the soft refresh serves the poll's invalidated cache - the new commit
		// is rendered immediately, not after another poll tick.
		hidden = false;
		setGraphPanelVisible(true);
		let appeared = false;
		for (let i = 0; i < 100 && !appeared; i++) {
			appeared = h.rows().some((row) => row.textContent.includes('committed while hidden, no watcher event'));
			if (!appeared) await sleep(100);
		}
		assert.ok(appeared, 'the commit the poll caught while hidden is rendered after the view is shown');
	}, 60000);

	after(async () => {
		setOnExtensionMessage(null);
		if (context !== null) {
			context.dispose();
			context.window.close();
		}
		let lastError = null;
		for (let i = 0; i < 40; i++) {
			try {
				fs.rmSync(repoDir, { recursive: true, force: true });
				lastError = null;
				break;
			} catch (error) {
				lastError = error;
				await sleep(250);
			}
		}
		if (lastError !== null) throw lastError;
	});
});
