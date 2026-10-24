/**
 * Resizes images for the view (e.g. commit author avatars).
 */
export class ImageResizer {
	private canvas: HTMLCanvasElement | null = null;
	private context: CanvasRenderingContext2D | null = null;

	/**
	 * Resize an image to an effective resolution of 18px x 18px (the actual resolution follows the
	 * screen's pixel ratio).
	 * @param dataUri The data URI of the image.
	 * @param callback Invoked with the data URI of the resized image.
	 */
	public resize(dataUri: string, callback: (dataUri: string) => void) {
		if (this.canvas === null) this.canvas = document.createElement('canvas');
		if (this.context === null) this.context = this.canvas.getContext('2d');
		if (this.context === null) {
			callback(dataUri);
			return;
		}

		const image = new Image();
		image.onload = () => {
			let outputDataUri = '';
			if (this.canvas === null || this.context === null) {
				outputDataUri = dataUri;
			} else {
				const size = Math.ceil(18 * window.devicePixelRatio);
				if (this.canvas.width !== size) this.canvas.width = size;
				if (this.canvas.height !== size) this.canvas.height = size;
				this.context.clearRect(0, 0, size, size);
				this.context.drawImage(image, 0, 0, size, size);
				outputDataUri = this.canvas.toDataURL();
			}
			callback(outputDataUri);
		};
		image.src = dataUri;
	}
}
