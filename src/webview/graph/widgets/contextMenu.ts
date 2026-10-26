import { alterClass, CLASS_MOBILE_MODE, CLASS_TABLET_MODE, handledEvent, removeClassFromAll } from '../../common/dom';
import { html, joinHtml, SafeHtml, setHtml } from '../../common/html';
import { SVG_ICONS } from '../../common/icons';
import { ensureWidgetStyles } from '../../common/onDemandStyles';
import * as GG from '../../common/protocol';
import { ContextMenuTarget, TargetType } from '../state/types';

export const CLASS_CONTEXT_MENU_ACTIVE = 'contextMenuActive';

export interface ContextMenuAction {
	/** The label: text, or markup (e.g. a leading icon). */
	readonly title: string | SafeHtml;
	readonly visible: boolean;
	readonly onClick: () => void;
	readonly checked?: boolean; // Required in checked context menus
}

export type ContextMenuActions = ReadonlyArray<ReadonlyArray<ContextMenuAction>>;

/**
 * The Git Graph View's context menus.
 */
export class ContextMenu {
	private elem: HTMLElement | null = null;
	private onClose: (() => void) | null = null;
	private target: ContextMenuTarget | null = null;
	/** The element to return the focus to when the menu closes (the invoker, or wherever focus sat when it opened). */
	private focusToReturn: HTMLElement | null = null;

	/**
	 * @param findCommitElem Resolve the rendered row of the commit at an index (NULL if it isn't rendered).
	 */
	constructor(private readonly findCommitElem: (index: number) => HTMLElement | null) {
		const listener = () => this.close();
		document.addEventListener('click', listener);
		document.addEventListener('contextmenu', listener);
	}

	/**
	 * Show a context menu.
	 * @param actions The groups of actions to display (the visible ones; empty groups are dropped).
	 * @param checked Should each action display a check mark column.
	 * @param target The target the context menu was opened on.
	 * @param event The mouse event that opened the context menu.
	 * @param frameElem The element the context menu is rendered within (and positioned relative to).
	 * @param onClose Invoked when the context menu closes.
	 * @param className An additional class name of the context menu.
	 */
	public show(actions: ContextMenuActions, checked: boolean, target: ContextMenuTarget | null, event: MouseEvent, requestedFrameElem: HTMLElement, onClose: (() => void) | null = null, className: string | null = null) {
		// The tablet layout's popovers are framed by the whole page: a menu opened from the side
		// pane (beside #view, not inside it) must stay next to its anchor rather than be pushed back
		// over the list, and on <body> no stacking context of #view can hide it under the pane
		const frameElem = document.body.classList.contains(CLASS_TABLET_MODE) ? document.body : requestedFrameElem;
		// The menu's styles are on demand (task 5.9's CSS split): kick their chunk so the first
		// menu of a session is styled as soon as the (idle-prefetched) chunk arrives
		ensureWidgetStyles(() => import('../../styles/onDemand'));
		const groups: SafeHtml[] = [], handlers: (() => void)[] = [];
		this.close();

		for (let i = 0; i < actions.length; i++) {
			const items: SafeHtml[] = [];
			for (let j = 0; j < actions[i].length; j++) {
				const action = actions[i][j];
				if (action.visible) {
					// Menu semantics (F5 accessibility): the items are menuitems the keyboard can walk
					// (tabindex="-1", focused with focus()); a checked menu's items are
					// menuitemcheckboxes carrying their check state
					const itemAttrs = checked
						? html`role="menuitemcheckbox" aria-checked="${action.checked ? 'true' : 'false'}" tabindex="-1"`
						: html`role="menuitem" tabindex="-1"`;
					items.push(html`<li class="contextMenuItem" data-index="${handlers.length}" ${itemAttrs}>${checked ? html`<span class="contextMenuItemCheck">${action.checked ? SVG_ICONS.check : ''}</span>` : ''}${action.title}</li>`);
					handlers.push(action.onClick);
				}
			}
			if (items.length > 0) groups.push(joinHtml(items));
		}

		if (handlers.length === 0) return; // No context menu actions are visible

		const menu = document.createElement('ul');
		menu.className = 'contextMenu' + (checked ? ' checked' : '') + (className !== null ? ' ' + className : '');
		menu.setAttribute('role', 'menu');
		menu.style.opacity = '0';
		setHtml(menu, joinHtml(groups, html`<li class="contextMenuDivider" role="separator"></li>`));
		// The mobile layout shows the menu as a full-screen action sheet (see the mobile section of
		// contextMenu.css), so it must live on <body>: inside a frame such as #view (position:fixed,
		// a stacking context of its own) no z-index could lift it above the Commit Details sheet it
		// is often opened from. Its position is set by the stylesheet there, so the frame-relative
		// maths below is moot.
		(document.body.classList.contains(CLASS_MOBILE_MODE) ? document.body : frameElem).appendChild(menu);
		const menuBounds = menu.getBoundingClientRect(), frameBounds = frameElem.getBoundingClientRect();
		const relativeX = event.pageX + menuBounds.width < frameBounds.right
			? -2 // context menu fits to the right
			: event.pageX - menuBounds.width > frameBounds.left
				? 2 - menuBounds.width // context menu fits to the left
				: -2 - (menuBounds.width - (frameBounds.width - (event.pageX - frameBounds.left))); // Overlap the context menu horizontally with the cursor
		const relativeY = event.pageY + menuBounds.height < frameBounds.bottom
			? -2 // context menu fits below
			: event.pageY - menuBounds.height > frameBounds.top
				? 2 - menuBounds.height // context menu fits above
				: -2 - (menuBounds.height - (frameBounds.height - (event.pageY - frameBounds.top))); // Overlap the context menu vertically with the cursor
		menu.style.left = (frameElem.scrollLeft + Math.max(event.pageX - frameBounds.left + relativeX, 2)) + 'px';
		menu.style.top = Math.max(event.clientY - frameBounds.top + relativeY, 2) + 'px';
		menu.style.opacity = '1';
		this.elem = menu;
		this.onClose = onClose;

		const itemElems = menu.getElementsByClassName('contextMenuItem');
		for (let i = 0; i < itemElems.length; i++) {
			itemElems[i].addEventListener('click', (e) => {
				// The user clicked on a context menu item => call the corresponding handler
				e.stopPropagation();
				this.close();
				handlers[parseInt((<HTMLElement>(<Element>e.target).closest('.contextMenuItem')!).dataset.index!)]();
			});
		}

		menu.addEventListener('click', (e) => {
			// The user clicked on the context menu (but not a specific item) => keep the context menu open to allow the user to reattempt clicking on a specific item
			e.stopPropagation();
			// In the mobile layout the menu element is the action sheet's full-screen scrim: a tap
			// on the scrim itself, outside the sheet's items, dismisses it
			if (e.target === menu && document.body.classList.contains(CLASS_MOBILE_MODE)) this.close();
		});

		menu.addEventListener('contextmenu', (e) => {
			// The user right-clicked on the context menu => keep the context menu open
			e.stopPropagation();
		});

		menu.addEventListener('keydown', (e) => {
			// Arrow-key navigation of the menu items (F5 accessibility): the focus walks the items,
			// wrapping at either end; Home / End jump to the first / last item. Escape is left to the
			// document-level handler (it closes the menu, and close() below returns the focus).
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
				const items = <HTMLElement[]>Array.from(menu.getElementsByClassName('contextMenuItem'));
				if (items.length === 0) return;
				const current = items.indexOf(<HTMLElement>document.activeElement);
				let next: number;
				if (e.key === 'Home') next = 0;
				else if (e.key === 'End') next = items.length - 1;
				else if (current === -1) next = e.key === 'ArrowDown' ? 0 : items.length - 1;
				else next = e.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
				items[next].focus();
				handledEvent(e);
			} else if (e.key === 'Tab') {
				// Tab moves the focus out of the menu: close it first, so what is on screen matches
				// where the focus is going (close() returns the focus to the invoker on the way)
				this.close();
			}
		});

