/**
 * The artifact compatibility gate (REFACTOR-PLAN §3.7.2): every script this repository emits
 * itself - the host and askpass bundles under dist/ and the webview bundle media/out.min.js -
 * must parse as ES2018, the syntax floor of VS Code 1.38 (Node 10.11 host, Chromium 69 webview).
 * esbuild's `target` downlevels our own sources, so what this gate catches is a dependency or a
 * future entry slipping newer syntax past the bundler.
 *
 * It reuses the TypeScript-parser scanner of scripts/build/es2018.mjs (template strings,
 * comments and regular expression literals cannot produce false positives) instead of pulling
 * in the es-check CLI the plan names: typescript is already installed, and the webview pipeline
 * gates its own bundle through the very same functions.
 *
 * The vendored media/vendor/*.js upstream builds are deliberately not scanned: the prebuilt
 * markdown-it.min.js already ships ES2019 optional catch binding, and replacing those artifacts
 * is tracked separately from this gate.
 *
 *   node scripts/build/compat.mjs   # checks the dist/ bundles and media/out.min.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFiles } from './es2018.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const webviewBundle = path.join(root, 'media', 'out.min.js');

function walk(directory, extension) {
	if (!fs.existsSync(directory)) return [];
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walk(full, extension));
		else if (entry.name.endsWith(extension)) files.push(full);
	}
	return files.sort();
}

/**
 * Check the emitted artifacts against the ES2018 floor.
 * @returns One message per problem; an empty array means the artifacts are compatible.
 */
export function checkCompat() {
	const problems = [];
	const scripts = walk(path.join(root, 'dist'), '.js');
	if (scripts.length === 0) {
		problems.push('no build output found under dist/: run npm run build:dist first');
		return problems;
	}
	if (!fs.existsSync(webviewBundle)) {
		problems.push('media/out.min.js is missing: the webview build (scripts/build/webview.mjs) did not run');
	} else {
		scripts.push(webviewBundle);
	}
	return [...problems, ...checkFiles(scripts, root)];
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const problems = checkCompat();
	if (problems.length > 0) {
		console.error('Compatibility check failed (floor: VS Code 1.38 = Node 10.11 / Chromium 69):\n');
		for (const problem of problems) console.error('  - ' + problem);
		process.exit(1);
	}
	console.log('Compatibility check passed (ES2018 syntax).');
}
