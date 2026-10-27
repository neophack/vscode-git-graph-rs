// @vitest-environment jsdom
/**
 * The hex comparison frontend (the grid, the offset column, the row-width picking, the selection &
 * copy surface and the right-click menu), imported as the modules the page runs: these cases
 * drive HexView and the pure builders of hexGrid directly, in a jsdom laid
 * out at 7px per character - the probe the view measures with reads in the same terms the
 * assertions reason in.
 */

import { describe, expect, it } from 'vitest';

import { formatBytes } from './hexCopy';
import { hexAsciiChar, hexColsTemplate, hexRulerHtml } from './hexGrid';
import { HexView } from './hexView';
import { compareStrings, compareMarkup, format } from './strings';

/** The byte mask and row helpers the assertions reason in. */
const b64 = (bytes: ReadonlyArray<number>) => window.btoa(String.fromCharCode(...bytes));

/** A page-like environment: the stub root laid out at the given width, and the posted requests. */
function makeHexView(width: number) {
	// The jsdom document is shared by every test of this file: start each one from a clean body,
	// so no element or timer of a previous view is still around.
	document.body.textContent = '';
	const root = document.createElement('div');
	Object.defineProperty(root, 'clientWidth', { get: () => width });
	const sent: Array<{ command: string, index?: number, bytesPerRow?: number, start?: number, count?: number, type?: string, data?: string }> = [];
	const view = new HexView({
		root: root,
		send: (message) => { sent.push(JSON.parse(JSON.stringify(message))); },
		onError: (text) => { throw new Error('unexpected load error: ' + text); },
		hasImageView: () => false,
		switchToImage: () => { throw new Error('no picture view in this harness'); }
	});
	document.body.appendChild(root);
	window.Element.prototype.getBoundingClientRect = function () {
		const text = this.textContent || '';
		return { top: 0, right: text.length * 7, bottom: 14, left: 0, width: text.length * 7, height: 14, x: 0, y: 0, toJSON() { return this; } } as DOMRect;
	};
	return { view: view, sent: sent, root: root };
}

const postedCommands = (h: ReturnType<typeof makeHexView>, command: string) => h.sent.filter((message) => message.command === command);
const copyStatus = () => document.getElementById('hexCopyStatus')!.textContent;

