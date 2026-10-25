/**
 * Build the Git Graph webview (REFACTOR-PLAN §3.4, §4.1): bundle the ES module sources under
 * src/webview into the two files the extension host serves - media/out.min.js and
 * media/out.min.css - and run the gates that keep them inside the VS Code 1.38 floor
 * (Chromium 69 = ES2018):
 *
 *   1. type check   tsc -p src/webview (lib es2018 + dom: newer built-ins are type errors)
 *   2. source gate  no syntax newer than ES2018 in src/webview/**.ts
 *   3. html gate    innerHTML / outerHTML / insertAdjacentHTML appear only in
 *                   src/webview/common/html.ts, which accepts SafeHtml alone
 *   4. bundle       esbuild, IIFE, target es2018 + chrome69
 *   5. output gate  no syntax newer than ES2018 in the emitted bundle
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

const sources = walk(webviewDir, '.ts');

if (TYPECHECK) {
	const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
	const result = spawnSync(process.execPath, [tsc, '-p', path.join(webviewDir, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
	if (result.status !== 0) fail('Webview type check failed:', (result.stdout + result.stderr).trim().split(/\r?\n/));
}

const sourceProblems = checkFiles(sources, root);
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
/* The extracted comparison frontends (REFACTOR-PLAN task 6.1): each page gets its own entry,
   bundled by the same rules as the main view. The comparison stylesheet inlines the shared
   binary-compare styles (its page embeds that area); the binary-compare stylesheet stands
   alone for the standalone tab. */
const jsEntries = [
	{ entry: path.join(webviewDir, 'graph', 'main.ts'), out: outJs },
	{ entry: path.join(webviewDir, 'comparison', 'main.ts'), out: path.join(mediaDir, 'comparison.min.js') },
	{ entry: path.join(webviewDir, 'binaryCompare', 'main.ts'), out: path.join(mediaDir, 'binaryCompare.min.js') }
];
const cssEntries = [
	{ entry: path.join(webviewDir, 'styles', 'index.css'), out: outCss },
	{ entry: path.join(webviewDir, 'styles', 'comparison.css'), out: path.join(mediaDir, 'comparison.min.css') },
	{ entry: path.join(webviewDir, 'styles', 'binaryCompare.css'), out: path.join(mediaDir, 'binaryCompare.min.css') }
];
try {
	for (const { entry, out } of jsEntries) {
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
} catch (error) {
	fail('Webview bundling failed:', [String(error)]);
}
// A debug build produces no map: drop one left behind by an earlier production build, so a stale
// map never ships next to a bundle it does not describe
if (DEBUG && fs.existsSync(outJs + '.map')) fs.unlinkSync(outJs + '.map');

const outputProblems = checkFiles(jsEntries.map(({ out }) => out), root);
if (outputProblems.length > 0) fail('The webview bundle contains syntax newer than ES2018:', outputProblems);

console.log('Webview built (' + (DEBUG ? 'debug' : 'production') + '): ' + jsEntries.concat(cssEntries)
	.map(({ out }) => relative(out) + ' ' + Math.round(fs.statSync(out).size / 1024) + ' KB')
	.join(', '));
