/* Observers of the view itself: window resizes, scrolling, VS Code theme changes and the keyboard. */

import { alterClass, getVSCodeStyle, handledEvent } from '../../common/dom';
import { modifyColourOpacity } from '../../common/util';
import { GraphContext } from '../context';
import { measureScroll } from '../render/measure';
import type { Store } from '../state/store';

const CSS_PROP_FONT_FAMILY = '--vscode-font-family';
const CSS_PROP_EDITOR_FONT_FAMILY = '--vscode-editor-font-family';
const CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND = '--vscode-editor-findMatchHighlightBackground';
const CSS_PROP_SELECTION_BACKGROUND = '--vscode-selection-background';

/** Re-render when the window is resized (coalesced into one update per animation frame). */
export function observeWindowSizeChanges(ctx: GraphContext) {
	let windowWidth = window.outerWidth, windowHeight = window.outerHeight, resizeRafId: number | null = null;

	window.addEventListener('resize', () => {
		// Coalesce bursts of resize events into a single render per animation frame: with many
		// loaded commits, each renderGraph call rebuilds the entire SVG graph
		if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
		resizeRafId = requestAnimationFrame(() => {
			resizeRafId = null;

			// A resize that crossed the layout breakpoint (the phone/tablet/wide switch) changes
			// which columns are rendered: re-render so the Date/Author/Commit columns appear or
			// disappear
			ctx.table.updateNarrowWindowLayout();

			// The visible row count of a windowed render derives from the view height, so a resize
			// must recompute the window (otherwise rows below the old window end are missing until
			// the user scrolls)
			ctx.viewport.updateVirtualWindow();

			if (windowWidth === window.outerWidth && windowHeight === window.outerHeight) {
				ctx.table.renderGraph();
			} else {
				windowWidth = window.outerWidth;
				windowHeight = window.outerHeight;

				// The view was resized: recompute the automatic graph column layout so that the
				// graph width limit tracks the new view size
				ctx.columns.applyGraphColumnAutoLayout();
			}
		});
	});
}

/** Follow the VS Code theme: fonts, the find match colour and whether a selection background exists. */
export function observeWebviewStyleChanges(ctx: GraphContext) {
	let fontFamily = getVSCodeStyle(CSS_PROP_FONT_FAMILY),
		editorFontFamily = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY),
		findMatchColour = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND),
		selectionBackgroundColor = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);

	const setFlashColour = (colour: string) => {
		document.body.style.setProperty('--git-graph-flashPrimary', modifyColourOpacity(colour, 0.7));
		document.body.style.setProperty('--git-graph-flashSecondary', modifyColourOpacity(colour, 0.5));
	};
	const setSelectionBackgroundColorExists = () => {
		alterClass(document.body, 'selection-background-color-exists', selectionBackgroundColor);
	};

	ctx.widgets.find.setColour(findMatchColour);
	setFlashColour(findMatchColour);
	setSelectionBackgroundColorExists();

	(new MutationObserver(() => {
		const ff = getVSCodeStyle(CSS_PROP_FONT_FAMILY),
			eff = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY),
			fmc = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND),
			sbc = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);

		if (ff !== fontFamily || eff !== editorFontFamily) {
			fontFamily = ff;
			editorFontFamily = eff;
			ctx.controls.repoDropdown.refresh();
			ctx.controls.branchDropdown.refresh();
			ctx.controls.authorDropdown.refresh();
		}
		if (fmc !== findMatchColour) {
			findMatchColour = fmc;
			ctx.widgets.find.setColour(findMatchColour);
			setFlashColour(findMatchColour);
		}
		if (selectionBackgroundColor !== sbc) {
			selectionBackgroundColor = sbc;
			setSelectionBackgroundColorExists();
		}
	})).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}

/**
 * Scrolling the view: keep the windowed render around the viewport, load more commits when the end
 * is reached, and save the scroll position once the scrolling rests.
 */
export function observeViewScroll(ctx: GraphContext) {
	const viewElem = ctx.dom.view, store = ctx.store;
	let timeout: number | null = null;
	let virtualRafId: number | null = null;

	// Passive: the handler never prevents the default scroll, and a passive listener
	// keeps it off the scroll's critical path
	viewElem.addEventListener('scroll', () => {
		const scrollTop = viewElem.scrollTop;

		// Track the scroll velocity for the windowed render's direction-aware lead (see
		// Viewport.getScrollLeadRows)
		ctx.viewport.recordScrollMotion(scrollTop);

		// Windowed rendering: re-render the visible commit rows (and the graph vertices) around the
		// new scroll position, coalesced into one update per animation frame
		if (ctx.viewport.viewportOutsideRenderedWindow()) {
			// A jump already carried the viewport past the rendered rows (a fast fling, a scrollbar
			// drag): the browser paints the newly exposed region from the DOM as it is, so the rows
			// must exist NOW - waiting for the next animation frame paints the empty spacers first
			// (the "unloaded content" flash of a fast scroll)
			if (virtualRafId !== null) {
				cancelAnimationFrame(virtualRafId);
				virtualRafId = null;
			}
			ctx.viewport.updateVirtualWindow();
		}
		if (virtualRafId !== null) cancelAnimationFrame(virtualRafId);
		virtualRafId = requestAnimationFrame(() => {
			virtualRafId = null;
			ctx.viewport.updateVirtualWindow();
		});

		if (store.config.loadMoreCommitsAutomatically && store.moreCommitsAvailable && !store.refreshState.inProgress) {
			// The scroll geometry reads of this handler, batched (measure.ts)
			const metrics = measureScroll(viewElem);
			if (metrics.scrollTop > 0 && metrics.viewHeight > 0 && metrics.contentHeight > 0 && (metrics.scrollTop + metrics.viewHeight) >= metrics.contentHeight - 25) {
				// If the user has scrolled such that the bottom of the visible view is within 25px of the end of the content, load more commits.
				ctx.loader.loadMoreCommits();
			}
		}

		if (timeout !== null) window.clearTimeout(timeout);
		timeout = window.setTimeout(() => {
			store.slices.ui.setScrollTop(scrollTop);
			ctx.persistence.saveState();
			timeout = null;
		}, 250);
	}, { passive: true });
}