		// A menu takes the focus when it opens (F5 accessibility): the first item is focused, so the
		// keyboard flow continues from the menu itself, and closing it can return the focus to where
		// it came from. Saved after the close() above, so replacing one menu with another chains the
		// focus back through the first menu's invoker. <body> is not saved: its focus() is a no-op,
		// and it is where the focus already sits when no control holds it.
		const focusBeforeMenu = document.activeElement;
		this.focusToReturn = focusBeforeMenu instanceof HTMLElement && focusBeforeMenu !== document.body ? focusBeforeMenu : null;
		const firstItem = <HTMLElement | null>menu.querySelector('.contextMenuItem');
		if (firstItem !== null) firstItem.focus();

		this.target = target;
		if (this.target !== null && this.target.type !== TargetType.Repo) {
			alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
		}
	}

	/** Close the context menu (if one is open). */
	public close() {
		if (this.elem !== null) {
			// Return the focus to the invoker (F5 accessibility) when it is still usable and the
			// focus is free (on <body>) or still inside the menu being removed - never steal it
			// from wherever the user has moved it
			const active = document.activeElement;
			const focusIsFreeOrInsideMenu = active === null || active === document.body
				|| (active instanceof Node && this.elem.contains(active));
			if (focusIsFreeOrInsideMenu && this.focusToReturn !== null && this.focusToReturn.isConnected) {
				this.focusToReturn.focus();
			}
			this.elem.remove();
			this.elem = null;
		}
		removeClassFromAll(document, CLASS_CONTEXT_MENU_ACTIVE);
		if (this.onClose !== null) {
			this.onClose();
			this.onClose = null;
		}
		this.target = null;
		this.focusToReturn = null;
	}

	/**
	 * Refresh the context menu after the commits were re-rendered: a menu with a dynamic target is
	 * re-linked to the target's new element, or closed when the target is no longer rendered.
	 * @param commits The commits now rendered.
	 */
	public refresh(commits: ReadonlyArray<GG.GitCommit>) {
		if (!this.isOpen() || this.target === null || this.target.type === TargetType.Repo) {
			// Don't need to refresh if no context menu is open, or it is not dynamic
			return;
		}

		if (this.target.index < commits.length && commits[this.target.index].hash === this.target.hash) {
			// The commit still exists at the same index
			const commitElem = this.findCommitElem(this.target.index);
			if (commitElem !== null) {
				if (typeof this.target.ref === 'undefined') {
					// ContextMenu is only dependent on the commit itself
					if (this.target.type !== TargetType.CommitDetailsView) {
						this.target.elem = commitElem;
						alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
					}
					return;
				} else {
					// ContextMenu is dependent on the commit and ref
					const elems = commitElem.querySelectorAll<HTMLElement>('[data-fullref]');
					for (let i = 0; i < elems.length; i++) {
						if (elems[i].dataset.fullref! === this.target.ref) {
							this.target.elem = this.target.type === TargetType.Ref ? elems[i] : commitElem;
							alterClass(this.target.elem, CLASS_CONTEXT_MENU_ACTIVE, true);
							return;
						}
					}
				}
			}
		}

		this.close();
	}

	/** Is a context menu open. */
	public isOpen() {
		return this.elem !== null;
	}

	/** Is the target of the open context menu dynamic (tied to a commit row of the view). */
	public isTargetDynamicSource() {
		return this.isOpen() && this.target !== null;
	}
}
