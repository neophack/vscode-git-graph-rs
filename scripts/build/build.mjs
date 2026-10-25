/**
 * The unified dist build (REFACTOR-PLAN §4.1, task 1.3): one esbuild pipeline that bundles the
 * extension host (src/extension.ts) into a single dist/extension.js on the VS Code 1.38 floor
 * (Node 10.11), bundles the askpass helper git's credential prompts run, copies the askpass
 * launchers, and chains the webview pipeline (scripts/build/webview.mjs) that emits
 * media/out.min.{js,css}.
 *
 *   dist/extension.js           the host, one file on the node10.11 target; only `vscode` and the
 *                               original-fs fallback stay outside the bundle
 *   dist/automation/extension.js  the same host built with `--automation`: __AUTOMATION__ is
 *                               defined truthy, so the automation subsystem's gate keeps its
 *                               requires and the automation modules are bundled in
 *   dist/askpass/askpassMain.js git's credential helper, spawned by the askpass launchers
 *   dist/askpass/askpass*.sh    the launchers git runs via GIT_ASKPASS (LF endings, exec bit)
 *   media/out.min.js|css        the webview, produced by scripts/build/webview.mjs
 *
 * What bundling changes about the sources' path assumptions, patched here at build time only
 * (the plan's Phase 1 risk note; the final home of runtime paths is platform/paths.ts):
 *
 * 1. `require("fs")` used to be textually rewritten to an original-fs fallback by
 *    scripts/package-src.js (the askpass server needs original-fs inside VS Code's Electron
 *    host). The same fallback is expressed here as a virtual module behind the `fs` specifier;
 *    `node:fs` bypasses the alias for the fallback itself. String literals that embed
 *    `require("fs")` (the temporary rebase editor scripts dataSource.ts writes) are untouched:
 *    an onResolve hook only ever sees real module specifiers, never literal contents.
 * 2. src/backend/addon.ts resolves the extension root as `path.join(__dirname, '..', '..')`
 *    because it compiles to out/backend/addon.js. Bundled at dist/extension.js the root is one
 *    level up, so the three default parameters are rewritten to a single '..'. `__dirname`
 *    itself survives bundling unchanged under format cjs - it stays a real Node global there,
 *    evaluating to dist/ at runtime.
 * 3. src/askpass/askpassManager.ts expects askpass.sh, askpass-empty.sh and askpassMain.js
 *    beside itself (out/askpass/). In the bundle `__dirname` is dist/ while the files live in
 *    dist/askpass/, so each of its five `__dirname` uses is rewritten to
 *    `path.join(__dirname, 'askpass')`.
 *
 * The automation subsystem is a compile-time build variant (REFACTOR-PLAN task 6.2): the
 * `__AUTOMATION__` define decides it. In the default build the flag is false and the gate in
 * src/automation/modules.ts is dead-code-eliminated, so no automation module (catalog, server,
 * suite runner) enters the bundle at all; with `--automation` the flag is true, the gate's
 * requires survive and the modules are bundled (nothing about them stays external). The out/
 * (tsc) tree defines nothing — there the gate loads the modules exactly when the packaging
 * variant put them in place, the v1.0 behavior.
 *
 *   node scripts/build/build.mjs              # development build (sourcemap, not minified)
 *   node scripts/build/build.mjs --production # what ships (minified, no sourcemaps)
 *   node scripts/build/build.mjs --automation # the automation-testing build variant
 *
 * After the webview build, the ES2018 compatibility gate (scripts/build/compat.mjs) scans the
 * emitted artifacts and fails the build on a violation. Type checking stays with the tsc
 * pipelines (`build:ts`, the webview build's own check): esbuild only strips types.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { checkCompat } from './compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(root, 'dist');
const production = process.argv.includes('--production');
const debugWebview = process.argv.includes('debug');
// The automation-testing build variant (task 6.2): __AUTOMATION__ defined truthy, the automation
// modules bundled in, everything emitted under dist/automation/ so the default dist/extension.js
// and the automation artifact can coexist (and be checked against each other) in one tree.
const automationBuild = process.argv.includes('--automation');
const hostOut = automationBuild ? path.join(dist, 'automation') : dist;

const common = {
	bundle: true,
	minify: production,
	sourcemap: production ? false : 'linked',
	sourcesContent: true,
	legalComments: 'none',
	logLevel: 'warning',
	// Node 10.11 and Chromium 69 both parse `catch {}`, but it is ES2019; lowering it keeps
	// every artifact inside the ES2018 syntax floor of VS Code 1.38 (REFACTOR-PLAN §3.7.2).
	supported: { 'optional-catch-binding': false }
};

/**
 * Rewrites the out/-tree path assumptions of the host sources for the dist/ bundle (points 1-3
 * above). The occurrence counts are asserted so a source edit that changes them fails the build
 * with a pointer here instead of silently producing a bundle with broken runtime paths.
 */
