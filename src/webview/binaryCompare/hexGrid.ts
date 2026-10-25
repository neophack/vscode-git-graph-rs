/**
 * The pure builders of the hex comparison grid: the offset column's text and width, the grid
 * template the rows and the ruler share, and the HTML of one side / row / ruler. Everything here
 * is a function of its explicit inputs (no DOM, no view state), so the grid's geometry - what the
 * ch-based column tracking depends on - is testable on its own.
 */

import { html, joinHtml, SafeHtml } from '../common/html';
import type { HexRowData } from '../../shared/protocol/binaryCompare';

/** One uppercase hex digit per byte value. */
export const HEXDIGITS: ReadonlyArray<string> = (() => {
	const digits: string[] = [];
	for (let i = 0; i < 256; i++) digits.push((i < 16 ? '0' : '') + i.toString(16).toUpperCase());
	return digits;
})();

/** The offset column's digit floor: eight digits (the classic 4 GiB column), so the column never
 *  shifts while a file is viewed. */
export const HEX_OFFSET_DIGITS = 8;

/** Which side of a comparison cell: 'o' the original, 'n' the modified. */
export type HexSide = 'o' | 'n';

/** The geometry and selection state one row is drawn against. */
export interface HexGridContext {
	readonly bytesPerRow: number;
	readonly offDigits: number;
	isSelected(rowIndex: number, col: number): boolean;
}

/** The ASCII pane's glyph for a byte: printable ASCII and Latin-1 as themselves, a 0x00 as a
 *  blank so zero-filled regions read as empty space, and other control bytes as a dot. */
export function hexAsciiChar(byte: number): string {
	if (byte === 0) return ' ';
	if (byte >= 32 && byte < 127) return String.fromCharCode(byte);
	if (byte >= 160) return String.fromCharCode(byte);
	return '\u00B7';
}

/** The offset digits a file of the given size needs: the eight-digit floor, or the digit count of
 *  its last offset when that is longer. */
export function hexOffsetDigitsFor(size: number): number {
	return Math.max(HEX_OFFSET_DIGITS, Math.max(0, size - 1).toString(16).length);
}

/** The offset as uppercase hex, padded to the active column width. */
export function hexOffsetText(offset: number, offDigits: number): string {
	let text = offset.toString(16).toUpperCase();
	while (text.length < offDigits) text = '0' + text;
	return text;
}

/** The offset column's width in ch: the padded offset plus the 1ch it keeps clear of its rule and
 *  1ch of breathing room before the first byte. */
export function hexOffCh(offDigits: number): number {
	return offDigits + 2;
}

/** Bytes are grouped for the eye - eights at 16 per row, fours below. */
export function hexGroupSize(bytesPerRow: number): number {
	return bytesPerRow >= 16 && bytesPerRow % 8 === 0 ? 8 : 4;
}

/** The width of one side in character cells: offset | one 3ch cell per byte plus a dedicated 1ch
 *  gap track opening each group | a 3ch gutter | one 1ch cell per ASCII character. */
export function hexSideCh(bytesPerRow: number, offDigits: number): number {
	return hexOffCh(offDigits) + 3 * bytesPerRow + (bytesPerRow / hexGroupSize(bytesPerRow) - 1) + 3 + bytesPerRow;
}

/** The grid template every row and the ruler share, so the ruler's digits sit exactly over their
 *  byte columns however wide the font is. The group gap is its own 1ch track, not extra width
 *  folded into the group's first byte column - a widened byte column would center its digit in the
 *  middle of that width, splitting the gap into two smaller, unevenly-sized ones straddling the
 *  byte instead of one gap between the groups. */
export function hexColsTemplate(bytesPerRow: number, offDigits: number): string {
	const group = hexGroupSize(bytesPerRow);
	const widths = [hexOffCh(offDigits) + 'ch'];
	for (let i = 0; i < bytesPerRow; i++) {
		if (i % group === 0 && i > 0) widths.push('1ch');
		widths.push('3ch');
	}
	widths.push('3ch');
	for (let i = 0; i < bytesPerRow; i++) widths.push('1ch');
	return widths.join(' ');
}

/** The decoded bytes one side of a row holds: empty for a side with no row on this line. */
function sideBytes(offset: number, b64: string): string {
	return offset < 0 || b64 === '' ? '' : atob(b64);
}

/**
 * One side of a row: the offset cell, a cell per byte (blank past a short tail so the grid keeps
 * its tracks), the gutter, and a cell per ASCII character. `rowIndex` (-1 when omitted) is the
 * row's absolute grid position, purely for the selection predicate - it plays no part in which
 * bytes are shown.
 */
export function hexSideHtml(offset: number, b64: string, mask: string, side: HexSide, rowIndex: number, ctx: HexGridContext): SafeHtml {
	const bytes = sideBytes(offset, b64);
	const group = hexGroupSize(ctx.bytesPerRow);
	const hex: SafeHtml[] = [];
	const ascii: SafeHtml[] = [];
	for (let i = 0; i < ctx.bytesPerRow; i++) {
		if (i % group === 0 && i > 0) {
			hex.push(html`<span class="hbg"></span>`);
		}
		const sel = ctx.isSelected(rowIndex, i) ? ' hxSel' : '';
		if (i >= bytes.length) {
			hex.push(html`<span class="hb${sel}"></span>`);
			ascii.push(html`<span class="ha${sel}"></span>`);
			continue;
		}
		const byte = bytes.charCodeAt(i) & 0xff;
		const changed = mask.charAt(i) === '1' ? ' hx' + side : '';
		hex.push(html`<span class="hb${changed}${sel}">${HEXDIGITS[byte]}</span>`);
		ascii.push(html`<span class="ha${changed}${sel}">${hexAsciiChar(byte)}</span>`);
	}
	return html`<div class="hside"><span class="hoff">${bytes !== '' ? hexOffsetText(offset, ctx.offDigits) : ''}</span>${hex}<span class="hg"></span>${ascii}</div>`;
}

/** One full row: both sides, zebra-striped when `odd`, at absolute grid position `rowIndex`. */
export function hexRowHtml(row: HexRowData, odd: boolean, rowIndex: number, ctx: HexGridContext): SafeHtml {
	return html`<div class="hrow${odd ? ' hxOdd' : ''}">${hexSideHtml(row.o, row.ob, row.om, 'o', rowIndex, ctx)}${hexSideHtml(row.n, row.nb, row.nm, 'n', rowIndex, ctx)}</div>`;
}

/** The column ruler: a blank offset cell, one hex digit over each byte column (0..F), and the
 *  same digits again over the ASCII pane, on both sides. */
export function hexRulerHtml(ctx: HexGridContext): SafeHtml {
	const group = hexGroupSize(ctx.bytesPerRow);
	const cells: SafeHtml[] = [];
	const ascii: SafeHtml[] = [];
	for (let i = 0; i < ctx.bytesPerRow; i++) {
		if (i % group === 0 && i > 0) {
			cells.push(html`<span class="hbg"></span>`);
		}
		const digit = (i % 16).toString(16).toUpperCase();
		cells.push(html`<span class="hb">${digit}</span>`);
		ascii.push(html`<span class="ha">${digit}</span>`);
	}
	const side = (byteCells: SafeHtml[], asciiCells: SafeHtml[]) =>
		html`<div class="hside"><span class="hoff"></span>${byteCells}<span class="hg"></span>${asciiCells}</div>`;
	return joinHtml([side(cells, ascii), side(cells, ascii)]);
}
