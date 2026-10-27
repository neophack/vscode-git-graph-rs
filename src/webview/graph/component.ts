/**
 * The base of the graph view's components: a component owns one element subtree, registers
 * every listener it creates through its disposable store, and answers for all of them at
 * dispose() time.
 *
 *   - `listen(target, type, fn)` ties a listener to the COMPONENT's lifetime: `dispose()`
 *     (called by the parent) removes it. Document- and window-level listeners (a context
 *     menu's outside-click close, a dropdown's capture-phase click) live here, so a component
 *     that is torn down cannot leave a global handler behind.
 *   - `listenOnSurface(...)` ties a listener to the component's currently OPEN surface (an
 *     open dialog, an open menu, one render of a re-rendered view). `clearSurfaceListeners()`
 *     removes them when the surface closes or is re-rendered, so a widget that is shown,
 *     closed and shown again — the way a repository switch and every dialog open cycle the
 *     widgets — can no longer accumulate handlers or keep detached DOM alive.
 *   - `query` / `queryAll` / `byId` look up DOM only under `scope` — the component's root, or
 *     its open surface once one is open. This is the enforcement side of the component
 *     convention (no cross-component `document.getElementById`): the ESLint
 *     `no-restricted-properties` rule on `document.getElementById/querySelector*` leaves
 *     main.ts (the composition root that resolves the view's skeleton) and common/dom.ts (the
 *     shared helpers) as the only sanctioned callers, and every component reaches its DOM
 *     through these scoped helpers instead.
 *
 * The base itself stays dependency-free on purpose: the codebase passes two shapes of
 * collaborators (a `() => GraphContext` getter for the view's long-lived components, and a
 * plain deps object or callback set for the widgets), and both keep working unchanged — a
 * subclass keeps its constructor contract and hands its root to `super`.
 */

import { ListenerGroup, makeKeyboardActivatable, observeElemScroll } from '../common/dom';

/** Anything with a teardown: structurally `vscode.Disposable`, as returned by the host's `toDisposable` (src/shared/util/disposable.ts). */
export interface DisposableLike {
	dispose(): void;
}

export abstract class Component {
	/** The listeners of the component's whole lifetime, removed by dispose(). */
	private readonly listeners = new ListenerGroup();
	/** The listeners of the currently open surface (open menu / dialog / one render), removed together when it closes. */
	private readonly surfaceListeners = new ListenerGroup();
	/** Other registered teardowns (sub-widgets, observers), disposed with the component. */
	private readonly disposables: DisposableLike[] = [];

	constructor(
		/**
		 * The element subtree the component owns and may mutate. Lookups run against `scope`,
		 * which defaults to the root; a component whose working element is created per show()
		 * (a dialog, a menu) re-points `scope` at it while it is open.
		 */
		protected readonly root: HTMLElement | Document
	) { }

	/** The subtree DOM lookups run against: the root, or the currently open surface. */
	protected get scope(): HTMLElement | Document {
		return this.root;
	}

	/** Register a listener owned by the component: dispose() removes it. */
	protected listen<K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
	protected listen(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
	protected listen(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
		this.listeners.add(target, type, listener, options);
	}

	/**
	 * Register a listener owned by the component's currently open surface (an open dialog, an
	 * open menu, one render of a re-rendered view): clearSurfaceListeners() removes it.
	 */
	protected listenOnSurface<K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
	protected listenOnSurface(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
	protected listenOnSurface(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
		this.surfaceListeners.add(target, type, listener, options);
	}

	/** Remove every listener of the open surface (the surface closed, or a new one replaces it). */
	protected clearSurfaceListeners(): void {
		this.surfaceListeners.removeAll();
	}

	/** Register any other teardown (a sub-widget with a remove()/dispose(), an observer) with the component. */
	protected register(disposable: DisposableLike): void {
		this.disposables.push(disposable);
	}

	/**
	 * Make a non-native button activate on Enter / Space, with the keydown listener in the
	 * component's store (see common/dom.ts) — dispose() removes it.
	 */
	protected makeKeyboardActivatable(elem: HTMLElement): void {
		makeKeyboardActivatable(elem, this.listeners);
	}

	/** The surface-store variant of {@link makeKeyboardActivatable}: clearSurfaceListeners() removes it. */
	protected makeSurfaceKeyboardActivatable(elem: HTMLElement): void {
		makeKeyboardActivatable(elem, this.surfaceListeners);
	}

	/**
	 * Observe an element's scrolling, with the scroll listener in the component's store (see
	 * common/dom.ts) — dispose() removes it.
	 */
	protected observeElemScroll(elem: HTMLElement | null, initialScrollTop: number, onScroll: (scrollTop: number) => void, onScrolled: () => void): void {
		observeElemScroll(elem, initialScrollTop, onScroll, onScrolled, this.listeners);
	}

	/** The surface-store variant of {@link observeElemScroll}: clearSurfaceListeners() removes it. */
	protected observeSurfaceElemScroll(elem: HTMLElement | null, initialScrollTop: number, onScroll: (scrollTop: number) => void, onScrolled: () => void): void {
		observeElemScroll(elem, initialScrollTop, onScroll, onScrolled, this.surfaceListeners);
	}

	/** The first element under `scope` matching the selector, or NULL. */
	protected query<E extends Element = HTMLElement>(selector: string): E | null {
		return this.scope.querySelector<E>(selector);
	}

	/** Every element under `scope` matching the selector. */
	protected queryAll<E extends Element = HTMLElement>(selector: string): NodeListOf<E> {
		return this.scope.querySelectorAll<E>(selector);
	}

	/** The element with the given id under `scope`, or NULL. */
	protected byId(id: string): HTMLElement | null {
		return this.query<HTMLElement>('#' + id);
	}

	/**
	 * Tear the component down: removes every listener registered through it — the open
	 * surface's first, then the component's own. The parent calls this (main.ts wires the
	 * view's top-level components into `GraphContext.dispose`); a component's own close()
	 * calls clearSurfaceListeners() for the per-surface half.
	 */
	public dispose(): void {
		this.onDispose();
		this.clearSurfaceListeners();
		this.listeners.removeAll();
		for (let i = 0; i < this.disposables.length; i++) {
			try {
				this.disposables[i].dispose();
			} catch (_) {
				// A failing teardown must not stop the rest of the disposal
			}
		}
		this.disposables.length = 0;
	}

	/** Subclass teardown hook, run before the listener stores are emptied. */
	protected onDispose(): void { }
}