describe('the hex rows draw the hex viewer\'s grid', () => {
	const count = (html: string, needle: string) => html.split(needle).length - 1;

	it('shares one grid template between the ruler and every row: offset | 3ch per byte with a dedicated 1ch gap track opening each group | gutter | 1ch per character', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		expect(h.view.metrics().bytesPerRow).toBe(16);
		// 8 offset digits + 2ch, sixteen 3ch byte cells with a 1ch gap track of its own before
		// the second eight, the 3ch gutter, sixteen 1ch character cells. The gap is a track
		// between the groups, not extra width folded into the group's first byte cell - that
		// would center the byte in the middle of the widened column and split the gap into two
		// smaller, unevenly-sized ones straddling the byte instead of one gap between the groups.
		const byteSection = new Array<string>(16).fill('3ch');
		byteSection.splice(8, 0, '1ch');
		const expected = ['10ch'].concat(byteSection, ['3ch'], new Array<string>(16).fill('1ch')).join(' ');
		expect(h.view.metrics().colsTemplate).toBe(expected);
		expect(document.getElementById('hexWrap')!.style.getPropertyValue('--hcols')).toBe(expected);
		// Twelve per row groups in fours: a dedicated gap track at each of the two group
		// openings, on top of the offset, twelve bytes, the gutter and twelve ASCII cells.
		expect(hexColsTemplate(12, 8).split(' ').length).toBe(1 + 12 + 2 + 1 + 12);
	});

	it('draws the ruler as a blank offset cell, a hex digit over every byte column and again over the ASCII pane, on both sides', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		const ruler = hexRulerHtml({ bytesPerRow: h.view.metrics().bytesPerRow, offDigits: 8, isSelected: () => false }).html;
		expect(count(ruler, '<div class="hside">')).toBe(2);
		expect(count(ruler, '<span class="hoff"></span>')).toBe(2);
		expect(count(ruler, '<span class="hb">')).toBe(32);
		expect(count(ruler, '<span class="ha">')).toBe(32);
		expect(count(ruler, '<span class="hg"></span>')).toBe(2);
		// Uppercase digits 0..F, like the offsets and the bytes.
		expect(ruler.includes('<span class="hb">A</span>') && ruler.includes('<span class="ha">F</span>')).toBe(true);
		expect(ruler.includes('Offset') || ruler.includes('ASCII')).toBe(false);
	});

	it('renders a row as one cell per byte and per character, uppercase, tinting a changed byte on its own side', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		const row = {
			o: 16, ob: b64([0x48, 0x69, 0x00, 0x0a, 0xff, 0x3c]), om: '000010',
			n: 16, nb: b64([0x48, 0x69, 0x00, 0x0a, 0xab, 0x3c]), nm: '000010'
		};
		const html = h.view.rowHtmlAt(row, 1).html;
		expect(html.startsWith('<div class="hrow hxOdd">')).toBe(true);
		expect(count(html, '<div class="hside">')).toBe(2);
		expect(count(html, '<span class="hoff">00000010</span>')).toBe(2);
		// Every side keeps its sixteen byte tracks: six bytes drawn, ten blank cells behind them,
		// plus the one dedicated gap track before the second eight (not a widened byte cell).
		expect(count(html, 'class="hbg"')).toBe(2);
		expect(count(html, 'class="hb')).toBe(32 + 2); // 32 byte cells + the two gap spacers
		expect(count(html, 'class="ha')).toBe(32);
		expect(count(html, '<span class="hb"></span>')).toBe(20);
		expect(html.includes('<span class="hb">48</span><span class="hb">69</span>')).toBe(true);
		// The changed byte is tinted red on the old side and green on the new, hex and ASCII alike.
		expect(html.includes('<span class="hb hxo">FF</span>') && html.includes('<span class="ha hxo">')).toBe(true);
		expect(html.includes('<span class="hb hxn">AB</span>') && html.includes('<span class="ha hxn">')).toBe(true);
		expect(html.includes('<b ')).toBe(false);
		// A 0x00 reads as a blank, a control byte as a dot; markup characters are returned raw
		// and escaped when the row renders them (the glyph function feeds the SafeHtml template).
		expect(hexAsciiChar(0)).toBe(' ');
		expect(hexAsciiChar(0x0a)).toBe('\u00B7');
		expect(hexAsciiChar(38)).toBe('&');
		expect(hexAsciiChar(60)).toBe('<');
		expect(hexAsciiChar(0x41)).toBe('A');
		expect(hexAsciiChar(0xe9)).toBe('\u00E9');
		expect(h.view.rowHtmlAt(row, 0).html.includes('<span class="ha">&lt;</span>')).toBe(true);
	});

	it('keeps the tracks of a side the other file runs past, with its offset blank', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		const html = h.view.rowHtmlAt({ o: -1, ob: '', om: '', n: 32, nb: b64([1, 2]), nm: '00' }, 0).html;
		expect(html.startsWith('<div class="hrow">')).toBe(true);
		expect(html.startsWith('<div class="hrow"><div class="hside"><span class="hoff"></span><span class="hb"></span>')).toBe(true);
		expect(html.includes('<span class="hoff">00000020</span><span class="hb">01</span><span class="hb">02</span>')).toBe(true);
	});

	it('names each pane and its byte count in the sticky head once the sizes arrive', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.handle({ command: 'hexInfo', index: 0, error: null, oldSize: 300, newSize: 1200, totalRows: 75, sections: null, layoutVersion: 1, bytesPerRow: 16, rowHeight: 19 });
		expect(document.getElementById('hexOldSize')!.textContent).toBe((300).toLocaleString() + ' B');
		expect(document.getElementById('hexNewSize')!.textContent).toBe((1200).toLocaleString() + ' B');
	});
});

