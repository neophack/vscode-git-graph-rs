/**
 * The hex comparison view: two panes side by side, each the hex editor's offset | bytes | gutter |
 * ASCII grid. Only the visible rows are kept in the DOM and requested from the extension host, so
 * a file of any size scrolls smoothly and costs the same memory. Ported out of the host's template
 * string (task 6.1); the grid geometry lives in hexGrid.ts, the protocol in
 * shared/protocol/binaryCompare.
 */

import { escapeHtml, html, joinHtml, raw, setHtml } from '../common/html';
import type { BinaryCompareRequest, BinaryCompareResponse, HexRowData } from '../../shared/protocol/binaryCompare';
import { compareMarkup, compareStrings as s, format } from './strings';
import { HexGridContext, hexColsTemplate, hexOffsetDigitsFor, hexOffsetText, hexOffCh, hexRowHtml, hexRulerHtml, hexSideCh, HEX_OFFSET_DIGITS, HEXDIGITS } from './hexGrid';

/** Height of one row, in pixels (matches the text diff's line height). */
const HEX_ROW_H = 19;
/** The row cache keeps at most this many rows (see the eviction in the hexRows handler). Copy
 *  reads through that same cache, so a selection is only guaranteed copyable while every one of
 *  its rows fits in it beside the viewport's own rows: the Copy limit derives from the capacity
 *  (with a margin for the viewport) rather than promising sizes the cache would evict halfway
 *  through the fetch. */
const HEX_ROW_CACHE_MAX = 6000;
/** Each side of the row is padded 12px, like the hex viewer's rows. */
const HEX_SIDE_PAD = 12;

interface HexEls {
	wrap: HTMLElement;
	ruler: HTMLElement;
	scroller: HTMLElement;
	spacer: HTMLElement;
	view: HTMLElement;
	oldSize: HTMLElement;
	newSize: HTMLElement;
	status: HTMLElement;
	copyStatus: HTMLElement;
	prev: HTMLButtonElement;
	next: HTMLButtonElement;
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

/** The byte a hex or ASCII cell under a delegated event stands for (its row, column, side and
 *  pane), or NULL anywhere else in the view. */
export interface HexCell {
	row: number;
	col: number;
	side: 'o' | 'n';
	pane: 'hex' | 'ascii';
}

export interface HexViewEnv {
	/** The element the views render into (the page's #diffArea). */
	readonly root: HTMLElement;
	/** Post a protocol request to the extension host. */
	send(message: BinaryCompareRequest): void;
	/** The view failed to load: show the localised error in place of the view. */
	onError(text: string): void;
	/** The page can switch to the picture view of the current file (the toolbar's toggle). */
	hasImageView(): boolean;
	/** Enter the picture view of the file at the given index. */
	switchToImage(index: number): void;
}

export class HexView {
	public active = false;
	private index = -1;
	private totalRows = 0;
	private sameSize = false;
	private layoutVersion = 0;
	private bytesPerRow = 16;
	private offDigits = HEX_OFFSET_DIGITS;
	private sections: ReadonlyArray<number> | null = null;
	private diffs: Array<{ row: number, rows: number }> = [];
	private diffPos = -1;
	private readonly rows = new Map<number, HexRowData>();
	private pending = false;
	private els: HexEls | null = null;
	private scrollQueued = false;

	/* A selection is a span of grid position, not file address: [anchor, head] as linear indices
	   row*bytesPerRow+col, painted the same on both sides - the position a drag picks, not the
	   bytes there, since the two sides can differ at it. -1 means "not placed yet"; both
	   invalidated whenever the row width changes, since the linear index's meaning depends on it. */
	private selAnchor = -1;
	private selHead = -1;
	/* The side ('o'/'n') and pane ('hex'/'ascii') a drag or click started in - a plain Copy reads
	   that side, and 'smart' format follows that pane the way the hex viewer's own Copy does. The
	   right-click menu overrides both with wherever it landed. */
	private selSide: 'o' | 'n' = 'o';
	private selPane: 'hex' | 'ascii' = 'hex';
	private dragging = false;
	/* The absolute row index of the view element's first child - renderViewport keeps it current -
	   so a delegated event on a cell can recover that cell's row from its position in the DOM
	   without the row's own address (which a differing side may not have). */
	private viewFirstRow = 0;
	private copyWaiters: CopyWaiter[] = [];
	private menuEl: HTMLElement | null = null;
	private copyStatusTimer: ReturnType<typeof setTimeout> | null = null;

