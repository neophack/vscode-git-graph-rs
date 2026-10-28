/**
 * The picture comparison view: old picture | pixel difference | new picture, rendered from data
 * URLs the extension host builds out of the two git sides; the difference canvas is computed in
 * the webview.
 */

import { html, raw, setHtml } from '../common/html';
import { measureClientSize } from '../common/measure';
import type { BinaryCompareRequest, BinaryCompareResponse } from '../../shared/protocol/binaryCompare';
import { compareMarkup, compareStrings as s, format } from './strings';
import { frame } from './hexView';

/** One decoded side, or the marker of a side that failed to decode. */
export type SideImage = HTMLImageElement | 'error' | null;

/** The difference engine's result: one Uint8 per-pixel maximum channel delta (0..255, 255 where a
 *  pixel has no counterpart) plus the sum of squared RGB deltas for the MSE. Everything the
 *  display modes and the statistics need is derived from these, so changing the tolerance,
 *  amplification or mode never re-decodes the images. */
export interface ImageDiff {
	readonly map: Uint8Array;
	readonly sumSquares: number;
	readonly total: number;
	readonly width: number;
	readonly height: number;
}

interface ImageEls {
	stats: HTMLElement;
	zoomLabel: HTMLElement;
	scroller: HTMLElement;
	row: HTMLElement;
	oldHolder: HTMLElement;
	diffHolder: HTMLElement;
	newHolder: HTMLElement;
	oldCaption: HTMLElement;
	newCaption: HTMLElement;
	modeSel: HTMLSelectElement;
	amplifyRow: HTMLElement;
	amplifyRange: HTMLInputElement;
	amplifyVal: HTMLElement;
	blendRow: HTMLElement;
	blendRange: HTMLInputElement;
	blendVal: HTMLElement;
	toleranceRange: HTMLInputElement;
	toleranceVal: HTMLElement;
}

export interface ImageViewEnv {
	/** The element the views render into (the page's #diffArea). */
	readonly root: HTMLElement;
	/** Post a protocol request to the extension host. */
	send(message: BinaryCompareRequest): void;
	/** The view failed to load: show the localised error in place of the view. */
	onError(text: string): void;
	/** Enter the hex view of the file at the given index. */
	switchToHex(index: number): void;
}

export class ImageView {
	public active = false;
	private index = -1;
	private zoomMode = -1;
	private scale = 1;
	private oldImage: SideImage = null;
	private newImage: SideImage = null;
	private oldBytes = -1;
	private newBytes = -1;
	private diff: ImageDiff | null = null;
	private mode = 'enhanced';
	private amplify = 10;
	private tolerance = 0;
	private blend = 0.5;
	private blinkTimer: ReturnType<typeof setInterval> | null = null;
	private blinkSide = 0;
	private renderQueued = false;
	private els: ImageEls | null = null;

	public constructor(private readonly env: ImageViewEnv) {}

