const ID_EVENT_CAPTURE_ELEM = 'eventCaptureElem';

/**
 * An overlay covering the view, used to block mouse events (behind a dialog) or to capture them
 * (while a column, the Commit Details View or its divider is being resized).
 *
 * The drag listeners speak POINTER events (pointermove/pointerup/pointercancel), so one code path
 * serves the mouse and a finger or stylus alike. A touch pointer is implicitly captured by the
 * element it went down on (the drag handle, not this overlay), so a drag started with a pointerId
 * retargets that pointer onto the overlay: every move and the lift then arrive here whichever
 * element they started on.
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
	 * @param move Invoked when the pointer moves over the overlay.
	 * @param stop Invoked when the pointer is released over the overlay, or the drag is cancelled.
	 * @param pointerId The pointer that started the drag (a touch or stylus is captured onto the
	 * overlay, so its events keep arriving here rather than on the handle it went down on).
	 */
	public create(className: string, move: EventListener | null, stop: EventListener | null, pointerId?: number) {
		if (document.getElementById(ID_EVENT_CAPTURE_ELEM) !== null) this.remove();

		const eventOverlayElem = document.createElement('div');
		eventOverlayElem.id = ID_EVENT_CAPTURE_ELEM;
		eventOverlayElem.className = className;

		this.move = move;
		this.stop = stop;
		if (this.move !== null) {
			eventOverlayElem.addEventListener('pointermove', this.move);
		}
		if (this.stop !== null) {
			eventOverlayElem.addEventListener('pointerup', this.stop);
			eventOverlayElem.addEventListener('pointercancel', this.stop);
		}
		if (pointerId !== undefined) {
			// The pointer may already be gone (a tap so short it lifted before the overlay mounted)
			try { eventOverlayElem.setPointerCapture(pointerId); } catch (e) { /* nothing is dragging then */ }
		}

		this.onCreate();
		document.body.appendChild(eventOverlayElem);
	}

	/** Remove the active event overlay (if any). */
	public remove() {
		const eventOverlayElem = document.getElementById(ID_EVENT_CAPTURE_ELEM);
		if (eventOverlayElem === null) return;

		if (this.move !== null) {
			eventOverlayElem.removeEventListener('pointermove', this.move);
			this.move = null;
		}
		if (this.stop !== null) {
			eventOverlayElem.removeEventListener('pointerup', this.stop);
			eventOverlayElem.removeEventListener('pointercancel', this.stop);
			this.stop = null;
		}

		document.body.removeChild(eventOverlayElem);
	}
}
