/**
 * Seamless (flicker-free) updates of the commit table while the user is viewing a commit in the
 * middle of the history, driven through the REAL compiled webview bundle (`media/out.min.js`)
 * inside a jsdom document.
 *
 * The scenario the user sees in the editor: the graph is open, the user has scrolled down and is
 * looking at some historical commit, and the repository moves underneath them - a commit is made
 * on the checked-out branch, or files are edited so the "Uncommitted Changes" row appears / its
 * count changes / it disappears again. None of this may disturb the viewport:
 *
 *   - only the scroll bar adjusts (by exactly the height the top rows add or remove),
 *   - the visible rows stay put: same commits in the same order at the same position,
 *   - the new rows stay HIDDEN above the viewport until the user scrolls back up,
 *   - the already rendered rows are not rebuilt (DOM node identity is preserved outside the
 *     windowed-render window, which only ever holds the small viewport slice).
 *
 * These tests boot the full webview (html skeleton + initialState + acquireVsCodeApi stub),
 * answer its requests like the extension host would, and assert on the resulting DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROW_HEIGHT, bootView, commit } from './webviewHarness.mjs';

describe('seamless updates while viewing a commit in the middle of the history', () => {
	it('boots, virtualizes a 300-commit history and settles at the scrolled position', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);
		assert.ok(h.document.querySelector('tr.virtSpacer') !== null, 'the windowed renderer is active');
		const anchor = h.rows().find((row) => row.dataset.id === '150');
		assert.ok(anchor !== undefined, 'the row the user is looking at is rendered');
		assert.match(anchor.textContent, /commit 150/);
	});

	it('keeps the viewport perfectly still when a commit lands on the checked-out branch (virtualized)', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);

		// The commit list the user is looking at, before the repository moves
		const before = h.rows().map((row) => row.dataset.id + ':' + row.textContent);
		const scrollTopBefore = h.viewElem.scrollTop;

		// A commit is made on the checked-out branch: new head, the 'main' label moves to it
		const newCommit = commit(0, 1, ['main']);
		newCommit.hash = 'n00000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		newCommit.message = 'commit NEW';
		newCommit.parents = [h.state.history[0].hash];
		h.state.history[0].heads = [];
		h.state.history.unshift(newCommit);
		h.state.head = newCommit.hash;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		// The scroll bar shifted by exactly one row height - nothing else in the viewport moved
		assert.equal(h.viewElem.scrollTop, scrollTopBefore + ROW_HEIGHT);
		// The same commits are in the rendered window, at the same visual position (id + 1)
		const after = h.rows().map((row) => (parseInt(row.dataset.id) - 1) + ':' + row.textContent);
		assert.deepEqual(after, before);
		// The new commit is HIDDEN above the viewport: it is not among the rendered rows
		assert.ok(!h.rows().some((row) => /commit NEW/.test(row.textContent)), 'the new commit is not in view');
		// Scrolling back up to the top reveals it
		await h.scrollTo(0);
		const topRow = h.rows().find((row) => row.dataset.id === '0');
		assert.ok(topRow !== undefined && /commit NEW/.test(topRow.textContent), 'the new commit appears at the top');
	});

	it('keeps every rendered DOM row node (and the Graph column header) when off-screen changes happen while windowed', async () => {
		// A full teardown-and-rebuild of the windowed table on every off-screen change (a file
		// edited, a commit landing while the user is scrolled down) forces the browser to redo the
		// table's auto-layout column widths from scratch on every refresh, even though nothing on
		// screen actually changed - perceptible as the Description column jittering left/right. The
		// fix patches the rendered rows in place instead, so every DOM node here - including the
		// Graph column header, whose width the auto-layout depends on - must be the SAME node.
		const h = await bootView(300);
		await h.scrollTo(150);

		const graphColHeaderBefore = h.document.getElementById('tableHeaderGraphCol');
		assert.ok(graphColHeaderBefore !== null);
		const nodesBefore = h.rows();
		const startIdBefore = parseInt(nodesBefore[0].dataset.id, 10);

		// Files are edited off-screen: the Uncommitted Changes row appears above the viewport
		h.state.uncommitted = 3;
		h.state.uncommittedCount = 3;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assert.equal(h.document.getElementById('tableHeaderGraphCol'), graphColHeaderBefore, 'the Graph column header was not rebuilt');
		let rows = h.rows();
		assert.deepEqual(rows, nodesBefore, 'every rendered row kept its DOM node');
		// One new row (the Uncommitted Changes row) was inserted above the window: every id shifts by 1
		rows.forEach((row, i) => assert.equal(row.dataset.id, String(startIdBefore + 1 + i)));

		// Everything is committed off-screen: the row vanishes and a new commit takes its place
		const newCommit = commit(0, 1, ['main']);
		newCommit.hash = 'n00000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		newCommit.message = 'commit NEW';
		newCommit.parents = [h.state.history[0].hash];
		h.state.history[0].heads = [];
		h.state.history.unshift(newCommit);
		h.state.head = newCommit.hash;
		h.state.uncommitted = null;
		h.state.uncommittedCount = null;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assert.equal(h.document.getElementById('tableHeaderGraphCol'), graphColHeaderBefore, 'the Graph column header was still not rebuilt');
		rows = h.rows();
		assert.deepEqual(rows, nodesBefore, 'every rendered row still keeps its DOM node');
		// The Uncommitted Changes row is removed and the new commit is inserted in its place: no
		// further shift on top of the +1 the Uncommitted Changes row already caused above
		rows.forEach((row, i) => assert.equal(row.dataset.id, String(startIdBefore + 1 + i)));
	});

	it('re-renders only the row whose remote label moved deep in the history (e.g. a background git fetch), touching nothing else', async () => {
		// A `git fetch` moving a remote-tracking branch (origin/main) onto a commit that is NOT at
		// the top of the history is a common background event, unrelated to any commit landing on
		// the checked-out branch. It must not degrade into a full re-render (which would rebuild
		// every row's DOM node and force the browser to redo the table's column layout).
		const h = await bootView(300);
		await h.scrollTo(150);

		const nodesBefore = h.rows();
		const scrollTopBefore = h.viewElem.scrollTop;
		const graphColHeaderBefore = h.document.getElementById('tableHeaderGraphCol');

		// commit 200 is well below the top and outside the rendered window either way. A new object
		// (not a mutation of the existing one) - otherwise `this.commits[200]` inside the view,
		// which references this very object, would "change" too and the comparison would be moot.
		h.state.history[200] = { ...h.state.history[200], remotes: [{ name: 'main', remote: 'origin' }] };
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assert.equal(h.viewElem.scrollTop, scrollTopBefore, 'the scroll bar did not move');
		assert.equal(h.document.getElementById('tableHeaderGraphCol'), graphColHeaderBefore, 'the Graph column header was not rebuilt');
		assert.deepEqual(h.rows(), nodesBefore, 'every rendered row (none of which is commit 200) kept its DOM node');
	});

	it('re-renders a visible row when its remote label changes, leaving every other row untouched', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);

		const nodesBefore = h.rows();
		const targetIndex = nodesBefore.findIndex((row) => row.dataset.id === '155');
		assert.ok(targetIndex !== -1, 'commit 155 is in the rendered window');

		// A new object, not a mutation of the existing one - see the comment in the previous test
		h.state.history[155] = { ...h.state.history[155], remotes: [{ name: 'main', remote: 'origin' }] };
		h.dispatch({ command: 'refresh' });
		await h.pump();

		const rowsAfter = h.rows();
		assert.equal(rowsAfter.length, nodesBefore.length);
		rowsAfter.forEach((row, i) => {
			if (i === targetIndex) {
				assert.notEqual(row, nodesBefore[i], 'the changed row was re-rendered');
				assert.match(row.innerHTML, /origin/, 'the new remote label is present');
			} else {
				assert.equal(row, nodesBefore[i], 'every other row kept its exact DOM node');
			}
		});
	});

	it('keeps every rendered DOM row node when the Uncommitted Changes row appears, updates and vanishes (full render)', async () => {
		const h = await bootView(60); // <= 100 commits: full render, every row is in the DOM
		await h.scrollTo(30);
		assert.equal(h.document.querySelector('tr.virtSpacer'), null, 'the full renderer is active');

		const nodesBefore = h.rows();
		const scrollTopBefore = h.viewElem.scrollTop;

		// Files are edited: the Uncommitted Changes row appears at the very top
		h.state.uncommitted = 3;
		h.state.uncommittedCount = 3;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		let rows = h.rows();
		assert.equal(rows.length, 61);
		assert.equal(h.viewElem.scrollTop, scrollTopBefore + ROW_HEIGHT, 'the scroll bar shifted by exactly one row');
		assert.match(rows[0].textContent, /Uncommitted Changes \(3\)/);
		// Every previously rendered row keeps its DOM node (only the new row was inserted)
		assert.deepEqual(rows.slice(1), nodesBefore);
		// The visible rows did not move: row N of the old list is still at the same offset from the
		// (shifted) scroll position - here checked as data-id + 1 for every old row
		rows.forEach((row, i) => assert.equal(row.dataset.id, String(i)));

		// More files are edited: only the number changes, patched in place
		const nodesWithRow = h.rows();
		h.state.uncommitted = 5;
		h.state.uncommittedCount = 5;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		rows = h.rows();
		assert.deepEqual(rows, nodesWithRow, 'not a single row node was rebuilt');
		assert.match(rows[0].textContent, /Uncommitted Changes \(5\)/);
		assert.equal(rows[0].dataset.id, '0');

		// Everything is committed: the row vanishes and a new commit takes its place at the top
		const scrollTopBeforeCommit = h.viewElem.scrollTop;
		const newCommit = commit(0, 1, ['main']);
		newCommit.hash = 'n00000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		newCommit.message = 'commit NEW';
		newCommit.parents = [h.state.history[0].hash];
		h.state.history[0].heads = [];
		h.state.history.unshift(newCommit);
		h.state.head = newCommit.hash;
		h.state.uncommitted = null;
		h.state.uncommittedCount = null;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		rows = h.rows();
		assert.equal(rows.length, 61);
		assert.match(rows[0].textContent, /commit NEW/);
		// One row removed (Uncommitted) and one added (the commit): the scroll bar nets out
		assert.equal(h.viewElem.scrollTop, scrollTopBeforeCommit, 'the scroll bar did not move');
		// The old rows keep their nodes AND their positions (the top swap nets out to zero shift).
		// The one exception is the previous head: the new commit took the 'main' label off it, so
		// its content genuinely changed and it is the only row that may be re-rendered.
		rows.slice(1).forEach((row, i) => {
			if (i === 0) {
				assert.match(row.textContent, /commit 0/, 'the previous head is still row 1');
				assert.equal(row.querySelector('.gitRef.head'), null, 'the previous head lost the branch label');
			} else {
				assert.strictEqual(row, nodesBefore[i], 'row ' + i + ' kept its DOM node');
			}
		});
	});
});

describe('the Commit Details View stays open and untouched while the repository moves in the background', () => {
	/** Click a row to open its Commit Details View, then answer the resulting request. */
	async function openCommitDetails(h, id) {
		const row = h.rows().find((r) => r.dataset.id === String(id));
		row.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
		await h.pump(); // the click sends a 'commitDetails' request, answered like every other
	}

	it('never rebuilds the #cdv element on an off-screen file edit or a new commit (windowed rendering)', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);

		// commit 155 is comfortably inside the rendered window
		await openCommitDetails(h, 155);
		const cdvBefore = h.document.getElementById('cdv');
		assert.ok(cdvBefore !== null, 'the Commit Details View is open');
		assert.match(cdvBefore.textContent, /c0155/);

		// Files edited off-screen: the Uncommitted Changes row appears above the viewport
		h.state.uncommitted = 3;
		h.state.uncommittedCount = 3;
		h.dispatch({ command: 'refresh' });
		await h.pump();
		assert.equal(h.document.getElementById('cdv'), cdvBefore, 'the CDV element was not rebuilt after a file edit');
		assert.match(h.document.getElementById('cdv').textContent, /c0155/, 'still showing the same commit');

		// A commit lands on the checked-out branch, off-screen
		const newCommit = commit(0, 1, ['main']);
		newCommit.hash = 'n00000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		newCommit.message = 'commit NEW';
		newCommit.parents = [h.state.history[0].hash];
		h.state.history[0].heads = [];
		h.state.history.unshift(newCommit);
		h.state.head = newCommit.hash;
		h.state.uncommitted = null;
		h.state.uncommittedCount = null;
		h.dispatch({ command: 'refresh' });
		await h.pump();
		assert.equal(h.document.getElementById('cdv'), cdvBefore, 'the CDV element was not rebuilt after a new commit landed');
		assert.match(h.document.getElementById('cdv').textContent, /c0155/, 'still showing the same commit');
	});

	it('never rebuilds the #cdv element when a background git fetch moves a remote label elsewhere', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);

		await openCommitDetails(h, 160);
		const cdvBefore = h.document.getElementById('cdv');
		assert.ok(cdvBefore !== null);

		h.state.history[200] = { ...h.state.history[200], remotes: [{ name: 'main', remote: 'origin' }] };
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assert.equal(h.document.getElementById('cdv'), cdvBefore, 'the CDV element was not rebuilt');
	});

	it('suppresses the fade-in animation once the commit is open, even across a full table rebuild', async () => {
		// A change that cannot match ANY incremental path (a commit inserted in the MIDDLE of the
		// history, not at the top, changing both the list length and the order) forces the general
		// fallback: a full render() that rebuilds the whole <table>, destroying and recreating #cdv
		// as a side effect even though its DOM reference is carefully preserved and reinserted. The
		// entrance animation (which plays across the loading-skeleton and loaded-content renders
		// that opening a commit always goes through) must never play again after that - see
		// `entered` on ExpandedCommit.
		const h = await bootView(300);
		await h.scrollTo(150);

		await openCommitDetails(h, 155);
		let cdv = h.document.getElementById('cdv');
		assert.equal(cdv.style.animation, 'none', 'settled after opening: the entrance animation already played');

		const insertedCommit = commit(0, 1, []);
		insertedCommit.hash = 'mid00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		insertedCommit.message = 'commit MID-INSERTED';
		insertedCommit.parents = [h.state.history[120].hash];
		h.state.history.splice(120, 0, insertedCommit); // not at the top: defeats every incremental path
		h.dispatch({ command: 'refresh' });
		await h.pump();

		cdv = h.document.getElementById('cdv');
		assert.ok(cdv !== null, 'the Commit Details View is still open');
		assert.equal(cdv.style.animation, 'none', 'the entrance animation is suppressed on every later render');
	});
});