	/** Enter the picture view of the file at `index`, resetting every piece of view state. */
	public enter(index: number) {
		this.active = true;
		this.index = index;
		this.zoomMode = -1;
		this.oldImage = null;
		this.newImage = null;
		this.diff = null;
		this.mode = 'enhanced';
		this.amplify = 10;
		this.tolerance = 0;
		this.blend = 0.5;
		this.stopBlink();
		const root = this.env.root;
		root.className = 'imgMode';
		setHtml(root, html`<div id="imgWrap">
			<div id="imgToolbar">
				<span id="imgStats">${raw(compareMarkup('compareLoadingDiff'))}</span>
				<span class="hxSpacer"></span>
				<button id="imgZoomOutBtn" title="${s.compareImageZoomOut}">&minus;</button>
				<span id="imgZoomLabel"></span>
				<button id="imgZoomInBtn" title="${s.compareImageZoomIn}">+</button>
				<button id="imgZoomFitBtn">${s.compareImageZoomFit}</button>
				<button id="imgZoomFullBtn">1:1</button>
				<button id="imgHexBtn">${s.compareHexToggleButton}</button>
				<div id="imgControls">
					<select id="imgModeSel">
						<option value="enhanced">${s.compareImageModeEnhanced}</option>
						<option value="difference">${s.compareImageModeDifference}</option>
						<option value="blend">${s.compareImageModeBlend}</option>
						<option value="highlight">${s.compareImageModeHighlight}</option>
						<option value="blink">${s.compareImageModeBlink}</option>
					</select>
					<label id="imgAmplifyRow">${s.compareImageAmplify} <input type="range" id="imgAmplifyRange" min="1" max="32" step="1" value="10"><span id="imgAmplifyVal">&times;10</span></label>
					<label id="imgBlendRow" class="hidden">${s.compareImageBlendAlpha} <input type="range" id="imgBlendRange" min="0" max="100" step="1" value="50"><span id="imgBlendVal">50%</span></label>
					<label>${s.compareImageTolerance} <input type="range" id="imgToleranceRange" min="0" max="128" step="1" value="0"><span id="imgToleranceVal">0</span></label>
				</div>
			</div>
			<div id="imgScroller"><div id="imgRow">
				<div class="imgPane"><div class="imgCaption" id="imgOldCaption">${s.compareImageCaptionOld}</div><div class="imgHolder" id="imgOldHolder"></div></div>
				<div class="imgPane"><div class="imgCaption">${s.compareImageCaptionDiff}</div><div class="imgHolder" id="imgDiffHolder"></div></div>
				<div class="imgPane"><div class="imgCaption" id="imgNewCaption">${s.compareImageCaptionNew}</div><div class="imgHolder" id="imgNewHolder"></div></div>
			</div></div>
		</div>`);
		this.els = {
			stats: byId('imgStats'),
			zoomLabel: byId('imgZoomLabel'),
			scroller: byId('imgScroller'),
			row: byId('imgRow'),
			oldHolder: byId('imgOldHolder'),
			diffHolder: byId('imgDiffHolder'),
			newHolder: byId('imgNewHolder'),
			oldCaption: byId('imgOldCaption'),
			newCaption: byId('imgNewCaption'),
			modeSel: <HTMLSelectElement>byId('imgModeSel'),
			amplifyRow: byId('imgAmplifyRow'),
			amplifyRange: <HTMLInputElement>byId('imgAmplifyRange'),
			amplifyVal: byId('imgAmplifyVal'),
			blendRow: byId('imgBlendRow'),
			blendRange: <HTMLInputElement>byId('imgBlendRange'),
			blendVal: byId('imgBlendVal'),
			toleranceRange: <HTMLInputElement>byId('imgToleranceRange'),
			toleranceVal: byId('imgToleranceVal')
		};
		byId('imgZoomOutBtn').addEventListener('click', () => { this.zoomBy(1 / 1.25); });
		byId('imgZoomInBtn').addEventListener('click', () => { this.zoomBy(1.25); });
		byId('imgZoomFitBtn').addEventListener('click', () => { this.zoomMode = -1; this.applyZoom(); });
		byId('imgZoomFullBtn').addEventListener('click', () => { this.zoomMode = 1; this.applyZoom(); });
		byId('imgHexBtn').addEventListener('click', () => { this.env.switchToHex(this.index); });
		this.els.modeSel.addEventListener('change', () => { this.setMode(this.els === null ? 'enhanced' : this.els.modeSel.value, this.amplify, this.tolerance, this.blend); });
		this.els.amplifyRange.addEventListener('input', () => {
			if (this.els === null) return;
			this.amplify = parseInt(this.els.amplifyRange.value, 10) || 1;
			this.els.amplifyVal.textContent = '\u00D7' + this.amplify;
			this.queueRender();
		});
		this.els.blendRange.addEventListener('input', () => {
			if (this.els === null) return;
			this.blend = (parseInt(this.els.blendRange.value, 10) || 0) / 100;
			this.els.blendVal.textContent = this.els.blendRange.value + '%';
			this.queueRender();
		});
		this.els.toleranceRange.addEventListener('input', () => {
			if (this.els === null) return;
			this.tolerance = parseInt(this.els.toleranceRange.value, 10) || 0;
			this.els.toleranceVal.textContent = String(this.tolerance);
			this.updateStats();
			this.queueRender();
		});
		this.env.send({ command: 'getImageData', index: index });
	}

	/** Leave the view (another view entered, or the view errored). */
	public leave() {
		this.active = false;
		this.els = null;
		this.stopBlink();
	}

	/** A window resize: re-fit when the fit mode is active. */
	public onResize() {
		if (this.active && this.zoomMode < 0) this.applyZoom();
	}

	/** Route one protocol response into the view. Returns TRUE when handled. */
	public handle(msg: BinaryCompareResponse): boolean {
		if (msg.command !== 'imageData') return false;
		if (!this.active || msg.index !== this.index) return true;
		if (msg.error !== null) {
			this.stopBlink();
			this.leave();
			this.env.onError(msg.error);
			return true;
		}
		this.oldBytes = msg.oldSize;
		this.newBytes = msg.newSize;
		void Promise.all([loadImage(msg.oldData), loadImage(msg.newData)]).then((images) => {
			if (!this.active || msg.index !== this.index) return;
			this.oldImage = images[0];
			this.newImage = images[1];
			this.renderImages();
		});
		return true;
	}

