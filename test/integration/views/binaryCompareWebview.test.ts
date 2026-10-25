/**
 * A jsdom smoke test of the extracted standalone Binary Compare frontend (REFACTOR-PLAN task
 * 6.1): boot the built bundle (media/binaryCompare.min.js) in the exact shell the host serves,
 * under a scripted extension host, and drive the boot handshake into both of the page's views
 * (the hex view of a binary file, the picture view of an image).
 *
 * Ported from tests/binaryCompareWebview.test.mjs (REFACTOR-PLAN task 7.1); assertions are
 * unchanged. The whole suite self-skips when the bundle has not been built.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUNDLE = path.join(rootDir, 'media', 'binaryCompare.min.js');
const skip = !fs.existsSync(BUNDLE);

/* The skeleton the host renders (see the Binary Compare view controller). */
const SHELL_HTML = `<!DOCTYPE html><html><head></head><body class="binaryComparePage">
<div id="header">
	<span class="letter">M</span>
	<span class="path">data.bin</span>
	<span class="refs">aaaaaaaa &harr; bbbbbbbb</span>
</div>
<div id="diffArea"></div>
</body></html>`;

function boot() {
	const dom = new JSDOM(SHELL_HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.invalid/' });
	const { window } = dom;
	const document = window.document;

	const sent: any[] = [];
	(window as any).acquireVsCodeApi = () => ({
		getState: () => null,
		setState: () => { /* nothing */ },
		postMessage: (message: unknown) => { sent.push(JSON.parse(JSON.stringify(message))); }
	});
	// The hex view's width probe measures a 28-character string: lay text out at 7px per
	// character, so the probe reads 196px and the row-width pick behaves as on a real page.
	(window as any).Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const width = (this.textContent || '').length * 7;
		return { top: 0, right: width, bottom: 400, left: 0, width: width, height: 400, x: 0, y: 0, toJSON() { return this; } };
	};
	const errors: string[] = [];
	window.addEventListener('error', (e: any) => errors.push(String(e.error || e.message)));

	window.eval(fs.readFileSync(BUNDLE, 'utf8'));
	window.dispatchEvent(new window.Event('load'));

	const dispatch = (message: unknown) => {
		window.dispatchEvent(new window.MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	};
	const posted = (command: string) => sent.filter((message) => message.command === command);
	return { window, document, sent, errors, dispatch, posted };
}

const maybeDescribe = skip ? describe.skip : describe;

maybeDescribe('the extracted binary compare frontend boots and runs', () => {
	it('boots into the hex view for a binary file and renders the scrolled window of rows', () => {
		const page = boot();
		assert.deepEqual(page.posted('ready'), [{ command: 'ready' }]);
		page.dispatch({ command: 'init', isImage: false, language: 'en' });

		// The hex view: toolbar with the difference navigation, sticky captions, ruler, viewport.
		const diffArea = page.document.getElementById('diffArea')!;
		assert.ok(diffArea.classList.contains('hexMode'));
		assert.ok(page.document.getElementById('hexToolbar') !== null);
		assert.ok(page.document.getElementById('hexPrevBtn') !== null);
		assert.ok(page.document.getElementById('hexRuler') !== null);
		const info = page.posted('getHexInfo')[0];
		assert.ok(info !== undefined && info.index === 0, 'the layout must be requested on entry');

		// jsdom reports no client height: the first render asks for the leading rows.
		page.dispatch({ command: 'hexInfo', index: 0, error: null, oldSize: 16, newSize: 32, totalRows: 2, sections: [0, 16, 0, 32, 0], layoutVersion: 1, bytesPerRow: info.bytesPerRow, rowHeight: 19 });
		assert.equal((page.document.getElementById('hexOldSize') as HTMLElement)!.textContent, '16 B');
		assert.equal((page.document.getElementById('hexNewSize') as HTMLElement)!.textContent, '32 B');
		assert.ok(page.posted('getHexRows').length >= 1, 'the visible rows must be requested');
		page.dispatch({ command: 'hexRows', index: 0, start: 0, layoutVersion: 1, error: null, rows: [{ o: 0, n: 0, ob: Buffer.from([0x41]).toString('base64'), nb: Buffer.from([0x42]).toString('base64'), om: '0', nm: '0' }] });
		const rows = page.document.querySelectorAll('#hexView .hrow');
		assert.ok(rows.length >= 1, 'the fetched rows must render');
		assert.ok((page.document.getElementById('hexView') as HTMLElement)!.textContent!.toUpperCase().includes('41'), 'the old side\'s first byte');
		assert.equal(page.errors.length, 0, page.errors.join('; '));
	});

	it('boots into the picture view for an image file and asks for its data', () => {
		const page = boot();
		page.dispatch({ command: 'init', isImage: true, language: 'en' });

		assert.ok(page.document.getElementById('diffArea')!.classList.contains('imgMode'));
		assert.ok(page.document.getElementById('imgToolbar') !== null);
		assert.ok(page.document.getElementById('imgOldHolder') !== null);
		assert.deepEqual(page.posted('getImageData'), [{ command: 'getImageData', index: 0 }]);
		assert.equal(page.errors.length, 0, page.errors.join('; '));
	});

	it('replaces the view with the localised error when the contents fail to load', () => {
		const page = boot();
		page.dispatch({ command: 'init', isImage: false, language: 'en' });
		page.dispatch({ command: 'hexInfo', index: 0, error: 'Unable to load the binary contents: boom', oldSize: -1, newSize: -1, totalRows: 0, sections: null, layoutVersion: 0, bytesPerRow: 16, rowHeight: 19 });
		const status = page.document.querySelector('#diffArea .status') as HTMLElement | null;
		assert.ok(status !== null && status.textContent!.includes('boom'), 'the error must replace the view');
		assert.equal(page.errors.length, 0, page.errors.join('; '));
	});
});
