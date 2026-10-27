/**
 * The keyed patcher of the commit table: reconciles the rows the row model wants (`commits[from..to)`
 * of a RowContext) with the DOM, so that only rows whose own content changed are rebuilt. Rows are
 * matched by COMMIT HASH, not by index; a row whose recorded build inputs all match is kept without
 * its markup ever being built. Also keeps the spacer rows that stand in for the unrendered rows
 * outside the windowed render range.
 */

import { parseHtmlRow, raw } from '../../common/html';
import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import { getCommitRowHtml, RowContext } from './commitRow';
import { RowBuildInputs, RowModelFactory } from './rowModel';

export class RowPatcher {
	/**
	 * The markup each rendered row was built from, minus the parts that are patched in place (its
	 * index, its lane colour, the checked-out marker). A row is rebuilt only when this changes, so
	 * an update that does not affect a row leaves its DOM node completely alone. Held outside the
	 * elements themselves so the nodes stay pristine.
	 */
	private readonly rowSignatures = new WeakMap<HTMLElement, string>();
	/**
	 * The INPUTS each rendered row was built from (see RowBuildInputs): the cheap keyed-patch fast
	 * path. While the signatures above decide "would the markup differ?" by comparing markup (which
	 * has to be built first), the inputs decide it without building anything - pure reference and
	 * flag comparisons - so an unchanged row costs a handful of `===` instead of a row build. When
	 * the inputs match, the markup is guaranteed to be the same; when they don't, the signature
	 * comparison still decides (an input can change without the markup changing, e.g. a Gerrit
	 * state arriving with the same badge).
	 */
	private readonly rowInputs = new WeakMap<HTMLElement, RowBuildInputs>();

	constructor(private readonly ctx: () => GraphContext, private readonly model: RowModelFactory) { }

	private get tableElem() {
		return this.ctx().dom.table;
	}