	/** Place the decoded sides (the message flow after loadImage, and the tests). */
	public setImages(oldImage: SideImage, newImage: SideImage) {
		this.oldImage = oldImage;
		this.newImage = newImage;
	}

	/** The active display state (the tests drive it the way the controls do). */
	public setMode(mode: string, amplify: number, tolerance: number, blend?: number) {
		this.mode = mode;
		this.amplify = amplify;
		this.tolerance = tolerance;
		if (blend !== undefined) this.blend = blend;
		this.stopBlink();
		if (this.els !== null) {
			this.els.amplifyRow.classList.toggle('hidden', mode !== 'enhanced');
			this.els.blendRow.classList.toggle('hidden', mode !== 'blend');
		}
		if (mode === 'blink') this.startBlink();
		else this.queueRender();
	}

	private stopBlink() {
		if (this.blinkTimer !== null) {
			clearInterval(this.blinkTimer);
			this.blinkTimer = null;
		}
	}

	private startBlink() {
		if (this.blinkTimer !== null || this.diff === null) return;
		this.blinkSide = 0;
		this.drawBlinkFrame();
		this.blinkTimer = setInterval(() => {
			this.blinkSide = 1 - this.blinkSide;
			this.drawBlinkFrame();
		}, 600);
	}

	private drawBlinkFrame() {
		if (!this.active || this.els === null) return;
		const canvas = <HTMLCanvasElement | null>this.els.diffHolder.firstChild;
		if (canvas === null || canvas.tagName !== 'CANVAS') return;
		const ctx = canvas.getContext('2d');
		if (ctx === null) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const image = this.blinkSide === 0 ? this.oldImage : this.newImage;
		if (image !== null && image !== 'error') ctx.drawImage(image, 0, 0);
	}

	private queueRender() {
		if (this.renderQueued) return;
		this.renderQueued = true;
		frame(() => {
			this.renderQueued = false;
			this.renderDiffPane();
		});
	}

	/** Paint the middle pane in the active mode. */
	public renderDiffPane() {
		if (!this.active || this.els === null || this.diff === null) return;
		const width = this.diff.width, height = this.diff.height;
		let canvas = <HTMLCanvasElement | null>this.els.diffHolder.firstChild;
		if (canvas === null || canvas.tagName !== 'CANVAS' || canvas.width !== width || canvas.height !== height) {
			canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			setHtml(this.els.diffHolder, html``);
			this.els.diffHolder.appendChild(canvas);
		}
		if (this.mode === 'blink') {
			this.drawBlinkFrame();
			this.applyZoom();
			return;
		}
		const ctx = canvas.getContext('2d');
		if (ctx === null) return;
		if (this.mode === 'blend' || this.mode === 'highlight') {
			// The picture-based modes need the decoded pixels again; re-read from the images.
			const oldSize = paneSize(this.oldImage), newSize = paneSize(this.newImage);
			const a = readSidePixels(this.oldImage, width, height);
			const b = this.mode === 'blend' ? readSidePixels(this.newImage, width, height) : null;
			const out = ctx.createImageData(width, height);
			for (let y = 0; y < height; y++) {
				const rowOld = y < oldSize.h, rowNew = y < newSize.h;
				for (let x = 0; x < width; x++) {
					const p = y * width + x, i = p * 4;
					const inOld = rowOld && x < oldSize.w, inNew = rowNew && x < newSize.w;
					if (this.mode === 'blend') {
						// Alpha blend between the sides: identical pictures stay still, a moved
						// or edited region shows up as a ghost.
						if (inOld && inNew && b !== null) {
							out.data[i] = Math.round(this.blend * a[i] + (1 - this.blend) * b[i]);
							out.data[i + 1] = Math.round(this.blend * a[i + 1] + (1 - this.blend) * b[i + 1]);
							out.data[i + 2] = Math.round(this.blend * a[i + 2] + (1 - this.blend) * b[i + 2]);
							out.data[i + 3] = Math.round(this.blend * a[i + 3] + (1 - this.blend) * b[i + 3]);
						} else if (inOld) {
							out.data[i] = a[i]; out.data[i + 1] = a[i + 1]; out.data[i + 2] = a[i + 2]; out.data[i + 3] = a[i + 3];
						} else if (inNew && b !== null) {
							out.data[i] = b[i]; out.data[i + 1] = b[i + 1]; out.data[i + 2] = b[i + 2]; out.data[i + 3] = b[i + 3];
						}
					} else {
						// Highlight: the original picture with the differing pixels dyed red.
						if (inOld) {
							// A flat saturated red: mixing the dye from the base pixel's own
							// channels left the mark proportional to the pixel's darkness, so
							// large changes on bright areas washed out to pale pink while small
							// changes on dark ones glared - visibility must not depend on what
							// lies underneath.
							const dye = this.diff.map[p] > this.tolerance;
							out.data[i] = dye ? 255 : a[i];
							out.data[i + 1] = dye ? 0 : a[i + 1];
							out.data[i + 2] = dye ? 0 : a[i + 2];
							out.data[i + 3] = 255;
						} else if (inNew) {
							out.data[i] = 170; out.data[i + 1] = 170; out.data[i + 2] = 170; out.data[i + 3] = 255;
						}
					}
				}
			}
			ctx.putImageData(out, 0, 0);
		} else {
			// The magnitude modes: the per-pixel delta as greyscale, amplified by the chosen
			// factor so that small differences become visible, and blanked below the tolerance.
			const factor = this.mode === 'enhanced' ? this.amplify : 1;
			const out = ctx.createImageData(width, height);
			for (let p = 0; p < this.diff.total; p++) {
				const value = this.diff.map[p] > this.tolerance ? Math.min(255, this.diff.map[p] * factor) : 0;
				const i = p * 4;
				out.data[i] = value;
				out.data[i + 1] = value;
				out.data[i + 2] = value;
				out.data[i + 3] = 255;
			}
			ctx.putImageData(out, 0, 0);
		}
		this.applyZoom();
	}

