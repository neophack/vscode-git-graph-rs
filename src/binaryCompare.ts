import { DataSource } from './dataSource';
import { HEX_BYTES_PER_ROW, HEX_ROW_HEIGHT, HexDiffSession, HexSection } from './hexDiff';
import { t } from './i18n';
import { GitFileChange } from './types';
import { UNCOMMITTED, copyToClipboard } from './utils';

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

/**
 * Answer a page's `copyToClipboard`: the hex view's own selection copy, and its Copy Address -
 * both read entirely from data the page already has (the cached rows), so this only ever writes
 * the clipboard and echoes back whether that succeeded.
 */
export async function respondCopyToClipboard(post: BinaryComparePost, type: string, data: string): Promise<void> {
	post({ command: 'copyToClipboard', type: type, error: await copyToClipboard(data) });
}

/** Is a file change one the picture mode can render? (Shared so both pages agree with the responders.) */
export function isImageChange(file: GitFileChange): boolean {
	const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
	return imageMimeOf(filePath) !== null;
}

/** The styles of the embedded hex / image comparison area. Pages wrap this in their own <style>. */
export function binaryCompareCss(): string {
	return `
		/* Hex comparison view (binary files): two panes side by side, each the hex editor's
		   offset | bytes | gutter | ASCII grid — the same table Git Graph Studio's hex viewer
		   draws, so the comparison reads like the viewer it sits next to. */
		#diffArea.hexMode { overflow: hidden; display: flex; }
		#hexWrap { --hcols: 10ch; flex: 1; display: flex; flex-direction: column; min-width: 0; }
		#hexToolbar, #imgToolbar { display: flex; align-items: center; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); flex-shrink: 0; font-size: 12px; }
		#hexToolbar .hxSpacer, #imgToolbar .hxSpacer { flex: 1; }
		#hexToolbar button, #imgToolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; padding: 2px 10px; cursor: pointer; font-size: 11px; line-height: 16px; }
		#hexToolbar button:disabled, #imgToolbar button:disabled { opacity: 0.45; cursor: default; }
		/* The ruler and the rows share one font: the ch-based grid tracks only line up when
		   both measure the same monospace glyph. */
		#hexScroller { flex: 1; overflow: auto; font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: var(--vscode-editor-font-size, 13px); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
		#hexInner { display: inline-block; min-width: 100%; }
		/* The sticky head: each pane's caption (which side, how many bytes) over the column
		   ruler — one hex digit above every byte column and again above the ASCII pane, so a
		   character reads back to its byte. */
		#hexHead { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-editorIndentGuide-background, var(--vscode-panel-border, rgba(128,128,128,0.35))); user-select: none; }
		#hexCaps { display: flex; font-size: 12px; color: var(--vscode-descriptionForeground, rgba(128,128,128,0.9)); }
		.hcap { flex: 1 1 50%; min-width: 0; display: flex; justify-content: space-between; gap: 2ch; padding: 4px 12px 2px; white-space: nowrap; overflow: hidden; }
		.hcap:first-child { border-right: 1px solid var(--vscode-editorIndentGuide-background, var(--vscode-panel-border, rgba(128,128,128,0.35))); }
		.hcap .hxSize { color: var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.7)); }
		#hexRuler { color: var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.7)); }
		#hexSpacer { position: relative; }
		#hexView { position: absolute; top: 0; left: 0; right: 0; }
		.hrow { display: flex; height: 19px; line-height: 19px; white-space: pre; }
		/* Every other row is faintly tinted, the zebra banding hex editors use to keep the eye
		   on a row across the panes; a wash of the foreground so it suits any theme. */
		.hrow.hxOdd { background: color-mix(in srgb, var(--vscode-editor-foreground, #ccc) 6%, transparent); }
		/* Each side is a grid over the template the script builds (offset | bytes | gutter |
		   ASCII), sized in ch so the ruler's digits sit exactly over their byte columns. A rule
		   down the middle keeps the sides apart the way the offset and gutter rules do. */
		.hside { display: grid; grid-template-columns: var(--hcols); flex: 1 1 50%; min-width: 0; padding: 0 12px; user-select: none; }
		.hside:first-child { border-right: 1px solid var(--vscode-editorIndentGuide-background, var(--vscode-panel-border, rgba(128,128,128,0.35))); }
		.hoff { color: var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.7)); padding-right: 1ch; border-right: 1px solid var(--vscode-editorIndentGuide-background, var(--vscode-panel-border, rgba(128,128,128,0.35))); user-select: none; }
		.hb, .ha { text-align: center; }
		/* .hbg is the dedicated 1ch track hexColsTemplate opens between byte groups - a blank
		   spacer, styled by nothing here. It keeps the group gap a single gap between two
		   bytes, not extra width folded into the group's first byte cell (which would center
		   that byte in the middle of its own widened column, splitting the gap into two
		   smaller, unevenly-sized ones straddling the byte instead). */
		/* The gutter's rule sits in its middle, 1.5ch clear of the last byte and the first char. */
		.hg { border-left: 1px solid var(--vscode-editorIndentGuide-background, var(--vscode-panel-border, rgba(128,128,128,0.35))); margin-left: 1.5ch; }
		/* A differing byte reads as a tinted cell on both sides — the diff editor's removed red
		   on the old side and its added green on the new — over the hex and ASCII cell alike. */
		.hb.hxo, .ha.hxo { background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f48771) 24%, transparent); }
		.hb.hxn, .ha.hxn { background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #81b88b) 24%, transparent); }
		.ha.hxo { color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
		.ha.hxn { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
		/* A selection is one shared span of grid position (row, column), painted identically on
		   both sides — the same position can hold different bytes on each side, so this marks
		   "the same spot in the comparison", not "the same file address". Layered under the diff
		   tint (later in the sheet), so a selected changed byte keeps its red/green and gains the
		   selection's outline. */
		.hb.hxSel, .ha.hxSel { background: var(--vscode-editor-selectionBackground, #264f78); }
		.hb.hxSel.hxo, .ha.hxSel.hxo { box-shadow: inset 0 0 0 1px var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
		.hb.hxSel.hxn, .ha.hxSel.hxn { box-shadow: inset 0 0 0 1px var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
		.hxCopyStatus { opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
		/* The right-click menu: a minimal VS Code-styled popup, since this page has none of the
		   main Git Graph view's bundled menu component. */
		#hexMenu { position: fixed; z-index: 1000; min-width: 170px; background: var(--vscode-menu-background, var(--vscode-editor-background)); color: var(--vscode-menu-foreground, var(--vscode-editor-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,0.35))); border-radius: 4px; padding: 4px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.35); font-size: 12px; }
		.hexMenuItem { padding: 4px 14px; cursor: pointer; white-space: nowrap; }
		.hexMenuItem:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
		.hexMenuItem.disabled { opacity: 0.45; cursor: default; }
		.hexMenuItem.disabled:hover { background: none; }
		.hexMenuSep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border, rgba(128,128,128,0.35))); }
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
	for (let i = 0; i < 256; i++) HEXDIGITS.push(((i < 16 ? '0' : '') + i.toString(16)).toUpperCase());
	const HEXDIFF_TPL = '${t('compareHexDiffStatus', '{0}', '{1}')}';
	const IMGSTATS_TPL = '${t('compareImageStatsTpl', '{0}', '{1}', '{2}', '{3}', '{4}', '{5}')}';
	const HEXCOPY_DONE_TPL = '${t('compareHexCopyDone', '{0}')}';
	const HEXCOPY_TOOLARGE_TPL = '${t('compareHexCopyTooLarge', '{0}')}';
	const HEX_OLD_LABEL = '${t('compareImageCaptionOld')}';
	const HEX_NEW_LABEL = '${t('compareImageCaptionNew')}';
	/* The largest selection Copy reads at once, in cells (one cell is one byte on one side): a
	   clipboard payload, not a file dump - past this, Copy is refused with a reminder rather than
	   fetching an unbounded number of rows one request at a time. */
	const HEX_COPY_LIMIT = 10 * 1024 * 1024;
	function bcEscapeHtml(str) {
		return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	let hexActive = false, hexIndex = -1, hexTotalRows = 0, hexSameSize = false, hexLayoutVersion = 0, hexBytesPerRow = 16;
	let hexSections = null, hexDiffs = [], hexDiffPos = -1;
	/* Offsets are hex, eight digits at the floor (the classic 4 GiB column) so the column never
	   shifts while a file is viewed, one digit more for every 16x past 4 GiB: hexOffDigits is
	   that count for the larger side (the floor until the sizes arrive). */
	const HEX_OFFSET_DIGITS = 8;
	let hexOffDigits = HEX_OFFSET_DIGITS;
	let currentFileIsImage = false;
	const hexRows = new Map();
	let hexPending = false, hexEls = null, hexScrollQueued = false;
	/* ---------- Selection & copy ---------- */
	/* A selection is a span of grid position, not file address: [hexSelAnchor, hexSelHead] as
	   linear indices row*hexBytesPerRow+col, painted the same on both sides (see hexCellSelected) -
	   the position a drag picks, not the bytes there, since the two sides can differ at it. -1
	   means "not placed yet"; both invalidated whenever the row width changes (refreshHexLayout,
	   enterHexView), since the linear index's meaning depends on it. */
	let hexSelAnchor = -1, hexSelHead = -1;
	/* The side ('o'/'n') and pane ('hex'/'ascii') a drag or click started in - a plain Copy reads
	   that side, and 'smart' format follows that pane the way the hex viewer's own Copy does. The
	   right-click menu overrides both with wherever it landed. */
	let hexSelSide = 'o', hexSelPane = 'hex';
	let hexDragging = false;
	/* The absolute row index of hexEls.view's first child - renderHexViewport keeps it current -
	   so a delegated event on a cell can recover that cell's row from its position in the DOM
	   without the row's own address (which a differing side may not have). */
	let hexViewFirstRow = 0;
	/* Pending getHexRows fetches made for a copy (as opposed to the viewport's own, independent
	   one): each resolves true once every row it asked for is cached, false on a reply that
	   reported an error or an intervening layout change. */
	let hexCopyWaiters = [];
	let hexMenuEl = null;
	let hexCopyStatusTimer = null;
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

	/* The offset digits a file of the given size needs: the eight-digit floor, or the digit count
	   of its last offset when that is longer. */
	function hexOffsetDigitsFor(size) {
		return Math.max(HEX_OFFSET_DIGITS, Math.max(0, size - 1).toString(16).length);
	}

	function hexOffsetText(offset) {
		let text = offset.toString(16).toUpperCase();
		while (text.length < hexOffDigits) text = '0' + text;
		return text;
	}

	/* The offset column's width in ch: the padded offset plus the 1ch it keeps clear of its rule
	   and 1ch of breathing room before the first byte. */
	function hexOffCh() {
		return hexOffDigits + 2;
	}

	/* Bytes are grouped for the eye - eights at 16 per row, fours below - with an extra ch of
	   space opening each group after the first. */
	function hexGroupSize(bytesPerRow) {
		return bytesPerRow >= 16 && bytesPerRow % 8 === 0 ? 8 : 4;
	}

	/* The width of one side in character cells: offset | one 3ch cell per byte plus a
	   dedicated 1ch gap track opening each group | a 3ch gutter | one 1ch cell per ASCII
	   character. */
	function hexSideCh(bytesPerRow) {
		return hexOffCh() + 3 * bytesPerRow + (bytesPerRow / hexGroupSize(bytesPerRow) - 1) + 3 + bytesPerRow;
	}

	/* The grid template every row and the ruler share, so the ruler's digits sit exactly over
	   their byte columns however wide the font is. The group gap is its own 1ch track, not
	   extra width folded into the group's first byte column - a widened byte column would
	   center its digit in the middle of that width, splitting the gap into two smaller,
	   unevenly-sized ones straddling the byte instead of one gap between the groups. */
	function hexColsTemplate(bytesPerRow) {
		const group = hexGroupSize(bytesPerRow);
		const widths = [hexOffCh() + 'ch'];
		for (let i = 0; i < bytesPerRow; i++) {
			if (i % group === 0 && i > 0) widths.push('1ch');
			widths.push('3ch');
		}
		widths.push('3ch');
		for (let i = 0; i < bytesPerRow; i++) widths.push('1ch');
		return widths.join(' ');
	}

	/* Each side of the row is padded 12px, like the hex viewer's rows. */
	const HEX_SIDE_PAD = 12;

	/* The hex view fits the window: both sides at 16 bytes per row need 2 * hexSideCh(16)
	   character cells plus the sides' padding, so narrower windows step down to 12/8/4 bytes
	   per row. The probe measures the rows' own font, so a font change re-picks correctly. */
	function pickHexBytesPerRow() {
		const probe = document.createElement('span');
		probe.style.visibility = 'hidden';
		probe.style.position = 'absolute';
		probe.style.whiteSpace = 'pre';
		probe.style.fontFamily = 'var(--vscode-editor-font-family, Consolas, monospace)';
		probe.style.fontSize = 'var(--vscode-editor-font-size, 13px)';
		probe.textContent = '0000000000000000000000000000';
		document.body.appendChild(probe);
		const charWidth = probe.getBoundingClientRect().width / 28;
		document.body.removeChild(probe);
		const available = diffArea.clientWidth - 20 - 4 * HEX_SIDE_PAD;
		const candidates = [16, 12, 8, 4];
		for (let i = 0; i < candidates.length; i++) {
			if (2 * hexSideCh(candidates[i]) * charWidth <= available) return candidates[i];
		}
		return 4;
	}

	function applyHexBytesPerRow() {
		if (hexEls === null) return;
		hexEls.wrap.style.setProperty('--hcols', hexColsTemplate(hexBytesPerRow));
		hexEls.ruler.innerHTML = hexRulerHtml();
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
		// The row width is changing: hexSelAnchor/hexSelHead are linear indices over the OLD
		// width, meaningless (and liable to point at the wrong bytes) under the new one.
		hexClearSelection();
		hexCancelCopyWaiters();
		updateHexNav();
		vscode.postMessage({ command: 'getHexInfo', index: hexIndex, bytesPerRow: hexBytesPerRow });
	}

	/* ---------- Selection & copy ---------- */

	function hexHasSelection() {
		return hexSelAnchor >= 0 && hexSelHead >= 0 && hexSelAnchor !== hexSelHead;
	}

	function hexSelStart() {
		return Math.min(hexSelAnchor, hexSelHead);
	}

	function hexSelEnd() {
		return Math.max(hexSelAnchor, hexSelHead);
	}

	/* Whether grid position (rowIndex, col) - not a file address - falls in the selection.
	   rowIndex < 0 stands for "no real row" (the probe row hexRowHtml is measured with), which
	   never selects. */
	function hexCellSelected(rowIndex, col) {
		if (rowIndex < 0 || !hexHasSelection()) return false;
		const idx = rowIndex * hexBytesPerRow + col;
		return idx >= hexSelStart() && idx <= hexSelEnd();
	}

	function hexClearSelection() {
		hexSelAnchor = -1;
		hexSelHead = -1;
		hexDragging = false;
	}

	/* The byte a hex or ASCII cell under a delegated event stands for: its row (recovered from
	   its position among hexEls.view's children, kept in lockstep by hexViewFirstRow - the row
	   itself carries no address a differing side can be trusted to have), its column (its
	   position among its own side's .hb or .ha cells - the .hbg gap spacers carry a different
	   class, so they do not throw the count off), and which side and pane it belongs to. NULL
	   anywhere else in the view (the offset cell, the gutter, a still-loading placeholder row). */
	function hexCellAt(target) {
		if (target === null || target === undefined || typeof target.closest !== 'function') return null;
		const cell = target.closest('.hb, .ha');
		if (cell === null || hexEls === null) return null;
		const sideEl = cell.closest('.hside');
		const rowEl = cell.closest('.hrow');
		if (sideEl === null || rowEl === null) return null;
		const rowPos = Array.prototype.indexOf.call(hexEls.view.children, rowEl);
		if (rowPos < 0) return null;
		const pane = cell.classList.contains('ha') ? 'ascii' : 'hex';
		const cells = sideEl.querySelectorAll(pane === 'ascii' ? '.ha' : '.hb');
		const col = Array.prototype.indexOf.call(cells, cell);
		if (col < 0) return null;
		const side = rowEl.children[0] === sideEl ? 'o' : 'n';
		return { row: hexViewFirstRow + rowPos, col: col, side: side, pane: pane };
	}

	function hexCellIndex(row, col) {
		return row * hexBytesPerRow + col;
	}

	function hexOnMouseDown(event) {
		if (event.button !== 0) return;
		const cell = hexCellAt(event.target);
		if (cell === null) return;
		// The cells carry the selection model; the browser's own text selection has no business
		// over them (user-select: none on .hside already discourages it, this stops it outright).
		event.preventDefault();
		hexDragging = true;
		const idx = hexCellIndex(cell.row, cell.col);
		if (event.shiftKey && hexSelAnchor >= 0) {
			hexSelHead = idx;
			hexSelSide = cell.side;
			hexSelPane = cell.pane;
			renderHexViewport();
			return;
		}
		hexSelAnchor = idx;
		hexSelHead = idx;
		hexSelSide = cell.side;
		hexSelPane = cell.pane;
		renderHexViewport();
	}

	function hexOnMouseMove(event) {
		if (!hexDragging) return;
		const cell = hexCellAt(event.target);
		if (cell === null) return;
		const idx = hexCellIndex(cell.row, cell.col);
		if (idx === hexSelHead) return;
		hexSelHead = idx;
		renderHexViewport();
	}

	function hexOnMouseUp() {
		hexDragging = false;
	}
	window.addEventListener('mouseup', hexOnMouseUp);

	/* ---------- The right-click menu ---------- */
	/* Nothing in this page's own bundle draws a menu (the main Git Graph view's is a separate,
	   much larger script this lightweight page does not include), so this is a minimal
	   VS Code-styled popup built by hand: a fixed-position list, closed by clicking away, an
	   Escape, or picking an item. */

	function hexCloseMenu() {
		if (hexMenuEl !== null) {
			hexMenuEl.remove();
			hexMenuEl = null;
		}
	}

	/* items: entries of { label, disabled, run } and the literal string 'sep' for a divider. */
	function hexShowMenu(x, y, items) {
		hexCloseMenu();
		const menu = document.createElement('div');
		menu.id = 'hexMenu';
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item === 'sep') {
				const sep = document.createElement('div');
				sep.className = 'hexMenuSep';
				menu.appendChild(sep);
				continue;
			}
			const row = document.createElement('div');
			row.className = 'hexMenuItem' + (item.disabled ? ' disabled' : '');
			row.textContent = item.label;
			if (!item.disabled) {
				row.addEventListener('click', function (clickEvent) {
					clickEvent.stopPropagation();
					hexCloseMenu();
					item.run();
				});
			}
			menu.appendChild(row);
		}
		document.body.appendChild(menu);
		const rect = menu.getBoundingClientRect();
		const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
		const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
		menu.style.left = left + 'px';
		menu.style.top = top + 'px';
		hexMenuEl = menu;
	}

	document.addEventListener('mousedown', function (event) {
		if (hexMenuEl !== null && (event.target === null || typeof event.target.closest !== 'function' || event.target.closest('#hexMenu') === null)) {
			hexCloseMenu();
		}
	});
	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape' && hexMenuEl !== null) hexCloseMenu();
	});

	function hexOnContextMenu(event) {
		event.preventDefault();
		hexDragging = false;
		const cell = hexCellAt(event.target);
		const selected = hexHasSelection();
		const side = cell !== null ? cell.side : hexSelSide;
		const pane = cell !== null ? cell.pane : hexSelPane;
		const sideLabel = side === 'o' ? HEX_OLD_LABEL : HEX_NEW_LABEL;
		const copyItem = function (label, format) {
			return { label: label + ' \\u2014 ' + sideLabel, disabled: !selected, run: function () { void hexCopySelection(format, side, pane); } };
		};
		hexShowMenu(event.clientX, event.clientY, [
			copyItem('${t('compareHexMenuCopy')}', 'smart'),
			copyItem('${t('compareHexMenuCopyHex')}', 'hex'),
			copyItem('${t('compareHexMenuCopyText')}', 'text'),
			copyItem('${t('compareHexMenuCopyC')}', 'c'),
			copyItem('${t('compareHexMenuCopyBase64')}', 'base64'),
			{ label: '${t('compareHexMenuCopyAddress')}', disabled: !selected && cell === null, run: function () { hexCopyAddress(cell); } },
			'sep',
			{ label: '${t('compareHexMenuClearSelection')}', disabled: !selected, run: function () { hexClearSelection(); renderHexViewport(); } }
		]);
	}

	/* ---------- Copy ---------- */

	function hexSetCopyStatus(text) {
		if (hexEls === null || hexEls.copyStatus === undefined || hexEls.copyStatus === null) return;
		hexEls.copyStatus.textContent = text;
		if (hexCopyStatusTimer !== null) clearTimeout(hexCopyStatusTimer);
		const forEls = hexEls;
		hexCopyStatusTimer = setTimeout(function () {
			if (forEls.copyStatus !== null && forEls.copyStatus !== undefined) forEls.copyStatus.textContent = '';
		}, 4000);
	}

	/* Settles every pending copy fetch that asked for rows starting at "start" (the viewport's
	   own request can share that start, so a reply is only ever a PARTIAL cover of what a waiter
	   asked for) - "ok" false settles the waiter failed outright (an erroring reply, or one that
	   belongs to a page or layout the waiter is no longer part of); a successful reply settles
	   the waiter only once every row it asked for is actually in hexRows, and leaves it pending
	   otherwise, for the copy's own complete reply to finish. */
	function hexResolveCopyWaiters(start, ok) {
		for (let i = hexCopyWaiters.length - 1; i >= 0; i--) {
			const waiter = hexCopyWaiters[i];
			if (waiter.first !== start) continue;
			if (!ok || waiter.layoutVersion !== hexLayoutVersion) {
				hexCopyWaiters.splice(i, 1);
				waiter.resolve(false);
				continue;
			}
			let complete = true;
			for (let row = waiter.first; row <= waiter.last; row++) {
				if (!hexRows.has(row)) { complete = false; break; }
			}
			if (complete) {
				hexCopyWaiters.splice(i, 1);
				waiter.resolve(true);
			}
		}
	}

	/* Settle every pending copy fetch as failed: a row-width change or a re-entry gives the
	   waiters' row indices a new meaning, so whatever reply arrives next answers a question
	   nobody asked any more. Resolving (rather than dropping) matters because
	   hexEnsureRowsCached is still awaiting each waiter. */
	function hexCancelCopyWaiters() {
		for (let i = 0; i < hexCopyWaiters.length; i++) hexCopyWaiters[i].resolve(false);
		hexCopyWaiters = [];
	}

	/* Makes sure rows [first, last] are in hexRows, fetching whatever is missing in batches (the
	   host caps a single getHexRows at 512 rows) - the viewport's own request (hexPending) is
	   independent and may be in flight at the same time; the two never collide because each
	   waiter is only resolved by the one reply whose start matches what it asked for. */
	async function hexEnsureRowsCached(first, last) {
		for (let row = first; row <= last;) {
			if (hexRows.has(row)) { row++; continue; }
			const end = Math.min(last, row + 511);
			const layoutVersion = hexLayoutVersion;
			const ok = await new Promise(function (resolve) {
				hexCopyWaiters.push({ first: row, last: end, layoutVersion: layoutVersion, resolve: resolve });
				vscode.postMessage({ command: 'getHexRows', index: hexIndex, start: row, count: end - row + 1 });
			});
			if (!ok) return false;
			row = end + 1;
		}
		return true;
	}

	/* One side's bytes over grid positions [cellStart, cellEnd] (inclusive, linear row*width+col
	   indices) - only the positions that side actually has a byte at; a position past a short
	   row, or a row with nothing cached, contributes nothing (NULL: the row was never fetched -
	   the caller is expected to have awaited hexEnsureRowsCached first). */
	function hexReadSideBytes(side, rowFirst, rowLast, cellStart, cellEnd) {
		const out = [];
		for (let row = rowFirst; row <= rowLast; row++) {
			const cached = hexRows.get(row);
			if (cached === undefined) return null;
			const b64 = side === 'o' ? cached.ob : cached.nb;
			const bytes = b64 === '' ? '' : atob(b64);
			const rowBase = row * hexBytesPerRow;
			const colFrom = Math.max(0, cellStart - rowBase);
			const colTo = Math.min(hexBytesPerRow - 1, cellEnd - rowBase);
			for (let col = colFrom; col <= colTo; col++) {
				if (col < bytes.length) out.push(bytes.charCodeAt(col) & 0xff);
			}
		}
		return out;
	}

	function hexBytesToLatin1(bytes) {
		let text = '';
		for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
		return text;
	}

	function hexFormatBytes(bytes, format, pane) {
		if (format === 'base64') return btoa(hexBytesToLatin1(bytes));
		if (format === 'c') return bytes.map(function (b) { return '0x' + HEXDIGITS[b]; }).join(', ');
		if (format === 'text' || (format === 'smart' && pane === 'ascii')) return hexBytesToLatin1(bytes);
		return bytes.map(function (b) { return HEXDIGITS[b]; }).join('');
	}

	/* Copies the selection in one of the hex viewer's own formats, reading side's file over the
	   selected grid span - 'smart' honours pane: hex bytes from the hex pane, raw text from the
	   ASCII pane, the way the standalone hex editor's Copy does. */
	async function hexCopySelection(format, side, pane) {
		if (!hexHasSelection()) return;
		const start = hexSelStart(), end = hexSelEnd();
		if (end - start + 1 > HEX_COPY_LIMIT) {
			hexSetCopyStatus(HEXCOPY_TOOLARGE_TPL.replace('{0}', (end - start + 1).toLocaleString()));
			return;
		}
		const rowFirst = Math.floor(start / hexBytesPerRow), rowLast = Math.floor(end / hexBytesPerRow);
		const ok = await hexEnsureRowsCached(rowFirst, rowLast);
		// The page may have left the hex view, the selection may have been cleared, or the layout
		// may have changed, while the fetch was in flight.
		if (!hexActive || !hexHasSelection() || hexSelStart() !== start || hexSelEnd() !== end) return;
		if (!ok) {
			hexSetCopyStatus('${t('compareHexCopyReadFailed')}');
			return;
		}
		const bytes = hexReadSideBytes(side, rowFirst, rowLast, start, end);
		if (bytes === null) {
			hexSetCopyStatus('${t('compareHexCopyReadFailed')}');
			return;
		}
		const text = hexFormatBytes(bytes, format, pane);
		vscode.postMessage({ command: 'copyToClipboard', type: 'Hex Bytes', data: text });
		hexSetCopyStatus(HEXCOPY_DONE_TPL.replace('{0}', side === 'o' ? HEX_OLD_LABEL : HEX_NEW_LABEL));
	}

	/* The real address behind grid position (row, col) on one side - NULL when that side has no
	   byte there (a short row, or a row not yet cached). */
	function hexAddressAt(row, col, side) {
		const cached = hexRows.get(row);
		if (cached === undefined) return null;
		const offset = side === 'o' ? cached.o : cached.n;
		if (offset < 0) return null;
		const b64 = side === 'o' ? cached.ob : cached.nb;
		const length = b64 === '' ? 0 : atob(b64).length;
		if (col >= length) return null;
		return hexOffsetText(offset + col);
	}

	/* Copies the address(es) behind the right-click: with a selection, both sides' real start-end
	   spans for that grid span (which can genuinely differ - a diff aligns by position, not
	   address); over a lone byte with nothing selected, that byte's own side's address. Every row
	   involved is one the user has already clicked or dragged over, so it is already cached -
	   no fetch is needed here the way Copy's selection body needs one. */
	function hexCopyAddress(cell) {
		let text = null;
		if (hexHasSelection()) {
			const start = hexSelStart(), end = hexSelEnd();
			const rowFirst = Math.floor(start / hexBytesPerRow), colFirst = start - rowFirst * hexBytesPerRow;
			const rowLast = Math.floor(end / hexBytesPerRow), colLast = end - rowLast * hexBytesPerRow;
			const oldFrom = hexAddressAt(rowFirst, colFirst, 'o'), oldTo = hexAddressAt(rowLast, colLast, 'o');
			const newFrom = hexAddressAt(rowFirst, colFirst, 'n'), newTo = hexAddressAt(rowLast, colLast, 'n');
			const oldText = oldFrom !== null && oldTo !== null ? oldFrom + '-' + oldTo : '\\u2014';
			const newText = newFrom !== null && newTo !== null ? newFrom + '-' + newTo : '\\u2014';
			text = HEX_OLD_LABEL + ' ' + oldText + '   ' + HEX_NEW_LABEL + ' ' + newText;
		} else if (cell !== null) {
			const address = hexAddressAt(cell.row, cell.col, cell.side);
			// A bare address is ambiguous in a comparison - the same position can hold different
			// addresses on the two sides - so the lone byte names its side too, the way the
			// selection path names both.
			if (address !== null) text = (cell.side === 'o' ? HEX_OLD_LABEL : HEX_NEW_LABEL) + ' ' + address;
		}
		if (text === null) return;
		vscode.postMessage({ command: 'copyToClipboard', type: 'Address', data: text });
		hexSetCopyStatus('${t('compareHexCopyDoneAddress')}');
	}

	/* The ASCII pane's glyph for a byte: printable ASCII and Latin-1 as themselves, a 0x00 as a
	   blank so zero-filled regions read as empty space, and other control bytes as a dot. */
	function hexAsciiChar(byte) {
		if (byte === 0) return ' ';
		if (byte === 38) return '&amp;';
		if (byte === 60) return '&lt;';
		if (byte === 62) return '&gt;';
		return (byte >= 32 && byte < 127) || byte >= 160 ? String.fromCharCode(byte) : '\\u00B7';
	}

	/* One side of a row: the offset cell, a cell per byte (blank past a short tail so the grid
	   keeps its tracks), the gutter, and a cell per ASCII character. A side without a row on
	   this line - the other file runs longer here - keeps its cells empty. rowIndex (-1 when
	   omitted) is the row's absolute grid position, purely for hexCellSelected - it plays no
	   part in which bytes are shown. */
	function hexSideHtml(offset, b64, mask, side, rowIndex) {
		const bytes = offset < 0 || b64 === '' ? '' : atob(b64);
		const group = hexGroupSize(hexBytesPerRow);
		let hex = '', ascii = '';
		for (let i = 0; i < hexBytesPerRow; i++) {
			if (i % group === 0 && i > 0) hex += '<span class="hbg"></span>';
			const sel = hexCellSelected(rowIndex, i) ? ' hxSel' : '';
			if (i >= bytes.length) {
				hex += '<span class="hb' + sel + '"></span>';
				ascii += '<span class="ha' + sel + '"></span>';
				continue;
			}
			const byte = bytes.charCodeAt(i) & 0xff;
			const changed = mask.charAt(i) === '1' ? ' hx' + side : '';
			hex += '<span class="hb' + changed + sel + '">' + HEXDIGITS[byte] + '</span>';
			ascii += '<span class="ha' + changed + sel + '">' + hexAsciiChar(byte) + '</span>';
		}
		return '<div class="hside"><span class="hoff">' + (bytes === '' ? '' : hexOffsetText(offset)) + '</span>' + hex + '<span class="hg"></span>' + ascii + '</div>';
	}

	function hexRowHtml(row, odd, rowIndex) {
		if (rowIndex === undefined) rowIndex = -1;
		return '<div class="hrow' + (odd ? ' hxOdd' : '') + '">' + hexSideHtml(row.o, row.ob, row.om, 'o', rowIndex) + hexSideHtml(row.n, row.nb, row.nm, 'n', rowIndex) + '</div>';
	}

	/* The column ruler: a blank offset cell, one hex digit over each byte column (0..F), and
	   the same digits again over the ASCII pane, on both sides. */
	function hexRulerHtml() {
		const group = hexGroupSize(hexBytesPerRow);
		let hex = '', ascii = '';
		for (let i = 0; i < hexBytesPerRow; i++) {
			if (i % group === 0 && i > 0) hex += '<span class="hbg"></span>';
			const digit = (i % 16).toString(16).toUpperCase();
			hex += '<span class="hb">' + digit + '</span>';
			ascii += '<span class="ha">' + digit + '</span>';
		}
		const side = '<div class="hside"><span class="hoff"></span>' + hex + '<span class="hg"></span>' + ascii + '</div>';
		return side + side;
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
		hexOffDigits = HEX_OFFSET_DIGITS; // the sizes are not known yet: the floor until hexInfo answers
		hexBytesPerRow = pickHexBytesPerRow();
		hexClearSelection();
		hexCancelCopyWaiters();
		hexViewFirstRow = 0;
		hexCloseMenu();
		stopImageBlink();
		imgActive = false;
		imgEls = null;
		imgDiff = null;
		diffArea.className = 'hexMode';
		diffArea.innerHTML =
			'<div id="hexWrap">' +
				'<div id="hexToolbar">' +
					'<span id="hexCopyStatus" class="hxCopyStatus"></span>' +
					'<span class="hxSpacer"></span>' +
					(currentFileIsImage ? '<button id="hexImageBtn">${t('compareImageToggleButton')}</button>' : '') +
					'<button id="hexPrevBtn" title="${t('compareHexPrevDiff')}">&#9650;</button>' +
					'<span id="hexDiffStatus">${t('compareHexAnalysing')}</span>' +
					'<button id="hexNextBtn" title="${t('compareHexNextDiff')}">&#9660;</button>' +
				'</div>' +
				'<div id="hexScroller"><div id="hexInner">' +
					'<div id="hexHead">' +
						'<div id="hexCaps">' +
							'<div class="hcap"><span>${t('compareImageCaptionOld')}</span><span class="hxSize" id="hexOldSize"></span></div>' +
							'<div class="hcap"><span>${t('compareImageCaptionNew')}</span><span class="hxSize" id="hexNewSize"></span></div>' +
						'</div>' +
						'<div id="hexRuler" class="hrow">' + hexRulerHtml() + '</div>' +
					'</div>' +
					'<div id="hexSpacer"><div id="hexView"></div></div>' +
				'</div></div>' +
			'</div>';
		hexEls = {
			wrap: document.getElementById('hexWrap'),
			ruler: document.getElementById('hexRuler'),
			scroller: document.getElementById('hexScroller'),
			spacer: document.getElementById('hexSpacer'),
			view: document.getElementById('hexView'),
			oldSize: document.getElementById('hexOldSize'),
			newSize: document.getElementById('hexNewSize'),
			status: document.getElementById('hexDiffStatus'),
			copyStatus: document.getElementById('hexCopyStatus'),
			prev: document.getElementById('hexPrevBtn'),
			next: document.getElementById('hexNextBtn')
		};
		applyHexBytesPerRow();
		hexEls.scroller.addEventListener('scroll', queueHexRender);
		hexEls.prev.addEventListener('click', function () { hexNavigate(-1); });
		hexEls.next.addEventListener('click', function () { hexNavigate(1); });
		// Delegated on the view's own stable element - its innerHTML is rebuilt on every render,
		// but the element itself survives, so one listener here outlives every row it ever holds.
		hexEls.view.addEventListener('mousedown', hexOnMouseDown);
		hexEls.view.addEventListener('mousemove', hexOnMouseMove);
		hexEls.view.addEventListener('contextmenu', hexOnContextMenu);
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
		// hexOnMouseDown/hexOnMouseMove recover a cell's row from its position among these
		// children (renderHexViewport always rebuilds first..last with none skipped), so this
		// must stay in lockstep with what is actually drawn below.
		hexViewFirstRow = first;
		let html = '', needStart = -1, needEnd = -1;
		for (let row = first; row <= last; row++) {
			const cached = hexRows.get(row);
			if (cached === undefined) {
				if (needStart < 0) needStart = row;
				needEnd = row;
				html += '<div class="hrow' + (row % 2 ? ' hxOdd' : '') + '"></div>';
			} else {
				html += hexRowHtml(cached, row % 2 === 1, row);
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
		// A copy still fetching rows for the hex view has nothing to land in any more; settling
		// it here also covers a page that is disposed before the reply arrives at all.
		hexCancelCopyWaiters();
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
			// Size the offset column by the largest offset either side will show: the eight-digit
			// floor, growing past 4 GiB. A wider column can push the row layout down a step, which
			// must be re-picked — the refresh re-requests everything, so this reply is not applied
			// any further.
			const digits = hexOffsetDigitsFor(Math.max(msg.oldSize, msg.newSize));
			if (digits !== hexOffDigits) {
				hexOffDigits = digits;
				if (pickHexBytesPerRow() !== hexBytesPerRow && hexEls !== null) {
					refreshHexLayout();
					return true;
				}
				applyHexBytesPerRow(); // same row width: only the offset column widens
			}
			if (typeof msg.bytesPerRow === 'number' && msg.bytesPerRow !== hexBytesPerRow) {
				hexBytesPerRow = msg.bytesPerRow;
				applyHexBytesPerRow();
			}
			if (hexEls !== null) {
				hexEls.oldSize.textContent = hexBytesLabel(msg.oldSize);
				hexEls.newSize.textContent = hexBytesLabel(msg.newSize);
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
			if (!hexActive || msg.index !== hexIndex) {
				// The page moved on (or this pane's index isn't the active one): a copy fetch may
				// still be waiting on this exact reply, so it must not be left hanging forever.
				hexResolveCopyWaiters(msg.start, false);
				return true;
			}
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
			hexResolveCopyWaiters(msg.start, msg.error === null);
			renderHexViewport();
			return true;
		}
		if (msg.command === 'copyToClipboard') {
			// The write itself already happened optimistically (hexCopySelection/hexCopyAddress set
			// the status right after posting); only a genuine failure needs to override it, with the
			// host's own already-localised reason.
			if (msg.error !== null) hexSetCopyStatus(msg.error);
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
