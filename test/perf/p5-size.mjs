/**
 * P5 — the size gate (REFACTOR-PLAN §6.7, row P5): measures what `dist/` and `media/` ship.
 *
 * The webview is code-split since task 5.9 (esbuild ESM + `splitting`), so the first-paint
 * payload is NOT a single file. A module script's dependency graph resolves before any code
 * runs: the browser fetches the entry chunk AND every chunk it imports STATICALLY before the
 * first paint, while everything reached through dynamic `import()` (the widgets, markdown-it,
 * the zh-cn string table) loads on demand and is never first paint. The items:
 *
 *   webview-entry-js / webview-entry-css   media/out.min.{js,css} — the entry chunk and the
 *         critical stylesheet. §3.8.2's slimming work bounds what the ENTRY itself carries
 *         (the "webview parses <= 200 KB" target), budgeted at the §3.8.1 critical-JS size.
 *   first-paint-js-total   the entry plus the transitive closure of its static imports (the
 *         shared chunks several on-demand modules and the entry have in common) — the bytes
 *         the browser really downloads and parses before first paint. Computed by walking the
 *         EMITTED files' import statements (top-level `import ... from "./chunks/..."` /
 *         `import "./chunks/..."`), so an arbitrary artifacts tree measures without rebuilding.
 *         Checked against the §3.8.1 budget (as calibrated by ADR-0005: the string table and
 *         the inlined icons/images are irreducibly first paint — see the ADR's evidence).
 *   webview-ondemand-js:<name>   every chunk under media/chunks NOT in the static closure —
 *         fetched at first use and idle-prefetched after the first paint, separate line items.
 *   webview-vendor-js:<name>   media/vendor/*.min.js, when a build still ships vendor scripts
 *         (none today: markdown-it rides an on-demand chunk since task 5.9).
 *   webview-comparison-js/css, webview-binarycompare-js/css   the two extracted auxiliary
 *         pages — loaded only when their view opens.
 *   host-extension-js   dist/extension.js — the host bundle (single file, Node 10.11 floor).
 *
 * `--artifacts-dir <tree>` measures another tree's dist/ + media/ instead of the workspace's
 * (the same-machine comparison scaffolding: CI builds base and PR side by side).
 *
 * `node test/perf/p5-size.mjs [--artifacts-dir <dir>]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { commitStamp, ensureResultsDir, parseArguments, perfDir, root, writeJson } from './lib/env.mjs';

/**
 * The §3.8.1 size budgets, in bytes (minified, not gzipped). The first-paint total carries the
 * ADR-0005 calibration of the split layout (the English string table, the inlined icons and
 * the data-URI assets are first paint by necessity; the pre-split 200 KB figure predated them
 * being counted at all — the ADR records the floor evidence); the entry keeps the 200 KB
 * §3.8.2 slimming target, and the stylesheet keeps §3.8.1's 60 KB.
 */
const BUDGETS = {
	'webview-entry-js': 200 * 1024,
	'webview-entry-css': 60 * 1024,
	'first-paint-js-total': 360 * 1024
};

/** A size item: one measured file (or set of files), built the same way for every kind. */
function sizeItem(id, bytes, file, budget = null, note = null) {
	const item = {
		gate: 'p5', id: id, backend: 'size', n: 1, unit: 'bytes',
		median: bytes, p95: bytes, mean: bytes, best: bytes, worst: bytes,
		file: file, budget: budget
	};
	if (note !== null) item.note = note;
	if (budget !== null && bytes > budget) item.overBudget = true;
	return item;
}

/**
 * The module specifiers a chunk imports STATICALLY, read from the emitted file. esbuild hoists
 * every static import to the top of the chunk (the ES module grammar requires it), so the scan
 * walks the file's leading `import {...} from "<spec>";` / `import "<spec>";` statements and
 * stops at the first statement that is not an import — dynamic `import()` inside the code never
 * matches because it never leads the file. Relative specifiers (./, ../) are chunk-to-chunk
 * edges; bare specifiers would mean a dependency escaped the bundle (none does today).
 */
