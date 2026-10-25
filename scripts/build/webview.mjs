/**
 * Build the Git Graph webview (REFACTOR-PLAN §3.4, §4.1, task 5.9): bundle the ES module sources
 * under src/webview into the files the extension host serves - and run the gates that keep them
 * inside the VS Code 1.38 floor (Chromium 69 = ES2018):
 *
 *   1. type check   tsc -p src/webview (lib es2018 + dom: newer built-ins are type errors)
 *   2. source gate  no syntax newer than ES2018 in src/webview/**.ts (dynamic import() allowed:
 *                   the on-demand chunks of task 5.9 rely on it, and Chromium 69 runs it natively)
 *   3. html gate    innerHTML / outerHTML / insertAdjacentHTML appear only in
 *                   src/webview/common/html.ts, which accepts SafeHtml alone
 *   4. bundle       the graph view: esbuild, ESM + splitting, target es2018 + chrome69 - the
 *                   entry chunk media/out.min.js plus on-demand media/chunks/*.js pulled in by
 *                   dynamic import() (the widgets and modules that must not sit on the first
 *                   paint); the comparison and binary-compare pages stay single-file IIFEs
 *                   (their controllers load them with classic <script> tags)
 *   5. output gate  no syntax newer than ES2018 in the emitted scripts (import() allowed as above)
 *
 *   node scripts/build/webview.mjs [debug] [--no-typecheck]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { checkFiles } from './es2018.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const webviewDir = path.join(root, 'src', 'webview');
const mediaDir = path.join(root, 'media');

const DEBUG = process.argv.includes('debug');
const TYPECHECK = !process.argv.includes('--no-typecheck');

/** The only module allowed to write HTML into the DOM (see the html gate). */
const HTML_SINK_MODULE = path.join(webviewDir, 'common', 'html.ts');
/* Any occurrence of the three DOM-HTML identifiers counts, not only assignment-shaped lines:
   bracket writes (elem['innerHTML'] = ...), assignments split across lines and bare references
   (aliases, .bind) all evade a line-local dot-then-= match, and the only legitimate readers are
   the sinks of html.ts itself, which the module exemption covers. A line-by-line scan is
   complete for this pattern: the identifiers themselves never span lines. */
const HTML_SINK_PATTERN = /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/;

function walk(directory, extension) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walk(full, extension));
		else if (entry.name.endsWith(extension)) files.push(full);
	}
	return files.sort();
}

function relative(file) {
	return path.relative(root, file).split(path.sep).join('/');
}

function fail(title, problems) {
	console.error(title);
	for (const problem of problems) console.error('  ' + problem);
	process.exit(1);
}

// The artifact gates below govern what ships to Chromium 69; colocated *.test.ts files never
// enter a bundle and run on the dev-toolchain Node, so they are exempt from both the syntax
// floor and the SafeHtml DOM-write scan (REFACTOR-PLAN §3.7.2 separates dev tool from runtime).
const sources = walk(webviewDir, '.ts').filter((file) => !/\.test\.ts$/.test(file));