	public constructor(private readonly env: HexViewEnv) {}

	private get grid(): HexGridContext {
		const view = this;
		return {
			bytesPerRow: view.bytesPerRow,
			offDigits: view.offDigits,
			isSelected(rowIndex, col) { return view.cellSelected(rowIndex, col); }
		};
	}

	/** Run once per page: the menu-close and drag-release listeners that outlive every render. */
	public installGlobalInput() {
		window.addEventListener('mouseup', () => { this.dragging = false; });
		document.addEventListener('mousedown', (event) => {
			const target = event.target;
			if (this.menuEl !== null && (target === null || typeof (<Element>target).closest !== 'function' || (<Element>target).closest('#hexMenu') === null)) {
				this.closeMenu();
			}
		});
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && this.menuEl !== null) this.closeMenu();
		});
	}

	private bytesLabel(size: number): string {
		return size < 0 ? '\u2014' : size.toLocaleString() + ' B';
	}

	/** The hex view fits the window: both sides at 16 bytes per row need 2 * hexSideCh(16)
	 *  character cells plus the sides' padding, so narrower windows step down to 12/8/4 bytes per
	 *  row. The probe measures the rows' own font, so a font change re-picks correctly. */
	private pickBytesPerRow(): number {
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
		const available = this.env.root.clientWidth - 20 - 4 * HEX_SIDE_PAD;
		const candidates = [16, 12, 8, 4];
		for (let i = 0; i < candidates.length; i++) {
			if (2 * hexSideCh(candidates[i], this.offDigits) * charWidth <= available) return candidates[i];
		}
		return 4;
	}

	private applyBytesPerRow() {
		if (this.els === null) return;
		this.els.wrap.style.setProperty('--hcols', hexColsTemplate(this.bytesPerRow, this.offDigits));
		setHtml(this.els.ruler, hexRulerHtml(this.grid));
	}

	/** The row width is changing: the selection's linear indices are over the OLD width,
	 *  meaningless (and liable to point at the wrong bytes) under the new one. */
	public refreshLayout() {		this.bytesPerRow = this.pickBytesPerRow();
		this.applyBytesPerRow();
		if (this.els !== null) setHtml(this.els.view, html``);
		this.rows.clear();
		this.pending = false;
		this.sections = null;
		this.diffs = [];
		this.diffPos = -1;
		this.clearSelection();
		this.cancelCopyWaiters();
		this.updateNav();
		this.env.send({ command: 'getHexInfo', index: this.index, bytesPerRow: this.bytesPerRow });
	}

	/** A window resize: re-pick the row width when it no longer fits, else just re-render. */
	public onResize() {
		if (!this.active) return;
		if (this.pickBytesPerRow() !== this.bytesPerRow) this.refreshLayout();
		else this.queueRender();
	}

	/** Enter the hex view of the file at `index`, resetting every piece of view state. */
	public enter(index: number) {
		this.active = true;
		this.index = index;
		this.totalRows = 0;
		this.sameSize = false;
		this.layoutVersion = 0;
		this.sections = null;
		this.diffs = [];
		this.diffPos = -1;
		this.rows.clear();
		this.pending = false;
		this.offDigits = HEX_OFFSET_DIGITS; // the sizes are not known yet: the floor until hexInfo answers
		this.bytesPerRow = this.pickBytesPerRow();
		this.clearSelection();
		this.cancelCopyWaiters();
		this.viewFirstRow = 0;
		this.closeMenu();
		const root = this.env.root;
		root.className = 'hexMode';
		setHtml(root, html`<div id="hexWrap">
			<div id="hexToolbar">
				<span id="hexCopyStatus" class="hxCopyStatus"></span>
				<span class="hxSpacer"></span>
				${this.env.hasImageView() ? html`<button id="hexImageBtn">${s.compareImageToggleButton}</button>` : null}
				<button id="hexPrevBtn" title="${s.compareHexPrevDiff}">&#9650;</button>
				<span id="hexDiffStatus">${raw(compareMarkup('compareHexAnalysing'))}</span>
				<button id="hexNextBtn" title="${s.compareHexNextDiff}">&#9660;</button>
			</div>
			<div id="hexScroller"><div id="hexInner">
				<div id="hexHead">
					<div id="hexCaps">
						<div class="hcap"><span>${s.compareImageCaptionOld}</span><span class="hxSize" id="hexOldSize"></span></div>
						<div class="hcap"><span>${s.compareImageCaptionNew}</span><span class="hxSize" id="hexNewSize"></span></div>
					</div>
					<div id="hexRuler" class="hrow"></div>
				</div>
				<div id="hexSpacer"><div id="hexView"></div></div>
			</div></div>
		</div>`);
		this.els = {
			wrap: byId('hexWrap'),
			ruler: byId('hexRuler'),
			scroller: byId('hexScroller'),
			spacer: byId('hexSpacer'),
			view: byId('hexView'),
			oldSize: byId('hexOldSize'),
			newSize: byId('hexNewSize'),
			status: byId('hexDiffStatus'),
			copyStatus: byId('hexCopyStatus'),
			prev: <HTMLButtonElement>byId('hexPrevBtn'),
			next: <HTMLButtonElement>byId('hexNextBtn')
		};
		this.applyBytesPerRow();
		this.els.scroller.addEventListener('scroll', () => this.queueRender());
		this.els.prev.addEventListener('click', () => this.navigate(-1));
		this.els.next.addEventListener('click', () => this.navigate(1));
		// Delegated on the view's own stable element - its content is rebuilt on every render, but
		// the element itself survives, so one listener here outlives every row it ever holds.
		this.els.view.addEventListener('mousedown', (event) => this.onMouseDown(event));
		this.els.view.addEventListener('mousemove', (event) => this.onMouseMove(event));
		this.els.view.addEventListener('contextmenu', (event) => this.onContextMenu(event));
		if (this.env.hasImageView()) {
			const imageBtn = byId('hexImageBtn');
			if (imageBtn !== null) imageBtn.addEventListener('click', () => { this.env.switchToImage(this.index); });
		}
		this.updateNav();
		this.env.send({ command: 'getHexInfo', index: index, bytesPerRow: this.bytesPerRow });
	}

	/** Leave the view (another view entered, or the view errored): drop the DOM and settle any
	 *  in-flight copy fetch. */
	public leave() {
		this.active = false;
		this.els = null;
		this.closeMenu();
		this.cancelCopyWaiters();
	}

	private queueRender() {
		if (this.scrollQueued || !this.active) return;
		this.scrollQueued = true;
		frame(() => {
			this.scrollQueued = false;
			this.renderViewport();
		});
	}

	private renderViewport() {
		if (!this.active || this.els === null) return;
		const els = this.els;
		els.spacer.style.height = (this.totalRows * HEX_ROW_H) + 'px';
		const top = els.scroller.scrollTop, height = els.scroller.clientHeight;
		const first = Math.max(0, Math.floor(top / HEX_ROW_H) - 16);
		const last = Math.min(this.totalRows - 1, Math.ceil((top + height) / HEX_ROW_H) + 24);
		els.view.style.transform = 'translateY(' + (first * HEX_ROW_H) + 'px)';
		// onMouseDown/onMouseMove recover a cell's row from its position among these children
		// (renderViewport always rebuilds first..last with none skipped), so this must stay in
		// lockstep with what is actually drawn below.
		this.viewFirstRow = first;
		const rowHtml: ReturnType<typeof hexRowHtml>[] = [];
		let needStart = -1, needEnd = -1;
		for (let row = first; row <= last; row++) {
			const cached = this.rows.get(row);
			if (cached === undefined) {
				if (needStart < 0) needStart = row;
				needEnd = row;
				rowHtml.push(html`<div class="hrow${row % 2 ? ' hxOdd' : ''}"></div>`);
			} else {
				rowHtml.push(hexRowHtml(cached, row % 2 === 1, row, this.grid));
			}
		}
		setHtml(els.view, joinHtml(rowHtml));
		if (needStart >= 0 && !this.pending) {
			this.pending = true;
			this.env.send({ command: 'getHexRows', index: this.index, start: needStart, count: needEnd - needStart + 1 });
		}
	}

	private updateNav() {
		if (this.els === null) return;
		const count = this.diffs.length;
		this.els.prev.disabled = count === 0;
		this.els.next.disabled = count === 0;
		if (count === 0) {
			setHtml(this.els.status, raw(this.sections === null ? compareMarkup('compareHexAnalysing') : s.compareHexNoDifferences));
		} else {
			setHtml(this.els.status, raw(format(s.compareHexDiffStatus, this.diffPos < 0 ? 1 : this.diffPos + 1, count)));
		}
	}

	private navigate(direction: number) {
		const count = this.diffs.length;
		if (count === 0) return;
		if (this.diffPos < 0) this.diffPos = direction > 0 ? 0 : count - 1;
		else this.diffPos = (this.diffPos + direction + count) % count;
		if (this.els !== null) this.els.scroller.scrollTop = Math.max(0, this.diffs[this.diffPos].row * HEX_ROW_H - 48);
		this.updateNav();
		this.renderViewport();
	}

	private applyMap(sections: ReadonlyArray<number>, totalRows: number, layoutVersion: number) {
		this.sections = sections;
		this.layoutVersion = layoutVersion;
		this.diffs = [];
		this.diffPos = -1;
		let row = 0;
		for (let i = 0; i < sections.length; i += 5) {
			const oldLength = sections[i + 1], newLength = sections[i + 3], equal = sections[i + 4] === 1;
			const rows = equal ? Math.ceil(oldLength / this.bytesPerRow) : Math.max(Math.ceil(oldLength / this.bytesPerRow), Math.ceil(newLength / this.bytesPerRow));
			if (!equal && rows > 0) this.diffs.push({ row: row, rows: rows });
			row += rows;
		}
		this.totalRows = totalRows;
		// Row indices were rebuilt by the alignment; equal-size files keep the identical layout.
		if (!this.sameSize) this.rows.clear();
		this.updateNav();
		this.renderViewport();
	}

	/** Route one protocol response into the view. Returns TRUE when handled. */
	public handle(msg: BinaryCompareResponse): boolean {
		if (msg.command === 'hexInfo') {
			if (!this.active || msg.index !== this.index) return true;
			if (msg.error !== null) {
				this.leave();
				this.env.onError(msg.error);
				return true;
			}
			this.sameSize = msg.oldSize === msg.newSize;
			// Size the offset column by the largest offset either side will show: the eight-digit
			// floor, growing past 4 GiB. A wider column can push the row layout down a step, which
			// must be re-picked - the refresh re-requests everything, so this reply is not applied
			// any further.
			const digits = hexOffsetDigitsFor(Math.max(msg.oldSize, msg.newSize));
			if (digits !== this.offDigits) {
				this.offDigits = digits;
				if (this.pickBytesPerRow() !== this.bytesPerRow && this.els !== null) {
					this.refreshLayout();
					return true;
				}
				this.applyBytesPerRow(); // same row width: only the offset column widens
			}
			if (typeof msg.bytesPerRow === 'number' && msg.bytesPerRow !== this.bytesPerRow) {
				this.bytesPerRow = msg.bytesPerRow;
				this.applyBytesPerRow();
			}
			if (this.els !== null) {
				this.els.oldSize.textContent = this.bytesLabel(msg.oldSize);
				this.els.newSize.textContent = this.bytesLabel(msg.newSize);
			}
			if (msg.sections !== null) {
				// The scan had already finished (e.g. while another view was showing): no hexMap
				// will follow, so apply the layout carried by this reply directly.
				this.applyMap(msg.sections, msg.totalRows, msg.layoutVersion);
			} else {
				// The section map can overtake the scan's completion message; its count wins then.
				if (this.sections === null) {
					this.totalRows = msg.totalRows;
					// Adopt the provisional layout's version too: the host bumped it when the
					// session initialised, and rows fetched under it would otherwise be discarded
					// as stale (the client is still on 0), re-requesting them in a loop for as long
					// as the background scan runs.
					this.layoutVersion = msg.layoutVersion;
				}
				this.renderViewport();
			}
			return true;
		}
		if (msg.command === 'hexMap') {
			if (!this.active || msg.index !== this.index) return true;
			if (msg.error !== null) {
				if (this.els !== null) setHtml(this.els.status, escapeHtml(msg.error));
				return true;
			}
			this.applyMap(msg.sections !== null ? msg.sections : [], msg.totalRows, msg.layoutVersion);
			return true;
		}
		if (msg.command === 'hexRows') {
			if (!this.active || msg.index !== this.index) {
				// The page moved on (or this pane's index isn't the active one): a copy fetch may
				// still be waiting on this exact reply, so it must not be left hanging forever.
				this.resolveCopyWaiters(msg.start, false);
				return true;
			}
			this.pending = false;
			if (msg.error !== null) {
				if (this.els !== null) setHtml(this.els.status, escapeHtml(msg.error));
			} else if (msg.layoutVersion === this.layoutVersion) {
				for (let i = 0; i < msg.rows.length; i++) this.rows.set(msg.start + i, msg.rows[i]);
				while (this.rows.size > HEX_ROW_CACHE_MAX) {
					const oldest = this.rows.keys().next();
					if (oldest.done) break;
					this.rows.delete(oldest.value);
				}
			}
			this.resolveCopyWaiters(msg.start, msg.error === null);
			this.renderViewport();
			return true;
		}
		if (msg.command === 'copyToClipboard') {
			// The write itself already happened optimistically (the copy functions set the status
			// right after posting); only a genuine failure needs to override it, with the host's
			// own already-localised reason.
			if (msg.error !== null) this.setCopyStatus(msg.error);
			return true;
		}
		return false;
	}

	/* ---------- Selection & copy ---------- */

	public hasSelection(): boolean {
		return this.selAnchor >= 0 && this.selHead >= 0 && this.selAnchor !== this.selHead;
	}

	private selStart(): number {
		return Math.min(this.selAnchor, this.selHead);
	}

	private selEnd(): number {
		return Math.max(this.selAnchor, this.selHead);
	}

	/** Whether grid position (rowIndex, col) - not a file address - falls in the selection.
	 *  rowIndex < 0 stands for "no real row" (the probe row the grid is measured with), which
	 *  never selects. */
	public cellSelected(rowIndex: number, col: number): boolean {
		if (rowIndex < 0 || !this.hasSelection()) return false;
		const idx = rowIndex * this.bytesPerRow + col;
		return idx >= this.selStart() && idx <= this.selEnd();
	}

	public clearSelection() {
		this.selAnchor = -1;
		this.selHead = -1;
		this.dragging = false;
	}

	/** Place a selection the way a drag would (anchor, head, the side and pane it started in). */
	public placeSelection(anchor: number, head: number, side: 'o' | 'n', pane: 'hex' | 'ascii') {
		this.selAnchor = anchor;
		this.selHead = head;
		this.selSide = side;
		this.selPane = pane;
	}

	/** The byte a hex or ASCII cell under a delegated event stands for: its row (recovered from
	 *  its position among the view element's children, kept in lockstep by viewFirstRow - the row
	 *  itself carries no address a differing side can be trusted to have), its column (its
	 *  position among its own side's byte or ASCII cells - the gap spacers carry a different
	 *  class, so they do not throw the count off), and which side and pane it belongs to. NULL
	 *  anywhere else in the view. */
	private cellAt(target: unknown): HexCell | null {
		if (target === null || target === undefined || typeof (<Element>target).closest !== 'function') return null;
		const cell = (<Element>target).closest('.hb, .ha');
		if (cell === null || this.els === null) return null;
		const sideEl = cell.closest('.hside');
		const rowEl = cell.closest('.hrow');
		if (sideEl === null || rowEl === null) return null;
		const rowPos = Array.prototype.indexOf.call(this.els.view.children, rowEl);
		if (rowPos < 0) return null;
		const pane = cell.classList.contains('ha') ? 'ascii' : 'hex';
		const cells = sideEl.querySelectorAll(pane === 'ascii' ? '.ha' : '.hb');
		const col = Array.prototype.indexOf.call(cells, cell);
		if (col < 0) return null;
		const side = rowEl.children[0] === sideEl ? 'o' : 'n';
		return { row: this.viewFirstRow + rowPos, col: col, side: side, pane: pane };
	}

	private onMouseDown(event: MouseEvent) {
		if (event.button !== 0) return;
		const cell = this.cellAt(event.target);
		if (cell === null) return;
		// The cells carry the selection model; the browser's own text selection has no business
		// over them (user-select: none on .hside already discourages it, this stops it outright).
		event.preventDefault();
		this.dragging = true;
		const idx = cell.row * this.bytesPerRow + cell.col;
		if (event.shiftKey && this.selAnchor >= 0) {
			this.selHead = idx;
			this.selSide = cell.side;
			this.selPane = cell.pane;
			this.renderViewport();
			return;
		}
		this.selAnchor = idx;
		this.selHead = idx;
		this.selSide = cell.side;
		this.selPane = cell.pane;
		this.renderViewport();
	}

	private onMouseMove(event: MouseEvent) {
		if (!this.dragging) return;
		const cell = this.cellAt(event.target);
		if (cell === null) return;
		const idx = cell.row * this.bytesPerRow + cell.col;
		if (idx === this.selHead) return;
		this.selHead = idx;
		this.renderViewport();
	}

	/* ---------- The right-click menu ---------- */

	/* Nothing in this page's own bundle draws a menu (the main Git Graph view's is a separate,
	   much larger script this lightweight page does not include), so this is a minimal
	   VS Code-styled popup built by hand: a fixed-position list, closed by clicking away, an
	   Escape, or picking an item. */

	private closeMenu() {
		if (this.menuEl !== null) {
			this.menuEl.remove();
			this.menuEl = null;
		}
	}

	private showMenu(x: number, y: number, items: ReadonlyArray<{ label: string, disabled?: boolean, run(): void } | 'sep'>) {
		this.closeMenu();
		const menu = document.createElement('div');
		menu.id = 'hexMenu';
		for (const item of items) {
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
				row.addEventListener('click', (clickEvent) => {
					clickEvent.stopPropagation();
					this.closeMenu();
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
		this.menuEl = menu;
	}

	/** The open right-click menu, if any (the tests read its items back). */
	public menu(): HTMLElement | null {
		return this.menuEl;
	}

	private onContextMenu(event: MouseEvent) {
		event.preventDefault();
		this.dragging = false;
		const cell = this.cellAt(event.target);
		const selected = this.hasSelection();
		const side = cell !== null ? cell.side : this.selSide;
		const pane = cell !== null ? cell.pane : this.selPane;
		const sideLabel = side === 'o' ? s.compareImageCaptionOld : s.compareImageCaptionNew;
		const copyItem = (label: string, copyFormat: string) => ({
			label: label + ' \u2014 ' + sideLabel,
			disabled: !selected,
			run: () => { void this.copySelection(copyFormat, side, pane); }
		});
		this.showMenu(event.clientX, event.clientY, [
			copyItem(s.compareHexMenuCopy, 'smart'),
			copyItem(s.compareHexMenuCopyHex, 'hex'),
			copyItem(s.compareHexMenuCopyText, 'text'),
			copyItem(s.compareHexMenuCopyC, 'c'),
			copyItem(s.compareHexMenuCopyBase64, 'base64'),
			{ label: s.compareHexMenuCopyAddress, disabled: !selected && cell === null, run: () => { this.copyAddress(cell); } },
			'sep',
			{ label: s.compareHexMenuClearSelection, disabled: !selected, run: () => { this.clearSelection(); this.renderViewport(); } }
		]);
	}

	/* ---------- Copy ---------- */

	private setCopyStatus(text: string) {
		if (this.els === null) return;
		this.els.copyStatus.textContent = text;
		if (this.copyStatusTimer !== null) clearTimeout(this.copyStatusTimer);
		const copyStatus = this.els.copyStatus;
		this.copyStatusTimer = setTimeout(() => { copyStatus.textContent = ''; }, 4000);
	}

	/** Settles every pending copy fetch that asked for rows starting at `start` (the viewport's
	 *  own request can share that start, so a reply is only ever a PARTIAL cover of what a waiter
	 *  asked for) - ok FALSE settles the waiter failed outright (an erroring reply, or one that
	 *  belongs to a page or layout the waiter is no longer part of); a successful reply settles
	 *  the waiter only once every row it asked for is actually cached, and leaves it pending
	 *  otherwise, for the copy's own complete reply to finish. */
	private resolveCopyWaiters(start: number, ok: boolean) {
		for (let i = this.copyWaiters.length - 1; i >= 0; i--) {
			const waiter = this.copyWaiters[i];
			if (waiter.first !== start) continue;
			if (!ok || waiter.layoutVersion !== this.layoutVersion) {
				this.copyWaiters.splice(i, 1);
				waiter.resolve(false);
				continue;
			}
			let complete = true;
			for (let row = waiter.first; row <= waiter.last; row++) {
				if (!this.rows.has(row)) { complete = false; break; }
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
	private cancelCopyWaiters() {
		for (const waiter of this.copyWaiters) waiter.resolve(false);
		this.copyWaiters = [];
	}

	/** The number of copy fetches still in flight (asserted by the tests). */
	public waiterCount(): number {
		return this.copyWaiters.length;
	}

	/** Makes sure rows [first, last] are cached, fetching whatever is missing in batches (the
	 *  host caps a single getHexRows at 512 rows) - the viewport's own request (pending) is
	 *  independent and may be in flight at the same time; the two never collide because each
	 *  waiter is only resolved by the one reply whose start matches what it asked for. */
	private async ensureRowsCached(first: number, last: number): Promise<boolean> {
		for (let row = first; row <= last;) {
			if (this.rows.has(row)) { row++; continue; }
			const end = Math.min(last, row + 511);
			const layoutVersion = this.layoutVersion;
			const ok = await new Promise<boolean>((resolve) => {
				this.copyWaiters.push({ first: row, last: end, layoutVersion: layoutVersion, resolve: resolve });
				this.env.send({ command: 'getHexRows', index: this.index, start: row, count: end - row + 1 });
			});
			if (!ok) return false;
			row = end + 1;
		}
		return true;
	}

	/** One side's bytes over grid positions [cellStart, cellEnd] (inclusive, linear row*width+col
	 *  indices) - only the positions that side actually has a byte at; a position past a short
	 *  row, or a row with nothing cached, contributes nothing (NULL: the row was never fetched -
	 *  the caller is expected to have awaited ensureRowsCached first). */
	private readSideBytes(side: 'o' | 'n', rowFirst: number, rowLast: number, cellStart: number, cellEnd: number): number[] | null {
		const out: number[] = [];
		for (let row = rowFirst; row <= rowLast; row++) {
			const cached = this.rows.get(row);
			if (cached === undefined) return null;
			const b64 = side === 'o' ? cached.ob : cached.nb;
			const bytes = b64 === '' ? '' : atob(b64);
			const rowBase = row * this.bytesPerRow;
			const colFrom = Math.max(0, cellStart - rowBase);
			const colTo = Math.min(this.bytesPerRow - 1, cellEnd - rowBase);
			for (let col = colFrom; col <= colTo; col++) {
				if (col < bytes.length) out.push(bytes.charCodeAt(col) & 0xff);
			}
		}
		return out;
	}

	/** Copies the selection in one of the hex viewer's own formats, reading side's file over the
	 *  selected grid span - 'smart' honours pane: hex bytes from the hex pane, raw text from the
	 *  ASCII pane, the way the standalone hex editor's Copy does. */
	public async copySelection(copyFormat: string, side: 'o' | 'n', pane: 'hex' | 'ascii') {
		if (!this.hasSelection()) return;
		const start = this.selStart(), end = this.selEnd();
		if (end - start + 1 > (HEX_ROW_CACHE_MAX - 1024) * this.bytesPerRow) {
			this.setCopyStatus(format(s.compareHexCopyTooLarge, (end - start + 1).toLocaleString()));
			return;
		}
		const rowFirst = Math.floor(start / this.bytesPerRow), rowLast = Math.floor(end / this.bytesPerRow);
		const ok = await this.ensureRowsCached(rowFirst, rowLast);
		// The page may have left the hex view, the selection may have been cleared, or the layout
		// may have changed, while the fetch was in flight.
		if (!this.active || !this.hasSelection() || this.selStart() !== start || this.selEnd() !== end) return;
		if (!ok) {
			this.setCopyStatus(s.compareHexCopyReadFailed);
			return;
		}
		const bytes = this.readSideBytes(side, rowFirst, rowLast, start, end);
		if (bytes === null) {
			this.setCopyStatus(s.compareHexCopyReadFailed);
			return;
		}
		const text = formatBytes(bytes, copyFormat, pane);
		this.env.send({ command: 'copyToClipboard', type: 'Hex Bytes', data: text });
		this.setCopyStatus(format(s.compareHexCopyDone, side === 'o' ? s.compareImageCaptionOld : s.compareImageCaptionNew));
	}

	/** The real address behind grid position (row, col) on one side - NULL when that side has no
	 *  byte there (a short row, or a row not yet cached). */
	private addressAt(row: number, col: number, side: 'o' | 'n'): string | null {
		const cached = this.rows.get(row);
		if (cached === undefined) return null;
		const offset = side === 'o' ? cached.o : cached.n;
		if (offset < 0) return null;
		const b64 = side === 'o' ? cached.ob : cached.nb;
		const length = b64 === '' ? 0 : atob(b64).length;
		if (col >= length) return null;
		return hexOffsetText(offset + col, this.offDigits);
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
			const rowFirst = Math.floor(start / this.bytesPerRow), colFirst = start - rowFirst * this.bytesPerRow;
			const rowLast = Math.floor(end / this.bytesPerRow), colLast = end - rowLast * this.bytesPerRow;
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
		this.env.send({ command: 'copyToClipboard', type: 'Address', data: text });
		this.setCopyStatus(s.compareHexCopyDoneAddress);
	}

	/** One row's markup at an absolute grid position (the tests assert the painted selection). */
	public rowHtmlAt(row: HexRowData, rowIndex: number) {
		return hexRowHtml(row, rowIndex % 2 === 1, rowIndex, this.grid);
	}

	/** The active grid metrics (the tests assert the column geometry). */
	public metrics() {
		return {
			bytesPerRow: this.bytesPerRow,
			offDigits: this.offDigits,
			offsetCh: hexOffCh(this.offDigits),
			colsTemplate: hexColsTemplate(this.bytesPerRow, this.offDigits),
			offsetText: (offset: number) => hexOffsetText(offset, this.offDigits)
		};
	}

	/** The element an id names, once the view is built (the tests read the rendered state). */
	public element(id: string): HTMLElement | null {
		return this.active ? byId(id) : null;
	}
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

function byId(id: string): HTMLElement {
	const el = document.getElementById(id);
	return el !== null ? el : document.createElement('div');
}

/** Schedule a callback on the next frame, or synchronously where no rAF exists (the stub DOMs of
 *  the tests, older hosts). */
export function frame(run: () => void) {
	const raf = window.requestAnimationFrame;
	if (typeof raf === 'function') raf(() => run());
	else run();
}
