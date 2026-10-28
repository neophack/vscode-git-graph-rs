/**
 * The graph view's batched layout measurements. The generic element-geometry reads live in
 * common/measure.ts (the standalone bundles and common/ widgets share them); this module keeps
 * the graph-specific measures and re-exports the generic helpers so the graph's callers have
 * one import home. Rule: call one of these functions, then write - never read and write in the
 * same loop.
 */

import { measureBoundingClientRect, measureClientSize, measureOffsetHeight, measureOffsetTop } from '../../common/measure';
import type { Store } from '../state/store';

export { measureBoundingClientRect, measureClientSize, measureOffsetHeight, measureOffsetTop };

/**
 * Everything `CommitTable.renderGraph` measures before the graph (a pure write phase) is drawn.
 * Each field is computed in jsdom too (where every box measures 0), which is exactly what the
 * zero-height guards downstream expect of a hidden view.
 */
export interface GraphRenderMetrics {
	/** The height of the (sticky) table column header row, plus its bottom border (0 when hidden). */
	readonly headerHeight: number;
	/** The height inserted below the expanded commit's row (the inline Commit Details View). */
	readonly expandY: number;
	/**
	 * The row height measured from the rendered table, 0 when it cannot be measured (an empty or
	 * hidden view) - the caller keeps the last good grid in that case.
	 */
	readonly measuredRowHeight: number;
}

/**
 * Read the measurements the graph render needs, in one batch: the column header height, the open
 * Commit Details View's height, and the per-row height derived from the rendered table's first
 * child. Reads only - hand the result to the write phase.
 * @param expandedCommitElem The rendered inline Commit Details View (NULL when none is open yet).
 * @param inlineCdvOpen Is an inline (non-docked) Commit Details View open (even before its element
 * exists): its height contributes to the table's measured height either way.
 */
export function measureGraphRender(store: Store, tableElem: HTMLElement, expandedCommitElem: HTMLElement | null, cdvHeight: number, inlineCdvOpen: boolean): GraphRenderMetrics {
	// (+1 for the header row's bottom border; the mobile layout hides the header row, adding nothing)
	// The headers are the table's own subtree (F3): look them up under the table it measures
	const colHeadersElem = tableElem.querySelector<HTMLElement>('#tableColHeaders');
	const headerHeight = colHeadersElem !== null && colHeadersElem.clientHeight > 0 ? colHeadersElem.clientHeight + 1 : 0;
	const expandY = expandedCommitElem !== null ? expandedCommitElem.getBoundingClientRect().height : cdvHeight;
	// The row height is MEASURED from the rendered table (real rows can deviate from the configured
	// graph.rowHeight), but a layout reporting no height - a hidden view (a backgrounded tab measures
	// every clientHeight as 0) or a table not yet laid out - must not overwrite the last good grid:
	// the graph's total height is reconstructed from these values, and reconstructing it from a zero
	// measurement leaves floating point noise around zero, which SVG rejects once it tips negative.
	const firstTableChild = <HTMLElement | null>tableElem.firstElementChild;
	const measuredRowHeight = store.commits.length > 0 && firstTableChild !== null && tableElem.children.length > 0
		? (firstTableChild.clientHeight - headerHeight - (inlineCdvOpen ? cdvHeight : 0)) / store.commits.length
		: 0;
	return { headerHeight: headerHeight, expandY: expandY, measuredRowHeight: measuredRowHeight };
}

/** The measurements the graph column's automatic layout needs, in one batch. */
export interface GraphColumnMetrics {
	/** The current width of the Graph column's header cell (CSS pixels). */
	readonly graphColumnWidth: number;
	/** The view's inner width (the automatic layout limits the graph to a third of it). */
	readonly viewWidth: number;
}

/**
 * Read the Graph column's auto-layout measurements in one batch. The caller must have reset any
 * padding a previous application added BEFORE this runs (that reset is a write, which is why it
 * stays at the call site): otherwise the width read reflects the stale, JS-inflated padding and
 * the derived padding oscillates between calls.
 */
export function measureGraphColumn(graphColElem: HTMLElement, viewElem: HTMLElement): GraphColumnMetrics {
	return { graphColumnWidth: graphColElem.offsetWidth, viewWidth: viewElem.clientWidth };
}

/** Reads for the windowed render: the view's scroll geometry, in one batch. */
export interface ScrollMetrics {
	readonly scrollTop: number;
	readonly viewHeight: number;
	readonly contentHeight: number;
}

/** Read the view's scroll geometry in one batch (the auto-load-more check of the scroll observer). */
export function measureScroll(viewElem: HTMLElement): ScrollMetrics {
	return { scrollTop: viewElem.scrollTop, viewHeight: viewElem.clientHeight, contentHeight: viewElem.scrollHeight };
}
