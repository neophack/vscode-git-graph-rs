const ID_EVENT_CAPTURE_ELEM = 'eventCaptureElem';

/**
 * An overlay covering the view, used to block mouse events (behind a dialog) or to capture them
 * (while a column, the Commit Details View or its divider is being resized).
 */
export class EventOverlay {
	private move: EventListener | null = null;
	private stop: EventListener | null = null;

	/**
	 * @param onCreate Invoked whenever an overlay is created (the context menu closes then).
	 */
	constructor(private readonly onCreate: () => void) { }

	/**
	 * Create an event overlay (replacing any existing one).
	 * @param className The class name of the overlay.
	 * @param move Invoked when the mouse moves over the overlay.
	 * @param stop Invoked when the mouse is released over, or leaves, the overlay.
	 */
	public create(className: string, move: EventListener | null, stop: EventListener | null) {
		if (document.getElementById(ID_EVENT_CAPTURE_ELEM) !== null) this.remove();

		const eventOverlayElem = document.createElement('div');
		eventOverlayElem.id = ID_EVENT_CAPTURE_ELEM;
		eventOverlayElem.className = className;

		this.move = move;
		this.stop = stop;
		if (this.move !== null) {
			eventOverlayElem.addEventListener('mousemove', this.move);
		}
		if (this.stop !== null) {
			eventOverlayElem.addEventListener('mouseup', this.stop);
			eventOverlayElem.addEventListener('mouseleave', this.stop);
		}

		this.onCreate();
		document.body.appendChild(eventOverlayElem);
	}

	/** Remove the active event overlay (if any). */
	public remove() {
		const eventOverlayElem = document.getElementById(ID_EVENT_CAPTURE_ELEM);
		if (eventOverlayElem === null) return;

		if (this.move !== null) {
			eventOverlayElem.removeEventListener('mousemove', this.move);
			this.move = null;
		}
		if (this.stop !== null) {
			eventOverlayElem.removeEventListener('mouseup', this.stop);
			eventOverlayElem.removeEventListener('mouseleave', this.stop);
			this.stop = null;
		}

		document.body.removeChild(eventOverlayElem);
	}
}
