/**
 * Builds every icon in the extension from two sources:
 *
 *   - the original Git Graph icons, kept verbatim under `resources/upstream/` (from
 *     mhutchie/vscode-git-graph, develop branch), and
 *   - `resources/rust-crab.svg`, the small Ferris that marks this fork as the Rust one.
 *
 * Each output is the untouched upstream icon with the crab riding the right edge at mid-height,
 * recoloured per variant so the crab is coloured on the coloured icons and a matching gray on
 * the themed monochrome ones.
 *
 *   node scripts/generate-icons.mjs
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'resources');
const upstream = path.join(resources, 'upstream');

/**
 * The crab, drawn in a 10x8 box, recoloured and placed with one transform.
 *
 * The stroked parts carry inline styles because the upstream artwork ships a document-wide
 * `path,circle{stroke:none}` rule, and a presentation attribute would lose to it.
 */
function crab({ body, limbs, eye = '#ffffff', pupil = '#20140f' }, transform) {
	const leg = `style="fill:none;stroke:${limbs};stroke-width:1.1;stroke-linecap:round"`;
	return `
<g transform="${transform}">
	<path ${leg} d="M 3.1 3.5 L 1.8 2.6"/>
	<path ${leg} d="M 6.9 3.5 L 8.2 2.6"/>
	<path ${leg} d="M 1.9 5.7 L 0.7 6.7"/>
	<path ${leg} d="M 2.1 6.5 L 1.1 7.6"/>
	<path ${leg} d="M 8.1 5.7 L 9.3 6.7"/>
	<path ${leg} d="M 7.9 6.5 L 8.9 7.6"/>
	<circle cx="1.3" cy="2" r="1.45" fill="${body}"/>
	<circle cx="8.7" cy="2" r="1.45" fill="${body}"/>
	<ellipse cx="5" cy="4.9" rx="3.5" ry="2.7" fill="${body}"/>
	<circle cx="3.6" cy="3.05" r="0.82" fill="${eye}"/>
	<circle cx="6.4" cy="3.05" r="0.82" fill="${eye}"/>
	<circle cx="3.72" cy="3.16" r="0.4" fill="${pupil}"/>
	<circle cx="6.28" cy="3.16" r="0.4" fill="${pupil}"/>
</g>`;
}

const FERRIS = { body: '#f74c00', limbs: '#d63a00' };

/** Insert extra elements just before the closing tag of an SVG read from upstream/. */
function stamp(baseFile, extras) {
	const svg = fs.readFileSync(path.join(upstream, baseFile), 'utf8');
	const close = svg.lastIndexOf('</svg>');
	return svg.slice(0, close) + extras + '\n' + svg.slice(close);
}

/** One notification badge, drawn last so it sits on top of the crab. */
function badge() {
	return `
<circle cx="40" cy="9" r="7.5" fill="#ff3b30"/>
<circle cx="40" cy="9" r="7.5" style="fill:none;stroke:#ffffff;stroke-width:2.4"/>
<circle cx="40" cy="6.8" r="1.5" fill="#ffffff"/>
<path d="M 40 9 V 12.2" style="fill:none;stroke:#ffffff;stroke-width:2;stroke-linecap:round"/>`;
}

/* ---------- The SVG set ---------- */

const write = (file, contents) => fs.writeFileSync(path.join(resources, file), contents);

// The webview title icon, 24x24: coloured upstream art plus the coloured crab.
const webview = stamp(
	'webview-icon.svg',
	crab(FERRIS, 'translate(16.2 8.6) scale(0.78)')
);
write('git-graph-rs-webview-icon.svg', webview);
write(
	'git-graph-rs-webview-icon-dark.svg',
	stamp('webview-icon-dark.svg', crab({ body: '#c5c5c5', limbs: '#757575' }, 'translate(16.2 8.6) scale(0.78)'))
);
write(
	'git-graph-rs-webview-icon-light.svg',
	stamp('webview-icon-light.svg', crab({ body: '#656565', limbs: '#858585' }, 'translate(16.2 8.6) scale(0.78)'))
);

// The command icons, 16x16: gray crab, matching each theme's grays.
write(
	'git-graph-rs-cmd-icon-light.svg',
	stamp('cmd-icon-light.svg', crab({ body: '#424242', limbs: '#757575' }, 'translate(10.45 5.61) scale(0.55)'))
);
write(
	'git-graph-rs-cmd-icon-dark.svg',
	stamp('cmd-icon-dark.svg', crab({ body: '#c5c5c5', limbs: '#8a8a8a' }, 'translate(10.45 5.61) scale(0.55)'))
);

// The mobile notification icons, 48x48: the upstream art doubled, the crab riding the right
// edge at mid-height and the badge pinned to the top-right corner. The crab and badge are
// *outside* the scale(2) group — they are placed in 48-canvas coordinates.
const notificationDir = path.join(resources, 'notification');
fs.mkdirSync(notificationDir, { recursive: true });

const inner = (file) => {
	const svg = fs.readFileSync(path.join(upstream, file), 'utf8');
	const open = svg.indexOf('>');
	const close = svg.lastIndexOf('</svg>');
	return svg.slice(open + 1, close);
};

fs.writeFileSync(
	path.join(notificationDir, 'notification.svg'),
	`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">\n` +
		`<g transform="scale(2)">${inner('webview-icon.svg')}</g>\n` +
		crab(FERRIS, 'translate(25 15.3) scale(2)') +
		badge() +
		'\n</svg>\n'
);

// The white silhouette for tintable status bars: everything, crab included, becomes white.
fs.writeFileSync(
	path.join(notificationDir, 'notification-white.svg'),
	`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">\n` +
		`<g transform="scale(2)">${inner('webview-icon.svg')}</g>\n` +
		crab({ body: '#ffffff', limbs: '#ffffff', eye: '#ffffff', pupil: '#ffffff' }, 'translate(25 15.3) scale(2)') +
		'<circle cx="40" cy="9" r="7.5" fill="#ffffff"/>' +
		'\n</svg>\n'
);

/* ---------- The raster set ---------- */

// The marketplace icon: the upstream PNG with the crab composited onto its right edge at mid-height.
const crabPng = await sharp(path.join(resources, 'rust-crab.svg'), { density: 300 }).resize({ width: 44 }).png().toBuffer();
await sharp(path.join(upstream, 'icon.png'))
	.composite([{ input: crabPng, left: 82, top: 44 }])
	.png()
	.toFile(path.join(resources, 'icon.png'));

for (const size of [96, 192]) {
	await sharp(path.join(notificationDir, 'notification.svg'), { density: 300 })
		.resize(size, size)
		.png()
		.toFile(path.join(notificationDir, `notification-${size}.png`));
	await sharp(path.join(notificationDir, 'notification-white.svg'), { density: 300 })
		.resize(size, size)
		.png()
		.toFile(path.join(notificationDir, `notification-white-${size}.png`));
}

console.log('icons rebuilt: upstream art + the Rust crab at mid-height on the right');
