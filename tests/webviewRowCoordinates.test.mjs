/**
 * Row-coordinate stability: while the user is viewing a commit in the middle of the history,
 * repository activity (files edited, the Uncommitted Changes count ticking up, a commit being
 * made, background refreshes repeating) must not move the rows ON SCREEN by a single pixel.
 *
 * Unlike webviewSeamlessUpdate.test.mjs (which asserts scrollTop deltas and DOM node identity),
 * these tests measure the on-screen Y coordinate of every rendered commit row - derived from the
 * DOM structure itself: the top virtual spacer's height plus the row's offset among the rendered
 * rows (uniform row height), minus the scroll position. That is exactly what the user perceives
 * as a "jump": the same commit suddenly sitting at a different position in the viewport.
 *
 * Each scenario records the coordinates, lets the repository move underneath the view, and
 * re-measures: every commit that was in the viewport must be at the identical coordinate, and no
 * other row may have appeared inside the viewport.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROW_HEIGHT, VIEWPORT_HEIGHT, bootView, commit, measureRowCoordinates } from './webviewHarness.mjs';

/** Every commit visible before must sit at the identical on-screen coordinate afterwards, and no
 * additional row may have entered the viewport. */
function assertViewportUnchanged(h, before, after, label) {
	const beforeVisible = new Map([...before].filter(([, y]) => y >= 0 && y < VIEWPORT_HEIGHT));
	assert.ok(beforeVisible.size >= 10, 'the recorded viewport holds a meaningful number of rows (got ' + beforeVisible.size + ')');
	for (const [key, y] of beforeVisible) {
		assert.ok(after.has(key), label + ': commit ' + key + ' is still rendered');
		assert.equal(after.get(key), y, label + ': commit ' + key + ' stays at on-screen y=' + y);
	}
	for (const [key, y] of after) {
		if (y >= 0 && y < VIEWPORT_HEIGHT) {
			assert.ok(beforeVisible.has(key), label + ': commit ' + key + ' entered the viewport out of nowhere (y=' + y + ')');
		}
	}
}

/** Edit files so the working tree becomes dirty: the Uncommitted Changes row appears at the top. */
function editFiles(h, count) {
	h.state.uncommitted = count;
	h.state.uncommittedCount = count;
}

/** Commit everything: the Uncommitted Changes row vanishes, a new commit lands on the branch. */
function commitEverything(h) {
	const newCommit = commit(0, 1, ['main']);
	newCommit.hash = 'n' + String(h.state.history.length).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
	newCommit.message = 'commit NEW' + h.state.history.length;
	newCommit.parents = [h.state.history[0].hash];
	h.state.history[0].heads = [];
	h.state.history.unshift(newCommit);
	h.state.head = newCommit.hash;
	h.state.uncommitted = null;
	h.state.uncommittedCount = null;
}

async function applyChange(h, label, mutate) {
	let before = measureRowCoordinates(h);
	mutate();
	h.dispatch({ command: 'refresh' });
	await h.pump();
	assertViewportUnchanged(h, before, measureRowCoordinates(h), label);
}

describe('on-screen row coordinates stay frozen while the repository moves (windowed rendering)', () => {
	it('a commit landing on the checked-out branch does not move any visible row', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);
		await applyChange(h, 'commit on checked-out branch', () => commitEverything(h));

		// The new commit itself stays hidden above the viewport
		assert.ok(!h.rows().some((row) => /commit NEW/.test(row.textContent)), 'the new commit is not in view');
	});

	it('files being edited, the count ticking up, a commit, and repeated idle refreshes never move a visible row', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);

		await applyChange(h, 'files edited (3)', () => editFiles(h, 3));
		await applyChange(h, 'more files edited (5)', () => editFiles(h, 5));
		await applyChange(h, 'fewer files (4)', () => editFiles(h, 4));
		await applyChange(h, 'everything committed', () => commitEverything(h));
		// The 5-second background signature poll firing twice with NOTHING changed
		await applyChange(h, 'idle background refresh #1', () => {});
		await applyChange(h, 'idle background refresh #2', () => {});

		// And after all that, the user's row is exactly where it started
		const coords = measureRowCoordinates(h);
		assert.equal(coords.get('commit 150'), 0, 'commit 150 is still at the very top of the viewport where the user scrolled it');
	});
});

describe('on-screen row coordinates stay frozen in a repository longer than the loaded window (windowed rendering)', () => {
	/* initialLoadCommits defaults to 300: in any repository with more history than that, every
	 * loadCommits response carries only the newest 300 commits (moreCommitsAvailable=true). A new
	 * commit at the top - or the Uncommitted Changes row appearing - therefore also pushes the
	 * OLDEST LOADED commit out of the window: the tail of the list changes, which must not degrade
	 * the seamless top-update path into a full re-render (the visible rows would shift by the
	 * height of the inserted row - the "jump" the user sees every time anything happens). */
	it('a commit landing at the top (oldest loaded commit dropping out of the window) moves nothing', async () => {
		const h = await bootView(1000, { window: 300 });
		await h.scrollTo(150);
		await applyChange(h, 'commit on checked-out branch (windowed out)', () => commitEverything(h));
	});

	it('files being edited and committed in a big repository never move a visible row', async () => {
		const h = await bootView(1000, { window: 300 });
		await h.scrollTo(150);
		await applyChange(h, 'files edited (3)', () => editFiles(h, 3));
		await applyChange(h, 'more files edited (5)', () => editFiles(h, 5));
		await applyChange(h, 'everything committed', () => commitEverything(h));
		const coords = measureRowCoordinates(h);
		assert.equal(coords.get('commit 150'), 0, 'commit 150 is still at the very top of the viewport where the user scrolled it');
	});
});