function staticImportsOf(file) {
	const text = fs.readFileSync(file, 'utf8');
	const specs = [];
	let rest = text;
	for (;;) {
		const match = /^(?:import(?:[^'"]*?)from\s*"([^"]+)"|import\s*"([^"]+)");/.exec(rest);
		if (match === null) break;
		const spec = match[1] ?? match[2];
		if (!spec.startsWith('./') && !spec.startsWith('../')) {
			throw new Error('P5 cannot follow the static import "' + spec + '" of ' + file + ' — only in-bundle chunk edges are expected.');
		}
		specs.push(spec);
		rest = rest.slice(match[0].length);
	}
	return specs;
}

/**
 * The first-paint JS closure of the entry: media/out.min.js plus every chunk reached over
 * static imports, transitively (a shared chunk may itself statically import another). Returns
 * the files in discovery order, entry first.
 */
function firstPaintClosure(entry) {
	const closure = [entry];
	const seen = new Set([entry]);
	for (let index = 0; index < closure.length; index++) {
		for (const spec of staticImportsOf(closure[index])) {
			const resolved = path.resolve(path.dirname(closure[index]), spec);
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			closure.push(resolved);
		}
	}
	return closure;
}

/**
 * Run the P5 gate.
 * @param options `{ artifactsDir?: string }` — another tree to measure (its dist/ + media/).
 */
export async function runP5(options = {}) {
	const tree = options.artifactsDir !== undefined ? path.resolve(options.artifactsDir) : root;
	const relative = (file) => path.relative(tree, file).split(path.sep).join('/');

	const mustExist = (file) => {
		if (!fs.existsSync(file)) {
			throw new Error('P5 artifact missing: ' + relative(file) + (tree === root ? ' — run `npm run build:dist -- --production` first.' : ' (in ' + tree + ')'));
		}
	};

	const items = [];
	const entryJs = path.join(tree, 'media', 'out.min.js');
	const outCss = path.join(tree, 'media', 'out.min.css');

	/* The auxiliary pages and the host bundle: one file each. */
	const files = [
		['webview-comparison-js', path.join(tree, 'media', 'comparison.min.js')],
		['webview-comparison-css', path.join(tree, 'media', 'comparison.min.css')],
		['webview-binarycompare-js', path.join(tree, 'media', 'binaryCompare.min.js')],
		['webview-binarycompare-css', path.join(tree, 'media', 'binaryCompare.min.css')],
		['host-extension-js', path.join(tree, 'dist', 'extension.js')]
	];
	for (const [id, file] of files) {
		mustExist(file);
		items.push(sizeItem(id, fs.statSync(file).size, relative(file)));
	}

	/* The first paint: the entry chunk, its critical stylesheet, and the static import closure. */
	mustExist(entryJs);
	mustExist(outCss);
	items.push(sizeItem('webview-entry-js', fs.statSync(entryJs).size, relative(entryJs), BUDGETS['webview-entry-js'], 'the entry chunk (§3.8.2 slimming target: what the entry itself carries)'));
	items.push(sizeItem('webview-entry-css', fs.statSync(outCss).size, relative(outCss), BUDGETS['webview-entry-css'], 'the critical stylesheet'));

	const closure = firstPaintClosure(entryJs);
	for (const file of closure.slice(1)) mustExist(file);
	const closureBytes = closure.reduce((sum, file) => sum + fs.statSync(file).size, 0);
	items.push(sizeItem(
		'first-paint-js-total', closureBytes,
		closure.map((file) => relative(file)).join(' + '),
		BUDGETS['first-paint-js-total'],
		'the entry plus the shared chunks it imports statically — everything the browser fetches before first paint (§3.8.1 budget as calibrated by ADR-0005)'
	));

	/* The on-demand surface: every emitted chunk NOT in the static closure, one line item each. */
	const chunksDir = path.join(tree, 'media', 'chunks');
	const onDemand = [];
	if (fs.existsSync(chunksDir)) {
		for (const name of fs.readdirSync(chunksDir).filter((n) => n.endsWith('.js')).sort()) {
			const file = path.join(chunksDir, name);
			if (closure.some((closed) => path.resolve(closed) === path.resolve(file))) continue;
			onDemand.push({ name: name, file: file, bytes: fs.statSync(file).size });
		}
	}
	for (const chunk of onDemand) {
		/* Named chunks keep their module name (markdown-it-<hash> -> markdown-it); esbuild's
		   anonymous shared chunks are all "chunk-<hash>", which would collide once there are
		   two - they keep the full hashed basename instead. */
		const named = chunk.name.replace(/\.js$/, '').replace(/-[A-Z0-9]{8}$/, '');
		const id = named !== 'chunk' ? named : chunk.name.replace(/\.js$/, '');
		items.push(sizeItem('webview-ondemand-js:' + id, chunk.bytes, relative(chunk.file), null, 'loaded at first use, idle-prefetched after first paint (task 5.9)'));
	}

	/* The vendored libraries (none in today's build: markdown-it rides an on-demand chunk). */
	const vendorDir = path.join(tree, 'media', 'vendor');
	if (fs.existsSync(vendorDir)) {
		for (const name of fs.readdirSync(vendorDir).filter((n) => n.endsWith('.min.js')).sort()) {
			items.push(sizeItem('webview-vendor-js:' + name.replace(/\.min\.js$/, ''), fs.statSync(path.join(vendorDir, name)).size, 'media/vendor/' + name));
		}
	}

	/* Whether the tree was built with --production (the host bundle is only minified then; the
	 * webview is minified in both modes). Budgets still apply — they gate the minified bytes. */
	const production = !fs.existsSync(path.join(tree, 'dist', 'extension.js.map'));

	const result = {
		gate: 'p5',
		tier: null,
		commit: commitStamp(),
		tree: tree === root ? '.' : path.relative(root, tree) || tree,
		production: production,
		splitting: true,
		items: items
	};
	for (const item of items) {
		const kb = (item.median / 1024).toFixed(1);
		const budget = item.budget !== null ? '  (budget ' + (item.budget / 1024).toFixed(0) + ' KB' + (item.overBudget ? ' EXCEEDED)' : ')') : '';
		console.log('      ' + pad(item.id, 34) + kb.padStart(9) + ' KB   ' + item.file + budget);
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