describe('the hex offset column holds eight digits and grows only past 4 GiB', () => {
	it('pads every offset to eight uppercase digits however small the file, so the column never shifts', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		expect(h.view.metrics().offDigits).toBe(8);
		expect(h.view.metrics().offsetCh).toBe(10);
		expect(h.view.metrics().offsetText(16)).toBe('00000010');
		expect(h.view.metrics().offsetText(0xabc)).toBe('00000ABC');

		h.view.handle({ command: 'hexInfo', index: 0, error: null, oldSize: 300, newSize: 300, totalRows: 19, sections: null, layoutVersion: 1, bytesPerRow: 16, rowHeight: 19 });
		// 299 = 0x12B is a 3-digit offset: the column stays at the eight-digit floor regardless.
		expect(h.view.metrics().offDigits).toBe(8);
		expect(h.view.metrics().offsetText(16)).toBe('00000010');
		expect(document.getElementById('hexWrap')!.style.getPropertyValue('--hcols').split(' ')[0]).toBe('10ch');

		// A file past 4 GiB needs 9 digits: the column grows WITH the number.
		h.view.handle({ command: 'hexInfo', index: 0, error: null, oldSize: 0x100000001, newSize: 300, totalRows: 268435457, sections: null, layoutVersion: 2, bytesPerRow: 16, rowHeight: 19 });
		expect(h.view.metrics().offDigits).toBe(9);
		expect(h.view.metrics().offsetCh).toBe(11);
		expect(h.view.metrics().offsetText(16)).toBe('000000010');
		expect(document.getElementById('hexWrap')!.style.getPropertyValue('--hcols').split(' ')[0]).toBe('11ch');
	});

	it('steps the row width down when the window cannot hold both 16-byte sides, and re-picks when the column widens', () => {
		// At 7px per character a 16-byte side is 78ch: both sides need 1092px plus the 48px of
		// side padding and the 20px kept for the scrollbar - 1160px. A 1400px webview holds it;
		// 1100px steps down to 12 bytes per row (63ch a side, 930px all in).
		const wide = makeHexView(1400);
		wide.view.enter(0);
		expect(postedCommands(wide, 'getHexInfo')[0]).toMatchObject({ command: 'getHexInfo', bytesPerRow: 16 });

		const narrow = makeHexView(1100);
		narrow.view.enter(0);
		expect(postedCommands(narrow, 'getHexInfo')[0]).toMatchObject({ bytesPerRow: 12 });

		// 1165px holds 16 a side with the eight-digit column but not the nine-digit one a file
		// past 4 GiB needs: the view re-requests the layout at 12 bytes per row.
		const edge = makeHexView(1165);
		edge.view.enter(0);
		expect(postedCommands(edge, 'getHexInfo')[0]).toMatchObject({ bytesPerRow: 16 });
		edge.view.handle({ command: 'hexInfo', index: 0, error: null, oldSize: 0x100000001, newSize: 300, totalRows: 268435457, sections: null, layoutVersion: 1, bytesPerRow: 16, rowHeight: 19 });
		expect(postedCommands(edge, 'getHexInfo').some((message) => message.bytesPerRow === 12)).toBe(true);
	});
});

describe('the frontend\'s string templates', () => {
	it('carry every placeholder with both braces intact for the client-side substitutions', () => {
		// The pages re-substitute these ({0}/{1} handed back through the format() helper so the
		// diff counter can tick), so the dictionary must carry the complete placeholders.
		const hexDiffTpl = compareStrings.compareHexDiffStatus;
		const imgStatsTpl = compareMarkup('compareImageStatsTpl');
		expect(hexDiffTpl).toBe('Difference {0} of {1}');
		const placeholdersOf = (template: string) => (template.match(/\{\d+\}/g) || []).map((match) => match[0] + match[1] + match[2]);
		expect(placeholdersOf(hexDiffTpl)).toEqual(['{0}', '{1}']);
		expect(placeholdersOf(imgStatsTpl)).toEqual(['{0}', '{1}', '{2}', '{3}', '{4}', '{5}']);
		expect(format(hexDiffTpl, 2, 7)).toBe('Difference 2 of 7');
	});
});

