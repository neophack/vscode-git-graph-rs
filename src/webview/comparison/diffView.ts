/**
 * The diff view of the Commit Comparison View: the file header (status letter, path, counts, the
 * open-diff button) and the split diff table of the selected file, switching between side-by-side
 * and inline layout at the width breakpoint VS Code's own diff editor uses. Binary files hand the
 * area over to the shared hex / picture comparison.
 */

import { escapeHtml, html, SafeHtml, setHtml } from '../common/html';
import type { ComparisonFileModel } from './model';
import { compareStrings as s } from './../binaryCompare/strings';
import { DiffRow, detectLanguage, pageHighlighter, parseDiff } from './diffParsing';

/** Below this width the diff pane switches from a side-by-side (old | new) split to a single
 *  inline column - the same threshold and behaviour as VS Code's own diff editor
 *  (diffEditor.renderSideBySideInlineBreakpoint / useInlineViewWhenSpaceIsLimited defaults). */
const SIDE_BY_SIDE_BREAKPOINT = 900;

/** The image extensions the picture mode can render. */
const IMAGE_EXTS: { [extension: string]: number } = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, ico: 1, avif: 1, svg: 1 };

export function isImagePath(filePath: string): boolean {
	const dot = filePath.lastIndexOf('.');
	return dot >= 0 && IMAGE_EXTS[filePath.substring(dot + 1).toLowerCase()] === 1;
}

export interface DiffViewEnv {
	readonly fileHeader: HTMLElement;
	readonly diffArea: HTMLElement;
	/** Post a getFileDiff / viewDiff / viewDiffBinary request to the extension host. */
	sendFileRequest(index: number, command: 'getFileDiff' | 'viewDiff' | 'viewDiffBinary'): void;
	/** The selected file is binary: enter the picture view for an image, else the hex view. */
	enterBinaryView(index: number, isImage: boolean): void;
	/** Colour and letter helpers shared with the file tree. */
	statusColour(file: ComparisonFileModel): string;
	statusLetter(file: ComparisonFileModel): string;
	countsHtml(file: ComparisonFileModel, index: number): SafeHtml;
}

export class DiffView {
	private selectedIndex = -1;
	private requestedIndex = -1;
	private lastDiffWasBinary = false;
	private currentFilePath = '';
	private currentFileIsImage = false;
	private currentRows: ReadonlyArray<DiffRow> | null = null;
	private lastLayoutWasSideBySide: boolean | null = null;
	private readonly diffCache = new Map<number, { diff: string | null, error: string | null }>();
	private readonly highlight = pageHighlighter();

	public constructor(private readonly env: DiffViewEnv) {
		// A panel resize (or the sidebar being dragged) can cross the side-by-side/inline
		// breakpoint; when it does, the displayed diff - already parsed and highlighted - is just
		// relaid out, not re-fetched or recomputed. (Guarded for the stub DOMs of the tests.)
		if (typeof ResizeObserver !== 'undefined') {
			new ResizeObserver(() => this.relayout()).observe(this.env.diffArea);
		}
	}

	public selected(): number {
		return this.selectedIndex;
	}

	public wasBinary(): boolean {
		return this.lastDiffWasBinary;
	}

	/** Select a file: patch the header, mark the tree row, and show the cached diff or ask the
	 *  host for it. */
	public selectFile(file: ComparisonFileModel, index: number) {
		this.selectedIndex = index;
		this.lastDiffWasBinary = false;
		this.currentRows = null;
		this.lastLayoutWasSideBySide = null;
		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		this.currentFileIsImage = isImagePath(filePath);
		this.currentFilePath = filePath;
		this.env.diffArea.className = '';
		setHtml(this.env.fileHeader, html`<span class="letter" style="color: ${this.env.statusColour(file)}">${this.env.statusLetter(file)}</span>
			<span id="filePath">${filePath}</span>${this.env.countsHtml(file, index)}
			<button id="openDiffBtn">${s.compareOpenDiffInEditor}</button>`);
		const openDiffBtn = document.getElementById('openDiffBtn');
		if (openDiffBtn !== null) {
			// A binary file has no textual diff for the native editor: its button opens the
			// standalone Binary Compare tab instead.
			openDiffBtn.addEventListener('click', () => {
				this.env.sendFileRequest(index, this.lastDiffWasBinary ? 'viewDiffBinary' : 'viewDiff');
			});
		}
		const cached = this.diffCache.get(index);
		if (cached !== undefined) {
			this.showDiff(cached);
		} else {
			setHtml(this.env.diffArea, html`<div class="status">${s.compareLoadingDiff}</div>`);
			this.env.sendFileRequest(index, 'getFileDiff');
		}
		this.requestedIndex = index;
	}

	/** The reply to a getFileDiff: cache it and show it when it is the requested file. */
	public fileDiff(index: number, diff: string | null, error: string | null) {
		this.diffCache.set(index, { diff: diff, error: error });
		if (index === this.requestedIndex) this.showDiff(this.diffCache.get(index)!);
	}