/* The multi-stage load pipeline (first response without the working-tree status, remote-refs
 * follow-up, then the Uncommitted Changes row with its count) is covered against the REAL
 * extension host, on a real repository, by webviewRealPipeline.test.mjs - and once more in a real
 * browser by tests/browserRepro (realPipelineLoop). A third, simulated copy of that same scenario
 * used to live here; it asserted nothing the other two do not. */

describe('on-screen row coordinates stay frozen while the repository moves (full render)', () => {
	it('files being edited, the count ticking up, a commit, and repeated idle refreshes never move a visible row', async () => {
		const h = await bootView(60); // <= 100 commits: full render, every row is in the DOM
		await h.scrollTo(30);
		assert.equal(h.document.querySelector('tr.virtSpacer'), null, 'the full renderer is active');

		await applyChange(h, 'files edited (3)', () => editFiles(h, 3));
		await applyChange(h, 'more files edited (5)', () => editFiles(h, 5));
		await applyChange(h, 'everything committed', () => commitEverything(h));
		await applyChange(h, 'idle background refresh #1', () => {});
		await applyChange(h, 'idle background refresh #2', () => {});

		const coords = measureRowCoordinates(h);
		assert.equal(coords.get('commit 30'), 0, 'commit 30 is still at the very top of the viewport where the user scrolled it');
	});
});

describe('a mid-history rewrite (rebase/amend) keeps the viewport anchored', () => {
	it('a commit deep in the middle of the windowed history getting a new hash keeps every visible row still', async () => {
		const h = await bootView(300, { window: 300 });
		await h.scrollTo(150);
		const before = measureRowCoordinates(h);

		// Rebase/amend: commit at index 150 (inside the viewport) is replaced by an equivalent
		// commit with a different hash - every fast path (no-op, append, prepend, patch) rejects
		// this, so the refresh goes through the full re-render with scroll re-anchoring
		const rewritten = { ...h.state.history[150], hash: 'f' + String(150).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
		h.state.history[150] = rewritten;
		h.state.history[149].parents = [rewritten.hash]; // 149 is the newer child referencing 150
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assertViewportUnchanged(h, before, measureRowCoordinates(h), 'mid-history rewrite (windowed)');
	});

	it('same in a short fully-rendered repository', async () => {
		const h = await bootView(60);
		await h.scrollTo(30);
		const before = measureRowCoordinates(h);

		const rewritten = { ...h.state.history[30], hash: 'f' + String(30).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
		h.state.history[30] = rewritten;
		h.state.history[29].parents = [rewritten.hash]; // 29 is the newer child referencing 30
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assertViewportUnchanged(h, before, measureRowCoordinates(h), 'mid-history rewrite (full render)');
	});
});

describe('rows removed above the viewport keep the viewport still', () => {
	it('the newest commits disappearing (history truncated / rebased away) moves no visible row (windowed)', async () => {
		const h = await bootView(300, { window: 300 });
		await h.scrollTo(150);
		const before = measureRowCoordinates(h);

		// The 3 newest commits vanish (e.g. a reset of the branch head): the list shrinks ABOVE
		// the viewport - no fast path accepts a removal, so the full re-render runs
		h.state.history.splice(0, 3);
		h.state.head = h.state.history[0].hash;
		h.state.history[0].heads = ['main'];
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assertViewportUnchanged(h, before, measureRowCoordinates(h), 'rows removed above viewport (windowed)');
	});

	it('the Uncommitted Changes row vanishing above the viewport moves no visible row', async () => {
		const h = await bootView(300, { window: 300 });
		h.state.uncommitted = 3;
		h.state.uncommittedCount = 3;
		h.dispatch({ command: 'refresh' });
		await h.pump();
		await h.scrollTo(150);
		const before = measureRowCoordinates(h);
		assert.ok(before.has('UNCOMMITTED') === false, 'the Uncommitted row sits above the scrolled viewport');

		// The working tree becomes clean (e.g. a stash) without any new commit landing: only the
		// Uncommitted row disappears - a removal at the top, full re-render
		h.state.uncommitted = null;
		h.state.uncommittedCount = null;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assertViewportUnchanged(h, before, measureRowCoordinates(h), 'uncommitted row vanishing');
	});

	it('rows removed above the viewport in a short fully-rendered repository move no visible row', async () => {
		const h = await bootView(60);
		await h.scrollTo(30);
		const before = measureRowCoordinates(h);

		h.state.history.splice(0, 3);
		h.state.head = h.state.history[0].hash;
		h.state.history[0].heads = ['main'];
		h.dispatch({ command: 'refresh' });
		await h.pump();

		assertViewportUnchanged(h, before, measureRowCoordinates(h), 'rows removed above viewport (full render)');
	});
});
