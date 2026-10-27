/**
 * The hex comparison's selection and copy machinery: the selection model (a span of grid position
 * shared by both panes), the copy formats, the row fetches a copy makes for uncached spans, the
 * address copies, and the waiters that settle when the host's rows arrive. It is a module of
 * its own because HexView delegates every selection question here - the view renders what this
 * selects, this copies what the view has cached.
 */

import type { BinaryCompareRequest, HexRowData } from '../../shared/protocol/binaryCompare';
import { hexOffsetText, HEXDIGITS } from './hexGrid';
import { compareStrings as s, format } from './strings';

/** The byte a hex or ASCII cell under a delegated event stands for (its row, column, side and
 *  pane), or NULL anywhere else in the view. */
export interface HexCell {
	row: number;
	col: number;
	side: 'o' | 'n';
	pane: 'hex' | 'ascii';
}

/** A pending getHexRows fetch made for a copy (as opposed to the viewport's own, independent
 *  one): resolves TRUE once every row it asked for is cached, FALSE on a reply that reported an
 *  error or an intervening layout change. */
interface CopyWaiter {
	first: number;
	last: number;
	layoutVersion: number;
	resolve(ok: boolean): void;
}

/** What HexCopy needs from the view that owns it. */
export interface HexCopyHost {
	bytesPerRow(): number;
	offDigits(): number;
	layoutVersion(): number;
	/** Whether the hex view is the active one (a copy in flight when the page moves on aborts). */
	isActive(): boolean;
	/** The cached row at an absolute index, or NULL. */
	row(row: number): HexRowData | undefined;
	/** Post a protocol request to the extension host. */
	send(message: BinaryCompareRequest): void;
	/** Show a copy status line in the toolbar. */
	copyStatus(text: string): void;
}

/** The row cache keeps at most this many rows (see the eviction in the view's hexRows handling).
 *  Copy reads through that same cache, so a selection is only guaranteed copyable while every one
 *  of its rows fits in it beside the viewport's own rows: the Copy limit derives from the capacity
 *  (with a margin for the viewport) rather than promising sizes the cache would evict halfway
 *  through the fetch. */
const HEX_ROW_CACHE_MAX = 6000;

export class HexCopy {
	/* A selection is a span of grid position, not file address: [anchor, head] as linear indices
	   row*bytesPerRow+col, painted the same on both sides - the position a drag picks, not the
	   bytes there, since the two sides can differ at it. -1 means "not placed yet"; both
	   invalidated whenever the row width changes, since the linear index's meaning depends on it. */
	private anchorValue = -1;
	private headValue = -1;
	/* The side ('o'/'n') and pane ('hex'/'ascii') a drag or click started in - a plain Copy reads
	   that side, and 'smart' format follows that pane the way the hex viewer's own Copy does. The
	   right-click menu overrides both with wherever it landed. */
	private sideValue: 'o' | 'n' = 'o';
	private paneValue: 'hex' | 'ascii' = 'hex';
	private copyWaiters: CopyWaiter[] = [];

	public constructor(private readonly host: HexCopyHost) {}

	public anchor(): number {
		return this.anchorValue;
	}

	public head(): number {
		return this.headValue;
	}

	public side(): 'o' | 'n' {
		return this.sideValue;
	}

	public pane(): 'hex' | 'ascii' {
		return this.paneValue;
	}

	public hasSelection(): boolean {
		return this.anchorValue >= 0 && this.headValue >= 0 && this.anchorValue !== this.headValue;
	}

	private selStart(): number {
		return Math.min(this.anchorValue, this.headValue);
	}

	private selEnd(): number {
		return Math.max(this.anchorValue, this.headValue);
	}

	/** Whether grid position (rowIndex, col) - not a file address - falls in the selection.
	 *  rowIndex < 0 stands for "no real row" (the probe row the grid is measured with), which
	 *  never selects. */
	public cellSelected(rowIndex: number, col: number): boolean {
		if (rowIndex < 0 || !this.hasSelection()) return false;
		const idx = rowIndex * this.host.bytesPerRow() + col;
		return idx >= this.selStart() && idx <= this.selEnd();
	}

	/** Place a selection the way a drag would (anchor, head, the side and pane it started in). */
	public placeSelection(anchor: number, head: number, side: 'o' | 'n', pane: 'hex' | 'ascii') {
		this.anchorValue = anchor;
		this.headValue = head;
		this.sideValue = side;
		this.paneValue = pane;
	}

	/** Move the head of an existing selection (a shift-click or a drag in progress). */
	public setHead(head: number, side: 'o' | 'n', pane: 'hex' | 'ascii') {
		this.headValue = head;
		this.sideValue = side;
		this.paneValue = pane;
	}

	public clearSelection() {
		this.anchorValue = -1;
		this.headValue = -1;
	}

