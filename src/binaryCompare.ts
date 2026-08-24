import { DataSource } from './dataSource';
import { HEX_BYTES_PER_ROW, HEX_ROW_HEIGHT, HexDiffSession, HexSection } from './hexDiff';
import { t } from './i18n';
import { GitFileChange } from './types';
import { UNCOMMITTED } from './utils';

/**
 * Everything the two binary comparison surfaces share: the Commit Comparison View's embedded
 * diff area, and the standalone Binary Compare tab. The styles and the client script below are
 * injected into both pages verbatim; the responders drive a HexDiffSession over the same
 * `hexInfo` / `hexMap` / `hexRows` / `imageData` messages from either page.
 */

/** A page's way of posting a message back to its webview. */
export type BinaryComparePost = (message: object) => void;

/** The section layout flattened for the webview: [oldStart, oldLength, newStart, newLength, equal?] repeated. */
export function flatSections(sections: ReadonlyArray<HexSection> | null): number[] | null {
	if (sections === null) return null;
	const flat: number[] = [];
	for (const section of sections) flat.push(section.os, section.ol, section.ns, section.nl, section.eq ? 1 : 0);
	return flat;
}

/** The image types the comparison view renders in picture mode, mapped to their MIME types. */
const IMAGE_MIME: { [extension: string]: string } = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml'
};

/**
 * The largest image side handed to the webview as a single data URL (decoding a few tens of MB
 * in the webview is fine; anything bigger stays in the hex view, which is size-independent).
 */
const IMAGE_SIZE_LIMIT = 32 * 1024 * 1024;

export function imageMimeOf(filePath: string): string | null {
	const dot = filePath.lastIndexOf('.');
	const extension = dot >= 0 ? filePath.substring(dot + 1).toLowerCase() : '';
	return Object.prototype.hasOwnProperty.call(IMAGE_MIME, extension) ? IMAGE_MIME[extension] : null;
}

/**
 * The session comparing one file between two revisions. `fromHash`/`toHash` treat
 * UNCOMMITTED and '' as the working tree, exactly like the diff the view is showing.
 */
export function createHexSession(dataSource: DataSource, repo: string, fromHash: string, toHash: string, file: GitFileChange): HexDiffSession {
	const fromWorkingTree = fromHash === UNCOMMITTED || fromHash === '';
	const toWorkingTree = toHash === UNCOMMITTED || toHash === '';
	return new HexDiffSession(dataSource, repo,
		fromWorkingTree, file.oldFilePath !== '' ? file.oldFilePath : file.newFilePath, fromHash,
		toWorkingTree, file.newFilePath !== '' ? file.newFilePath : file.oldFilePath, toHash,
		file);
}

/** Forward the session's background scan result into a page as a `hexMap` message. */
export function wireHexSession(session: HexDiffSession, index: number, post: BinaryComparePost): void {
	session.onSections = (sections, error) => {
		post({ command: 'hexMap', index: index, sections: flatSections(sections), totalRows: session.totalRows, layoutVersion: session.layoutVersion, error: error });
	};
}

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** Answer a page's `getHexInfo`: apply the row width it measured, resolve sizes, reply. */
export async function respondHexInfo(session: HexDiffSession, index: number, bytesPerRow: number, post: BinaryComparePost): Promise<void> {
	try {
		session.setBytesPerRow(bytesPerRow);
		await session.init();
		post({ command: 'hexInfo', index: index, error: null, oldSize: session.oldSize, newSize: session.newSize, totalRows: session.totalRows, sections: flatSections(session.sectionLayout), layoutVersion: session.layoutVersion, bytesPerRow: session.bytesPerRow, rowHeight: HEX_ROW_HEIGHT });
	} catch (err) {
		post({ command: 'hexInfo', index: index, error: t('compareHexLoadError', errorMessage(err)), oldSize: -1, newSize: -1, totalRows: 0, sections: null, layoutVersion: 0, bytesPerRow: HEX_BYTES_PER_ROW, rowHeight: HEX_ROW_HEIGHT });
	}
}

/** Answer a page's `getHexRows`: the rows of one visible window. */
export async function respondHexRows(session: HexDiffSession, index: number, start: number, count: number, post: BinaryComparePost): Promise<void> {
	try {
		const rows = await session.getRows(start, count);
		post({ command: 'hexRows', index: index, start: start, rows: rows, layoutVersion: session.layoutVersion, error: null });
	} catch (err) {
		post({ command: 'hexRows', index: index, start: start, rows: [], layoutVersion: session.layoutVersion, error: errorMessage(err) });
	}
}

/** Answer a page's `getImageData`: both sides as data URLs, bounded by the size limit. */
export async function respondImageData(session: HexDiffSession, index: number, file: GitFileChange, post: BinaryComparePost): Promise<void> {
	const reply = (error: string | null, oldData: string | null, newData: string | null) => {
		post({ command: 'imageData', index: index, error: error, oldData: oldData, newData: newData, oldSize: session.oldSize, newSize: session.newSize });
	};
	try {
		await session.init();
		const mime = imageMimeOf(file.newFilePath !== '' ? file.newFilePath : file.oldFilePath);
		const largest = Math.max(session.oldSize, session.newSize);
		if (mime === null || largest > IMAGE_SIZE_LIMIT) {
			reply(mime === null
				? t('compareImageUnsupportedType')
				: t('compareImageTooLarge', largest.toLocaleString(), IMAGE_SIZE_LIMIT.toLocaleString()), null, null);
			return;
		}
		const [oldBytes, newBytes] = await Promise.all([session.readSide('old'), session.readSide('new')]);
		reply(null,
			oldBytes !== null ? 'data:' + mime + ';base64,' + oldBytes.toString('base64') : null,
			newBytes !== null ? 'data:' + mime + ';base64,' + newBytes.toString('base64') : null);
	} catch (err) {
		reply(t('compareHexLoadError', errorMessage(err)), null, null);
	}
}

