// @vitest-environment jsdom
/**
 * The picture-difference half of the binary comparison frontend: these cases
 * drive ImageView and computeImageDiff directly, in a jsdom whose canvas behaves like the Chromium
 * one the real page draws into - including drawing pixels from the decoded sides, which is
 * precisely how the missing-side crash surfaced.
 */

import { describe, expect, it } from 'vitest';

import { ImageView, SideImage } from './imageView';
import { compareStrings } from './strings';

/** A canvas context stub: RGBA copies of the drawn image, and the last putImageData kept for asserts. */
type PaintTracker = HTMLCanvasElement & { __paint: { width: number, height: number, data: Uint8ClampedArray } | null };

function installCanvasStub() {
	const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown };
	proto.getContext = function (this: HTMLCanvasElement) {
		const canvas = this;
		const tracking = canvas as PaintTracker;
		if (tracking.__ctx !== undefined) return tracking.__ctx;
		const target = () => {
			if (tracking.__backing === undefined) tracking.__backing = new Uint8ClampedArray(canvas.width * canvas.height * 4);
			return tracking.__backing as Uint8ClampedArray;
		};
		const ctx = {
			drawImage(image: { naturalWidth: number, naturalHeight: number, __pixels: Uint8Array }, dx: number, dy: number) {
				const into = target();
				for (let y = 0; y < image.naturalHeight; y++) {
					for (let x = 0; x < image.naturalWidth; x++) {
						const from = (y * image.naturalWidth + x) * 4;
						const to = ((dy + y) * canvas.width + (dx + x)) * 4;
						into[to] = image.__pixels[from];
						into[to + 1] = image.__pixels[from + 1];
						into[to + 2] = image.__pixels[from + 2];
						into[to + 3] = image.__pixels[from + 3];
					}
				}
			},
			getImageData(x: number, y: number, w: number, h: number) {
				if (x !== 0 || y !== 0) throw new Error('stub canvas only reads from the origin');
				return { width: w, height: h, data: new Uint8ClampedArray(target()) };
			},
			createImageData(w: number, h: number) {
				return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
			},
			putImageData(imageData: { width: number, height: number, data: Uint8ClampedArray }) {
				tracking.__paint = imageData;
			},
			clearRect() { target().fill(0); }
		};
		tracking.__ctx = ctx;
		return ctx;
	};
}

declare global {
	interface HTMLCanvasElement {
		__pixelsBacking?: Uint8ClampedArray;
		__backing?: Uint8ClampedArray;
		__paint: { width: number, height: number, data: Uint8ClampedArray } | null;
		__ctx?: unknown;
	}
}

/** A decoded-picture stand-in: a real element (the view appends it to its pane), carrying exactly
 *  the fields paneSize and the canvas drawImage stub consume. */
function solidImage(width: number, height: number, rgba: ReadonlyArray<number>): SideImage {
	const image = document.createElement('img');
	Object.defineProperty(image, 'naturalWidth', { get: () => width });
	Object.defineProperty(image, 'naturalHeight', { get: () => height });
	const pixels = new Uint8Array(width * height * 4);
	for (let p = 0; p < width * height; p++) pixels.set(rgba, p * 4);
	(<{ __pixels: Uint8Array }><unknown>image).__pixels = pixels;
	return image;
}

function withPixel(image: SideImage, index: number, rgba: ReadonlyArray<number>): SideImage {
	(<{ __pixels: Uint8Array }><unknown>image).__pixels.set(rgba, index * 4);
	return image;
}

/** A page-like environment: the stub root, and the posted requests. */
function makeImageView() {
	document.body.textContent = '';
	installCanvasStub();
	const root = document.createElement('div');
	Object.defineProperty(root, 'clientWidth', { get: () => 1200 });
	const sent: Array<{ command: string }> = [];
	const view = new ImageView({
		root: root,
		send: (message) => { sent.push(JSON.parse(JSON.stringify(message))); },
		onError: (text) => { throw new Error('unexpected load error: ' + text); },
		switchToHex: () => { throw new Error('no hex view in this harness'); }
	});
	document.body.appendChild(root);
	view.enter(0);
	return { view: view, sent: sent };
}

const stats = () => document.getElementById('imgStats')!.textContent;

function diffPaint(): { width: number, height: number, data: Uint8ClampedArray } {
	const canvas = document.getElementById('imgDiffHolder')!.children[0] as PaintTracker;
	expect(canvas).toBeDefined();
	expect(canvas.__paint).not.toBeNull();
	return canvas.__paint!;
}