	/** The row width is changing: the selection's linear indices are over the OLD width,
	 *  meaningless (and liable to point at the wrong bytes) under the new one, and any in-flight
	 *  copy fetch must be settled. */
	public reset() {
		this.clearSelection();
		this.cancelCopyWaiters();
	}

	/** Copies the selection in one of the hex viewer's own formats, reading side's file over the
	 *  selected grid span - 'smart' honours pane: hex bytes from the hex pane, raw text from the
	 *  ASCII pane, the way the standalone hex editor's Copy does. */
	public async copySelection(copyFormat: string, side: 'o' | 'n', pane: 'hex' | 'ascii') {
		if (!this.hasSelection()) return;
		const start = this.selStart(), end = this.selEnd();
		if (end - start + 1 > (HEX_ROW_CACHE_MAX - 1024) * this.host.bytesPerRow()) {
			this.host.copyStatus(format(s.compareHexCopyTooLarge, (end - start + 1).toLocaleString()));
			return;
		}
		const rowFirst = Math.floor(start / this.host.bytesPerRow()), rowLast = Math.floor(end / this.host.bytesPerRow());
		const ok = await this.ensureRowsCached(rowFirst, rowLast);
		// The page may have left the hex view, the selection may have been cleared, or the layout
		// may have changed, while the fetch was in flight.
		if (!this.host.isActive() || !this.hasSelection() || this.selStart() !== start || this.selEnd() !== end) return;
		if (!ok) {
			this.host.copyStatus(s.compareHexCopyReadFailed);
			return;
		}
		const bytes = this.readSideBytes(side, rowFirst, rowLast, start, end);
		if (bytes === null) {
			this.host.copyStatus(s.compareHexCopyReadFailed);
			return;
		}
		const text = formatBytes(bytes, copyFormat, pane);
		this.host.send({ command: 'copyToClipboard', type: 'Hex Bytes', data: text });
		this.host.copyStatus(format(s.compareHexCopyDone, side === 'o' ? s.compareImageCaptionOld : s.compareImageCaptionNew));
	}

	/** Copies the address(es) behind the right-click: with a selection, both sides' real start-end
	 *  spans for that grid span (which can genuinely differ - a diff aligns by position, not
	 *  address); over a lone byte with nothing selected, that byte's own side's address. Every row
	 *  involved is one the user has already clicked or dragged over, so it is already cached - no
	 *  fetch is needed here the way Copy's selection body needs one. */
	public copyAddress(cell: HexCell | null) {
		let text: string | null = null;
		if (this.hasSelection()) {
			const start = this.selStart(), end = this.selEnd();
			const rowFirst = Math.floor(start / this.host.bytesPerRow()), colFirst = start - rowFirst * this.host.bytesPerRow();
			const rowLast = Math.floor(end / this.host.bytesPerRow()), colLast = end - rowLast * this.host.bytesPerRow();
			const oldFrom = this.addressAt(rowFirst, colFirst, 'o'), oldTo = this.addressAt(rowLast, colLast, 'o');
			const newFrom = this.addressAt(rowFirst, colFirst, 'n'), newTo = this.addressAt(rowLast, colLast, 'n');
			const oldText = oldFrom !== null && oldTo !== null ? oldFrom + '-' + oldTo : '\u2014';
			const newText = newFrom !== null && newTo !== null ? newFrom + '-' + newTo : '\u2014';
			text = s.compareImageCaptionOld + ' ' + oldText + '   ' + s.compareImageCaptionNew + ' ' + newText;
		} else if (cell !== null) {
			const address = this.addressAt(cell.row, cell.col, cell.side);
			// A bare address is ambiguous in a comparison - the same position can hold different
			// addresses on the two sides - so the lone byte names its side too, the way the
			// selection path names both.
			if (address !== null) text = (cell.side === 'o' ? s.compareImageCaptionOld : s.compareImageCaptionNew) + ' ' + address;
		}
		if (text === null) return;
		this.host.send({ command: 'copyToClipboard', type: 'Address', data: text });
		this.host.copyStatus(s.compareHexCopyDoneAddress);
	}

	/** Settles every pending copy fetch that asked for rows starting at `start` (the viewport's
	 *  own request can share that start, so a reply is only ever a PARTIAL cover of what a waiter
	 *  asked for) - ok FALSE settles the waiter failed outright (an erroring reply, or one that
	 *  belongs to a page or layout the waiter is no longer part of); a successful reply settles
	 *  the waiter only once every row it asked for is actually cached, and leaves it pending
	 *  otherwise, for the copy's own complete reply to finish. */
	public resolveCopyWaiters(start: number, ok: boolean) {
		for (let i = this.copyWaiters.length - 1; i >= 0; i--) {
			const waiter = this.copyWaiters[i];
			if (waiter.first !== start) continue;
			if (!ok || waiter.layoutVersion !== this.host.layoutVersion()) {
				this.copyWaiters.splice(i, 1);
				waiter.resolve(false);
				continue;
			}
			let complete = true;
			for (let row = waiter.first; row <= waiter.last; row++) {
				if (this.host.row(row) === undefined) { complete = false; break; }
			}
			if (complete) {
				this.copyWaiters.splice(i, 1);
				waiter.resolve(true);
			}
		}
	}