	/** The statistics line, recomputed from the delta map whenever the tolerance moves. */
	public updateStats() {
		if (this.els === null) return;
		if (this.diff === null) {
			this.els.stats.textContent = s.compareImageDecodeError;
			this.els.stats.title = '';
			return;
		}
		let count = 0, maxDelta = 0, sumDelta = 0;
		for (let p = 0; p < this.diff.total; p++) {
			const delta = this.diff.map[p];
			if (delta > this.tolerance) {
				count++;
				sumDelta += delta;
				if (delta > maxDelta) maxDelta = delta;
			}
		}
		if (count === 0) {
			this.els.stats.textContent = s.compareImageNoDifferences;
			this.els.stats.title = '';
			return;
		}
		const mse = this.diff.sumSquares / this.diff.total;
		const psnr = mse > 0 ? (10 * Math.log10(255 * 255 / mse)).toFixed(1) : '\u221E';
		const stats = format(compareMarkup('compareImageStatsTpl'),
			count.toLocaleString(), (count * 100 / this.diff.total).toFixed(2), String(maxDelta),
			(sumDelta / count).toFixed(2), mse.toFixed(2), psnr);
		setHtml(this.els.stats, raw(stats));
		this.els.stats.title = this.els.stats.textContent;
	}

	/** Render both panes and the difference, then apply the zoom (the message flow's completion,
	 *  and the tests' entry point). */
	public renderImages() {
		if (!this.active || this.els === null) return;
		const place = (image: SideImage, holder: HTMLElement) => {
			setHtml(holder, html``);
			if (image !== null && image !== 'error') holder.appendChild(image);
		};
		place(this.oldImage, this.els.oldHolder);
		place(this.newImage, this.els.newHolder);
		setHtml(this.els.diffHolder, html``);
		const dim = (size: { w: number, h: number }, bytes: number) => {
			return (size.w > 0 ? size.w + ' \u00D7 ' + size.h : '\u2014') + (bytes >= 0 ? ' \u00B7 ' + size.toLocaleString() + ' B' : '');
		};
		this.els.oldCaption.textContent = s.compareImageCaptionOld + ' \u00B7 ' + dim(paneSize(this.oldImage), this.oldBytes);
		this.els.newCaption.textContent = s.compareImageCaptionNew + ' \u00B7 ' + dim(paneSize(this.newImage), this.newBytes);
		this.diff = computeImageDiff(this.oldImage, this.newImage);
		if (this.diff !== null) {
			this.renderDiffPane(); // creates and sizes the difference canvas in every mode
			if (this.mode === 'blink') this.startBlink();
			this.updateStats();
		} else {
			this.els.stats.textContent = s.compareImageDecodeError;
		}
		this.applyZoom();
	}

	/** The difference engine's result (NULL when a side failed to decode). */
	public diffResult(): ImageDiff | null {
		return this.diff;
	}

