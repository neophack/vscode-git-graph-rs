/**
 * The artifact syntax gate's standalone runner (C1, REFACTOR-PLAN task 1.8): every script the
 * build emits under dist/ must parse as ES2018, the syntax floor of VS Code 1.38 (Node 10.11
 * host, Chromium 69 webview).
 *
 * The authoritative enforcement lives inside the build itself: scripts/build/build.mjs runs
 * this same es-check binary over the dist/ tree (glob: dist + "*.js") right behind its
 * in-tree TypeScript scanner (scripts/build/compat.mjs), so no build can emit an artifact
 * without both parsers agreeing. This script runs the gate standalone - for CI steps that do
 * not rebuild, and for manual runs - so the gate also exists outside the build pipeline.
 *
 *   node test/compat/artifactSyntax.test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Collect every .js file under dist/, at any depth (sourcemaps and non-scripts are not parsed). */
function collectDistScripts() {
	const dist = path.join(root, 'dist');
	if (!fs.existsSync(dist)) return [];
	const files = [];
	const walk = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.js')) files.push(full);
		}
	};
	walk(dist);
	return files.sort();
}

function fail(message) {
	console.error('ARTIFACT SYNTAX GATE FAILED: ' + message);
	process.exit(1);
}

const scripts = collectDistScripts();
if (scripts.length === 0) {
	fail('no build output found under dist/: run npm run build:dist first');
}

// es-check treats every argument as a glob, so the files go in as forward-slash paths
// relative to the repository root (absolute Windows backslash paths do not glob).
const scriptGlobs = scripts.map((file) => path.relative(root, file).replace(/\\/g, '/'));

let bin;
{
	const manifestPath = resolveDependencyManifest('es-check');
	if (manifestPath === null) {
		fail('es-check is not installed (it is a devDependency; run npm install)');
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	bin = path.join(path.dirname(manifestPath), manifest.bin['es-check']);
}

/**
 * Locate a devDependency's package.json by walking up the node_modules tree. require.resolve
 * cannot be used: a package whose `exports` field does not expose "./package.json"
 * (es-check among them) rejects the subpath resolution outright.
 */
function resolveDependencyManifest(name) {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = path.join(dir, 'node_modules', name, 'package.json');
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

const result = spawnSync(process.execPath, [bin, 'es2018', ...scriptGlobs], { cwd: root, encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error !== undefined) fail('failed to run es-check: ' + result.error.message);
if (result.status !== 0) {
	fail('es-check rejected the dist/ artifacts against the ES2018 floor (fix the esbuild targets in scripts/build/build.mjs, never the emitted output)');
}

console.log('Artifact syntax gate passed: ' + scripts.length + ' file(s) under dist/ parse as ES2018.');