const hostAdapter = {
	name: 'dist-host-adapter',
	setup(builder) {
		builder.onResolve({ filter: /^fs$/ }, () => ({ path: 'gg:fs-fallback', namespace: 'gg-fs-fallback' }));
		builder.onLoad({ filter: /.*/, namespace: 'gg-fs-fallback' }, () => ({
			contents: "module.exports = (() => { try { return require('original-fs'); } catch (_) { return require('node:fs'); } })();"
		}));
		const rewrite = (contents, search, replacement) => contents.split(search).join(replacement);
		builder.onLoad({ filter: /[\\/]src[\\/]backend[\\/]addon\.ts$/ }, (args) => {
			const source = fs.readFileSync(args.path, 'utf8');
			const expected = "path.join(__dirname, '..', '..')";
			const count = source.split(expected).length - 1;
			if (count !== 3) {
				return { errors: [{ text: `expected 3 extension-root defaults in ${path.relative(root, args.path)}, found ${count}: update the patch in scripts/build/build.mjs` }] };
			}
			return { contents: rewrite(source, expected, "path.join(__dirname, '..')"), loader: 'ts' };
		});
		builder.onLoad({ filter: /[\\/]src[\\/]askpass[\\/]askpassManager\.ts$/ }, (args) => {
			const source = fs.readFileSync(args.path, 'utf8');
			const count = source.split('__dirname').length - 1;
			if (count !== 5) {
				return { errors: [{ text: `expected 5 __dirname uses in ${path.relative(root, args.path)}, found ${count}: update the patch in scripts/build/build.mjs` }] };
			}
			return { contents: rewrite(source, '__dirname', "path.join(__dirname, 'askpass')"), loader: 'ts' };
		});
	}
};

const hostEntry = {
	...common,
	entryPoints: { extension: 'src/extension.ts' },
	outdir: automationBuild ? path.relative(root, hostOut) : 'dist',
	platform: 'node',
	format: 'cjs',
	target: 'node10.11',
	// The compile-time automation switch (task 6.2): false dead-code-eliminates the gate's
	// requires (so no automation module enters the default bundle — nothing about them needs to
	// stay external in either mode); true keeps them, and the modules are bundled in.
	define: { __AUTOMATION__: automationBuild ? 'true' : 'false' },
	// The original-fs fallback require stays a runtime require (it only resolves inside VS
	// Code's Electron host).
	external: ['vscode', 'original-fs'],
	plugins: [hostAdapter],
	tsconfig: path.join(root, 'src', 'tsconfig.json')
};

const askpassEntry = {
	...common,
	entryPoints: { askpassMain: 'src/askpass/askpassMain.ts' },
	outdir: automationBuild ? path.relative(root, path.join(hostOut, 'askpass')) : 'dist/askpass',
	platform: 'node',
	format: 'cjs',
	target: 'node10.11',
	tsconfig: path.join(root, 'src', 'tsconfig.json')
};

/** Remove the previous outputs, so a stale file never survives a build that no longer emits it. */
function cleanOutputs() {
	if (automationBuild) {
		fs.rmSync(path.join(dist, 'automation'), { recursive: true, force: true });
		return;
	}
	for (const name of ['extension.js', 'extension.js.map']) {
		fs.rmSync(path.join(dist, name), { force: true });
	}
	fs.rmSync(path.join(dist, 'askpass'), { recursive: true, force: true });
}

/**
 * Copy the askpass launchers git runs via GIT_ASKPASS. They are POSIX shell scripts, so the copy
 * normalizes CRLF to LF (a Windows checkout with core.autocrlf hands us CRLF files, and `sh`
 * chokes on the carriage returns) and marks them executable; the exec bit matters where git
 * spawns them through sh, while Windows ignores it.
 */
function copyAskpassScripts() {
	const source = path.join(root, 'src', 'askpass');
	const target = path.join(hostOut, 'askpass');
	fs.mkdirSync(target, { recursive: true });
	for (const name of fs.readdirSync(source).filter((name) => name.endsWith('.sh')).sort()) {
		const contents = fs.readFileSync(path.join(source, name), 'utf8').replace(/\r\n/g, '\n');
		fs.writeFileSync(path.join(target, name), contents);
		fs.chmodSync(path.join(target, name), 0o755);
	}
}

/** Chain the webview pipeline; it owns media/out.min.{js,css} and its own source gates. */
function buildWebview() {
	const script = path.join(root, 'scripts', 'build', 'webview.mjs');
	const result = spawnSync(process.execPath, [script, ...(debugWebview ? ['debug'] : [])], { cwd: root, stdio: 'inherit' });
	if (result.status !== 0) {
		console.error('The webview build (scripts/build/webview.mjs) failed.');
		process.exit(result.status ?? 1);
	}
}

async function main() {
	fs.mkdirSync(dist, { recursive: true });
	cleanOutputs();

	const started = Date.now();
	await Promise.all([
		esbuild.build({ absWorkingDir: root, ...hostEntry }),
		esbuild.build({ absWorkingDir: root, ...askpassEntry })
	]);
	copyAskpassScripts();
	console.log(`Bundled ${automationBuild ? 'dist/automation' : 'dist/'} in ${Date.now() - started} ms (${production ? 'production' : 'development'})`);

	buildWebview();

	// The compatibility gate runs on every build, development or production: a dependency
	// slipping post-ES2018 syntax past the bundler is as broken in a dev artifact as in a
	// shipped one.
	const problems = checkCompat();
	if (problems.length > 0) {
		console.error('\nCompatibility check failed (floor: VS Code 1.38 = Node 10.11 / Chromium 69):\n');
		for (const problem of problems) console.error('  - ' + problem);
		process.exit(1);
	}
	console.log('Compatibility check passed (ES2018 syntax).');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