	private applyZoom() {
		if (!this.active || this.els === null) return;
		const width = Math.max(paneSize(this.oldImage).w, paneSize(this.newImage).w);
		const height = Math.max(paneSize(this.oldImage).h, paneSize(this.newImage).h);
		if (width === 0 || height === 0) return;
		if (this.zoomMode < 0) {
			// Fit: the three panes side by side in the viewport; small pictures scale up to use
			// the available space (capped, and pixelated so scaled pixels stay crisp).
			const scrollerSize = measureClientSize(this.els.scroller);
			this.scale = Math.min((scrollerSize.width - 56) / (3 * width), (scrollerSize.height - 64) / height);
			this.scale = Math.min(4, Math.max(0.05, this.scale));
		} else {
			this.scale = this.zoomMode;
		}
		this.els.row.classList.toggle('zoomed', this.scale > 1);
		const media = this.els.row.querySelectorAll('img, canvas');
		for (let i = 0; i < media.length; i++) {
			const element = <HTMLElement>media[i];
			const naturalWidth = element.tagName === 'IMG' ? (<HTMLImageElement>element).naturalWidth : (<HTMLCanvasElement>element).width;
			element.style.width = Math.max(1, Math.round(naturalWidth * this.scale)) + 'px';
		}
		this.els.zoomLabel.textContent = this.zoomMode < 0 ? s.compareImageZoomFit : Math.round(this.scale * 100) + '%';
	}

	private zoomBy(factor: number) {
		this.zoomMode = Math.min(8, Math.max(0.05, (this.zoomMode < 0 ? this.scale : this.zoomMode) * factor));
		this.applyZoom();
	}
}

/** Decode one side; NULL means the side does not exist, 'error' a failed decode. */
function loadImage(dataUrl: string | null): Promise<SideImage> {
	if (dataUrl === null) return Promise.resolve(null);
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => { resolve(image); };
		image.onerror = () => { resolve('error'); };
		image.src = dataUrl;
	});
}

function paneSize(image: SideImage): { w: number, h: number } {
	return image === null || image === 'error' ? { w: 0, h: 0 } : { w: image.naturalWidth, h: image.naturalHeight };
}

function readSidePixels(image: SideImage, width: number, height: number): Uint8ClampedArray {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	// An added or deleted picture has a missing side: draw nothing (drawImage throws on null),
	// leaving the fresh canvas' transparent black, which the edge logic of computeImageDiff
	// already treats as maximally different.
	if (ctx !== null && image !== null && image !== 'error') ctx.drawImage(image, 0, 0);
	return ctx !== null ? ctx.getImageData(0, 0, width, height).data : new Uint8ClampedArray(width * height * 4);
}

/**
 * The difference engine: decode both sides over the union size and reduce them to one
 * maximum-channel-delta per pixel (0..255; 255 where a pixel has no counterpart on the other
 * side) plus the accumulated squared RGB error for the MSE.
 */
export function computeImageDiff(oldImage: SideImage, newImage: SideImage): ImageDiff | null {
	const oldSize = paneSize(oldImage), newSize = paneSize(newImage);
	const width = Math.max(oldSize.w, newSize.w), height = Math.max(oldSize.h, newSize.h);
	if (width === 0 || height === 0 || oldImage === 'error' || newImage === 'error') return null;
	const a = readSidePixels(oldImage, width, height);
	const b = readSidePixels(newImage, width, height);
	const map = new Uint8Array(width * height);
	let sumSquares = 0;
	for (let y = 0; y < height; y++) {
		const rowOld = y < oldSize.h, rowNew = y < newSize.h;
		for (let x = 0; x < width; x++) {
			const p = y * width + x;
			if (rowOld && rowNew && x < oldSize.w && x < newSize.w) {
				const i = p * 4;
				const dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]), db = Math.abs(a[i + 2] - b[i + 2]);
				const delta = Math.max(dr, dg, db, Math.abs(a[i + 3] - b[i + 3]));
				map[p] = delta;
				sumSquares += (dr * dr + dg * dg + db * db) / 3;
			} else if ((rowOld && x < oldSize.w) || (rowNew && x < newSize.w)) {
				map[p] = 255; // beyond one side's edge: no counterpart at all
				sumSquares += 255 * 255;
			}
		}
	}
	return { map: map, sumSquares: sumSquares, total: width * height, width: width, height: height };
}

function byId(id: string): HTMLElement {
	const el = document.getElementById(id);
	return el !== null ? el : document.createElement('div');
}