/** Is a file change one the picture mode can render? (Shared so both pages agree with the responders.) */
export function isImageChange(file: GitFileChange): boolean {
	const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
	return imageMimeOf(filePath) !== null;
}

/** The styles of the embedded hex / image comparison area. Pages wrap this in their own <style>. */
export function binaryCompareCss(): string {
	return `
		/* Hex comparison view (binary files): offset | old hex + ASCII || new hex + ASCII */
		#diffArea.hexMode { overflow: hidden; display: flex; }
		#hexWrap { --bpr: 16; flex: 1; display: flex; flex-direction: column; min-width: 0; }
		#hexToolbar, #imgToolbar { display: flex; align-items: center; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); flex-shrink: 0; font-size: 12px; }
		#hexToolbar .hxSpacer, #imgToolbar .hxSpacer { flex: 1; }
		#hexToolbar button, #imgToolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; padding: 2px 10px; cursor: pointer; font-size: 11px; line-height: 16px; }
		#hexToolbar button:disabled, #imgToolbar button:disabled { opacity: 0.45; cursor: default; }
		#hexScroller { flex: 1; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
		#hexInner { display: inline-block; min-width: 100%; }
		/* Same font size as the rows: the column widths below are in ch, which scales with the
		   font, so a smaller header font would slide its labels out of alignment with the bytes. */
		#hexHead { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); opacity: 0.9; }
		#hexSpacer { position: relative; }
		#hexView { position: absolute; top: 0; left: 0; right: 0; }
		.hrow { display: flex; height: 19px; line-height: 19px; white-space: pre; }
		.hrow.hxPending { opacity: 0.35; }
		.hoff { width: 10ch; flex-shrink: 0; color: var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.7)); }
		.hhex { width: calc(var(--bpr) * 3ch); flex-shrink: 0; }
		.hasc { width: calc((var(--bpr) + 1) * 1ch); flex-shrink: 0; }
		.hgap { width: 1ch; flex-shrink: 0; border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); margin: 0 2ch; }
		.hrow b { font-weight: 400; border-radius: 2px; }
		.hrow b.hxo { background: rgba(248,81,73,0.30); }
		.hrow b.hxn { background: rgba(46,160,67,0.30); }
		/* Image comparison view: old picture | pixel difference | new picture */
		#diffArea.imgMode { overflow: hidden; display: flex; }
		#imgWrap { flex: 1; display: flex; flex-direction: column; min-width: 0; }
		#imgToolbar { flex-wrap: wrap; }
		#imgStats { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		#imgControls { width: 100%; display: flex; align-items: center; gap: 16px; font-size: 11px; opacity: 0.9; flex-wrap: wrap; }
		#imgControls label { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
		#imgControls .hidden { display: none; }
		#imgControls select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.4)); border-radius: 2px; font-size: 11px; padding: 1px 4px; }
		#imgControls input[type=range] { width: 90px; accent-color: var(--vscode-button-background, #007acc); }
		#imgScroller { flex: 1; overflow: auto; }
		#imgRow { display: flex; align-items: flex-start; gap: 14px; padding: 14px; width: max-content; margin: 0 auto; }
		.imgPane { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 4px; overflow: hidden; background: var(--vscode-editor-background); flex-shrink: 0; }
		.imgCaption { font-size: 11px; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); opacity: 0.85; white-space: nowrap; }
		.imgHolder { padding: 8px; }
		.imgHolder img, .imgHolder canvas { display: block; }
		#imgRow.zoomed img, #imgRow.zoomed canvas { image-rendering: pixelated; }
`;
}

/**
 * The client script of the binary comparison area, shared by both pages. The page provides two
 * globals before including this: `vscode` (the acquireVsCodeApi handle) and `diffArea` (the
 * element the views render into); pages assign `currentFileIsImage` and call
 * `enterHexView(index)` / `enterImageView(index)` themselves, and route messages and resizes
 * through `handleBinaryCompareMessage(msg)` / `onBinaryCompareResize()`.
 */
