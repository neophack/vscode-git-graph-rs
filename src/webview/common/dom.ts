/* DOM helpers shared by every webview component. */

export const CLASS_ACTIVE = 'active';
export const CLASS_DISABLED = 'disabled';
export const CLASS_ENABLED = 'enabled';
export const CLASS_FOCUSSED = 'focussed';
export const CLASS_LOADING = 'loading';
export const CLASS_MOBILE_MODE = 'mobileMode';
export const CLASS_SELECTED = 'selected';
export const CLASS_TABLET_MODE = 'tabletMode';
/** Set with either touch layout (phone or tablet): the shared touch tokens and sheet styles key on it. */
export const CLASS_TOUCH_MODE = 'touchMode';
export const CLASS_TRANSITION = 'transition';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Alter an element such that it contains, or doesn't contain, a class name.
 * @param elem The element to alter.
 * @param className The class name.
 * @param state TRUE => ensure the element has the class, FALSE => ensure it doesn't.
 * @returns TRUE => the element was altered, FALSE => no change was required.
 */
export function alterClass(elem: Element, className: string, state: boolean) {
	if (elem.classList.contains(className) !== state) {
		if (state) {
			elem.classList.add(className);
		} else {
			elem.classList.remove(className);
		}
		return true;
	}
	return false;
}

/**
 * Remove a class name from every element under `root` that carries it (a snapshot is taken
 * first: the live collection would shrink while it is being altered).
 */
export function removeClassFromAll(root: Document | Element, className: string) {
	const elems = Array.prototype.slice.call(root.getElementsByClassName(className)) as Element[];
	for (let i = 0; i < elems.length; i++) elems[i].classList.remove(className);
}

/**
 * Add an event listener to every element under `root` carrying a class name.
 */
export function addListenerToClass(root: Document | Element, className: string, event: string, listener: EventListener) {
	const elems = root.getElementsByClassName(className);
	for (let i = 0; i < elems.length; i++) elems[i].addEventListener(event, listener);
}

/**
 * Add an event listener to every element of a collection.
 */
export function addListenerToCollectionElems(elems: HTMLCollection, event: string, listener: EventListener) {
	for (let i = 0; i < elems.length; i++) elems[i].addEventListener(event, listener);
}

/** Insert an element directly after a reference element (as a sibling). */
export function insertAfter(newNode: Element, referenceNode: Element) {
	referenceNode.parentNode!.insertBefore(newNode, referenceNode.nextSibling);
}

/** Insert an element before the first child of `parent` carrying a class name (or at the end). */
export function insertBeforeFirstChildWithClass(newChild: Element, parent: Element, className: string) {
	let referenceNode: Node | null = null;
	for (let i = 0; i < parent.children.length; i++) {
		if (parent.children[i].classList.contains(className)) {
			referenceNode = parent.children[i];
			break;
		}
	}
	parent.insertBefore(newChild, referenceNode);
}

/** Recursively collect the descendant leaf nodes of a node that have text content. */
export function getChildNodesWithTextContent(elem: Node) {
	const textChildren: Node[] = [];
	for (let i = 0; i < elem.childNodes.length; i++) {
		if (elem.childNodes[i].childNodes.length > 0) {
			textChildren.push(...getChildNodesWithTextContent(elem.childNodes[i]));
		} else if (elem.childNodes[i].textContent !== null && elem.childNodes[i].textContent !== '') {
			textChildren.push(elem.childNodes[i]);
		}
	}
	return textChildren;
}

/** Recursively collect the descendant leaf elements of an element whose class name is exactly `className`. */
export function getChildrenWithClassName(elem: Element, className: string) {
	const children: Element[] = [];
	for (let i = 0; i < elem.children.length; i++) {
		if (elem.children[i].children.length > 0) {
			children.push(...getChildrenWithClassName(elem.children[i], className));
		} else if (elem.children[i].className === className) {
			children.push(elem.children[i]);
		}
	}
	return children;
}

/** The first child of an element that is a `<ul>`, or NULL. */
export function getChildUl(elem: Element) {
	for (let i = 0; i < elem.children.length; i++) {
		if (elem.children[i].tagName === 'UL') return <HTMLUListElement>elem.children[i];
	}
	return null;
}

/** Register that an event has been handled: prevent its default behaviour and further propagation. */
export function handledEvent(event: Event) {
	event.preventDefault();
	event.stopPropagation();
}

/**
 * Make a non-native button (e.g. a `<div role="button">`) activate on Enter / Space, the way a
 * real `<button>` does.
 * @param group When given (a component's listener store, F3), the keydown listener is registered
 * there and removed with it; otherwise the listener lives on the element itself.
 */
export function makeKeyboardActivatable(elem: HTMLElement, group?: ListenerGroup) {
	if (elem.getAttribute('role') === null) elem.setAttribute('role', 'button');
	if (elem.tabIndex < 0) elem.tabIndex = 0;
	const listener: EventListener = (e) => {
		const key = (<KeyboardEvent>e).key;
		if (key === 'Enter' || key === ' ') {
			elem.click();
			handledEvent(e);
		}
	};
	if (group !== undefined) {
		group.add(elem, 'keydown', listener);
	} else {
		elem.addEventListener('keydown', listener);
	}
}

/** `makeKeyboardActivatable` for every element under `root` matching a selector. */
export function makeKeyboardActivatableCollection(root: ParentNode, selector: string) {
	const elems = root.querySelectorAll<HTMLElement>(selector);
	for (let i = 0; i < elems.length; i++) makeKeyboardActivatable(elems[i]);
}

/**
 * Initialise the scroll position of an element and observe its scrolling: `onScroll` runs on
 * every scroll, `onScrolled` once the scrolling has rested for 250 ms (when the position should
 * be saved).
 * @param group When given (a component's listener store), the scroll listener is registered
 * there and removed with it; otherwise it lives on the element itself.
 */
export function observeElemScroll(elem: HTMLElement | null, initialScrollTop: number, onScroll: (scrollTop: number) => void, onScrolled: () => void, group?: ListenerGroup) {
	if (elem === null) return;
	let timeout: number | null = null;
	elem.scroll(0, initialScrollTop);
	// Passive: the handler never prevents the default scroll
	const listener = () => {
		onScroll(elem.scrollTop);
		if (timeout !== null) window.clearTimeout(timeout);
		timeout = window.setTimeout(() => {
			onScrolled();
			timeout = null;
		}, 250);
	};
	if (group !== undefined) {
		group.add(elem, 'scroll', listener, { passive: true });
	} else {
		elem.addEventListener('scroll', listener, { passive: true });
	}
}

/** The value of a VS Code theme variable set on the document element. */
export function getVSCodeStyle(name: string) {
	return document.documentElement.style.getPropertyValue(name);
}

/**
 * Event listeners that are removed together. Replaces `addEventListener(..., { signal })`, which
 * Chromium only supports from version 90 (the VS Code 1.38 floor is 69, where the option is
 * silently ignored and the listeners would stack up).
 */
export class ListenerGroup {
	private readonly listeners: Array<{ target: EventTarget, type: string, listener: EventListener, options: boolean | AddEventListenerOptions | undefined }> = [];

	public add(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) {
		target.addEventListener(type, listener, options);
		this.listeners.push({ target: target, type: type, listener: listener, options: options });
	}

	public removeAll() {
		for (let i = 0; i < this.listeners.length; i++) {
			const entry = this.listeners[i];
			entry.target.removeEventListener(entry.type, entry.listener, entry.options);
		}
		this.listeners.length = 0;
	}
}