/** Keyboard shortcuts: dialogs, navigating the Commit Details View, the Extension Settings' keybindings, Escape. */
export function observeKeyboardEvents(ctx: GraphContext) {
	const store = ctx.store, widgets = ctx.widgets;

	document.addEventListener('keydown', (e) => {
		if (ctx.contextMenu.isOpen()) {
			if (e.key === 'Escape') {
				ctx.contextMenu.close();
				handledEvent(e);
			}
		} else if (ctx.dialog.isOpen()) {
			if (e.key === 'Escape') {
				ctx.dialog.close();
				handledEvent(e);
			} else if (e.keyCode ? e.keyCode === 13 : e.key === 'Enter') {
				// Use keyCode === 13 to detect 'Enter' events if available (for compatibility with IME Keyboards used by Chinese / Japanese / Korean users)
				const target = <HTMLElement>e.target;
				if (target && target.tagName === 'TEXTAREA' && !e.ctrlKey && !e.metaKey) {
					// Let Enter insert a newline in multi-line inputs; require Ctrl/Cmd+Enter to submit from a textarea
					return;
				}
				if (target && target.id === 'dialogSecondaryAction') {
					// The Cancel / secondary action button is focused: activate it, don't submit the primary action
					target.click();
				} else {
					ctx.dialog.submit();
				}
				handledEvent(e);
			} else if (e.key === ' ' && (<HTMLElement>e.target).getAttribute('role') === 'button') {
				// Space activates a focused dialog button (divs don't get this behaviour natively, and would otherwise scroll the page)
				(<HTMLElement>e.target).click();
				handledEvent(e);
			}
		} else if (store.expandedCommit !== null && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
			// (NaN reproduces the unknown-hash case of the old plain-object lookup: every comparison answers false)
			const curHashIndex = nanIfMissing(store, store.expandedCommit.commitHash);
			let newHashIndex = -1;

			if (e.ctrlKey || e.metaKey) {
				// Up / Down navigates according to the order of commits on the branch
				if (e.shiftKey) {
					// Follow commits on alternative branches when possible
					if (e.key === 'ArrowUp') {
						newHashIndex = ctx.graph.getAlternativeChildIndex(curHashIndex);
					} else if (e.key === 'ArrowDown') {
						newHashIndex = ctx.graph.getAlternativeParentIndex(curHashIndex);
					}
				} else {
					// Follow commits on the same branch
					if (e.key === 'ArrowUp') {
						newHashIndex = ctx.graph.getFirstChildIndex(curHashIndex);
					} else if (e.key === 'ArrowDown') {
						newHashIndex = ctx.graph.getFirstParentIndex(curHashIndex);
					}
				}
			} else {
				// Up / Down navigates according to the order of commits in the table
				if (e.key === 'ArrowUp' && curHashIndex > 0) {
					newHashIndex = curHashIndex - 1;
				} else if (e.key === 'ArrowDown' && curHashIndex < store.commits.length - 1) {
					newHashIndex = curHashIndex + 1;
				}
			}

			if (newHashIndex > -1) {
				handledEvent(e);
				const elem = ctx.table.findCommitElem(newHashIndex);
				if (elem !== null) ctx.details.load(elem);
			}
		} else if (e.key && (e.ctrlKey || e.metaKey)) {
			const key = e.key.toLowerCase(), keybindings = store.config.keybindings;
			if (key === keybindings.scrollToStash) {
				ctx.viewport.scrollToStash(!e.shiftKey);
				handledEvent(e);
			} else if (!e.shiftKey) {
				if (key === keybindings.refresh) {
					ctx.loader.refresh(true, true);
					handledEvent(e);
				} else if (key === keybindings.find) {
					widgets.find.show(true);
					handledEvent(e);
				} else if (key === keybindings.scrollToHead && store.commitHead !== null) {
					ctx.viewport.scrollToCommit(store.commitHead, true, true);
					handledEvent(e);
				}
			}
		} else if (e.key === 'Escape') {
			if (ctx.controls.repoDropdown.isOpen()) {
				ctx.controls.repoDropdown.close();
				handledEvent(e);
			} else if (ctx.controls.branchDropdown.isOpen()) {
				ctx.controls.branchDropdown.close();
				handledEvent(e);
			} else if (ctx.controls.authorDropdown.isOpen()) {
				ctx.controls.authorDropdown.close();
				handledEvent(e);
			} else if (widgets.settings.isVisible()) {
				widgets.settings.close();
				handledEvent(e);
			} else if (widgets.find.isVisible()) {
				widgets.find.close();
				handledEvent(e);
			} else if (widgets.reflog.isVisible()) {
				widgets.reflog.close();
				handledEvent(e);
			} else if (widgets.worktree.isVisible()) {
				widgets.worktree.close();
				handledEvent(e);
			} else if (widgets.statistics.isVisible()) {
				widgets.statistics.close();
				handledEvent(e);
			} else if (store.expandedCommit !== null) {
				ctx.details.close(true);
				handledEvent(e);
			}
		}
	});
}

/** A commit's row index, or NaN when it is not loaded (the old plain-object lookup answered undefined, whose comparisons all answer false). */
function nanIfMissing(store: Store, hash: string): number {
	const index = store.getCommitId(hash);
	return index !== null ? index : Number.NaN;
}
