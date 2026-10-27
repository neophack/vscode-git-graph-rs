/**
 * The ui slice: the view-level selections that outlive the data they
 * were made against - the scroll position (persisted with the webview state) and the "Select for
 * Compare" source. The ONLY writer of these fields is this class.
 *
 * Neither field feeds a renderer (the scroll position is an input of the persistence and the
 * first-paint snapshot; the compare source of the context menu's actions), so the actions emit
 * nothing: a renderer subscribed here would only ever schedule renders the view never used to do.
 */

export class UiSlice {
	private scrollTopValue: number = 0;
	private compareSourceHashValue: string | null = null;

	constructor() { }


	/* Reads */

	public get scrollTop(): number {
		return this.scrollTopValue;
	}

	/** The commit selected via "Select for Compare" (persisted with the webview state). */
	public get compareSourceHash(): string | null {
		return this.compareSourceHashValue;
	}


	/* Actions */

	/** Record where the view is scrolled to (the debounced scroll observer). */
	public setScrollTop(scrollTop: number): void {
		this.scrollTopValue = scrollTop;
	}

	/** Set (or clear) the "Select for Compare" source commit (a no-op when already this value). */
	public setCompareSourceHash(hash: string | null): void {
		this.compareSourceHashValue = hash;
	}
}
