/**
 * Theme audit (REFACTOR-PLAN 5.5/5.7): renders representative markup of every Git Graph
 * page-kind under the four VS Code theme kinds using the REAL built stylesheets
 * (media/out.min.css, media/comparison.min.css, media/binaryCompare.min.css — produced by
 * `npm run build:dist`), screenshots each page-kind x theme headlessly, and gates the current
 * rendering against a committed reference set with a pixel-diff tolerance.
 *
 *   node scripts/dev/theme-audit.mjs                     # generate .theme-audit/<run>/ (HTML + PNG)
 *   node scripts/dev/theme-audit.mjs --check             # generate, then diff vs docs/theme-audit/reference/
 *                                                         #   exit 1 when > 0.1% of pixels differ
 *   node scripts/dev/theme-audit.mjs --update-reference  # regenerate the committed reference set
 *
 * Options: --pages=a,b        only the named page-kinds
 *          --themes=a,b       only the named theme kinds
 *          --keep=N           how many runs to keep under .theme-audit/ (default 3)
 *
 * Screenshots use the system Edge browser via playwright's msedge channel when present (no
 * download needed); otherwise the bundled Chromium (`npx playwright install chromium`).
 * Reference PNGs are compressed with sharp (palette-quantised when that stays inside the diff
 * tolerance, lossless otherwise) so the committed set stays small. Not part of the extension:
 * .theme-audit/ is gitignored and docs/theme-audit/ is outside the packaging allowlist.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { rootVars, themes } from './theme-audit/themes.mjs';
import { mainPages } from './theme-audit/pages-main.mjs';
import { mobilePages } from './theme-audit/pages-mobile.mjs';
import { comparePages } from './theme-audit/pages-compare.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const referenceDir = join(root, 'docs', 'theme-audit', 'reference');
const auditDir = join(root, '.theme-audit');

/** Which built stylesheet each page-kind reads (scripts/build/webview.mjs output names). */
const stylesheets = {
	out: 'media/out.min.css',
	comparison: 'media/comparison.min.css',
	binaryCompare: 'media/binaryCompare.min.css'
};

/** A pixel counts as differing when any channel moves by more than this much. Absorbs palette
 * quantisation of the reference PNGs and single-level antialiasing noise; anything a person
 * would call a visual change moves channels far more. */
const CHANNEL_TOLERANCE = 8;
/** The gate: at most 0.1% of pixels may differ between a run and its reference image. */
const MAX_DIFFERING_PIXELS = 0.001;

const args = process.argv.slice(2);
const check = args.includes('--check');
const updateReference = args.includes('--update-reference');
const keep = parseInt(argValue('--keep') || '3', 10);
const onlyPages = argValue('--pages')?.split(',').map((s) => s.trim());
const onlyThemes = argValue('--themes')?.split(',').map((s) => s.trim());

function argValue(name) {
	const arg = args.find((a) => a.startsWith(name + '='));
	return arg === undefined ? undefined : arg.substring(name.length + 1);
}

const pages = [...mainPages, ...mobilePages, ...comparePages]
	.filter((p) => onlyPages === undefined || onlyPages.includes(p.name));
const themeEntries = Object.entries(themes)
	.filter(([name]) => onlyThemes === undefined || onlyThemes.includes(name));

if (pages.length === 0 || themeEntries.length === 0) {
	console.error('No pages or themes selected (check --pages/--themes values).');
	process.exit(2);
}

function loadStylesheet(name) {
	const file = join(root, stylesheets[name]);
	try {
		return readFileSync(file, 'utf8');
	} catch {
		console.error(`Missing ${stylesheets[name]} — run \`npm run build:dist\` first (esbuild only, no cargo).`);
		process.exit(1);
	}
}

/** Compose one auditable HTML page: the built stylesheet, the theme variables, the harness's
 * layout-only neutralisation, and the page's markup sample. */