if (TYPECHECK) {
	const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
	const result = spawnSync(process.execPath, [tsc, '-p', path.join(webviewDir, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
	if (result.status !== 0) fail('Webview type check failed:', (result.stdout + result.stderr).trim().split(/\r?\n/));
}

const sourceProblems = checkFiles(sources, root, { allowDynamicImport: true });
if (sourceProblems.length > 0) fail('Webview sources use syntax newer than ES2018:', sourceProblems);

const htmlProblems = [];
for (const file of sources) {
	if (file === HTML_SINK_MODULE) continue;
	fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
		if (HTML_SINK_PATTERN.test(line)) htmlProblems.push(relative(file) + ':' + (index + 1) + ' ' + line.trim());
	});
}
if (htmlProblems.length > 0) fail('innerHTML / outerHTML / insertAdjacentHTML may only be used by the SafeHtml sinks of src/webview/common/html.ts:', htmlProblems);

fs.mkdirSync(mediaDir, { recursive: true });
const outJs = path.join(mediaDir, 'out.min.js');
const outCss = path.join(mediaDir, 'out.min.css');
const chunksDir = path.join(mediaDir, 'chunks');
/* The extracted comparison frontends (REFACTOR-PLAN task 6.1): each page gets its own entry,
   bundled by the same rules as the main view. The comparison stylesheet inlines the shared
   binary-compare styles (its page embeds that area); the binary-compare stylesheet stands
   alone for the standalone tab. */
const classicEntries = [
	{ entry: path.join(webviewDir, 'comparison', 'main.ts'), out: path.join(mediaDir, 'comparison.min.js') },
	{ entry: path.join(webviewDir, 'binaryCompare', 'main.ts'), out: path.join(mediaDir, 'binaryCompare.min.js') }
];
const cssEntries = [
	{ entry: path.join(webviewDir, 'styles', 'index.css'), out: outCss },
	{ entry: path.join(webviewDir, 'styles', 'comparison.css'), out: path.join(mediaDir, 'comparison.min.css') },
	{ entry: path.join(webviewDir, 'styles', 'binaryCompare.css'), out: path.join(mediaDir, 'binaryCompare.min.css') }
];
// Hashed chunk names of a previous build must not survive as orphans (a source edit renames them)
fs.rmSync(chunksDir, { recursive: true, force: true });
let graphBuild = null;
try {
	/* The main view's first-paint bundle (task 5.9): ESM + code splitting. Everything the page
	   reaches only through dynamic import() - the settings widget, the statistics / reflog /
	   worktree views, the non-English string table, the Markdown renderer - lands in separate
	   chunks the browser loads on demand. Modules several chunks share (the dialog, the shared
	   utilities) land in SHARED chunks the entry imports STATICALLY - they are as first-paint as
	   the entry itself, which is why the size report below follows the entry's static import
	   closure instead of reading media/out.min.js alone. CSS imported by the module graph becomes
	   TEXT (loader below) instead of a sibling .css chunk: esbuild does not load a chunk's CSS
	   when the chunk is imported at runtime, so the on-demand widgets inject their styles from
	   the bundled string themselves (the page CSP allows inline styles). The critical stylesheet
	   keeps its own CSS entry. */
	graphBuild = esbuild.buildSync({
		entryPoints: [path.join(webviewDir, 'graph', 'main.ts')],
		outdir: mediaDir,
		entryNames: 'out.min',
		chunkNames: 'chunks/[name]-[hash]',
		bundle: true,
		splitting: true,
		format: 'esm',
		target: ['es2018', 'chrome69'],
		minify: !DEBUG,
		sourcemap: DEBUG ? false : 'linked',
		sourcesContent: true,
		legalComments: 'none',
		loader: { '.css': 'text' },
		tsconfig: path.join(webviewDir, 'tsconfig.json'),
		logLevel: 'warning',
		metafile: true
	});
	for (const { entry, out } of classicEntries) {
		esbuild.buildSync({
			entryPoints: [entry],
			outfile: out,
			bundle: true,
			format: 'iife',
			target: ['es2018', 'chrome69'],
			minify: !DEBUG,
			sourcemap: DEBUG ? false : 'linked',
			sourcesContent: true,
			legalComments: 'none',
			tsconfig: path.join(webviewDir, 'tsconfig.json'),
			logLevel: 'warning'
		});
	}
	for (const { entry, out } of cssEntries) {
		esbuild.buildSync({
			entryPoints: [entry],
			outfile: out,
			bundle: true,
			target: ['chrome69'],
			minify: !DEBUG,
			legalComments: 'none',
			logLevel: 'warning'
		});
	}
	/* The single-file variant the jsdom test harnesses execute (tests/webviewHarness.mjs and
	   its siblings): jsdom evaluates scripts with window.eval, which cannot run ES modules -
	   so the SAME entry is additionally bundled as one IIFE whose dynamic import() calls esbuild
	   lowers into inlined Promise wrappers (every on-demand module rides along; only the chunk
	   BOUNDARIES differ from the shipped bundle). It never enters the VSIX (the .vscodeignore
	   allowlist does not re-include it) - it exists for the test harnesses alone. */
	esbuild.buildSync({
		entryPoints: [path.join(webviewDir, 'graph', 'main.ts')],
		outfile: path.join(mediaDir, 'out.testbundle.js'),
		bundle: true,
		format: 'iife',
		target: ['es2018', 'chrome69'],
		minify: !DEBUG,
		sourcemap: false,
		sourcesContent: true,
		legalComments: 'none',
		loader: { '.css': 'text' },
		tsconfig: path.join(webviewDir, 'tsconfig.json'),
		logLevel: 'warning'
	});
} catch (error) {
	fail('Webview bundling failed:', [String(error)]);
}
// A debug build produces no map: drop one left behind by an earlier production build, so a stale
// map never ships next to a bundle it does not describe
if (DEBUG && fs.existsSync(outJs + '.map')) fs.unlinkSync(outJs + '.map');

const emitted = [outJs, path.join(mediaDir, 'out.testbundle.js'), ...classicEntries.map(({ out }) => out)];
if (fs.existsSync(chunksDir)) {
	for (const name of fs.readdirSync(chunksDir)) {
		if (name.endsWith('.js')) emitted.push(path.join(chunksDir, name));
	}
}
const outputProblems = checkFiles(emitted, root, { allowDynamicImport: true });
if (outputProblems.length > 0) fail('The webview bundle contains syntax newer than ES2018:', outputProblems);

function kib(file) {
	return Math.round(fs.statSync(file).size / 1024);
}
/**
 * The first paint downloads the entry chunk AND every chunk it imports STATICALLY (a module
 * script's dependency graph resolves before any code runs); only the chunks reached through
 * dynamic import() are on demand. Follow the entry's static import closure over the metafile,
 * so the reported critical size is what the browser really fetches before first paint.
 */
function staticClosureOfEntry(metafile) {
	const outputsByPath = {};
	for (const [out, info] of Object.entries(metafile.outputs)) outputsByPath[path.resolve(root, out)] = info;
	const closure = new Set([outJs]);
	const visit = (file) => {
		const info = outputsByPath[file];
		if (info === undefined) return;
		for (const imported of info.imports) {
			if (imported.kind !== 'import-statement') continue;
			const importedPath = path.resolve(root, imported.path);
			if (!closure.has(importedPath)) {
				closure.add(importedPath);
				visit(importedPath);
			}
		}
	};
	visit(outJs);
	return closure;
}
const criticalJs = [...staticClosureOfEntry(graphBuild.metafile)].sort();
const criticalJsBytes = criticalJs.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const onDemandJs = emitted.filter((file) => !criticalJs.includes(file) && !classicEntries.some(({ out }) => out === file) && path.basename(file) !== 'out.testbundle.js');
console.log('Webview built (' + (DEBUG ? 'debug' : 'production') + ')');
console.log('  first paint critical JS = ' + Math.round(criticalJsBytes / 1024) + ' KB (budget 360 KB, ADR-0005): '
	+ criticalJs.map((file) => path.basename(file) + ' ' + kib(file) + ' KB').join(', '));
console.log('  entry chunk = ' + path.basename(outJs) + ' ' + kib(outJs) + ' KB (REFACTOR-PLAN 3.8.2 slimming budget: 200 KB)');
console.log('  first paint critical CSS = ' + kib(outCss) + ' KB (budget: 60 KB)');
console.log(onDemandJs.length > 0 ? '  on demand: ' + onDemandJs.map((file) => relative(file) + ' ' + kib(file) + ' KB').join(', ') : '  on demand: (none)');
console.log('  pages: ' + classicEntries.map(({ out }) => relative(out) + ' ' + kib(out) + ' KB').join(', '));
