/**
 * A jsdom smoke test of the extracted Commit Comparison View frontend (REFACTOR-PLAN task 6.1):
 * boot the built bundle (media/comparison.min.js) in the exact shell the host serves, under a
 * scripted extension host, and drive the boot handshake, the file tree, the diff table, the
 * deferred line counts and the handover to the embedded binary comparison area.
 *
 * Ported from tests/comparisonWebview.test.mjs (REFACTOR-PLAN task 7.1); assertions are
 * unchanged. The whole suite self-skips when the bundle has not been built.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUNDLE = path.join(rootDir, 'media', 'comparison.min.js');
const skip = !fs.existsSync(BUNDLE);

/* The skeleton the host renders (see the comparison view controller): the CSP and the external
 * files do not matter to jsdom, only the element ids the frontend boots against. */
const SHELL_HTML = `<!DOCTYPE html><html><head></head><body>
<div id="header"><div id="commitCards"></div></div>
<div id="body">
	<div id="sidebar"><h2 id="filesChangedLabel">Files changed</h2></div>
	<div id="sidebarResizer"></div>
	<div id="main"><div id="fileHeader"></div><div id="diffArea"><div class="status">Loading</div></div></div>
</div>
</body></html>`;

const CHANGE = (type: string, oldPath: string, newPath: string) => ({ oldFilePath: oldPath, newFilePath: newPath, type: type, additions: null, deletions: null });