describe('the hex selection paints by grid position', () => {
	const count = (html: string, needle: string) => html.split(needle).length - 1;

	it('paints the selected positions on both sides and both panes, over the diff tint', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.placeSelection(15, 17, 'o', 'hex'); // row 0 col 15 through row 1 col 1
		const row = {
			o: 0, ob: b64(new Array<number>(16).fill(0x41)), om: '0'.repeat(15) + '1',
			n: 0, nb: b64(new Array<number>(16).fill(0x42)), nm: '0'.repeat(15) + '1'
		};
		const html = h.view.rowHtmlAt(row, 0).html;
		// Only position 15 is selected in row 0, and all four panes (old/new hex/ascii) carry it.
		expect(count(html, 'hxSel')).toBe(4);
		// The changed byte keeps its own side's tint and gains the selection on top of it.
		expect(html.includes('<span class="hb hxo hxSel">')).toBe(true);
		expect(html.includes('<span class="hb hxn hxSel">')).toBe(true);
		// Row 1 holds the other two selected positions (cols 0 and 1), on its own paint.
		expect(count(h.view.rowHtmlAt(row, 1).html, 'hxSel')).toBe(8);
	});

	it('paints a short row\'s blank tail as selected too - the selection is positions, not bytes', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.placeSelection(2, 3, 'o', 'hex');
		const row = { o: 0, ob: b64([0x41, 0x42]), om: '00', n: 0, nb: b64([0x41, 0x42]), nm: '00' };
		const html = h.view.rowHtmlAt(row, 0).html;
		expect(html.includes('<span class="hb hxSel"></span>')).toBe(true);
		expect(html.includes('<span class="ha hxSel"></span>')).toBe(true);
	});

	it('treats a single cell as no selection, and holds none until one is placed', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		expect(h.view.hasSelection()).toBe(false);
		// rowIndex < 0 is the probe row the grid is measured with: it never selects.
		h.view.placeSelection(2, 6, 'o', 'hex');
		expect(h.view.cellSelected(-1, 2)).toBe(false);
		expect(h.view.cellSelected(0, 1)).toBe(false);
		expect(h.view.cellSelected(0, 2)).toBe(true);
		expect(h.view.cellSelected(0, 6)).toBe(true);
		expect(h.view.cellSelected(0, 7)).toBe(false);
		h.view.placeSelection(5, 5, 'o', 'hex'); // a plain click: anchor equals head
		expect(h.view.hasSelection()).toBe(false);
		expect(h.view.cellSelected(0, 5)).toBe(false);
		h.view.clearSelection();
		expect(h.view.hasSelection()).toBe(false);
	});
});

describe('the copy formats', () => {
	it('format one side\'s bytes the way the hex viewer\'s own Copy does', () => {
		const bytes = [0x48, 0x69, 0x0a, 0xff];
		expect(formatBytes(bytes, 'hex', 'hex')).toBe('48690AFF');
		expect(formatBytes(bytes, 'text', 'ascii')).toBe('Hi\n\u00FF');
		// 'smart' follows the pane the drag started in: raw text from the ASCII pane.
		expect(formatBytes(bytes, 'smart', 'ascii')).toBe('Hi\n\u00FF');
		expect(formatBytes(bytes, 'smart', 'hex')).toBe('48690AFF');
		expect(formatBytes(bytes, 'c', 'hex')).toBe('0x48, 0x69, 0x0A, 0xFF');
		expect(formatBytes(bytes, 'base64', 'hex')).toBe(b64(bytes));
	});
});

