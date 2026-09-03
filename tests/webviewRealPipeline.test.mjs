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
import { createRepo, bootRealView, setAfterDeliver, sleep } from './webviewRealPipelineHarness.mjs';

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
