/**
 * The loadConfig stale-response guard. Two config requests can be in flight at once (the
 * Settings Widget's open fires one while a load cycle's own reload fires another), and the
 * OLDER request can be answered from a pre-change snapshot of the repository (the extension
 * host was busy; the read started before the repository changed). When that stale response
 * landed after the fresh one it used to overwrite the applied configuration: the author
 * dropdown collapsed back to "All Authors" and nothing ever re-requested - the
 * empty-repository automation run hung on "the generated repository config never loaded".
 * Responses now echo the request's refresh id, and a superseded one is dropped - the same
 * guard the loadRepoInfo/loadCommits responses carry.
 *
 * Ported from tests/webviewConfigStaleResponse.test.mjs (REFACTOR-PLAN task 7.1); assertions
 * are unchanged. The harness's fake host leaves loadConfig unanswered, so the tests deliver the
 * two responses in the adversarial order themselves.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { bootView } from '../../support/webviewHost';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

type Booted = Awaited<ReturnType<typeof bootView>>;

/** A GitRepoConfig the Settings Widget renders (the shape the extension host responds with). */
function repoConfig(authors: unknown[]) {
	return {
		branches: { main: { remote: 'origin', pushRemote: null } },
		authors: authors,
		diffTool: null, guiDiffTool: null, pushDefault: null,
		remotes: [{ name: 'origin', url: 'https://example.com/repo.git', pushUrl: null }],
		user: { name: { local: null, global: null }, email: { local: null, global: null } }
	};
}

describe('a stale loadConfig response never overwrites a newer one', () => {
	it('the superseded response is dropped, keeping the fresh authors and remotes rendered', async () => {
		const h = await bootView(300);
		await h.pump();

		// Two requests in flight: the first from the Settings Widget opening, the second from
		// closing and opening it again (a real run's second source is a load cycle's own reload).
		const requests: any[] = [];
		const originalPostMessage = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message: any) => { requests.push(message); originalPostMessage(message); };
		h.document.getElementById('settingsBtn')!.click();
		await h.pump();
		h.document.getElementById('settingsClose')!.click();
		h.document.getElementById('settingsBtn')!.click();
		await h.pump();

		const loadConfigRequests = requests.filter((message) => message.command === 'loadConfig');
		assert.ok(loadConfigRequests.length >= 2, 'two config requests were sent (got ' + loadConfigRequests.length + ')');
		const [older] = loadConfigRequests.slice(-2);
		const newer = loadConfigRequests[loadConfigRequests.length - 1];
		assert.notEqual(older.refreshId, newer.refreshId, 'each request carries its own refresh id');

		// The widget is open on the second request. The NEWER response lands first and applies:
		// the author dropdown gains the configured author and the widget renders the remote.
		h.dispatch({
			command: 'loadConfig', repo: newer.repo, refreshId: newer.refreshId, error: null,
			config: repoConfig([{ name: 'Fresh Author', email: 'fresh@example.com' }])
		});
		await h.pump();
		assert.equal(h.document.querySelectorAll('#authorDropdown .dropdownOption').length, 2,
			'the fresh config applied: "All Authors" plus the configured author');
		assert.ok(h.document.getElementById('settingsWidget')!.innerHTML.indexOf('>origin<') !== -1,
			'the fresh config applied: the widget renders the repository remote');

		// The OLDER response lands afterwards, carrying the pre-change snapshot (no authors, no
		// remotes). It is superseded - dropped wholesale, leaving the fresh configuration applied.
		h.dispatch({
			command: 'loadConfig', repo: older.repo, refreshId: older.refreshId, error: null,
			config: repoConfig([])
		});
		await h.pump();
		assert.equal(h.document.querySelectorAll('#authorDropdown .dropdownOption').length, 2,
			'the stale response did not collapse the author dropdown back to "All Authors"');
		assert.ok(h.document.getElementById('settingsWidget')!.innerHTML.indexOf('>origin<') !== -1,
			'the stale response did not blank the rendered remotes');
	});

	it('an in-order pair still applies: the newer response wins, the widget tracks it', async () => {
		const h = await bootView(300);
		await h.pump();

		const requests: any[] = [];
		const originalPostMessage = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message: any) => { requests.push(message); originalPostMessage(message); };
		h.document.getElementById('settingsBtn')!.click();
		await h.pump();
		h.document.getElementById('settingsClose')!.click();
		h.document.getElementById('settingsBtn')!.click();
		await h.pump();

		const loadConfigRequests = requests.filter((message) => message.command === 'loadConfig');
		const [older, newer] = loadConfigRequests.slice(-2);

		// The stale response arrives FIRST (it was requested first): it applies - momentarily -
		// and is then superseded by the newer one, which must still apply over it.
		h.dispatch({
			command: 'loadConfig', repo: older.repo, refreshId: older.refreshId, error: null,
			config: repoConfig([])
		});
		await h.pump();
		assert.equal(h.document.querySelectorAll('#authorDropdown .dropdownOption').length, 1,
			'the not-yet-superseded response applied (the dropdown holds "All Authors" only)');
		h.dispatch({
			command: 'loadConfig', repo: newer.repo, refreshId: newer.refreshId, error: null,
			config: repoConfig([{ name: 'Fresh Author', email: 'fresh@example.com' }])
		});
		await h.pump();
		assert.equal(h.document.querySelectorAll('#authorDropdown .dropdownOption').length, 2,
			'the newer response applied over the stale one');
	});
});