/** Boot the bundle under a scripted host; answer requests through `respond`. */
function boot() {
	const dom = new JSDOM(SHELL_HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.invalid/' });
	const { window } = dom;
	const document = window.document;

	const sent: any[] = [];
	const states: unknown[] = [];
	let persistedState: unknown = null;
	(window as any).acquireVsCodeApi = () => ({
		getState: () => persistedState,
		setState: (state: unknown) => { persistedState = JSON.parse(JSON.stringify(state)); states.push(persistedState); },
		postMessage: (message: unknown) => { sent.push(JSON.parse(JSON.stringify(message))); }
	});
	(window as any).Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
		// The hex view's width probe measures a 28-character string: lay text out at 7px per
		// character, so the probe reads 196px and the row-width pick behaves as on a real page.
		const width = (this.textContent || '').length * 7;
		return { top: 0, right: width, bottom: 400, left: 0, width: width, height: 400, x: 0, y: 0, toJSON() { return this; } };
	};
	Object.defineProperty(document.getElementById('diffArea')!, 'clientWidth', { get: () => 1200 });

	const errors: string[] = [];
	window.addEventListener('error', (e: any) => errors.push(String(e.error || e.message)));

	window.eval(fs.readFileSync(BUNDLE, 'utf8'));
	window.dispatchEvent(new window.Event('load'));

	const dispatch = (message: unknown) => {
		window.dispatchEvent(new window.MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	};
	const posted = (command: string) => sent.filter((message) => message.command === command);
	const click = (target: string | Element) => {
		const elem = typeof target === 'string' ? document.querySelector(target) : target;
		if (elem === null) throw new Error('click: nothing matches ' + target);
		elem!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
	};
	return { window, document, sent, states, errors, dispatch, posted, click };
}

const INIT = {
	command: 'init',
	fromHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	toHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
	countsPossible: true,
	singleCommit: false,
	summaries: {
		aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author: 'Ada', email: 'ada@example.com', date: 1700000000, message: 'The first commit' },
		bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: { hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', author: 'Ben', email: 'ben@example.com', date: 1700000100, message: 'The second commit' }
	},
	commitsBetween: 1,
	error: null,
	language: 'en'
};

const TEXT_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 context line
-removed line
+added line`;

const maybeDescribe = skip ? describe.skip : describe;

maybeDescribe('the extracted comparison frontend boots and runs', () => {
	it('asks for its data with the ready handshake, then renders header, stats and the file tree', () => {
		const page = boot();
		assert.deepEqual(page.posted('ready'), [{ command: 'ready' }]);

		page.dispatch({ ...INIT, changes: [CHANGE('M', 'src/a.ts', 'src/a.ts'), CHANGE('A', '', 'docs/logo.png')] });
		const { document } = page;

		// The header: one card per end of the comparison, joined around the divider.
		assert.equal(document.querySelectorAll('#commitCards .commitCard').length, 2);
		assert.equal((document.querySelector('#commitCards .commitCard[data-role="base"] .author') as HTMLElement)!.textContent, 'Ada');
		assert.equal((document.querySelector('#commitCards .commitCard[data-role="compare"] .author') as HTMLElement)!.textContent, 'Ben');
		assert.equal((document.querySelector('#compareDivider .count') as HTMLElement)!.textContent, '1 commit');
		assert.equal((document.querySelector('#filesChangedLabel') as HTMLElement)!.textContent, '2 files changed');

		// The tree: the folder nesting of the changed paths (folders first, alphabetically:
		// docs/ before src/), with each file's status letter.
		const rows = Array.from(document.querySelectorAll('#sidebar .treeRow.file')) as HTMLElement[];
		assert.deepEqual(rows.map((row) => row.dataset.index), ['1', '0']);
		assert.equal(rows[1].querySelector('.letter')!.textContent, 'M');
		assert.equal(rows[0].querySelector('.letter')!.textContent, 'A');
		assert.ok(rows[1].textContent!.includes('a.ts'));
		assert.equal(document.querySelectorAll('#sidebar .treeRow:not(.file)').length, 2); // src/ and docs/

		// The first file is selected and its diff requested.
		assert.ok(rows[1].classList.contains('selected'));
		assert.equal((document.querySelector('#filePath') as HTMLElement)!.textContent, 'src/a.ts');
		assert.deepEqual(page.posted('getFileDiff'), [{ command: 'getFileDiff', index: 0 }]);
		// The deferred counts of the files without any are asked for after the list renders.
		assert.deepEqual(page.posted('requestCounts'), [{ command: 'requestCounts', paths: ['src/a.ts', 'docs/logo.png'] }]);
		assert.equal(page.errors.length, 0, page.errors.join('; '));
		return page;
	});

	it('renders the diff table from the fileDiff reply, and the counts from lineCounts', () => {
		const page = boot();
		page.dispatch({ ...INIT, changes: [CHANGE('M', 'src/a.ts', 'src/a.ts')] });
		page.dispatch({ command: 'fileDiff', index: 0, diff: TEXT_DIFF, error: null });

		const table = page.document.querySelector('#diffArea table.diff')!;
		assert.ok(table !== null, 'the diff must render as a table');
		// The scripted width of 1200px is past the side-by-side breakpoint: the hunk header, the
		// context line, and the removed/added pair as ONE modified row (old | new).
		assert.equal(table.querySelectorAll('tr').length, 3, 'hunk, context and the paired change');
		assert.equal((table.querySelector('tr.hunk td') as HTMLElement)!.textContent, '@@ -1,2 +1,2 @@');
		assert.ok(table.textContent!.includes('added line'));
		const modCells = table.querySelectorAll('tr.mod td');
		assert.equal(modCells.length, 4, 'old line | old code | new line | new code');
		assert.ok(modCells[1].textContent!.includes('removed line'));
		assert.ok(modCells[3].textContent!.includes('added line'));

		// The deferred counts patch the tree row, the file header and the statistics.
		page.dispatch({ command: 'lineCounts', counts: { 'src/a.ts': { additions: 3, deletions: 5 } } });
		assert.ok((page.document.querySelector('.treeRow.file .counts') as HTMLElement)!.textContent!.includes('+3'));
		assert.ok((page.document.querySelector('#fileHeader .counts') as HTMLElement)!.textContent!.includes('-5'));
		assert.equal((page.document.querySelector('#filesChangedLabel') as HTMLElement)!.textContent, '1 file changed with +3 −5');
		assert.equal(page.errors.length, 0, page.errors.join('; '));
	});

	it('hands a binary file over to the embedded hex comparison and posts its requests', () => {
		const page = boot();
		page.dispatch({ ...INIT, changes: [CHANGE('M', 'data.bin', 'data.bin')] });
		assert.deepEqual(page.posted('getFileDiff'), [{ command: 'getFileDiff', index: 0 }]);
		page.dispatch({ command: 'fileDiff', index: 0, diff: 'Binary files a/data.bin and b/data.bin differ', error: null });

		// The binary handover enters the hex view and asks for its layout.
		assert.ok(page.document.getElementById('diffArea')!.classList.contains('hexMode'));
		assert.deepEqual(page.posted('getHexInfo'), [{ command: 'getHexInfo', index: 0, bytesPerRow: 16 }]);
		page.dispatch({ command: 'hexInfo', index: 0, error: null, oldSize: 100, newSize: 120, totalRows: 8, sections: null, layoutVersion: 1, bytesPerRow: 16, rowHeight: 19 });
		assert.equal((page.document.getElementById('hexOldSize') as HTMLElement)!.textContent, '100 B');
		assert.equal((page.document.getElementById('hexNewSize') as HTMLElement)!.textContent, '120 B');
		assert.equal(page.errors.length, 0, page.errors.join('; '));

		// The open-diff button of a binary file opens the standalone Binary Compare tab.
		page.click('#openDiffBtn');
		assert.deepEqual(page.posted('viewDiffBinary'), [{ command: 'viewDiffBinary', index: 0 }]);
	});

	it('shows the error of a failed comparison in place of the tree', () => {
		const page = boot();
		page.dispatch({ ...INIT, changes: [], error: 'git failed spectacularly' });
		assert.equal((page.document.querySelector('#filesChangedLabel') as HTMLElement)!.textContent, 'Error');
		assert.ok((page.document.querySelector('#diffArea .status') as HTMLElement)!.textContent!.includes('git failed spectacularly'));
		assert.equal(page.errors.length, 0, page.errors.join('; '));
	});
});