function pixelsOf(paint: { width: number, height: number, data: Uint8ClampedArray }) {
	const out: Array<[number, number, number, number]> = [];
	for (let p = 0; p < paint.width * paint.height; p++) {
		out.push([paint.data[p * 4], paint.data[p * 4 + 1], paint.data[p * 4 + 2], paint.data[p * 4 + 3]]);
	}
	return out;
}

describe('the picture difference engine', () => {
	it('derives the per-pixel map from the maximum channel delta, alpha included', () => {
		const h = makeImageView();
		const oldImage = solidImage(1, 2, [100, 100, 100, 255]);
		const newImage = solidImage(1, 2, [100, 100, 100, 255]);
		withPixel(oldImage, 0, [110, 100, 95, 255]); // RGB deltas 10/0/5 -> map 10
		withPixel(newImage, 1, [100, 100, 100, 245]); // alpha-only delta 10 -> map 10
		h.view.setImages(oldImage, newImage);
		h.view.renderImages();
		const diff = h.view.diffResult()!;
		expect(Array.from(diff.map)).toEqual([10, 10]);
		expect(diff.total).toBe(2);
		// MSE accumulates the mean of the squared RGB deltas; an alpha-only change adds nothing.
		expect(Math.abs(diff.sumSquares - (10 * 10 + 0 * 0 + 5 * 5) / 3)).toBeLessThan(1e-9);
	});

	it('marks pixels beyond either edge maximally different', () => {
		const h = makeImageView();
		h.view.setImages(solidImage(2, 1, [50, 50, 50, 255]), solidImage(1, 1, [50, 50, 50, 255]));
		h.view.renderImages();
		const diff = h.view.diffResult()!;
		expect(diff.width).toBe(2);
		expect(Array.from(diff.map)).toEqual([0, 255]);
		expect(diff.sumSquares).toBe(255 * 255);
		expect(diff.total).toBe(2);
	});

	it('survives a missing side (an added or deleted picture)', () => {
		const added = makeImageView();
		added.view.setImages(null, solidImage(1, 1, [200, 100, 50, 255]));
		expect(() => added.view.renderImages()).not.toThrow();
		expect(Array.from(added.view.diffResult()!.map)).toEqual([255]);
		expect(stats()).toContain('1 pixels (100.00%)');

		const deleted = makeImageView();
		deleted.view.setImages(solidImage(1, 1, [60, 120, 200, 255]), null);
		expect(() => deleted.view.renderImages()).not.toThrow();
		expect(Array.from(deleted.view.diffResult()!.map)).toEqual([255]);
		// The picture modes re-read the sides; they must tolerate the missing one too.
		deleted.view.setMode('highlight', 10, 0);
		expect(() => deleted.view.renderDiffPane()).not.toThrow();
		expect(pixelsOf(diffPaint())).toEqual([[255, 0, 0, 255]]);
	});

	it('reports identical pictures as having no differences', () => {
		const h = makeImageView();
		h.view.setImages(solidImage(2, 2, [10, 20, 30, 255]), solidImage(2, 2, [10, 20, 30, 255]));
		h.view.renderImages();
		const diff = h.view.diffResult()!;
		expect(diff.sumSquares).toBe(0);
		expect(Array.from(diff.map).every((delta) => delta === 0)).toBe(true);
		h.view.updateStats();
		expect(stats()).toBe(compareStrings.compareImageNoDifferences);
	});

	it('greyscales the delta, amplified and tolerance-filtered', () => {
		const h = makeImageView();
		const oldImage = solidImage(4, 1, [0, 0, 0, 255]);
		const newImage = solidImage(4, 1, [0, 0, 0, 255]);
		const deltas = [3, 26, 100, 255];
		deltas.forEach((delta, index) => withPixel(newImage, index, [delta, 0, 0, 255]));
		h.view.setImages(oldImage, newImage);

		h.view.setMode('enhanced', 10, 0); // default view: x10 saturates everything >= 26
		h.view.renderImages();
		expect(pixelsOf(diffPaint()).map((px) => px[0])).toEqual([30, 255, 255, 255]);

		h.view.setMode('difference', 1, 0); // raw magnitudes
		h.view.renderDiffPane();
		expect(pixelsOf(diffPaint()).map((px) => px[0])).toEqual(deltas);

		h.view.setMode('difference', 1, 30); // deltas within tolerance are blanked
		h.view.renderDiffPane();
		expect(pixelsOf(diffPaint()).map((px) => px[0])).toEqual([0, 0, 100, 255]);
	});

	it('dyes only the differing pixels red in highlight mode', () => {
		const h = makeImageView();
		const oldImage = solidImage(2, 1, [0, 0, 0, 255]);
		withPixel(oldImage, 0, [20, 30, 40, 255]);   // stays exactly as it was
		withPixel(oldImage, 1, [200, 200, 200, 255]); // changes by 10 on red
		const newImage = solidImage(2, 1, [0, 0, 0, 255]);
		withPixel(newImage, 0, [20, 30, 40, 255]);
		withPixel(newImage, 1, [210, 200, 200, 255]);
		h.view.setImages(oldImage, newImage);

		h.view.setMode('highlight', 10, 0);
		h.view.renderImages();
		// Regression: the unchanged pixel must keep its original red channel (it used to be
		// forced to 255, making untouched dark areas glow brighter than real differences).
		expect(pixelsOf(diffPaint())).toEqual([
			[20, 30, 40, 255],
			[255, 0, 0, 255]
		]);

		h.view.setMode('highlight', 10, 16); // the delta of 10 is within tolerance
		h.view.renderDiffPane();
		expect(pixelsOf(diffPaint())).toEqual([
			[20, 30, 40, 255],
			[200, 200, 200, 255]
		]);
	});

	it('dyes every differing pixel the same saturated red, whatever lies beneath', () => {
		const h = makeImageView();
		// A bright background with a dark element: the large change sits on the bright pixel,
		// the small one on the dark pixel.
		const oldImage = solidImage(4, 1, [240, 240, 240, 255]);
		withPixel(oldImage, 2, [25, 25, 25, 255]);
		const newImage = solidImage(4, 1, [240, 240, 240, 255]);
		withPixel(newImage, 0, [0, 0, 0, 255]);  // delta 240 on a bright pixel
		withPixel(newImage, 2, [35, 35, 35, 255]); // delta 10 on a dark pixel
		h.view.setImages(oldImage, newImage);

		h.view.setMode('highlight', 10, 0);
		h.view.renderImages();
		// Regression: the dye used to keep 30% of the base pixel's green/blue, so the large
		// change washed out to pale pink (255,72,72) on bright pictures while the small change
		// on dark ones glared (255,8,8) - the mark's visibility has to be magnitude- and
		// brightness-independent, or big differences read as unhighlighted.
		expect(pixelsOf(diffPaint())).toEqual([
			[255, 0, 0, 255],
			[240, 240, 240, 255],
			[255, 0, 0, 255],
			[240, 240, 240, 255]
		]);
	});

	it('blends the two sides at the chosen ratio', () => {
		const h = makeImageView();
		const oldImage = solidImage(2, 1, [255, 0, 0, 255]);
		withPixel(oldImage, 1, [10, 20, 30, 255]); // old-only pixel: passed through untouched
		const newImage = solidImage(1, 1, [0, 0, 255, 255]);
		h.view.setImages(oldImage, newImage);

		h.view.setMode('blend', 10, 0, 0.5);
		h.view.renderImages();
		expect(pixelsOf(diffPaint())).toEqual([
			[128, 0, 128, 255], // Math.round(0.5 * 255 + 0.5 * 0)
			[10, 20, 30, 255]
		]);

		h.view.setMode('blend', 10, 0, 0.25);
		h.view.renderDiffPane();
		expect(pixelsOf(diffPaint())[0]).toEqual([64, 0, 191, 255]);
	});

	it('summarises count, percentages, MSE and PSNR over the union', () => {
		const h = makeImageView();
		h.view.setImages(solidImage(2, 1, [50, 50, 50, 255]), solidImage(1, 1, [50, 50, 50, 255]));
		h.view.renderImages();
		const text = stats();
		expect(text).toContain('1 pixels (50.00%)');
		expect(text).toContain('max 255');
		expect(text).toContain('avg 255.00');
		expect(text).toContain('MSE 32512.50'); // 255^2 over two union pixels
		expect(text).toContain('PSNR 3.0');     // 10*log10(2)

		h.view.setMode('enhanced', 10, 255); // nothing exceeds a tolerance of 255
		h.view.updateStats();
		expect(stats()).toBe(compareStrings.compareImageNoDifferences);
	});

	it('treats an undecodable side as an error', () => {
		const h = makeImageView();
		h.view.setImages(solidImage(1, 1, [1, 2, 3, 255]), 'error');
		h.view.renderImages();
		expect(h.view.diffResult()).toBeNull();
		expect(stats()).toBe(compareStrings.compareImageDecodeError);
	});
});
