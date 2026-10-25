/**
 * The binary comparison area both pages embed: the controller that owns the diff area element and
 * the hex and picture views, enters one of them for a file, routes the protocol responses to the
 * active view, and re-picks layouts on resize. Ported out of the host's template string (task
 * 6.1); the pages (the standalone Binary Compare tab and the Commit Comparison View) differ only
 * in what file they show and which of the two views they enter first.
 */

import { escapeHtml, html, setHtml } from '../common/html';
import type { BinaryCompareRequest, BinaryCompareResponse } from '../../shared/protocol/binaryCompare';
import { HexView } from './hexView';
import { ImageView } from './imageView';

export interface BinaryCompareAreaEnv {
	/** The element the views render into (the page's #diffArea). */
	readonly root: HTMLElement;
	/** Post a protocol request to the extension host. */
	send(message: BinaryCompareRequest): void;
}

export class BinaryCompareArea {
	private readonly hex: HexView;
	private readonly image: ImageView;
	private fileIsImage = false;

	public constructor(private readonly env: BinaryCompareAreaEnv) {
		const root = env.root;
		this.hex = new HexView({
			root: root,
			send: (message) => env.send(message),
			onError: (text) => this.showError(text),
			hasImageView: () => this.fileIsImage,
			switchToImage: (index) => this.enterImage(index)
		});
		this.image = new ImageView({
			root: root,
			send: (message) => env.send(message),
			onError: (text) => this.showError(text),
			switchToHex: (index) => this.enterHex(index)
		});
		/* A window 'resize' event only tracks the OS window being dragged: maximising or restoring
		   it, toggling the side bar and splitting editors all resize the webview without one (or
		   fire it before the webview has re-laid out, when the old width is still measured). The
		   observer reports the area's own box after layout, so every cause is covered. */
		if (typeof ResizeObserver !== 'undefined') {
			new ResizeObserver(() => this.onResize()).observe(root);
		}
		window.addEventListener('resize', () => this.onResize());
	}

	/** Install the document-level input listeners (menu close, drag release): once per page. */
	public installGlobalInput() {
		this.hex.installGlobalInput();
	}

	/** Whether the file the area is about to show can be rendered as a picture (decides which
	 *  view the pages enter, and whether the hex toolbar offers the picture toggle). */
	public setFileIsImage(isImage: boolean) {
		this.fileIsImage = isImage;
	}

	public enterHex(index: number) {
		this.image.leave();
		this.hex.enter(index);
	}

	public enterImage(index: number) {
		this.hex.leave();
		this.image.enter(index);
	}

	/** Leave whichever view is active (the page moved on to a textual file). */
	public leave() {
		this.hex.leave();
		this.image.leave();
		this.env.root.className = '';
	}

	/** Route one protocol response to whichever view is active. Returns TRUE when handled. */
	public handle(msg: BinaryCompareResponse): boolean {
		if (this.hex.handle(msg)) return true;
		return this.image.handle(msg);
	}

	/** A resize of the area: re-pick the hex row width or re-fit the pictures. */
	public onResize() {
		this.hex.onResize();
		this.image.onResize();
	}

	/** The view's load error: show the localised message in place of the view. */
	public showError(text: string) {
		this.env.root.className = '';
		setHtml(this.env.root, html`<div class="status">${escapeHtml(text)}</div>`);
	}
}
