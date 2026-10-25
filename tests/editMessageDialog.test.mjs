/**
 * The webview half of the Edit Message feature: the dialog fetches the commit's full message
 * body through the commitBodies request/response pair before opening. These tests drive the
 * real compiled bundle in jsdom and answer its commitBodies requests like the extension host
 * would, covering the failure bookkeeping: a failed fetch must not permanently block a commit
 * (a later attempt re-requests), must not resolve waiters of unrelated in-flight requests (a
 * dialog prefilled with the subject would silently truncate the body on confirm), and a body
 * arriving late must not replace a dialog the user is already editing. The request itself must
 * also carry the author only when it changed, so a message-only edit takes the reword path (no
 * pre-commit hooks) on the host.
 *
 * Extracted from tests/editCommitMessage.test.mjs when that file's host-side suites moved to
 * test/integration/write/messageEdit.contract.test.ts (the DataSource deletion, task 3.6).
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

describe('the Edit Message dialog\'s body fetch (webview)', () => {
	let h;
	let sent = [];

	const hashOf = (i) => 'c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

	/** Open the commit's context menu and click "Edit Message...". */
	const openEditMessage = (hash) => {
		const cell = h.document.querySelector(`#commitTable tr.commit[data-hash="${hash}"] .description`);
		cell.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		const item = [...h.document.querySelectorAll('.contextMenuItem')]
			.find((li) => li.textContent.includes('Edit Message'));
		assert.ok(item, 'the commit context menu should offer "Edit Message..."');
		item.click();
	};

	const commitBodiesRequests = () => sent.filter((m) => m.command === 'commitBodies');

	/** Cancel the open dialog (if any) and let the closing dialog leave the DOM. */
	const closeDialog = async () => {
		const secondary = h.document.getElementById('dialogSecondaryAction');
		if (secondary !== null) secondary.click();
		await new Promise((resolve) => setTimeout(resolve, 200));
	};

	before(async () => {
		h = await bootView(4);
		h.window.Element.prototype.scrollIntoView = function () {};
		// The bundle holds the VSCODE_API object it acquired at boot; wrapping its postMessage
		// captures everything the view sends from here on (the harness keeps working through it).
		const originalPostMessage = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message) => {
			sent.push(message);
			return originalPostMessage.call(h.window.VSCODE_API, message);
		};
	});

	it('re-requests the body after a failed fetch instead of never opening the dialog again', async () => {
		const hash = hashOf(0);
		openEditMessage(hash);
		const request = commitBodiesRequests().at(-1);
		assert.ok(request, 'the dialog fetches the body before opening');
		assert.deepEqual([...request.commitHashes], [hash]);

		// The fetch fails: the dialog still opens, prefilled with the subject as a fallback.
		h.dispatch({ command: 'commitBodies', bodies: {}, requestId: request.requestId });
		const fallback = h.document.getElementById('dialogInput0');
		assert.ok(fallback !== null, 'the dialog opens with the subject when the fetch fails');
		assert.equal(fallback.value, 'commit 0');
		await closeDialog();

		// A second attempt on the same commit sends a fresh request (the failed hash is not stuck
		// in the requested set) and opens the dialog with the fetched body.
		openEditMessage(hash);
		const retried = commitBodiesRequests().at(-1);
		assert.ok(retried !== request, 'a failed fetch is re-requested on the next attempt');
		assert.deepEqual([...retried.commitHashes], [hash]);
		h.dispatch({ command: 'commitBodies', bodies: { [hash]: 'commit 0\n\nthe full body' }, requestId: retried.requestId });
		const textarea = h.document.getElementById('dialogInput0');
		assert.ok(textarea !== null, 'the dialog opens again once the retry succeeds');
		assert.equal(textarea.value, 'commit 0\n\nthe full body');
		await closeDialog();
	});

	it('omits the author from the request when it is unchanged, so a message-only edit rewords', async () => {
		const hash = hashOf(0); // the body is cached by the previous test: the dialog opens synchronously
		openEditMessage(hash);
		assert.equal(h.document.getElementById('dialogInput0').value, 'commit 0\n\nthe full body');
		h.document.getElementById('dialogInput0').value = 'commit 0, reworded';
		h.document.getElementById('dialogAction').click();

		const edit = sent.filter((m) => m.command === 'editCommitMessage').at(-1);
		assert.ok(edit, 'the update is sent');
		assert.equal(edit.message, 'commit 0, reworded');
		assert.ok(!('authorName' in edit) && !('authorEmail' in edit), 'an unchanged author must be omitted, so the host rewords instead of amending (no pre-commit hooks)');
		await closeDialog(); // dismisses the action-running dialog
	});

	it('sends the author when it changed', async () => {
		const hash = hashOf(0);
		openEditMessage(hash);
		h.document.getElementById('dialogInput1').value = 'A New Author';
		h.document.getElementById('dialogAction').click();

		const edit = sent.filter((m) => m.command === 'editCommitMessage').at(-1);
		assert.ok(edit, 'the update is sent');
		assert.equal(edit.authorName, 'A New Author');
		assert.equal(edit.authorEmail, 'author0@example.com', 'the email is sent along even when only the name changed');
		await closeDialog();
	});

	it('does not resolve another commit\'s pending dialog when a fetch fails', async () => {
		const bHash = hashOf(1), cHash = hashOf(2);
		openEditMessage(bHash);
		openEditMessage(cHash);
		const requests = commitBodiesRequests().slice(-2);
		assert.deepEqual([...requests[0].commitHashes], [bHash]);
		assert.deepEqual([...requests[1].commitHashes], [cHash]);

		// B's fetch fails (the native backend fails the whole call when one hash is unresolvable):
		// only B's waiter is resolved - with null, so B's dialog opens with the subject fallback.
		// C's waiter must stay pending, or C's dialog would open here with the subject only and a
		// confirm would silently truncate the body.
		h.dispatch({ command: 'commitBodies', bodies: {}, requestId: requests[0].requestId });
		const bDialog = h.document.getElementById('dialogInput0');
		assert.ok(bDialog !== null);
		assert.equal(bDialog.value, 'commit 1', 'B opens with the subject; C must not open from B\'s failure');
		await closeDialog();

		// C's own fetch succeeds: the dialog opens with the full body.
		h.dispatch({ command: 'commitBodies', bodies: { [cHash]: 'commit 2\n\nthe full body of C' }, requestId: requests[1].requestId });
		const cDialog = h.document.getElementById('dialogInput0');
		assert.ok(cDialog !== null, 'C\'s dialog opens once its own fetch lands');
		assert.equal(cDialog.value, 'commit 2\n\nthe full body of C');
		await closeDialog();
	});

	it('does not replace a dialog the user is already editing when a late body arrives', async () => {
		const bHash = hashOf(1), cHash = hashOf(2); // C's body is cached by the previous test

		// B's body fetch is in flight when the user right-clicks C, whose dialog opens
		// synchronously from the cache.
		openEditMessage(bHash);
		assert.equal(h.document.querySelector('.dialog'), null, 'B\'s dialog waits for its fetch');
		openEditMessage(cHash);
		const textarea = h.document.getElementById('dialogInput0');
		assert.equal(textarea.value, 'commit 2\n\nthe full body of C', 'C\'s dialog opens synchronously from the cache');
		textarea.value = 'commit 2\n\nthe full body of C, being edited';

		// B's late response must not close and replace the dialog mid-edit.
		const bRequest = commitBodiesRequests().at(-1);
		assert.deepEqual([...bRequest.commitHashes], [bHash]);
		h.dispatch({ command: 'commitBodies', bodies: { [bHash]: 'commit 1\n\nthe full body of B' }, requestId: bRequest.requestId });
		assert.equal(h.document.querySelectorAll('.dialog').length, 1, 'the late body must not open a second dialog');
		assert.equal(h.document.getElementById('dialogInput0').value, 'commit 2\n\nthe full body of C, being edited', 'the in-progress edits survive the late body');
		await closeDialog();
	});

	it('discards pending body waiters on a hard refresh, so a stale response cannot open a dialog', async () => {
		// The fourth commit's body was never fetched, so its dialog sends a request.
		const hash = hashOf(3);
		openEditMessage(hash);
		const stale = commitBodiesRequests().at(-1);
		assert.ok(stale && stale.commitHashes[0] === hash, 'a body fetch is in flight');
		assert.equal(h.document.querySelector('.dialog'), null, 'the dialog waits for the fetch');

		// The toolbar refresh button hard-refreshes: clearCommits() drops the commits, the cache
		// and the waiter registry.
		h.document.getElementById('refreshBtn').click();
		await h.pump();

		// The late response to the pre-refresh request arrives: it must not resolve anything.
		h.dispatch({ command: 'commitBodies', bodies: {}, requestId: stale.requestId });
		assert.equal(h.document.querySelector('.dialog'), null, 'a stale response cannot open a dialog after a hard refresh');

		// The dialog still works normally afterwards: the cache was cleared with everything else,
		// so the body is fetched again.
		openEditMessage(hash);
		const fresh = commitBodiesRequests().at(-1);
		assert.ok(fresh !== stale, 'a fresh request is sent after the refresh');
		h.dispatch({ command: 'commitBodies', bodies: { [hash]: 'commit 0\n\nfresh body' }, requestId: fresh.requestId });
		assert.equal(h.document.getElementById('dialogInput0').value, 'commit 0\n\nfresh body');
		await closeDialog();
	});
});
