/**
 * The generic element-geometry reads, shared by every webview bundle. A layout read
 * (clientHeight, offsetWidth, getBoundingClientRect, ...) interleaved with a DOM write forces a
 * synchronous layout of the whole page; gathering the reads into these helpers keeps them
 * batchable before the frame's writes. Rule: call one of these functions, then write - never
 * read and write in the same loop.
 *
 * This module is one of the two sanctioned homes for geometry reads (the ESLint rule rejects
 * them elsewhere in src/webview): the generic reads live HERE because the standalone bundles
 * (comparison, binaryCompare) and common/ widgets must not depend on the graph view's render
 * modules, and common/ sits below graph/ in the layering. The graph-specific batched measures
 * live in graph/render/measure.ts, which re-exports these helpers for its callers.
 */

/** A single element's client size (its content box plus padding), read in one batch. */
export interface ClientSizeMetrics {
	/** The element's clientWidth (content plus left/right padding, no scrollbar). */
	readonly width: number;
	/** The element's clientHeight (content plus top/bottom padding, no scrollbar). */
	readonly height: number;
}

/**
 * Read an element's client size in one batch. Both dimensions are read in the one call even when
 * the caller needs only one: the read stays here, batched, instead of reopening a geometry access
 * at the call site. In jsdom every box measures 0, as the hidden-view guards downstream expect.
 */
export function measureClientSize(elem: Element): ClientSizeMetrics {
	return { width: elem.clientWidth, height: elem.clientHeight };
}

/** Read an element's border-box height (clientHeight plus its top and bottom borders). */
export function measureOffsetHeight(elem: HTMLElement): number {
	return elem.offsetHeight;
}

/** Read an element's top offset within its offsetParent (a row's position inside its table). */
export function measureOffsetTop(elem: HTMLElement): number {
	return elem.offsetTop;
}

/**
 * Read an element's bounding rect in viewport coordinates - the read behind every popup position
 * (context menus, dropdowns, tooltips, scroll-into-view maths). The values are only valid until
 * the caller's next DOM write, so measure right before positioning, never across a write.
 */
export function measureBoundingClientRect(elem: Element): DOMRect {
	return elem.getBoundingClientRect();
}