	/**
	 * Make the rendered commit rows match `commits[from..to)` exactly, reusing the existing DOM
	 * node of every row that has not changed.
	 *
	 * This is what makes the virtual table's contract true: rows are matched by COMMIT HASH, not
	 * by index, and re-rendered only when their own markup actually differs. A commit inserted or
	 * removed outside the window therefore touches nothing inside it - the rows keep their very
	 * DOM nodes, and with them the column widths the browser already laid out, the find-widget
	 * highlights and the open Commit Details View. Only the `data-id` index label is restamped.
	 *
	 * The keyed-patch fast path: a row whose recorded build INPUTS all match is kept without its
	 * markup ever being built - most of the rows of a scroll or refresh window - and only rows
	 * whose inputs changed fall through to the (markup-comparing) signature check, where an input
	 * change that does not change the markup still keeps the DOM node.
	 */
	public syncCommitRows(rowContext: RowContext, from: number, to: number) {
		// Rows live inside the <tbody> (implicit or explicit), not directly under the <table>
		const tableBody = <HTMLElement | null>(this.tableElem.querySelector('table > tbody') || this.tableElem.querySelector('table'));
		if (tableBody === null) return;

		const existing = new Map<string, HTMLElement>();
		const existingRows = tableBody.querySelectorAll<HTMLElement>('tr.commit');
		for (let i = 0; i < existingRows.length; i++) {
			const hash = existingRows[i].dataset.hash;
			if (typeof hash === 'string' && !existing.has(hash)) existing.set(hash, existingRows[i]);
		}

		// Walk the desired rows in order, keeping a cursor on the node each one should sit before
		const headerRow = tableBody.querySelector('#tableColHeaders');
		const topSpacer = tableBody.querySelector('#tableColHeaders + tr.virtSpacer');
		let cursor: Node | null = (topSpacer !== null ? topSpacer : headerRow) as Node | null;
		cursor = cursor !== null ? cursor.nextSibling : tableBody.firstChild;

		const commits = rowContext.commits;
		const seed = this.model.computeRowSeed(rowContext);
		const alignedToGraph = rowContext.config.referenceLabels.branchLabelsAlignedToGraph;
		const kept = new Set<HTMLElement>();
		for (let i = from; i < to; i++) {
			const commit = commits[i];
			const hash = commit.hash;
			let row = existing.get(hash);

			if (row === undefined || !this.rowInputsMatch(row, seed, rowContext, i, commit, alignedToGraph)) {
				const rowHtml = getCommitRowHtml(i, rowContext);
				// Three things change without the ROW changing - its index label, its graph lane colour
				// and whether it is the checked-out commit - and all three can be applied to an existing
				// node in place. Keeping them out of the comparison is what lets a row survive a commit
				// arriving above it, or HEAD moving elsewhere, as the very same DOM node.
				const signature = rowHtml.html
					.replace(/ data-id="\d+"/, '')
					.replace(/ data-color="\d+"/, '')
					.replace(/ aria-rowindex="\d+"/, '')
					.replace(/^<tr class="commit current/, '<tr class="commit');

				if (row === undefined || this.rowSignatures.get(row) !== signature) {
					// The row's own content changed (or it was not rendered at all): build it, put it in
					// place, and only then drop the stale node - which may be the very node `cursor`
					// points at, so it must not be detached while the cursor still needs it.
					const fresh = parseHtmlRow(rowHtml);
					this.rowSignatures.set(fresh, signature);
					tableBody.insertBefore(fresh, cursor);
					if (row !== undefined && row.parentNode !== null) row.remove();
					row = fresh;
				} else {
					// The inputs changed but the markup did not: keep the node, restamping only what is
					// allowed to differ. Moving it is what absorbs rows inserted or removed above
					// without rebuilding anything.
					this.restampRow(row, i, hash, rowContext, tableBody, cursor);
				}
				this.saveRowInputs(row, seed, rowContext, i, commit, alignedToGraph);
			} else {
				// Fast path: every input matches, so the markup is what this node already shows -
				// only the index label, lane colour and checked-out marker may need restamping
				this.restampRow(row, i, hash, rowContext, tableBody, cursor);
			}

			// The next row goes immediately after this one, whatever just happened to the nodes
			cursor = row.nextSibling;
			kept.add(row);
			existing.delete(hash);
		}

		// Whatever is left is no longer in the window (scrolled out, or the commit is gone)
		const remainingRows = tableBody.querySelectorAll<HTMLElement>('tr.commit');
		for (let i = 0; i < remainingRows.length; i++) {
			if (!kept.has(remainingRows[i])) remainingRows[i].remove();
		}
	}

	/** Restamp the parts of a kept row that are allowed to differ without the row changing. */
	private restampRow(row: HTMLElement, i: number, hash: string, rowContext: RowContext, tableBody: HTMLElement, cursor: Node | null) {
		if (row.dataset.id !== String(i)) row.dataset.id = String(i);
		if (row.dataset.color !== String(rowContext.vertexColours[i])) row.dataset.color = String(rowContext.vertexColours[i]);
		// The absolute grid row (the header row is 1, the first commit 2): like the index label
		// above, it changes when rows arrive or leave above the window without the row changing
		const rowIndex = String(i + 2);
		if (row.getAttribute('aria-rowindex') !== rowIndex) row.setAttribute('aria-rowindex', rowIndex);
		row.classList.toggle('current', hash === rowContext.currentHash);
		// Moving an already-placed node is skipped: the move is only there to absorb rows inserted
		// or removed above, and a needless reinsertion would still show up as a DOM mutation
		if (row !== cursor) tableBody.insertBefore(row, cursor);
	}

	/** Do a rendered row's recorded build inputs match the row that index `i` wants now? */
	private rowInputsMatch(row: HTMLElement, seed: string, rowContext: RowContext, i: number, commit: GG.GitCommit, alignedToGraph: boolean): boolean {
		const inputs = this.rowInputs.get(row);
		if (inputs === undefined || inputs.seed !== seed || inputs.commit !== commit) return false;
		if (inputs.muted !== rowContext.mutedCommits[i]) return false;
		if (inputs.pinned !== rowContext.pinnedCommitHashes.has(commit.hash)) return false;
		if (inputs.avatarPresent !== (rowContext.avatars[commit.email] !== undefined)) return false;
		if (inputs.bodyPresent !== (rowContext.commitBodies[commit.hash] !== undefined)) return false;
		const gerritState = rowContext.gerritStates[commit.hash];
		if (inputs.gerritState !== gerritState) return false;
		if (inputs.pullRequest !== rowContext.pullRequestsByHead[commit.hash]) return false;
		if (inputs.gerritVisible !== (gerritState !== undefined && rowContext.gerritVisibleChanges.has(gerritState.change))) return false;
		// Only read when the labels align to the graph (the seed covers the setting itself)
		return !alignedToGraph || inputs.widthAtVertex === rowContext.widthsAtVertices[i];
	}

	/** Record the build inputs of a row the table just built or compared. */
	private saveRowInputs(row: HTMLElement, seed: string, rowContext: RowContext, i: number, commit: GG.GitCommit, alignedToGraph: boolean) {
		const gerritState = rowContext.gerritStates[commit.hash];
		this.rowInputs.set(row, {
			seed: seed,
			commit: commit,
			muted: rowContext.mutedCommits[i],
			pinned: rowContext.pinnedCommitHashes.has(commit.hash),
			avatarPresent: rowContext.avatars[commit.email] !== undefined,
			bodyPresent: rowContext.commitBodies[commit.hash] !== undefined,
			gerritState: gerritState,
			gerritVisible: gerritState !== undefined && rowContext.gerritVisibleChanges.has(gerritState.change),
			pullRequest: rowContext.pullRequestsByHead[commit.hash],
			widthAtVertex: alignedToGraph ? rowContext.widthsAtVertices[i] : -1
		});
	}

	/**
	 * Keep the spacer row that stands in for the `rows` unrendered commit rows above (`top`) or
	 * below the window, so the scroll height - and with it the scroll bar and the "Load More
	 * Commits" bottom detection - stays proportional to the whole commit list. The element is
	 * created once and afterwards only resized, so the rows around it are never disturbed.
	 */
	public syncSpacerRow(tableBody: HTMLElement, top: boolean, rows: number) {
		const ctx = this.ctx();
		let spacer = <HTMLElement | null>tableBody.querySelector(top ? '#virtSpacerTop' : '#virtSpacerBottom');
		if (ctx.viewport.renderedRange === null) {
			// Full render: every row is in the DOM, nothing to stand in for
			if (spacer !== null) spacer.remove();
			return;
		}
		if (spacer === null) {
			spacer = parseHtmlRow(raw('<tr id="' + (top ? 'virtSpacerTop' : 'virtSpacerBottom') + '" class="virtSpacer" aria-hidden="true"><td style="height:0;padding:0"></td></tr>'));
			if (top) {
				tableBody.querySelector('#tableColHeaders')!.insertAdjacentElement('afterend', spacer);
			}
		}
		if (!top) tableBody.appendChild(spacer); // always the last row, whatever was appended before it
		const td = <HTMLElement | null>spacer.querySelector('td');
		if (td !== null) {
			const height = Math.max(0, rows) * ctx.layout.getRowHeight() + 'px';
			if (td.style.height !== height) td.style.height = height;
			const colspan = String(ctx.layout.getNumColumns());
			if (td.getAttribute('colspan') !== colspan) td.setAttribute('colspan', colspan);
		}
	}
}
