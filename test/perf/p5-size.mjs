/**
 * P5 — the size gate (REFACTOR-PLAN §6.7, row P5): measures what `dist/` and `media/` ship.
 *
 *   webview-entry-js / webview-entry-css   the graph view's entry (media/out.min.{js,css}) —
 *         the first-paint critical payload. The webview is NOT yet code-split (§3.8.2's
 *         first-paint bundle slimming is pending), so the whole entry IS the critical chunk
 *         and is measured as such (`splitting: false` in the result). The §3.8.1 budgets
 *         (critical JS <= 200 KB, critical CSS <= 60 KB, minified and not gzipped) are
 *         checked against these items and FAIL the gate when exceeded.
 *   webview-comparison-js/css, webview-binarycompare-js/css   the two extracted auxiliary
 *         pages — the on-demand surface of today's build (loaded only when their view opens).
 *   webview-vendor-js   media/vendor/*.min.js — the vendored libraries the page loads; the
 *         markdown-it script is currently first-paint (loaded by the HTML before the bundle),
 *         so `first-paint-js-total` reports entry + that vendor file as the honest number the
 *         slimming work has to bring down.
 *   host-extension-js   dist/extension.js — the host bundle (single file, Node 10.11 floor).
 *
 * `--artifacts-dir <tree>` measures another tree's dist/ + media/ instead of the workspace's
 * (the same-machine comparison scaffolding: CI builds base and PR side by side).
 *
 * `node test/perf/p5-size.mjs [--artifacts-dir <dir>]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { commitStamp, distDir, ensureResultsDir, mediaDir, parseArguments, perfDir, root, writeJson } from './lib/env.mjs';

/** The §3.8.1 size budgets, in bytes (minified, not gzipped). */
const BUDGETS = {
	'webview-entry-js': 200 * 1024,
	'webview-entry-css': 60 * 1024
};

/**
 * Run the P5 gate.
 * @param options `{ artifactsDir?: string }` — another tree to measure (its dist/ + media/).
 */
export async function runP5(options = {}) {
	const tree = options.artifactsDir !== undefined ? path.resolve(options.artifactsDir) : root;
	const artifacts = {
		'webview-entry-js': ['media/out.min.js'],
		'webview-entry-css': ['media/out.min.css'],
		'webview-comparison-js': ['media/comparison.min.js'],
		'webview-comparison-css': ['media/comparison.min.css'],
		'webview-binarycompare-js': ['media/binaryCompare.min.js'],
		'webview-binarycompare-css': ['media/binaryCompare.min.css'],
		'host-extension-js': ['dist/extension.js']
	};
	const items = [];
	let firstPaintTotal = 0;
	for (const [id, [relative]] of Object.entries(artifacts)) {
		const file = path.join(tree, relative);
		if (!fs.existsSync(file)) {
			throw new Error('P5 artifact missing: ' + relative + (tree === root ? ' — run `npm run build:dist -- --production` first.' : ' (in ' + tree + ')'));
		}
		const bytes = fs.statSync(file).size;
		const item = {
			gate: 'p5', id: id, backend: 'size', n: 1, unit: 'bytes',
			median: bytes, p95: bytes, mean: bytes, best: bytes, worst: bytes,
			file: relative.split(path.sep).join('/'), budget: BUDGETS[id] ?? null
		};
		if (item.budget !== null && bytes > item.budget) item.overBudget = true;
		items.push(item);
		if (id === 'webview-entry-js' || id === 'webview-entry-css') firstPaintTotal += bytes;
	}

	/* The vendored libraries: every min.js under media/vendor, named per file. */
	const vendorDir = path.join(tree, 'media', 'vendor');
	let markdownItBytes = 0;
	if (fs.existsSync(vendorDir)) {
		for (const name of fs.readdirSync(vendorDir).filter((n) => n.endsWith('.min.js')).sort()) {
			const bytes = fs.statSync(path.join(vendorDir, name)).size;
			items.push({ gate: 'p5', id: 'webview-vendor-js:' + name.replace(/\.min\.js$/, ''), backend: 'size', n: 1, unit: 'bytes', median: bytes, p95: bytes, mean: bytes, best: bytes, worst: bytes, file: 'media/vendor/' + name, budget: null });
			if (name.startsWith('markdown-it')) markdownItBytes += bytes;
		}
	}

	/* The honest first-paint number: the entry plus the vendor script the page loads at boot. */
	const firstPaintItem = {
		gate: 'p5', id: 'first-paint-js-total', backend: 'size', n: 1, unit: 'bytes',
		median: firstPaintTotal + markdownItBytes, p95: firstPaintTotal + markdownItBytes, mean: firstPaintTotal + markdownItBytes, best: firstPaintTotal + markdownItBytes, worst: firstPaintTotal + markdownItBytes,
		file: 'media/out.min.js + media/vendor/markdown-it*.min.js', budget: BUDGETS['webview-entry-js'],
		note: 'entry + the vendor script the HTML loads at first paint; the slimming target of §3.8.2'
	};
	if (firstPaintItem.median > firstPaintItem.budget) firstPaintItem.overBudget = true;
	items.push(firstPaintItem);

	/* Whether the tree was built with --production (the host bundle is only minified then; the
	 * webview is minified in both modes). Budgets still apply — they gate the minified bytes. */
	const production = !fs.existsSync(path.join(tree, 'dist', 'extension.js.map'));

	const result = {
		gate: 'p5',
		tier: null,
		commit: commitStamp(),
		tree: tree === root ? '.' : path.relative(root, tree) || tree,
		production: production,
		splitting: false,
		items: items
	};
	for (const item of items) {
		const kb = (item.median / 1024).toFixed(1);
		const budget = item.budget !== null ? '  (budget ' + (item.budget / 1024).toFixed(0) + ' KB' + (item.overBudget ? ' EXCEEDED)' : ')') : '';
		console.log('      ' + pad(item.id, 30) + kb.padStart(9) + ' KB   ' + item.file + budget);
	}
	return result;
}

function pad(text, width) {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/* Standalone entry: `node test/perf/p5-size.mjs [--artifacts-dir <dir>]` */
if (process.argv[1] && process.argv[1].endsWith('p5-size.mjs')) {
	const args = parseArguments(process.argv.slice(2));
	const result = await runP5({ artifactsDir: args.options['artifacts-dir'] });
	ensureResultsDir();
	const file = path.join(perfDir, 'results', 'p5.json');
	writeJson(file, result);
	console.log('\n[p5] wrote ' + file + (result.production ? '' : '  (NOTE: dist/ is not a --production build)'));
}
