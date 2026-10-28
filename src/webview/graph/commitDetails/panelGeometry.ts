/* The Commit Details panel's geometry: the panel's height (clamped to the window, resizable by
   drag) and the divider between the summary and the file list (draggable between 20% and 80%). */

import { GraphContext } from '../context';
import { measureBoundingClientRect } from '../render/measure';
import { PanelSurface } from './panelSurface';
import { byId } from './panelDom';

/** Apply the panel's configured height to it (clamped to the window), reserving the space below the list in the docked layout. */
export function setHeight(ctx: GraphContext, elem: HTMLElement, isDocked: boolean) {
	const repoState = ctx.store.repoState;
	let height = repoState.cdvHeight;
	const windowHeight = window.innerHeight;
	if (height > windowHeight - 40) {
		height = Math.max(windowHeight - 40, 100);
		if (height !== repoState.cdvHeight) {
			ctx.store.slices.repos.updateRepoState(ctx.store.currentRepo, 'cdvHeight', height);
			ctx.persistence.saveRepoState();
		}
	}

	const heightPx = height + 'px';
	elem.style.height = heightPx;
	// The tablet side pane spans the full height beside the list: nothing is reserved below it
	if (isDocked && !ctx.layout.isCdvSidePane()) ctx.dom.view.style.bottom = heightPx;
}

/** Apply the configured divider position to the summary, the divider and the file list. */
export function setDivider(ctx: GraphContext, getScope: () => ParentNode) {
	const percent = (ctx.store.repoState.cdvDivider * 100).toFixed(2) + '%';
	const summaryElem = byId(getScope(), 'cdvSummary'), dividerElem = byId(getScope(), 'cdvDivider'), filesElem = byId(getScope(), 'cdvFiles');
	if (summaryElem !== null) summaryElem.style.width = percent;
	if (dividerElem !== null) dividerElem.style.left = percent;
	if (filesElem !== null) filesElem.style.left = percent;
}

/** Make the panel's height resizable by dragging its resize handles (the listeners live on the current render's surface store, F3). */
export function makeHeightResizable(ctx: GraphContext, surface: PanelSurface, getScope: () => ParentNode) {
	const repoState = ctx.store.repoState;
	let prevY = -1;

	const processResizingCdvHeight: EventListener = (e) => {
		if (prevY < 0) return;
		const delta = (<MouseEvent>e).pageY - prevY, isDocked = ctx.layout.isCdvDocked(), windowHeight = window.innerHeight;
		prevY = (<MouseEvent>e).pageY;
		let height = repoState.cdvHeight + (isDocked ? -delta : delta);
		if (height < 100) height = 100;
		else if (height > 600) height = 600;
		if (height > windowHeight - 40) height = Math.max(windowHeight - 40, 100);

		if (repoState.cdvHeight !== height) {
			ctx.store.slices.repos.updateRepoState(ctx.store.currentRepo, 'cdvHeight', height);
			const elem = byId(getScope(), 'cdv');
			if (elem !== null) setHeight(ctx, elem, isDocked);
			if (!isDocked) ctx.table.renderGraph();
		}
	};
	const stopResizingCdvHeight: EventListener = (e) => {
		if (prevY < 0) return;
		processResizingCdvHeight(e);
		ctx.persistence.saveRepoState();
		prevY = -1;
		ctx.eventOverlay.remove();
	};

	// The handle is this panel's own element; the listener is surface-owned (F3)
	const handles = getScope().querySelectorAll('.cdvHeightResize');
	for (let i = 0; i < handles.length; i++) {
		surface.listen(handles[i], 'pointerdown', (e) => {
			prevY = (<PointerEvent>e).pageY;
			ctx.eventOverlay.create('rowResize', processResizingCdvHeight, stopResizingCdvHeight, (<PointerEvent>e).pointerId);
		});
	}
}

/** Make the divider between the summary and the file list draggable (the listener lives on the current render's surface store, F3). */
export function makeDividerDraggable(ctx: GraphContext, surface: PanelSurface, getScope: () => ParentNode) {
	const repoState = ctx.store.repoState;
	let minX = -1, width = -1;

	const processDraggingCdvDivider: EventListener = (e) => {
		if (minX < 0) return;
		let percent = ((<MouseEvent>e).clientX - minX) / width;
		if (percent < 0.2) percent = 0.2;
		else if (percent > 0.8) percent = 0.8;

		if (repoState.cdvDivider !== percent) {
			ctx.store.slices.repos.updateRepoState(ctx.store.currentRepo, 'cdvDivider', percent);
			setDivider(ctx, getScope);
		}
	};
	const stopDraggingCdvDivider: EventListener = (e) => {
		if (minX < 0) return;
		processDraggingCdvDivider(e);
		ctx.persistence.saveRepoState();
		minX = -1;
		ctx.eventOverlay.remove();
	};

	surface.listen(byId(getScope(), 'cdvDivider')!, 'pointerdown', (e) => {
		const contentElem = byId(getScope(), 'cdvContent');
		if (contentElem === null) return;

		const bounds = measureBoundingClientRect(contentElem);
		minX = bounds.left;
		width = bounds.width;
		ctx.eventOverlay.create('colResize', processDraggingCdvDivider, stopDraggingCdvDivider, (<PointerEvent>e).pointerId);
	});
}
