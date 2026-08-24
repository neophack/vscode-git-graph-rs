/**
 * The picture-difference half of the binary comparison.
 *
 * Two layers are tested. The webview engine (computeImageDiff, the display modes and the
 * statistics) normally runs inside a webview page, so these tests execute the exact script
 * string `binaryCompareScript()` produces inside a stub DOM whose canvas behaves like the
 * Chromium one the real page draws into — including throwing TypeError on drawImage(null),
 * which is precisely how the missing-side crash surfaced. The host-side responders are driven
 * against throwaway git repositories, like the hex tests.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from 'node:module';
import { describe, it } from 'node:test';

/* out/binaryCompare.js transitively requires the extension-host-only 'vscode' module (through
   dataSource and i18n). These tests exercise the vscode-free parts, so resolve it to a stub
   whose configuration answers with defaults — which also pins the strings the script bakes in
   to the English dictionary, the same one the imported t() below reads. */
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' }, // interfaceLanguage 'auto' resolves through this
	/* config.js maps configured column names to these at module load time. */
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	workspace: {
		getConfiguration: () => ({
			get: (section, defaultValue) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const { binaryCompareScript, imageMimeOf, isImageChange, respondImageData } = await import('../out/binaryCompare.js');
const { t } = await import('../out/i18n.js');
const { HexDiffSession } = await import('../out/hexDiff.js');

/* ---------- A stub DOM just complete enough for the image view ---------- */

function makeStubElement(tagName) {
	const element = {
		tagName: tagName,
		style: {},
		children: [],
		className: '',
		title: '',
		textContent: '',
		clientWidth: 1000,
		clientHeight: 600,
		classList: { toggle() { } },
		addEventListener() { },
		appendChild(child) { element.children.push(child); return child; },
		removeChild(child) { element.children = element.children.filter((c) => c !== child); },
		getBoundingClientRect: () => ({ width: 336 }),
		querySelectorAll(selector) {
			const wanted = selector.split(',').map((part) => part.trim().toUpperCase());
			return element.children.filter((child) => wanted.includes(child.tagName));
		}
	};
	let html = '';
	Object.defineProperty(element, 'innerHTML', {
		get: () => html,
		set: (value) => { html = String(value); if (html === '') element.children.length = 0; }
	});
	Object.defineProperty(element, 'firstChild', { get: () => element.children[0] ?? null });
	return element;
}

/** A canvas stub: RGBA copies of the drawn image, and the last putImageData kept for asserts. */
function makeStubCanvas() {
	const canvas = makeStubElement('CANVAS');
	let backing = null, context = null;
	const target = () => {
		if (backing === null) backing = new Uint8ClampedArray(canvas.width * canvas.height * 4);
		return backing;
	};
	canvas.getContext = function () {
		if (context !== null) return context;
		context = {
			drawImage(image, dx, dy) {
				if (image === null || image === undefined) {
					throw new TypeError('drawImage: parameter 1 is not of type CanvasImageSource');
				}
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
			getImageData(x, y, w, h) {
				if (x !== 0 || y !== 0) throw new Error('stub canvas only reads from the origin');
				return { width: w, height: h, data: new Uint8ClampedArray(target()) };
			},
			createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
			putImageData(imageData) { canvas.__paint = imageData; },
			clearRect() { target().fill(0); }
		};
		return context;
	};
	canvas.__paint = null;
	return canvas;
}

/** A decoded-picture stand-in: exactly what paneSize and the canvas drawImage stub consume. */
function solidImage(width, height, rgba) {
	const pixels = new Uint8Array(width * height * 4);
	for (let p = 0; p < width * height; p++) pixels.set(rgba, p * 4);
	return { naturalWidth: width, naturalHeight: height, __pixels: pixels };
}

function withPixel(image, index, rgba) {
	image.__pixels.set(rgba, index * 4);
	return image;
}

/**
 * Run the real webview script once and hand back its entry points plus hooks into the module
 * scope only the page's own code normally reaches.
 */
function makeHarness() {
	const posted = [];
	const elements = new Map();
	const document = {
		body: makeStubElement('BODY'),
		getElementById(id) {
			if (!elements.has(id)) elements.set(id, makeStubElement('DIV'));
			return elements.get(id);
		},
		createElement(tag) { return tag.toLowerCase() === 'canvas' ? makeStubCanvas() : makeStubElement(tag.toUpperCase()); }
	};
	const factory = new Function('vscode', 'diffArea', 'document', 'window', 'Image', 'requestAnimationFrame',
		binaryCompareScript() + `;return {
			enterImageView: enterImageView,
			test: {
				setImages: (oldImage, newImage) => { imgOld = oldImage; imgNew = newImage; },
				setState: (mode, amplify, tolerance, blend) => {
					imgMode = mode; imgAmplify = amplify; imgTolerance = tolerance;
					if (blend !== undefined) imgBlend = blend;
				},
				render: () => renderImages(),
				renderPane: () => renderDiffPane(),
				refreshStats: () => updateImageStats(),
				diff: () => imgDiff,
				els: () => imgEls
			}
		};`);
	const api = factory(
		{ postMessage: (message) => { posted.push(message); } },
		makeStubElement('DIV'),
		document,
		{ addEventListener() { } },
		function StubImage() { },
		(fn) => { fn(); }
	);
	api.enterImageView(0);
	return {
		api: api,
		posted: posted,
		stats: () => elements.get('imgStats').innerHTML,
		diffPaint: () => {
			const canvas = elements.get('imgDiffHolder').children[0];
			assert.ok(canvas !== undefined, 'the difference pane must hold a canvas');
			assert.ok(canvas.__paint !== null, 'the difference canvas must have been painted');
			return canvas.__paint;
		},
		pixelsOf: (paint) => {
			const out = [];
			for (let p = 0; p < paint.width * paint.height; p++) {
				out.push([paint.data[p * 4], paint.data[p * 4 + 1], paint.data[p * 4 + 2], paint.data[p * 4 + 3]]);
			}
			return out;
		}
	};
}

/* ---------- The webview difference engine ---------- */

describe('the picture difference engine', () => {
	it('derives the per-pixel map from the maximum channel delta, alpha included', () => {
		const harness = makeHarness();
		const oldImage = solidImage(1, 2, [100, 100, 100, 255]);
		const newImage = solidImage(1, 2, [100, 100, 100, 255]);
		withPixel(oldImage, 0, [110, 100, 95, 255]); // RGB deltas 10/0/5 -> map 10
		withPixel(newImage, 1, [100, 100, 100, 245]); // alpha-only delta 10 -> map 10
		harness.api.test.setImages(oldImage, newImage);
		harness.api.test.render();
		const diff = harness.api.test.diff();
		assert.deepEqual(Array.from(diff.map), [10, 10]);
		assert.equal(diff.total, 2);
		// MSE accumulates the mean of the squared RGB deltas; an alpha-only change adds nothing.
		assert.ok(Math.abs(diff.sumSquares - (10 * 10 + 0 * 0 + 5 * 5) / 3) < 1e-9);
	});

	it('marks pixels beyond either edge maximally different', () => {
		const harness = makeHarness();
		harness.api.test.setImages(solidImage(2, 1, [50, 50, 50, 255]), solidImage(1, 1, [50, 50, 50, 255]));
		harness.api.test.render();
		const diff = harness.api.test.diff();
		assert.equal(diff.width, 2);
		assert.deepEqual(Array.from(diff.map), [0, 255]);
		assert.equal(diff.sumSquares, 255 * 255);
		assert.equal(diff.total, 2);
	});

	it('survives a missing side (an added or deleted picture)', () => {
		const added = makeHarness();
		added.api.test.setImages(null, solidImage(1, 1, [200, 100, 50, 255]));
		assert.doesNotThrow(() => added.api.test.render());
		assert.deepEqual(Array.from(added.api.test.diff().map), [255]);
		assert.ok(added.stats().includes('1 pixels (100.00%)'), added.stats());

		const deleted = makeHarness();
		deleted.api.test.setImages(solidImage(1, 1, [60, 120, 200, 255]), null);
		assert.doesNotThrow(() => deleted.api.test.render());
		assert.deepEqual(Array.from(deleted.api.test.diff().map), [255]);
		// The picture modes re-read the sides; they must tolerate the missing one too.
		deleted.api.test.setState('highlight', 10, 0);
		assert.doesNotThrow(() => deleted.api.test.renderPane());
		assert.deepEqual(deleted.pixelsOf(deleted.diffPaint()), [[255, 0, 0, 255]]);
	});

	it('reports identical pictures as having no differences', () => {
		const harness = makeHarness();
		harness.api.test.setImages(solidImage(2, 2, [10, 20, 30, 255]), solidImage(2, 2, [10, 20, 30, 255]));
		harness.api.test.render();
		const diff = harness.api.test.diff();
		assert.equal(diff.sumSquares, 0);
		assert.ok(Array.from(diff.map).every((delta) => delta === 0));
		harness.api.test.refreshStats();
		assert.equal(harness.stats(), t('compareImageNoDifferences'));
	});

	it('greyscales the delta, amplified and tolerance-filtered', () => {
		const harness = makeHarness();
		const oldImage = solidImage(4, 1, [0, 0, 0, 255]);
		const newImage = solidImage(4, 1, [0, 0, 0, 255]);
		const deltas = [3, 26, 100, 255];
		deltas.forEach((delta, index) => withPixel(newImage, index, [delta, 0, 0, 255]));
		harness.api.test.setImages(oldImage, newImage);

		harness.api.test.setState('enhanced', 10, 0); // default view: x10 saturates everything >= 26
		harness.api.test.render();
		assert.deepEqual(harness.pixelsOf(harness.diffPaint()).map((px) => px[0]), [30, 255, 255, 255]);

		harness.api.test.setState('difference', 1, 0); // raw magnitudes
		harness.api.test.renderPane();
		assert.deepEqual(harness.pixelsOf(harness.diffPaint()).map((px) => px[0]), deltas);

		harness.api.test.setState('difference', 1, 30); // deltas within tolerance are blanked
		harness.api.test.renderPane();
		assert.deepEqual(harness.pixelsOf(harness.diffPaint()).map((px) => px[0]), [0, 0, 100, 255]);
	});

	it('dyes only the differing pixels red in highlight mode', () => {
		const harness = makeHarness();
		const oldImage = solidImage(2, 1, [0, 0, 0, 255]);
		withPixel(oldImage, 0, [20, 30, 40, 255]);   // stays exactly as it was
		withPixel(oldImage, 1, [200, 200, 200, 255]); // changes by 10 on red
		const newImage = solidImage(2, 1, [0, 0, 0, 255]);
		withPixel(newImage, 0, [20, 30, 40, 255]);
		withPixel(newImage, 1, [210, 200, 200, 255]);
		harness.api.test.setImages(oldImage, newImage);

		harness.api.test.setState('highlight', 10, 0);
		harness.api.test.render();
		// Regression: the unchanged pixel must keep its original red channel (it used to be
		// forced to 255, making untouched dark areas glow brighter than real differences).
		assert.deepEqual(harness.pixelsOf(harness.diffPaint()), [
			[20, 30, 40, 255],
			[255, 0, 0, 255]
		]);

		harness.api.test.setState('highlight', 10, 16); // the delta of 10 is within tolerance
		harness.api.test.renderPane();
		assert.deepEqual(harness.pixelsOf(harness.diffPaint()), [
			[20, 30, 40, 255],
			[200, 200, 200, 255]
		]);
	});

	it('dyes every differing pixel the same saturated red, whatever lies beneath', () => {
		const harness = makeHarness();
		// A bright background with a dark element: the large change sits on the bright pixel,
		// the small one on the dark pixel.
		const oldImage = solidImage(4, 1, [240, 240, 240, 255]);
		withPixel(oldImage, 2, [25, 25, 25, 255]);
		const newImage = solidImage(4, 1, [240, 240, 240, 255]);
		withPixel(newImage, 0, [0, 0, 0, 255]);  // delta 240 on a bright pixel
		withPixel(newImage, 2, [35, 35, 35, 255]); // delta 10 on a dark pixel
		harness.api.test.setImages(oldImage, newImage);

		harness.api.test.setState('highlight', 10, 0);
		harness.api.test.render();
		// Regression: the dye used to keep 30% of the base pixel's green/blue, so the large
		// change washed out to pale pink (255,72,72) on bright pictures while the small change
		// on dark ones glared (255,8,8) — the mark's visibility has to be magnitude- and
		// brightness-independent, or big differences read as unhighlighted.
		assert.deepEqual(harness.pixelsOf(harness.diffPaint()), [
			[255, 0, 0, 255],
			[240, 240, 240, 255],
			[255, 0, 0, 255],
			[240, 240, 240, 255]
		]);
	});

	it('blends the two sides at the chosen ratio', () => {
		const harness = makeHarness();
		const oldImage = solidImage(2, 1, [255, 0, 0, 255]);
		withPixel(oldImage, 1, [10, 20, 30, 255]); // old-only pixel: passed through untouched
		const newImage = solidImage(1, 1, [0, 0, 255, 255]);
		harness.api.test.setImages(oldImage, newImage);

		harness.api.test.setState('blend', 10, 0, 0.5);
		harness.api.test.render();
		assert.deepEqual(harness.pixelsOf(harness.diffPaint()), [
			[128, 0, 128, 255], // Math.round(0.5 * 255 + 0.5 * 0)
			[10, 20, 30, 255]
		]);

		harness.api.test.setState('blend', 10, 0, 0.25);
		harness.api.test.renderPane();
		assert.deepEqual(harness.pixelsOf(harness.diffPaint())[0], [64, 0, 191, 255]);
	});

	it('summarises count, percentages, MSE and PSNR over the union', () => {
		const harness = makeHarness();
		harness.api.test.setImages(solidImage(2, 1, [50, 50, 50, 255]), solidImage(1, 1, [50, 50, 50, 255]));
		harness.api.test.render();
		const stats = harness.stats();
		assert.ok(stats.includes('1 pixels (50.00%)'), stats);
		assert.ok(stats.includes('max 255'), stats);
		assert.ok(stats.includes('avg 255.00'), stats);
		assert.ok(stats.includes('MSE 32512.50'), stats); // 255^2 over two union pixels
		assert.ok(stats.includes('PSNR 3.0'), stats);     // 10*log10(2)

		harness.api.test.setState('enhanced', 10, 255); // nothing exceeds a tolerance of 255
		harness.api.test.refreshStats();
		assert.equal(harness.stats(), t('compareImageNoDifferences'));
	});

	it('treats an undecodable side as an error', () => {
		const harness = makeHarness();
		harness.api.test.setImages(solidImage(1, 1, [1, 2, 3, 255]), 'error');
		harness.api.test.render();
		assert.equal(harness.api.test.diff(), null);
		assert.equal(harness.stats(), t('compareImageDecodeError'));
	});
});

/* ---------- The host-side image responders ---------- */

const gitSpawner = {
	spawnGitStream(args, repo) {
		return spawn('git', args, { cwd: repo });
	}
};

const fileChange = (type, oldFilePath, newFilePath) => ({ oldFilePath, newFilePath, type, additions: null, deletions: null });

function git(repo, args) {
	const result = spawnSync('git', args, { cwd: repo, encoding: 'buffer', maxBuffer: 1 << 28 });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.toString();
}

/** A fresh repository, with a callback-scoped teardown registered through the test's context. */
function withRepo(run) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdiff-'));
	git(repo, ['init', '-q']);
	git(repo, ['config', 'user.email', 'test@test']);
	git(repo, ['config', 'user.name', 'test']);
	// A session's killed git children take a moment to release the repository on Windows, so the
	// removal retries with real waits until the directory is actually gone.
	const cleanup = async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				fs.rmSync(repo, { recursive: true, force: true });
				return;
			} catch (err) {
				// Windows releases the directory under either EPERM or EBUSY while the children exit.
				if (attempt >= 50 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	};
	return Promise.resolve().then(() => run(repo)).then(
		(value) => cleanup().then(() => value),
		(err) => cleanup().then(() => { throw err; })
	);
}

/** A real 1x1 transparent PNG: the host only re-encodes bytes, but a decodable file keeps the fixture honest. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function sessionFor(repo, fromHash, toHash, change) {
	return new HexDiffSession(gitSpawner, repo,
		false, change.oldFilePath !== '' ? change.oldFilePath : change.newFilePath, fromHash,
		false, change.newFilePath !== '' ? change.newFilePath : change.oldFilePath, toHash,
		change);
}

async function imageReply(repo, fromHash, toHash, change) {
	const session = sessionFor(repo, fromHash, toHash, change);
	const replies = [];
	try {
		await respondImageData(session, 0, change, (message) => replies.push(message));
	} finally {
		session.dispose();
	}
	assert.equal(replies.length, 1);
	return replies[0];
}

describe('the host-side image responders', () => {
	it('recognises picture paths of every supported kind', () => {
		assert.equal(imageMimeOf('a.PNG'), 'image/png');       // case-insensitive extension
		assert.equal(imageMimeOf('dir/b.jpeg'), 'image/jpeg');
		assert.equal(imageMimeOf('c.svg'), 'image/svg+xml');
		assert.equal(imageMimeOf('icon.ico'), 'image/x-icon');
		assert.equal(imageMimeOf('d.bin'), null);
		assert.equal(imageMimeOf('noext'), null);
		assert.equal(imageMimeOf('photo.png/bak'), null); // only the text after the last dot counts

		assert.equal(isImageChange(fileChange('M', 'a.png', 'a.png')), true);
		assert.equal(isImageChange(fileChange('A', '', 'added.webp')), true);
		assert.equal(isImageChange(fileChange('D', 'gone.bmp', '')), true);
		assert.equal(isImageChange(fileChange('R', 'a.png', 'renamed.avif')), true);
		assert.equal(isImageChange(fileChange('R', 'a.png', 'now.bin')), false); // the new side is not a picture
		assert.equal(isImageChange(fileChange('M', 'a.bin', 'a.bin')), false);
	});

	it('answers getImageData with both sides as data URLs', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'pixel.png'), PNG_1X1);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		const edited = Buffer.from(PNG_1X1);
		edited[edited.length - 1] ^= 0xff;
		fs.writeFileSync(path.join(repo, 'pixel.png'), edited);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'two']);
		const toHash = git(repo, ['rev-parse', 'HEAD']).trim();

		const reply = await imageReply(repo, fromHash, toHash, fileChange('M', 'pixel.png', 'pixel.png'));
		assert.equal(reply.error, null);
		assert.equal(reply.oldSize, PNG_1X1.length);
		assert.equal(reply.newSize, edited.length);
		assert.ok(reply.oldData.startsWith('data:image/png;base64,'), reply.oldData);
		assert.ok(Buffer.from(reply.oldData.substring(22), 'base64').equals(PNG_1X1));
		assert.ok(Buffer.from(reply.newData.substring(22), 'base64').equals(edited));
	}));

	it('answers null for the missing side of an added picture', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'keep.txt'), 'x');
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		fs.writeFileSync(path.join(repo, 'pixel.png'), PNG_1X1);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'two']);
		const toHash = git(repo, ['rev-parse', 'HEAD']).trim();

		const reply = await imageReply(repo, fromHash, toHash, fileChange('A', '', 'pixel.png'));
		assert.equal(reply.error, null);
		assert.equal(reply.oldData, null);
		assert.ok(Buffer.from(reply.newData.substring(22), 'base64').equals(PNG_1X1));
	}));

	it('refuses types the picture view cannot render', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'data.bin'), Buffer.from([1, 2, 3, 4]));
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		fs.writeFileSync(path.join(repo, 'data.bin'), Buffer.from([5, 6, 7, 8]));
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'two']);
		const toHash = git(repo, ['rev-parse', 'HEAD']).trim();

		const reply = await imageReply(repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		assert.equal(reply.error, t('compareImageUnsupportedType'));
		assert.equal(reply.oldData, null);
		assert.equal(reply.newData, null);
	}));
});