describe('copying the selection', () => {
	const seqRow = (row: number) => ({
		o: row * 16, n: row * 16,
		ob: b64(new Array<number>(16).fill(0).map((_, i) => (row * 16 + i) & 0xff)),
		nb: b64(new Array<number>(16).fill(0).map((_, i) => (row * 16 + i) & 0xff)),
		om: '0'.repeat(16), nm: '0'.repeat(16)
	});
	const replyRows = (h: ReturnType<typeof makeHexView>, start: number, rows: ReadonlyArray<{ o: number, n: number, ob: string, nb: string, om: string, nm: string }>, error: string | null = null) =>
		h.view.handle({ command: 'hexRows', index: 0, start: start, rows: rows as never, layoutVersion: 0, error: error });

	it('copies straight from the cached rows, naming the side it read', async () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		replyRows(h, 0, [{
			o: 0, n: 0, ob: b64([0x41, 0x42, 0x43, 0x44]), nb: b64([0x61, 0x62, 0x63, 0x64]), om: '0000', nm: '0000'
		}]);
		h.view.placeSelection(0, 3, 'o', 'ascii');
		await h.view.copySelection('text', 'o', 'ascii');
		expect(postedCommands(h, 'copyToClipboard')).toEqual([
			{ command: 'copyToClipboard', type: 'Hex Bytes', data: 'ABCD' }
		]);
		expect(copyStatus()).toBe(format(compareStrings.compareHexCopyDone, 'Original'));
		// The other side reads its own bytes over the same positions.
		await h.view.copySelection('hex', 'n', 'hex');
		expect(postedCommands(h, 'copyToClipboard')[1]).toMatchObject({ data: '61626364' });
		expect(copyStatus()).toBe(format(compareStrings.compareHexCopyDone, 'Modified'));
	});

	it('fetches the rows the selection spans before copying, one host-capped batch at a time', async () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.placeSelection(0, 47, 'o', 'hex'); // rows 0..2, none cached yet
		const copying = h.view.copySelection('hex', 'o', 'hex');
		const fetches = postedCommands(h, 'getHexRows');
		expect(fetches.length).toBe(1);
		expect(fetches[0]).toMatchObject({ start: 0, count: 3 });
		expect(postedCommands(h, 'copyToClipboard').length).toBe(0);
		replyRows(h, 0, [seqRow(0), seqRow(1), seqRow(2)]);
		await copying;
		const expected = [seqRow(0), seqRow(1), seqRow(2)].map((row) => window.atob(row.ob)).join('')
			.split('').map((ch) => (ch.charCodeAt(0) & 0xff).toString(16).toUpperCase().padStart(2, '0')).join('');
		expect(postedCommands(h, 'copyToClipboard')).toEqual([
			{ command: 'copyToClipboard', type: 'Hex Bytes', data: expected }
		]);
	});

	it('caps a single fetch at the 512 rows the host serves per getHexRows', async () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.placeSelection(0, 16 * 601 - 1, 'o', 'hex'); // rows 0..600
		const copying = h.view.copySelection('hex', 'o', 'hex');
		const fetches = postedCommands(h, 'getHexRows');
		expect(fetches.length).toBe(1);
		expect(fetches[0]).toMatchObject({ start: 0, count: 512 });
		replyRows(h, 0, [], 'the blob is gone');
		await copying;
		expect(postedCommands(h, 'copyToClipboard').length).toBe(0);
		expect(copyStatus()).toBe(compareStrings.compareHexCopyReadFailed);
	});

	it('keeps a copy waiting when the viewport\'s own reply only partly covers its span', async () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.placeSelection(0, 47, 'o', 'hex'); // one waiter over rows 0..2
		const copying = h.view.copySelection('hex', 'o', 'hex');
		// The viewport's independent request can share the copy's start; its shorter reply must
		// not settle the waiter - rows 1 and 2 are still missing.
		replyRows(h, 0, [seqRow(0)]);
		expect(h.view.waiterCount()).toBe(1);
		expect(postedCommands(h, 'copyToClipboard').length).toBe(0);
		replyRows(h, 0, [seqRow(0), seqRow(1), seqRow(2)]);
		await copying;
		expect(h.view.waiterCount()).toBe(0);
		expect(postedCommands(h, 'copyToClipboard').length).toBe(1);
	});

	it('aborts quietly when the selection moved on while the fetch was in flight', async () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		replyRows(h, 0, [seqRow(0)]);
		h.view.placeSelection(0, 17, 'o', 'hex'); // rows 0..1, row 1 uncached
		const copying = h.view.copySelection('text', 'o', 'ascii');
		replyRows(h, 1, [seqRow(1)]);
		h.view.placeSelection(20, 30, 'o', 'hex'); // the user dragged elsewhere before the reply
		await copying;
		expect(postedCommands(h, 'copyToClipboard').length).toBe(0);
		expect(copyStatus()).toBe('');
	});

	it('settles an in-flight copy when the layout changes under it, instead of leaving it awaiting', async () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		replyRows(h, 0, [seqRow(0)]);
		h.view.placeSelection(0, 17, 'o', 'hex');
		const copying = h.view.copySelection('text', 'o', 'ascii');
		expect(postedCommands(h, 'getHexRows').length).toBe(1);
		// A row-width change re-requests the whole layout: the pending copy's row indices lose
		// their meaning, so it must be settled (failed), never left hanging on a reply that no
		// longer corresponds to anything.
		h.view.refreshLayout();
		await Promise.race([
			copying,
			new Promise((_, reject) => setTimeout(() => reject(new Error('the copy promise never settled')), 1000))
		]);
		expect(h.view.waiterCount()).toBe(0);
		expect(postedCommands(h, 'copyToClipboard').length).toBe(0);
	});

	it('refuses a selection past the copy limit without fetching anything', async () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.placeSelection(0, 10 * 1024 * 1024, 'o', 'hex'); // 10 MiB + 1 cells
		await h.view.copySelection('hex', 'o', 'hex');
		expect(postedCommands(h, 'getHexRows').length).toBe(0);
		expect(postedCommands(h, 'copyToClipboard').length).toBe(0);
		expect(copyStatus()).toBe(format(compareStrings.compareHexCopyTooLarge, (10 * 1024 * 1024 + 1).toLocaleString()));
	});
});

