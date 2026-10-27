/**
 * The per-render wiring handle the Commit Details shell hands its panes (the summary body, the
 * file view, the code review): a pane registers its controls' listeners and scroll observers
 * through this, so they land in the shell's SURFACE listener store (F3) and are removed together
 * when the next render replaces the panel's content or the view closes.
 */

/** Register a listener owned by the panel's current render (the shell's `listenOnSurface`). */
export interface PanelSurface {
	listen(target: EventTarget, type: string, listener: EventListener): void;
	/** Make a non-native control activate on Enter / Space, owned by the current render. */
	makeKeyboardActivatable(elem: HTMLElement): void;
	/** Observe an element's scrolling, owned by the current render (the shell's `observeSurfaceElemScroll`). */
	observeScroll(elem: HTMLElement | null, initialScrollTop: number, onScroll: (scrollTop: number) => void, onScrolled: () => void): void;
}