describe('identical background refreshes leave the auxiliary DOM untouched', () => {
	it('keeps the "Load More Commits" button node on an unchanged refresh, and it stays wired', async () => {
		const h = await bootView(300, { window: 100 }); // a longer repository: the footer button shows
		const button = h.document.getElementById('loadMoreCommitsBtn');
		assert.ok(button !== null, 'the footer renders the Load More button');

		// The watcher firing on a file save with the repository unchanged: the footer's content is
		// identical, so its nodes are left alone (a swap would only reset whatever the user is
		// doing with the button)
		h.dispatch({ command: 'refresh' });
		await h.pump();
		assert.strictEqual(h.document.getElementById('loadMoreCommitsBtn'), button, 'the button node survived an unchanged refresh');

		// ... and the kept node is still wired: clicking starts the next page load
		// (footer -> loading), and the button rebuilt after the answer is wired again
		button.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
		assert.ok(h.document.getElementById('loadingHeader') !== null, 'clicking started the next page load');
		h.state.window = 150; // the host answers with the next page of commits
		await h.pump();
		const rebuilt = h.document.getElementById('loadMoreCommitsBtn');
		assert.ok(rebuilt !== null && rebuilt !== button, 'the button was rebuilt after the page load');
		rebuilt.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
		assert.ok(h.document.getElementById('loadingHeader') !== null, 'the rebuilt button is wired too');
		h.state.window = 200;
		await h.pump();
		assert.ok(h.document.getElementById('loadMoreCommitsBtn') !== null, 'the footer is back to the button');
	});

	it('keeps the Uncommitted Changes row cells on an unchanged refresh', async () => {
		const h = await bootView(300);
		// Pin the clock: the row's rendered date text derives from the response's arrival time
		const realNow = h.window.Date.now;
		h.window.Date.now = () => 1700000000000;
		try {
			h.state.uncommitted = 3;
			h.state.uncommittedCount = 3;
			h.dispatch({ command: 'refresh' });
			await h.pump();
			const row = h.document.getElementById('uncommittedChanges');
			assert.ok(row !== null, 'the Uncommitted Changes row is rendered');
			const cells = Array.from(row.children);

			// Another file save, the status answer identical: the row is patched in place only
			// when the content actually changed, so every cell keeps its DOM node
			h.dispatch({ command: 'refresh' });
			await h.pump();
			const rowAfter = h.document.getElementById('uncommittedChanges');
			assert.strictEqual(rowAfter, row, 'the row element is kept');
			Array.from(rowAfter.children).forEach((td, i) => {
				assert.strictEqual(td, cells[i], 'cell ' + i + ' kept its DOM node');
			});
		} finally {
			h.window.Date.now = realNow;
		}
	});
});
