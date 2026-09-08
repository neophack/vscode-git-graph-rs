/**
 * End-to-end reproduction of the stale "Use Global Author" badge: after the last author
 * identity was deleted from the Settings Widget, the badge kept showing the deleted identity
 * (e.g. "Use Global Author (neophack <pep3309531@163.com>)" under an already-empty list). The
 * widget reloaded the repository configuration NEXT TO the save - racing the extension host's
 * global-author writes, that reload was served the pre-save snapshot, and nothing reloaded
 * after the save completed. The REAL compiled extension and REAL compiled webview run against
 * a REAL throwaway repository whose GLOBAL Git configuration is an isolated throwaway file:
 * the identity list, the global-author clearing and the useConfigOnly guard all operate on
 * it, never on the developer's machine.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';

/* Isolate the global Git configuration BEFORE anything boots: the DataSource spawns git with
 * the inherited environment, so every `git config --global` of the pipeline hits this file.
 * It holds the identity the badge must stop showing once the list is emptied. */
const globalConfigFile = path.join(os.tmpdir(), 'gg-author-badge-gitconfig');
fs.writeFileSync(globalConfigFile, '[user]\n\tname = neophack\n\temail = pep3309531@163.com\n');
process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { createRepo, bootRealView, setOnExtensionMessage, sleep } = await import('./webviewRealPipelineHarness.mjs');

const repoDir = path.join(os.tmpdir(), 'git-graph-rs-author-badge');
const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });

/** Read the ISOLATED global config key (NULL => not set). */
function globalConfigValue(key) {
	try {
		return execFileSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
}

describe('the Settings Widget global author badge after the identity list was emptied', () => {
	let context = null;

	after(() => {
		if (context !== null) {
			context.dispose();
			try { context.window.close(); } catch { /* already closed */ }
		}
		fs.rmSync(repoDir, { recursive: true, force: true });
		fs.rmSync(globalConfigFile, { force: true });
	});

	it('deleting the last author clears the badge - the config reload FOLLOWS the save, never races it', async () => {
		createRepo(repoDir);
		// The repository follows the GLOBAL identity (no local override to commit with)
		git('config', '--local', '--unset', 'user.name');
		git('config', '--local', '--unset', 'user.email');

		const h = await bootRealView(repoDir);
		context = h;
		for (let i = 0; i < 200 && h.rows().length === 0; i++) await sleep(100);
		assert.ok(h.rows().length > 0, 'commits were rendered');

		/* The editor pushes a `configChanged` message once the setting write of a save becomes
		 * visible; the harness' stubbed configuration has no events, so the test delivers the
		 * pushes itself, exactly as the editor would around each save. */
		const pushCommitAuthors = (authors) => {
			const config = h.window.eval('initialState').config; // the full webview config, always current
			config.commitAuthors = authors;
			h.window.dispatchEvent(new h.window.MessageEvent('message', { data: { command: 'configChanged', config: config } }));
		};

		// The identity list holds the global identity (what the seeding would have saved)
		pushCommitAuthors([{ name: 'neophack', email: 'pep3309531@163.com' }]);

		// Open the Settings Widget: the badge follows the global Git configuration
		h.document.getElementById('settingsBtn').click();
		let authorRows = null;
		for (let i = 0; i < 100; i++) {
			await sleep(100);
			authorRows = h.document.querySelectorAll('.authorTable .authorBtns');
			if (authorRows.length > 0) break;
		}
		assert.ok(authorRows !== null && authorRows.length === 1, 'the identity list shows the configured identity');
		assert.match(h.document.getElementById('useGlobalAuthorRow').textContent, /neophack <pep3309531@163\.com>/, 'the badge shows the global identity while it exists');

		/* One timeline of the message pipeline: every request the webview sends to the host, and
		 * every response the host posts back. The race under test is a 'loadConfig' REQUEST
		 * leaving between the save's request and its response - it would be answered from the
		 * not-yet-invalidated configuration cache and render the pre-save global author. */
		const timeline = [];
		const originalPostMessage = h.window.__api.postMessage;
		h.window.__api.postMessage = (message) => { timeline.push('>' + message.command); originalPostMessage(message); };
		setOnExtensionMessage((message) => { timeline.push('<' + message.command); });

		// Delete the identity: confirmation dialog -> confirm
		h.document.querySelector('.authorTable .deleteAuthor').click();
		h.document.getElementById('dialogAction').click();

		// The editor pushes the emptied list the moment the setting write completes (during the
		// save's round trip, before its response): deliver that push like the editor does
		pushCommitAuthors([]);

		// The response (and the reload it orders) arrive asynchronously: settle on the badge
		let badge = '';
		for (let i = 0; i < 100 && !badge.includes('Not Set'); i++) {
			await sleep(100);
			badge = h.document.getElementById('useGlobalAuthorRow').textContent;
		}
		assert.match(badge, /Not Set/, 'the badge shows the cleared global author');
		assert.doesNotMatch(badge, /neophack/, 'the deleted identity is gone from the badge');
		assert.match(h.document.querySelector('#settingsContent').textContent, /No author identities are configured/, 'the empty-list hint is shown');

		// The repository configuration was reloaded only AFTER the save's response: no
		// 'loadConfig' request left the webview while the save was still in flight
		const saveRequest = timeline.indexOf('>setGlobalSetting');
		const saveResponse = timeline.indexOf('<setGlobalSetting', saveRequest);
		const reload = timeline.indexOf('>loadConfig', saveRequest);
		assert.ok(saveRequest >= 0, 'the save was requested');
		assert.ok(saveResponse > saveRequest, 'the save was responded to');
		assert.ok(reload > saveResponse, 'the config reload follows the save response (got: ' + timeline.join(' ') + ')');

		// The real global Git configuration: the identity is cleared and the guard is down
		assert.equal(globalConfigValue('user.name'), null);
		assert.equal(globalConfigValue('user.email'), null);
		assert.equal(globalConfigValue('user.useConfigOnly'), 'true');
	});
});