	/** Settle every pending copy fetch as failed: a row-width change or a re-entry gives the
	 *  waiters' row indices a new meaning, so whatever reply arrives next answers a question
	 *  nobody asked any more. Resolving (rather than dropping) matters because
	 *  ensureRowsCached is still awaiting each waiter. */
	public cancelCopyWaiters() {
		for (const waiter of this.copyWaiters) waiter.resolve(false);
		this.copyWaiters = [];
	}

	/** The number of copy fetches still in flight (asserted by the tests). */
	public waiterCount(): number {
		return this.copyWaiters.length;
	}

	/** Makes sure rows [first, last] are cached, fetching whatever is missing in batches (the
	 *  host caps a single getHexRows at 512 rows) - the viewport's own request is independent and
	 *  may be in flight at the same time; the two never collide because each waiter is only
	 *  resolved by the one reply whose start matches what it asked for. */
	private async ensureRowsCached(first: number, last: number): Promise<boolean> {
		for (let row = first; row <= last;) {
			if (this.host.row(row) !== undefined) { row++; continue; }
			const end = Math.min(last, row + 511);
			const layoutVersion = this.host.layoutVersion();
			const ok = await new Promise<boolean>((resolve) => {
				this.copyWaiters.push({ first: row, last: end, layoutVersion: layoutVersion, resolve: resolve });
				this.host.send({ command: 'getHexRows', index: this.index(), start: row, count: end - row + 1 });
			});
			if (!ok) return false;
			row = end + 1;
		}
		return true;
	}

	/** The file index whose rows are being copied (the page's active comparison). */
	private index(): number {
		return this.activeIndex;
	}

	/** One side's bytes over grid positions [cellStart, cellEnd] (inclusive, linear row*width+col
	 *  indices) - only the positions that side actually has a byte at; a position past a short
	 *  row, or a row with nothing cached, contributes nothing (NULL: the row was never fetched -
	 *  the caller is expected to have awaited ensureRowsCached first). */
	private readSideBytes(side: 'o' | 'n', rowFirst: number, rowLast: number, cellStart: number, cellEnd: number): number[] | null {
		const out: number[] = [];
		for (let row = rowFirst; row <= rowLast; row++) {
			const cached = this.host.row(row);
			if (cached === undefined) return null;
			const b64 = side === 'o' ? cached.ob : cached.nb;
			const bytes = b64 === '' ? '' : atob(b64);
			const rowBase = row * this.host.bytesPerRow();
			const colFrom = Math.max(0, cellStart - rowBase);
			const colTo = Math.min(this.host.bytesPerRow() - 1, cellEnd - rowBase);
			for (let col = colFrom; col <= colTo; col++) {
				if (col < bytes.length) out.push(bytes.charCodeAt(col) & 0xff);
			}
		}
		return out;
	}

	/** The real address behind grid position (row, col) on one side - NULL when that side has no
	 *  byte there (a short row, or a row not yet cached). */
	private addressAt(row: number, col: number, side: 'o' | 'n'): string | null {
		const cached = this.host.row(row);
		if (cached === undefined) return null;
		const offset = side === 'o' ? cached.o : cached.n;
		if (offset < 0) return null;
		const b64 = side === 'o' ? cached.ob : cached.nb;
		const length = b64 === '' ? 0 : atob(b64).length;
		if (col >= length) return null;
		return hexOffsetText(offset + col, this.host.offDigits());
	}

	/** @internal Set by the view on entry: the index whose rows the copies read. */
	public setActiveIndex(index: number) {
		this.activeIndex = index;
	}

	private activeIndex = -1;
}

/** Format one side's bytes the way the hex viewer's own Copy does: 'smart' follows the pane the
 *  drag started in (raw text from the ASCII pane, hex bytes from the hex pane). */
export function formatBytes(bytes: ReadonlyArray<number>, copyFormat: string, pane: string): string {
	if (copyFormat === 'base64') return btoa(bytesToLatin1(bytes));
	if (copyFormat === 'c') return bytes.map((b) => '0x' + HEXDIGITS[b]).join(', ');
	if (copyFormat === 'text' || (copyFormat === 'smart' && pane === 'ascii')) return bytesToLatin1(bytes);
	return bytes.map((b) => HEXDIGITS[b]).join('');
}

function bytesToLatin1(bytes: ReadonlyArray<number>): string {
	let text = '';
	for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
	return text;
}