	/** Drop a file's cached diff (a fresh comparison was loaded). */
	public clearCache() {
		this.diffCache.clear();
	}

	private showDiff(result: { diff: string | null, error: string | null }) {
		if (result.error !== null) {
			this.currentRows = null;
			setHtml(this.env.diffArea, html`<div class="status">${escapeHtml(result.error)}</div>`);
			return;
		}
		if (result.diff !== null) this.renderDiff(result.diff);
	}

	private renderDiff(diffText: string) {
		const parsed = parseDiff(diffText, detectLanguage(this.currentFilePath), this.highlight);
		if (parsed.binary) {
			this.currentRows = null;
			this.lastDiffWasBinary = true;
			this.env.enterBinaryView(this.selectedIndex, this.currentFileIsImage);
		} else if (parsed.rows.length === 0) {
			this.currentRows = null;
			setHtml(this.env.diffArea, html`<div class="status">${s.compareNoTextualChanges}</div>`);
		} else {
			this.currentRows = parsed.rows;
			this.layoutTable(parsed.rows);
		}
	}

	private relayout() {
		if (this.currentRows === null) return;
		if ((this.env.diffArea.clientWidth >= SIDE_BY_SIDE_BREAKPOINT) === this.lastLayoutWasSideBySide) return;
		this.layoutTable(this.currentRows);
	}

	private lnCell(side: string | null, lineNo: number | null): SafeHtml {
		return html`<td class="${side !== null ? 'ln ' + side : 'ln'}">${lineNo === null ? '' : lineNo}</td>`;
	}

	private codeCell(side: string | null, content: SafeHtml | null): SafeHtml {
		return html`<td class="${side !== null ? 'code ' + side : 'code'}">${content}</td>`;
	}

	/** Arranges already-highlighted row descriptors into a <table>, side-by-side or inline
	 *  depending on the diff pane's current width. A "mod" descriptor becomes one row (old | new)
	 *  side-by-side, or two stacked rows (a "del" row then an "add" row, each keeping its own
	 *  word-diff marks) inline - exactly how VS Code's inline diff view renders a change. */
	private layoutTable(rows: ReadonlyArray<DiffRow>) {
		const sideBySide = this.env.diffArea.clientWidth >= SIDE_BY_SIDE_BREAKPOINT;
		this.lastLayoutWasSideBySide = sideBySide;
		const table = document.createElement('table');
		table.className = 'diff' + (sideBySide ? '' : ' inline');
		setHtml(table, sideBySide
			? html`<colgroup><col class="colLn"><col class="colCode"><col class="colLn"><col class="colCode"></colgroup>`
			: html`<colgroup><col class="colLn"><col class="colLn"><col></colgroup>`);
		const frag = document.createDocumentFragment();
		const cells: SafeHtml[] = [];
		for (const r of rows) {
			cells.length = 0;
			let trClass: string;
			if (r.type === 'hunk') {
				trClass = 'hunk';
				cells.push(html`<td colspan="${sideBySide ? 4 : 3}">${r.html}</td>`);
			} else if (r.type === 'ctx') {
				trClass = 'ctx';
				if (sideBySide) {
					cells.push(this.lnCell('old', r.o), this.codeCell(null, r.html), this.lnCell('new', r.n), this.codeCell(null, r.html));
				} else {
					cells.push(this.lnCell(null, r.o), this.lnCell(null, r.n), this.codeCell(null, r.html));
				}
			} else if (r.type === 'add') {
				trClass = 'add';
				if (sideBySide) {
					cells.push(this.lnCell(null, null), this.codeCell(null, null), this.lnCell('new', r.n), this.codeCell('new', r.html));
				} else {
					cells.push(this.lnCell(null, null), this.lnCell('new', r.n), this.codeCell('new', r.html));
				}
			} else if (r.type === 'del') {
				trClass = 'del';
				if (sideBySide) {
					cells.push(this.lnCell('old', r.o), this.codeCell('old', r.html), this.lnCell(null, null), this.codeCell(null, null));
				} else {
					cells.push(this.lnCell('old', r.o), this.lnCell(null, null), this.codeCell('old', r.html));
				}
			} else if (sideBySide) {
				trClass = 'mod';
				cells.push(this.lnCell('old', r.o), this.codeCell('old', r.oldHtml), this.lnCell('new', r.n), this.codeCell('new', r.newHtml));
			} else {
				frag.appendChild(this.buildRow('del', [this.lnCell('old', r.o), this.lnCell(null, null), this.codeCell('old', r.oldHtml)]));
				frag.appendChild(this.buildRow('add', [this.lnCell(null, null), this.lnCell('new', r.n), this.codeCell('new', r.newHtml)]));
				continue;
			}
			frag.appendChild(this.buildRow(trClass!, cells));
		}
		table.appendChild(frag);
		setHtml(this.env.diffArea, html``);
		this.env.diffArea.appendChild(table);
	}

	private buildRow(trClass: string, cells: ReadonlyArray<SafeHtml>) {
		const tr = document.createElement('tr');
		tr.className = trClass;
		setHtml(tr, html`${cells}`);
		return tr;
	}
}