export function binaryCompareScript(): string {
	return `
	/* ---------- Binary comparison (hex and picture), shared by both pages ---------- */
	/* Only the visible hex rows are kept in the DOM and requested from the extension, so a file
	   of any size scrolls smoothly and costs the same memory. */
	const HEX_ROW_H = 19;
	const HEXDIGITS = [];
	for (let i = 0; i < 256; i++) HEXDIGITS.push((i < 16 ? '0' : '') + i.toString(16));
	const HEXDIFF_TPL = '${t('compareHexDiffStatus', '{0}', '{1}')}';
	const HEXSIZES_TPL = '${t('compareHexSizes', '{0}', '{1}')}';
	const IMGSTATS_TPL = '${t('compareImageStatsTpl', '{0}', '{1}', '{2}', '{3}', '{4}', '{5}')}';
	function bcEscapeHtml(str) {
		return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	let hexActive = false, hexIndex = -1, hexTotalRows = 0, hexSameSize = false, hexLayoutVersion = 0, hexBytesPerRow = 16;
	let hexSections = null, hexDiffs = [], hexDiffPos = -1;
	let currentFileIsImage = false;
	const hexRows = new Map();
	let hexPending = false, hexEls = null, hexScrollQueued = false;
	let imgActive = false, imgEls = null, imgIndex = -1;
	let imgZoomMode = -1, imgScale = 1, imgOld = null, imgNew = null, imgOldBytes = -1, imgNewBytes = -1;
	/* The difference engine: one Uint8 per-pixel maximum channel delta (0..255, 255 where a
	   pixel has no counterpart), plus the sum of squared RGB deltas for the MSE. Everything the
	   display modes and the statistics need is derived from these, so changing the tolerance,
	   amplification or mode never re-decodes the images. */
	let imgDiff = null, imgMode = 'enhanced', imgAmplify = 10, imgTolerance = 0, imgBlend = 0.5;
	let imgBlinkTimer = null, imgBlinkSide = 0, imgRenderQueued = false;

	function hexBytesLabel(size) {
		return size < 0 ? '\\u2014' : size.toLocaleString() + ' B';
	}

	function hexOffsetText(offset) {
		let text = offset.toString(16);
		while (text.length < 8) text = '0' + text;
		return text;
	}

	/* The hex view fits the window: the widest row layout (16 bytes) needs roughly
	   (8 * 16 + 29) character cells, so narrower windows step down to 12/8/4 bytes per row. */
	function pickHexBytesPerRow() {
		const probe = document.createElement('span');
		probe.style.visibility = 'hidden';
		probe.style.position = 'absolute';
		probe.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		probe.style.fontSize = '12px';
		probe.textContent = '0000000000000000000000000000';
		document.body.appendChild(probe);
		const charWidth = probe.getBoundingClientRect().width / 28;
		document.body.removeChild(probe);
		const available = diffArea.clientWidth - 24;
		const candidates = [16, 12, 8, 4];
		for (let i = 0; i < candidates.length; i++) {
			if ((8 * candidates[i] + 29) * charWidth <= available) return candidates[i];
		}
		return 4;
	}

	function applyHexBytesPerRow() {
		if (hexEls === null) return;
		hexEls.wrap.style.setProperty('--bpr', String(hexBytesPerRow));
		hexEls.head.innerHTML = hexHeadHtml();
	}

	function refreshHexLayout() {
		hexBytesPerRow = pickHexBytesPerRow();
		applyHexBytesPerRow();
		if (hexEls !== null) hexEls.view.innerHTML = '';
		hexRows.clear();
		hexPending = false;
		hexSections = null;
		hexDiffs = [];
		hexDiffPos = -1;
		updateHexNav();
		vscode.postMessage({ command: 'getHexInfo', index: hexIndex, bytesPerRow: hexBytesPerRow });
	}

	function hexSideHtml(offset, b64, mask, side) {
		if (offset < 0 || b64 === '') {
			return '<span class="hoff"></span><span class="hhex"></span><span class="hasc"></span>';
		}
		const bytes = atob(b64);
		const half = hexBytesPerRow / 2 - 1;
		let hex = '', ascii = '';
		for (let i = 0; i < bytes.length; i++) {
			const byte = bytes.charCodeAt(i) & 0xff;
			const changed = mask.charAt(i) === '1';
			const hexText = HEXDIGITS[byte];
			const asciiText = byte >= 32 && byte <= 126 ? bcEscapeHtml(String.fromCharCode(byte)) : '\\u00B7';
			if (changed) {
				hex += '<b class="hx' + side + '">' + hexText + '</b>';
				ascii += '<b class="hx' + side + '">' + asciiText + '</b>';
			} else {
				hex += hexText;
				ascii += asciiText;
			}
			if (i === half) hex += '  ';
			else if (i < bytes.length - 1) hex += ' ';
		}
		return '<span class="hoff">' + hexOffsetText(offset) + '</span><span class="hhex">' + hex + '</span><span class="hasc">' + ascii + '</span>';
	}

	function hexRowHtml(row) {
		return '<div class="hrow">' + hexSideHtml(row.o, row.ob, row.om, 'o') + '<span class="hgap"></span>' + hexSideHtml(row.n, row.nb, row.nm, 'n') + '</div>';
	}

	function hexHeadHtml() {
		let hexHead = '';
		for (let i = 0; i < hexBytesPerRow; i++) {
			hexHead += HEXDIGITS[i] + (i === hexBytesPerRow / 2 - 1 ? '  ' : (i < hexBytesPerRow - 1 ? ' ' : ''));
		}
		const cells = '<span class="hoff">${t('compareHexColOffset')}</span><span class="hhex">' + hexHead + '</span><span class="hasc">${t('compareHexColAscii')}</span>';
		return cells + '<span class="hgap"></span>' + cells;
	}

	function enterHexView(index) {
		hexActive = true;
		hexIndex = index;
		hexTotalRows = 0;
		hexSameSize = false;
		hexLayoutVersion = 0;
		hexSections = null;
		hexDiffs = [];
		hexDiffPos = -1;
		hexRows.clear();
		hexPending = false;
		hexBytesPerRow = pickHexBytesPerRow();
		stopImageBlink();
		imgActive = false;
		imgEls = null;
		imgDiff = null;
		diffArea.className = 'hexMode';
		diffArea.innerHTML =
			'<div id="hexWrap">' +
				'<div id="hexToolbar">' +
					'<span id="hexSizes"></span>' +
					'<span class="hxSpacer"></span>' +
					(currentFileIsImage ? '<button id="hexImageBtn">${t('compareImageToggleButton')}</button>' : '') +
					'<button id="hexPrevBtn" title="${t('compareHexPrevDiff')}">&#9650;</button>' +
					'<span id="hexDiffStatus">${t('compareHexAnalysing')}</span>' +
					'<button id="hexNextBtn" title="${t('compareHexNextDiff')}">&#9660;</button>' +
				'</div>' +
				'<div id="hexScroller"><div id="hexInner">' +
					'<div id="hexHead" class="hrow">' + hexHeadHtml() + '</div>' +
					'<div id="hexSpacer"><div id="hexView"></div></div>' +
				'</div></div>' +
			'</div>';
		hexEls = {
			wrap: document.getElementById('hexWrap'),
			head: document.getElementById('hexHead'),
			scroller: document.getElementById('hexScroller'),
			spacer: document.getElementById('hexSpacer'),
			view: document.getElementById('hexView'),
			sizes: document.getElementById('hexSizes'),
			status: document.getElementById('hexDiffStatus'),
			prev: document.getElementById('hexPrevBtn'),
			next: document.getElementById('hexNextBtn')
		};
		applyHexBytesPerRow();
		hexEls.scroller.addEventListener('scroll', queueHexRender);
		hexEls.prev.addEventListener('click', function () { hexNavigate(-1); });
		hexEls.next.addEventListener('click', function () { hexNavigate(1); });
		const hexImageBtn = document.getElementById('hexImageBtn');
		if (hexImageBtn !== null) hexImageBtn.addEventListener('click', function () { enterImageView(hexIndex); });
		updateHexNav();
		vscode.postMessage({ command: 'getHexInfo', index: index, bytesPerRow: hexBytesPerRow });
	}

	function queueHexRender() {
		if (hexScrollQueued || !hexActive) return;
		hexScrollQueued = true;
		requestAnimationFrame(function () {
			hexScrollQueued = false;
			renderHexViewport();
		});
	}

	function renderHexViewport() {
		if (!hexActive || hexEls === null) return;
		hexEls.spacer.style.height = (hexTotalRows * HEX_ROW_H) + 'px';
		const top = hexEls.scroller.scrollTop, height = hexEls.scroller.clientHeight;
		const first = Math.max(0, Math.floor(top / HEX_ROW_H) - 16);
		const last = Math.min(hexTotalRows - 1, Math.ceil((top + height) / HEX_ROW_H) + 24);
		hexEls.view.style.transform = 'translateY(' + (first * HEX_ROW_H) + 'px)';
		let html = '', needStart = -1, needEnd = -1;
		for (let row = first; row <= last; row++) {
			const cached = hexRows.get(row);
			if (cached === undefined) {
				if (needStart < 0) needStart = row;
				needEnd = row;
				html += '<div class="hrow hxPending"></div>';
			} else {
				html += hexRowHtml(cached);
			}
		}
		hexEls.view.innerHTML = html;
		if (needStart >= 0 && !hexPending) {
			hexPending = true;
			vscode.postMessage({ command: 'getHexRows', index: hexIndex, start: needStart, count: needEnd - needStart + 1 });
		}
	}

	function updateHexNav() {
		if (hexEls === null) return;
		const count = hexDiffs.length;
		hexEls.prev.disabled = count === 0;
		hexEls.next.disabled = count === 0;
		if (count === 0) {
			hexEls.status.innerHTML = hexSections === null ? '${t('compareHexAnalysing')}' : '${t('compareHexNoDifferences')}';
		} else {
			hexEls.status.innerHTML = HEXDIFF_TPL.replace('{0}', String(hexDiffPos < 0 ? 1 : hexDiffPos + 1)).replace('{1}', String(count));
		}
	}

	function hexNavigate(direction) {
		const count = hexDiffs.length;
		if (count === 0) return;
		if (hexDiffPos < 0) hexDiffPos = direction > 0 ? 0 : count - 1;
		else hexDiffPos = (hexDiffPos + direction + count) % count;
		if (hexEls !== null) hexEls.scroller.scrollTop = Math.max(0, hexDiffs[hexDiffPos].row * HEX_ROW_H - 48);
		updateHexNav();
		renderHexViewport();
	}

	function applyHexMap(sections, totalRows, layoutVersion) {
		hexSections = sections;
		hexLayoutVersion = layoutVersion;
		hexDiffs = [];
		hexDiffPos = -1;
		let row = 0;
		for (let i = 0; i < sections.length; i += 5) {
			const oldLength = sections[i + 1], newLength = sections[i + 3], equal = sections[i + 4] === 1;
			const rows = equal ? Math.ceil(oldLength / hexBytesPerRow) : Math.max(Math.ceil(oldLength / hexBytesPerRow), Math.ceil(newLength / hexBytesPerRow));
			if (!equal && rows > 0) hexDiffs.push({ row: row, rows: rows });
			row += rows;
		}
		hexTotalRows = totalRows;
		// Row indices were rebuilt by the alignment; equal-size files keep the identical layout.
		if (!hexSameSize) hexRows.clear();
		updateHexNav();
		renderHexViewport();
	}

	/* ---------- Image comparison view (picture files) ---------- */
	/* Old picture | pixel difference | new picture, rendered from data URLs the extension
	   builds out of the two git sides; the difference canvas is computed in the webview. */
	const IMAGE_EXTS = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, ico: 1, avif: 1, svg: 1 };
	function isImagePath(filePath) {
		const dot = filePath.lastIndexOf('.');
		return dot >= 0 && IMAGE_EXTS[filePath.substring(dot + 1).toLowerCase()] === 1;
	}

	function stopImageBlink() {
		if (imgBlinkTimer !== null) {
			clearInterval(imgBlinkTimer);
			imgBlinkTimer = null;
		}
	}

	function enterImageView(index) {
		imgActive = true;
		imgIndex = index;
		imgZoomMode = -1;
		imgOld = null;
		imgNew = null;
		imgDiff = null;
		imgMode = 'enhanced';
		imgAmplify = 10;
		imgTolerance = 0;
		imgBlend = 0.5;
		stopImageBlink();
		hexActive = false;
		hexEls = null;
		diffArea.className = 'imgMode';
		diffArea.innerHTML =
			'<div id="imgWrap">' +
				'<div id="imgToolbar">' +
					'<span id="imgStats">${t('compareLoadingDiff')}</span>' +
					'<span class="hxSpacer"></span>' +
					'<button id="imgZoomOutBtn" title="${t('compareImageZoomOut')}">&minus;</button>' +
					'<span id="imgZoomLabel"></span>' +
					'<button id="imgZoomInBtn" title="${t('compareImageZoomIn')}">+</button>' +
					'<button id="imgZoomFitBtn">${t('compareImageZoomFit')}</button>' +
					'<button id="imgZoomFullBtn">1:1</button>' +
					'<button id="imgHexBtn">${t('compareHexToggleButton')}</button>' +
					'<div id="imgControls">' +
						'<select id="imgModeSel">' +
							'<option value="enhanced">${t('compareImageModeEnhanced')}</option>' +
							'<option value="difference">${t('compareImageModeDifference')}</option>' +
							'<option value="blend">${t('compareImageModeBlend')}</option>' +
							'<option value="highlight">${t('compareImageModeHighlight')}</option>' +
							'<option value="blink">${t('compareImageModeBlink')}</option>' +
						'</select>' +
						'<label id="imgAmplifyRow">${t('compareImageAmplify')} <input type="range" id="imgAmplifyRange" min="1" max="32" step="1" value="10"><span id="imgAmplifyVal">&times;10</span></label>' +
						'<label id="imgBlendRow" class="hidden">${t('compareImageBlendAlpha')} <input type="range" id="imgBlendRange" min="0" max="100" step="1" value="50"><span id="imgBlendVal">50%</span></label>' +
						'<label>${t('compareImageTolerance')} <input type="range" id="imgToleranceRange" min="0" max="128" step="1" value="0"><span id="imgToleranceVal">0</span></label>' +
					'</div>' +
				'</div>' +
				'<div id="imgScroller"><div id="imgRow">' +
					'<div class="imgPane"><div class="imgCaption" id="imgOldCaption">${t('compareImageCaptionOld')}</div><div class="imgHolder" id="imgOldHolder"></div></div>' +
					'<div class="imgPane"><div class="imgCaption">${t('compareImageCaptionDiff')}</div><div class="imgHolder" id="imgDiffHolder"></div></div>' +
					'<div class="imgPane"><div class="imgCaption" id="imgNewCaption">${t('compareImageCaptionNew')}</div><div class="imgHolder" id="imgNewHolder"></div></div>' +
				'</div></div>' +
			'</div>';
		imgEls = {
			stats: document.getElementById('imgStats'),
			zoomLabel: document.getElementById('imgZoomLabel'),
			scroller: document.getElementById('imgScroller'),
			row: document.getElementById('imgRow'),
			oldHolder: document.getElementById('imgOldHolder'),
			diffHolder: document.getElementById('imgDiffHolder'),
			newHolder: document.getElementById('imgNewHolder'),
			oldCaption: document.getElementById('imgOldCaption'),
			newCaption: document.getElementById('imgNewCaption'),
			modeSel: document.getElementById('imgModeSel'),
			amplifyRow: document.getElementById('imgAmplifyRow'),
			amplifyRange: document.getElementById('imgAmplifyRange'),
			amplifyVal: document.getElementById('imgAmplifyVal'),
			blendRow: document.getElementById('imgBlendRow'),
			blendRange: document.getElementById('imgBlendRange'),
			blendVal: document.getElementById('imgBlendVal'),
			toleranceRange: document.getElementById('imgToleranceRange'),
			toleranceVal: document.getElementById('imgToleranceVal')
		};
		document.getElementById('imgZoomOutBtn').addEventListener('click', function () { zoomImageBy(1 / 1.25); });
		document.getElementById('imgZoomInBtn').addEventListener('click', function () { zoomImageBy(1.25); });
		document.getElementById('imgZoomFitBtn').addEventListener('click', function () { imgZoomMode = -1; applyImageZoom(); });
		document.getElementById('imgZoomFullBtn').addEventListener('click', function () { imgZoomMode = 1; applyImageZoom(); });
		document.getElementById('imgHexBtn').addEventListener('click', function () { enterHexView(imgIndex); });
		imgEls.modeSel.addEventListener('change', function () { setImageMode(this.value); });
		imgEls.amplifyRange.addEventListener('input', function () {
			imgAmplify = parseInt(this.value, 10) || 1;
			imgEls.amplifyVal.innerHTML = '&times;' + imgAmplify;
			queueImageRender();
		});
		imgEls.blendRange.addEventListener('input', function () {
			imgBlend = (parseInt(this.value, 10) || 0) / 100;
			imgEls.blendVal.textContent = this.value + '%';
			queueImageRender();
		});
		imgEls.toleranceRange.addEventListener('input', function () {
			imgTolerance = parseInt(this.value, 10) || 0;
			imgEls.toleranceVal.textContent = this.value;
			updateImageStats();
			queueImageRender();
		});
		vscode.postMessage({ command: 'getImageData', index: index });
	}

	/** Decode one side; NULL means the side does not exist, 'error' a failed decode. */
	function loadImage(dataUrl) {
		if (dataUrl === null) return Promise.resolve(null);
		return new Promise(function (resolve) {
			const image = new Image();
			image.onload = function () { resolve(image); };
			image.onerror = function () { resolve('error'); };
			image.src = dataUrl;
		});
	}

	function paneSize(image) {
		return image === null || image === 'error' ? { w: 0, h: 0 } : { w: image.naturalWidth, h: image.naturalHeight };
	}

	function readSidePixels(image, width, height) {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		// An added or deleted picture has a missing side: draw nothing (drawImage throws on null),
		// leaving the fresh canvas' transparent black, which the edge logic of computeImageDiff
		// already treats as maximally different.
		if (image !== null && image !== 'error') ctx.drawImage(image, 0, 0);
		return ctx.getImageData(0, 0, width, height).data;
	}

	/**
	 * The difference engine: decode both sides over the union size and reduce them to one
	 * maximum-channel-delta per pixel (0..255; 255 where a pixel has no counterpart on the
	 * other side) plus the accumulated squared RGB error for the MSE. Every display mode and
	 * statistic is derived from these, so moving the tolerance or amplification sliders never
	 * re-decodes the images.
	 */
	function computeImageDiff() {
		const oldSize = paneSize(imgOld), newSize = paneSize(imgNew);
		const width = Math.max(oldSize.w, newSize.w), height = Math.max(oldSize.h, newSize.h);
		if (width === 0 || height === 0 || imgOld === 'error' || imgNew === 'error') return null;
		const a = readSidePixels(imgOld, width, height);
		const b = readSidePixels(imgNew, width, height);
		const map = new Uint8Array(width * height);
		let sumSquares = 0;
		for (let y = 0; y < height; y++) {
			const rowOld = y < oldSize.h, rowNew = y < newSize.h;
			for (let x = 0; x < width; x++) {
				const p = y * width + x;
				if (rowOld && rowNew && x < oldSize.w && x < newSize.w) {
					const i = p * 4;
					const dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]), db = Math.abs(a[i + 2] - b[i + 2]);
					const delta = Math.max(dr, dg, db, Math.abs(a[i + 3] - b[i + 3]));
					map[p] = delta;
					sumSquares += (dr * dr + dg * dg + db * db) / 3;
				} else if ((rowOld && x < oldSize.w) || (rowNew && x < newSize.w)) {
					map[p] = 255; // beyond one side's edge: no counterpart at all
					sumSquares += 255 * 255;
				}
			}
		}
		return { map: map, sumSquares: sumSquares, total: width * height, width: width, height: height };
	}

	function setImageMode(mode) {
		imgMode = mode;
		stopImageBlink();
		if (imgEls !== null) {
			imgEls.amplifyRow.classList.toggle('hidden', mode !== 'enhanced');
			imgEls.blendRow.classList.toggle('hidden', mode !== 'blend');
		}
		if (mode === 'blink') startImageBlink();
		else queueImageRender();
	}

	function startImageBlink() {
		if (imgBlinkTimer !== null || imgDiff === null) return;
		imgBlinkSide = 0;
		drawBlinkFrame();
		imgBlinkTimer = setInterval(function () {
			imgBlinkSide = 1 - imgBlinkSide;
			drawBlinkFrame();
		}, 600);
	}

	function drawBlinkFrame() {
		if (!imgActive || imgEls === null) return;
		const canvas = imgEls.diffHolder.firstChild;
		if (canvas === null || canvas === undefined || canvas.tagName !== 'CANVAS') return;
		const ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const image = imgBlinkSide === 0 ? imgOld : imgNew;
		if (image !== null && image !== 'error') ctx.drawImage(image, 0, 0);
	}

	function queueImageRender() {
		if (imgRenderQueued) return;
		imgRenderQueued = true;
		requestAnimationFrame(function () {
			imgRenderQueued = false;
			renderDiffPane();
		});
	}

	/** Paint the middle pane in the active mode. */
	function renderDiffPane() {
		if (!imgActive || imgEls === null || imgDiff === null) return;
		const width = imgDiff.width, height = imgDiff.height;
		let canvas = imgEls.diffHolder.firstChild;
		if (canvas === null || canvas === undefined || canvas.tagName !== 'CANVAS' || canvas.width !== width || canvas.height !== height) {
			canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			imgEls.diffHolder.innerHTML = '';
			imgEls.diffHolder.appendChild(canvas);
		}
		if (imgMode === 'blink') {
			drawBlinkFrame();
			applyImageZoom();
			return;
		}
		const ctx = canvas.getContext('2d');
		if (imgMode === 'blend' || imgMode === 'highlight') {
			// The picture-based modes need the decoded pixels again; re-read from the images.
			const oldSize = paneSize(imgOld), newSize = paneSize(imgNew);
			const a = readSidePixels(imgOld, width, height);
			const b = imgMode === 'blend' ? readSidePixels(imgNew, width, height) : null;
			const out = ctx.createImageData(width, height);
			for (let y = 0; y < height; y++) {
				const rowOld = y < oldSize.h, rowNew = y < newSize.h;
				for (let x = 0; x < width; x++) {
					const p = y * width + x, i = p * 4;
					const inOld = rowOld && x < oldSize.w, inNew = rowNew && x < newSize.w;
					if (imgMode === 'blend') {
						// Alpha blend between the sides: identical pictures stay still, a moved
						// or edited region shows up as a ghost.
						if (inOld && inNew) {
							out.data[i] = Math.round(imgBlend * a[i] + (1 - imgBlend) * b[i]);
							out.data[i + 1] = Math.round(imgBlend * a[i + 1] + (1 - imgBlend) * b[i + 1]);
							out.data[i + 2] = Math.round(imgBlend * a[i + 2] + (1 - imgBlend) * b[i + 2]);
							out.data[i + 3] = Math.round(imgBlend * a[i + 3] + (1 - imgBlend) * b[i + 3]);
						} else if (inOld) {
							out.data[i] = a[i]; out.data[i + 1] = a[i + 1]; out.data[i + 2] = a[i + 2]; out.data[i + 3] = a[i + 3];
						} else if (inNew) {
							out.data[i] = b[i]; out.data[i + 1] = b[i + 1]; out.data[i + 2] = b[i + 2]; out.data[i + 3] = b[i + 3];
						}
					} else {
						// Highlight: the original picture with the differing pixels dyed red.
						if (inOld) {
							// A flat saturated red: mixing the dye from the base pixel's own channels
							// left the mark proportional to the pixel's darkness, so large changes on
							// bright areas washed out to pale pink while small changes on dark ones
							// glared — visibility must not depend on what lies underneath.
							const dye = imgDiff.map[p] > imgTolerance;
							out.data[i] = dye ? 255 : a[i];
							out.data[i + 1] = dye ? 0 : a[i + 1];
							out.data[i + 2] = dye ? 0 : a[i + 2];
							out.data[i + 3] = 255;
						} else if (inNew) {
							out.data[i] = 170; out.data[i + 1] = 170; out.data[i + 2] = 170; out.data[i + 3] = 255;
						}
					}
				}
			}
			ctx.putImageData(out, 0, 0);
		} else {
			// The magnitude modes: the per-pixel delta as greyscale, amplified by the chosen
			// factor so that small differences become visible, and blanked below the tolerance.
			const factor = imgMode === 'enhanced' ? imgAmplify : 1;
			const out = ctx.createImageData(width, height);
			for (let p = 0; p < imgDiff.total; p++) {
				const value = imgDiff.map[p] > imgTolerance ? Math.min(255, imgDiff.map[p] * factor) : 0;
				const i = p * 4;
				out.data[i] = value;
				out.data[i + 1] = value;
				out.data[i + 2] = value;
				out.data[i + 3] = 255;
			}
			ctx.putImageData(out, 0, 0);
		}
		applyImageZoom();
	}

	/** The statistics line, recomputed from the delta map whenever the tolerance moves. */
	function updateImageStats() {
		if (imgEls === null) return;
		if (imgDiff === null) {
			imgEls.stats.innerHTML = '${t('compareImageDecodeError')}';
			imgEls.stats.title = '';
			return;
		}
		let count = 0, maxDelta = 0, sumDelta = 0;
		for (let p = 0; p < imgDiff.total; p++) {
			const delta = imgDiff.map[p];
			if (delta > imgTolerance) {
				count++;
				sumDelta += delta;
				if (delta > maxDelta) maxDelta = delta;
			}
		}
		if (count === 0) {
			imgEls.stats.innerHTML = '${t('compareImageNoDifferences')}';
			imgEls.stats.title = '';
			return;
		}
		const mse = imgDiff.sumSquares / imgDiff.total;
		const psnr = mse > 0 ? (10 * Math.log10(255 * 255 / mse)).toFixed(1) : '\\u221E';
		imgEls.stats.innerHTML = IMGSTATS_TPL
			.replace('{0}', count.toLocaleString())
			.replace('{1}', (count * 100 / imgDiff.total).toFixed(2))
			.replace('{2}', String(maxDelta))
			.replace('{3}', (sumDelta / count).toFixed(2))
			.replace('{4}', mse.toFixed(2))
			.replace('{5}', psnr);
		imgEls.stats.title = imgEls.stats.textContent;
	}

	function renderImages() {
		if (!imgActive || imgEls === null) return;
		const place = function (image, holder) {
			holder.innerHTML = '';
			if (image !== null && image !== 'error') holder.appendChild(image);
		};
		place(imgOld, imgEls.oldHolder);
		place(imgNew, imgEls.newHolder);
		imgEls.diffHolder.innerHTML = '';
		const dim = function (size, bytes) {
			return (size.w > 0 ? size.w + ' \\u00D7 ' + size.h : '\\u2014') + (bytes >= 0 ? ' \\u00B7 ' + hexBytesLabel(bytes) : '');
		};
		imgEls.oldCaption.innerHTML = '${t('compareImageCaptionOld')}' + ' \\u00B7 ' + dim(paneSize(imgOld), imgOldBytes);
		imgEls.newCaption.innerHTML = '${t('compareImageCaptionNew')}' + ' \\u00B7 ' + dim(paneSize(imgNew), imgNewBytes);
		imgDiff = computeImageDiff();
		if (imgDiff !== null) {
			renderDiffPane(); // creates and sizes the difference canvas in every mode
			if (imgMode === 'blink') startImageBlink();
			updateImageStats();
		} else {
			imgEls.stats.innerHTML = '${t('compareImageDecodeError')}';
		}
		applyImageZoom();
	}

	function applyImageZoom() {
		if (!imgActive || imgEls === null) return;
		const width = Math.max(paneSize(imgOld).w, paneSize(imgNew).w);
		const height = Math.max(paneSize(imgOld).h, paneSize(imgNew).h);
		if (width === 0 || height === 0) return;
		if (imgZoomMode < 0) {
			// Fit: the three panes side by side in the viewport; small pictures scale up to use
			// the available space (capped, and pixelated so scaled pixels stay crisp).
			imgScale = Math.min((imgEls.scroller.clientWidth - 56) / (3 * width), (imgEls.scroller.clientHeight - 64) / height);
			imgScale = Math.min(4, Math.max(0.05, imgScale));
		} else {
			imgScale = imgZoomMode;
		}
		imgEls.row.classList.toggle('zoomed', imgScale > 1);
		const media = imgEls.row.querySelectorAll('img, canvas');
		for (let i = 0; i < media.length; i++) {
			const element = media[i];
			const naturalWidth = element.tagName === 'IMG' ? element.naturalWidth : element.width;
			element.style.width = Math.max(1, Math.round(naturalWidth * imgScale)) + 'px';
		}
		imgEls.zoomLabel.textContent = imgZoomMode < 0 ? '${t('compareImageZoomFit')}' : Math.round(imgScale * 100) + '%';
	}

	function zoomImageBy(factor) {
		imgZoomMode = Math.min(8, Math.max(0.05, (imgZoomMode < 0 ? imgScale : imgZoomMode) * factor));
		applyImageZoom();
	}

	/** Route a message to whichever comparison view is active. Returns TRUE when handled. */
	function handleBinaryCompareMessage(msg) {
		if (msg.command === 'hexInfo') {
			if (!hexActive || msg.index !== hexIndex) return true;
			if (msg.error !== null) {
				hexActive = false;
				hexEls = null;
				diffArea.className = '';
				diffArea.innerHTML = '<div class="status">' + bcEscapeHtml(msg.error) + '</div>';
				return true;
			}
			hexSameSize = msg.oldSize === msg.newSize;
			if (typeof msg.bytesPerRow === 'number' && msg.bytesPerRow !== hexBytesPerRow) {
				hexBytesPerRow = msg.bytesPerRow;
				applyHexBytesPerRow();
			}
			if (hexEls !== null) {
				hexEls.sizes.innerHTML = HEXSIZES_TPL.replace('{0}', hexBytesLabel(msg.oldSize)).replace('{1}', hexBytesLabel(msg.newSize));
			}
			if (msg.sections !== null) {
				// The scan had already finished (e.g. while another view was showing): no hexMap
				// will follow, so apply the layout carried by this reply directly.
				applyHexMap(msg.sections, msg.totalRows, msg.layoutVersion);
			} else {
				// The section map can overtake the scan's completion message; its count wins then.
				if (hexSections === null) hexTotalRows = msg.totalRows;
				renderHexViewport();
			}
			return true;
		}
		if (msg.command === 'hexMap') {
			if (!hexActive || msg.index !== hexIndex) return true;
			if (msg.error !== null) {
				if (hexEls !== null) hexEls.status.innerHTML = bcEscapeHtml(msg.error);
				return true;
			}
			applyHexMap(msg.sections, msg.totalRows, msg.layoutVersion);
			return true;
		}
		if (msg.command === 'hexRows') {
			if (!hexActive || msg.index !== hexIndex) return true;
			hexPending = false;
			if (msg.error !== null) {
				if (hexEls !== null) hexEls.status.innerHTML = bcEscapeHtml(msg.error);
			} else if (msg.layoutVersion === hexLayoutVersion) {
				for (let i = 0; i < msg.rows.length; i++) hexRows.set(msg.start + i, msg.rows[i]);
				while (hexRows.size > 6000) {
					const oldest = hexRows.keys().next();
					if (oldest.done) break;
					hexRows.delete(oldest.value);
				}
			}
			renderHexViewport();
			return true;
		}
		if (msg.command === 'imageData') {
			if (!imgActive || msg.index !== imgIndex) return true;
			if (msg.error !== null) {
				stopImageBlink();
				imgActive = false;
				imgEls = null;
				imgDiff = null;
				diffArea.className = '';
				diffArea.innerHTML = '<div class="status">' + bcEscapeHtml(msg.error) + '</div>';
				return true;
			}
			imgOldBytes = msg.oldSize;
			imgNewBytes = msg.newSize;
			Promise.all([loadImage(msg.oldData), loadImage(msg.newData)]).then(function (images) {
				if (!imgActive || msg.index !== imgIndex) return;
				imgOld = images[0];
				imgNew = images[1];
				renderImages();
			});
			return true;
		}
		return false;
	}

	function onBinaryCompareResize() {
		if (hexActive) {
			if (pickHexBytesPerRow() !== hexBytesPerRow) refreshHexLayout();
			else queueHexRender();
		}
		if (imgActive && imgZoomMode < 0) applyImageZoom();
	}

	/* A window 'resize' event only tracks the OS window being dragged: maximising or restoring
	   it, toggling the side bar and splitting editors all resize the webview without one (or
	   fire it before the webview has re-laid out, when the old width is still measured). The
	   observer reports the area's own box after layout, so every cause is covered. */
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(function () { onBinaryCompareResize(); }).observe(diffArea);
	}
	window.addEventListener('resize', function () { onBinaryCompareResize(); });
`;
}