function renderPageHtml(page, css, theme) {
	const vars = Object.entries(rootVars(theme)).map(([k, v]) => `${k}:${v};`).join('');
	const bodyClasses = [theme.bodyClass, page.bodyClass].filter(Boolean).join(' ');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Git Graph theme audit — ${page.label} — ${theme.label}</title>
<style>
${css}
</style>
<style>
/* Harness-only: neutralise the fixed/absolute overlay positioning so every component renders in
   document flow for a full-page screenshot. Positioning and display only — never colours. */
:root{${vars}}
html{overflow-x:hidden}
body{position:static;display:block;overflow:visible;background-color:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);margin:0;padding:0 0 40px 0}
a{color:var(--vscode-textLink-foreground)}
.sectionTitle{margin:28px 12px 10px 12px;font-size:15px;border-bottom:1px solid rgba(128,128,128,0.35);padding-bottom:4px}
${page.harnessCss}
</style>
</head>
<body class="${bodyClasses}">
<h1 style="text-align:center;font-size:16px;margin:12px">${page.label} — ${theme.label}</h1>
${page.body}
</body>
</html>`;
}

/** Launch Edge when the system has it; fall back to the bundled Chromium. */
async function launchBrowser() {
	const attempts = [
		{ label: 'system Edge (channel msedge)', options: { channel: 'msedge' } },
		{ label: 'bundled Chromium', options: {} }
	];
	let lastError = null;
	for (const attempt of attempts) {
		try {
			const browser = await chromium.launch({ headless: true, ...attempt.options });
			return { browser, label: attempt.label };
		} catch (error) {
			lastError = error;
		}
	}
	console.error('No usable browser found. Install Chromium for playwright with:');
	console.error('  npx playwright install chromium');
	throw lastError;
}

/** Screenshot every selected page-kind x theme into the run directory. */
async function captureRun(runDir) {
	const cssCache = {};
	const files = [];
	const { browser, label } = await launchBrowser();
	console.log(`Capturing with ${label}: ${pages.length} page-kind(s) x ${themeEntries.length} theme(s)`);
	try {
		for (const page of pages) {
			if (cssCache[page.stylesheet] === undefined) cssCache[page.stylesheet] = loadStylesheet(page.stylesheet);
			for (const [themeName, theme] of themeEntries) {
				const base = `${page.name}-${themeName}`;
				const htmlFile = join(runDir, base + '.html');
				writeFileSync(htmlFile, renderPageHtml(page, cssCache[page.stylesheet], theme));
				const context = await browser.newContext({
					viewport: page.viewport,
					deviceScaleFactor: 1,
					reducedMotion: 'reduce'
				});
				const ctxPage = await context.newPage();
				try {
					await ctxPage.goto(pathToFileURL(htmlFile).href);
					const png = join(runDir, base + '.png');
					await ctxPage.screenshot({ path: png, fullPage: true, animations: 'disabled', caret: 'hide' });
					files.push({ page: page.name, theme: themeName, png });
					console.log(`  ${base}.png`);
				} finally {
					await context.close();
				}
			}
		}
	} finally {
		await browser.close();
	}
	return files;
}

/** Raw RGBA pixel data of an image (alpha normalised away). */
async function rawPixels(file) {
	const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Count pixels whose maximum per-channel delta exceeds CHANNEL_TOLERANCE. */
async function compareImages(current, reference) {
	const a = await rawPixels(current);
	const b = await rawPixels(reference);
	if (a.width !== b.width || a.height !== b.height) {
		return { total: a.width * a.height, differing: a.width * a.height, sizeMismatch: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
	}
	const channels = Math.min(a.channels, b.channels);
	let differing = 0;
	for (let i = 0; i < a.width * a.height; i++) {
		for (let c = 0; c < 3 && c < channels; c++) {
			if (Math.abs(a.data[i * a.channels + c] - b.data[i * b.channels + c]) > CHANNEL_TOLERANCE) {
				differing++;
				break;
			}
		}
	}
	return { total: a.width * a.height, differing, sizeMismatch: null };
}

/**
 * Compress a screenshot for the committed reference set: palette-quantised PNG when the
 * quantisation error stays inside the diff tolerance (checked by actually measuring it),
 * lossless PNG otherwise. Keeps every reference file small without hiding real changes.
 */
async function compressReference(source, target) {
	const original = await rawPixels(source);
	const candidate = await sharp(source).png({ palette: true, quality: 100, compressionLevel: 9 }).toBuffer();
	const tmp = target + '.quant.png';
	writeFileSync(tmp, candidate);
	const quantised = await rawPixels(tmp);
	let worst = 0;
	for (let i = 0; i < original.width * original.height; i++) {
		for (let c = 0; c < 3; c++) {
			worst = Math.max(worst, Math.abs(original.data[i * original.channels + c] - quantised.data[i * quantised.channels + c]));
		}
	}
	rmSync(tmp, { force: true });
	const finalBuffer = worst <= CHANNEL_TOLERANCE
		? candidate
		: await sharp(source).png({ compressionLevel: 9 }).toBuffer();
	writeFileSync(target, finalBuffer);
	return { quantised: worst <= CHANNEL_TOLERANCE, worstDelta: worst, size: finalBuffer.length };
}

/** Remove all but the newest N run directories under .theme-audit/. */
function pruneOldRuns() {
	const runs = readdirSync(auditDir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name.startsWith('run-'))
		.map((e) => e.name)
		.sort();
	while (runs.length > keep) {
		rmSync(join(auditDir, runs.shift()), { recursive: true, force: true });
	}
}

async function main() {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', ' ').substring(0, 19);
	const runDir = join(auditDir, 'run-' + stamp);
	mkdirSync(runDir, { recursive: true });
	console.log(`Theme audit run: ${runDir.substring(root.length + 1)}`);

	const files = await captureRun(runDir);

	if (updateReference) {
		mkdirSync(referenceDir, { recursive: true });
		let quantisedCount = 0, totalBytes = 0;
		for (const file of files) {
			const stats = await compressReference(file.png, join(referenceDir, basename(file.png)));
			if (stats.quantised) quantisedCount++;
			totalBytes += stats.size;
		}
		console.log(`Reference set updated: ${files.length} images in docs/theme-audit/reference/`);
		console.log(`  ${quantisedCount}/${files.length} palette-quantised, ${(totalBytes / 1024).toFixed(0)} KB total`);
	}

	if (check) {
		let failures = 0;
		console.log(`\nPixel-diff gate vs docs/theme-audit/reference/ (tolerance: <= ${(MAX_DIFFERING_PIXELS * 100).toFixed(2)}% of pixels, channel delta > ${CHANNEL_TOLERANCE})`);
		for (const file of files) {
			const reference = join(referenceDir, basename(file.png));
			let stats;
			try {
				stats = await compareImages(file.png, reference);
			} catch {
				console.log(`  FAIL ${basename(file.png)} — no reference image (run with --update-reference)`);
				failures++;
				continue;
			}
			const ratio = stats.total > 0 ? stats.differing / stats.total : 1;
			const verdict = stats.sizeMismatch !== null || ratio > MAX_DIFFERING_PIXELS ? 'FAIL' : 'ok';
			if (verdict === 'FAIL') failures++;
			const detail = stats.sizeMismatch !== null ? `size mismatch: ${stats.sizeMismatch}` : `${(ratio * 100).toFixed(4)}% (${stats.differing}/${stats.total} px) differ`;
			console.log(`  ${verdict.padEnd(4)} ${basename(file.png)} — ${detail}`);
		}
		if (failures > 0) {
			console.error(`\n${failures} of ${files.length} images exceed the diff tolerance.`);
			process.exitCode = 1;
		} else {
			console.log(`\nAll ${files.length} images within tolerance.`);
		}
	}

	pruneOldRuns();
	if (!check && !updateReference) {
		console.log(`\nDone. Open the HTML files in ${runDir.substring(root.length + 1)} for interactive inspection.`);
		console.log('Compare against the committed set with --check, or refresh it with --update-reference.');
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