describe('copying addresses', () => {
	const seedRow = (h: ReturnType<typeof makeHexView>) =>
		h.view.handle({
			command: 'hexRows', index: 0, start: 0, layoutVersion: 0, error: null,
			rows: [{ o: 0x10, n: 0x20, ob: b64([1, 2, 3, 4]), nb: b64([5, 6, 7, 8]), om: '0000', nm: '0000' }] as never
		});

	it('copies both sides\' real address spans, which can differ at the same positions', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		seedRow(h);
		h.view.placeSelection(0, 3, 'o', 'hex');
		h.view.copyAddress(null);
		expect(postedCommands(h, 'copyToClipboard')).toEqual([{
			command: 'copyToClipboard', type: 'Address',
			data: 'Original 00000010-00000013   Modified 00000020-00000023'
		}]);
		expect(copyStatus()).toBe(compareStrings.compareHexCopyDoneAddress);
		// The rows a right-click can act on are already on screen, so no fetch is issued.
		expect(postedCommands(h, 'getHexRows').length).toBe(0);
	});

	it('copies the one side\'s address of the byte under the right-click', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		seedRow(h);
		// Nothing is selected: the address is the byte's own, named by its side - a bare address
		// could not say which of the two files it indexes.
		h.view.copyAddress({ row: 0, col: 2, side: 'n', pane: 'hex' });
		expect(postedCommands(h, 'copyToClipboard')).toEqual([
			{ command: 'copyToClipboard', type: 'Address', data: 'Modified 00000022' }
		]);
	});

	it('writes an em dash for a side with nothing at the position, and nothing at all when neither has', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.handle({
			command: 'hexRows', index: 0, start: 0, layoutVersion: 0, error: null,
			rows: [{ o: -1, n: 0x20, ob: '', nb: b64([5, 6, 7, 8]), om: '', nm: '0000' }] as never
		});
		h.view.placeSelection(0, 3, 'o', 'hex');
		h.view.copyAddress(null);
		expect(postedCommands(h, 'copyToClipboard')[0]).toMatchObject({ data: 'Original \u2014   Modified 00000020-00000023' });
		// With nothing selected, the byte under the right-click speaks for itself: a byte neither
		// side has (the old side is absent here) copies nothing and says nothing.
		h.view.clearSelection();
		h.view.copyAddress({ row: 0, col: 2, side: 'o', pane: 'hex' });
		expect(postedCommands(h, 'copyToClipboard').length).toBe(1);
		expect(copyStatus()).toBe(compareStrings.compareHexCopyDoneAddress); // unchanged by the no-op
	});
});

describe('the right-click menu', () => {
	const openMenu = () => {
		const view = document.getElementById('hexView')!;
		view.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
	};
	const menuItems = () => Array.from(document.getElementById('hexMenu')!.children);

	it('offers the copy formats for the side it lands on, disabled until a selection exists', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		openMenu();
		const items = menuItems();
		expect(items.length).toBe(8); // five copies, the address, a separator, clear selection
		expect(items[6].className).toBe('hexMenuSep');
		const expected = [
			compareStrings.compareHexMenuCopy, compareStrings.compareHexMenuCopyHex, compareStrings.compareHexMenuCopyText,
			compareStrings.compareHexMenuCopyC, compareStrings.compareHexMenuCopyBase64
		];
		for (let i = 0; i < 5; i++) {
			// The side suffix tells the user WHICH file a plain Copy would read.
			expect(items[i].textContent).toBe(expected[i] + ' \u2014 Original');
			expect(items[i].className).toBe('hexMenuItem disabled');
		}
		expect(items[5].textContent).toBe(compareStrings.compareHexMenuCopyAddress);
		expect(items[5].className).toBe('hexMenuItem disabled'); // no selection and no byte under the click
		expect(items[7].textContent).toBe(compareStrings.compareHexMenuClearSelection);
		expect(items[7].className).toBe('hexMenuItem disabled');
	});

	it('enables everything over a selection, naming the side that selection was made in', () => {
		const h = makeHexView(1400);
		h.view.enter(0);
		h.view.placeSelection(0, 3, 'n', 'ascii');
		openMenu();
		const items = menuItems();
		for (let i = 0; i < 5; i++) {
			expect(items[i].textContent!.endsWith(' \u2014 Modified')).toBe(true);
			expect(items[i].className).toBe('hexMenuItem');
		}
		expect(items[5].className).toBe('hexMenuItem');
		expect(items[7].className).toBe('hexMenuItem');
	});
});
