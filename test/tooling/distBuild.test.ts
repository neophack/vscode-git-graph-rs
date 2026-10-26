/**
 * Build regression test for the unified dist pipeline (scripts/build/build.mjs and
 * scripts/build/compat.mjs, REFACTOR-PLAN tasks 1.3/1.4): the host bundle exists, parses and
 * loads under a vscode stub, keeps only the declared externals outside the bundle, ships the
 * askpass launchers with LF endings beside the helper, and passes the ES2018 compatibility
 * gate.
 *
 * Ported from tests/distBuild.test.mjs (REFACTOR-PLAN task 7.1); assertions are unchanged. The
 * whole suite self-skips when dist/ has not been built, so `npx vitest run` stays green in a
 * source-only checkout.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';
import { checkCompat } from '../../scripts/build/compat.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionBundle = path.join(root, 'dist', 'extension.js');
const skip = fs.existsSync(extensionBundle)
	? false
	: 'dist/ has not been built (run "npm run build:dist"); skipping';

function walk(directory: string, extension: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walk(full, extension));
		else if (entry.name.endsWith(extension)) files.push(path.relative(root, full).split(path.sep).join('/'));
	}
	return files.sort();
}

const maybeIt = (skip as boolean) ? it.skip : it;

describe('the unified dist pipeline (build.mjs)', () => {
	maybeIt('dist/extension.js parses and loads under a vscode stub', () => {
		const original = (Module as any)._resolveFilename;
		(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
			return request === 'vscode' ? request : original.call(this, request, ...rest);
		};
		// config.ts builds a module-level table from vscode.ViewColumn; the stub only needs that.
		(require.cache as any)['vscode'] = { exports: { ViewColumn: { Active: 1, Beside: 2, One: 3, Two: 4, Three: 5, Four: 6, Five: 7, Six: 8, Seven: 9, Eight: 10, Nine: 11 } } };
		try {
			const bundle = require(extensionBundle);
			assert.equal(typeof bundle.activate, 'function');
			assert.equal(typeof bundle.deactivate, 'function');
		} finally {
			(Module as any)._resolveFilename = original;
			delete (require.cache as any)['vscode'];
		}
	});

	maybeIt('the host bundle keeps only the declared externals outside the bundle', () => {
		const source = fs.readFileSync(extensionBundle, 'utf8');
		const specifiers = new Set<string>();
		// the git layer embeds `require("fs")` inside string literals (the temporary rebase editor
		// scripts); node builtins are allowed for those just as for real requires.
		for (const match of source.matchAll(/require\("([^"]+)"\)/g)) specifiers.add(match[1]);
		assert.ok(specifiers.has('vscode'), 'the vscode API must stay external');
		// The automation modules are NOT allowed as externals any more: the compile-time
		// __AUTOMATION__ switch (task 6.2) either eliminates their requires (default build) or
		// bundles them in (dist/automation), so a require of them here means the gate broke.
		const allowed = new Set(['vscode', 'original-fs']);
		const unexpected = [...specifiers].filter((specifier) => !allowed.has(specifier) && !(Module as any).builtinModules.includes(specifier));
		assert.deepEqual(unexpected, [], 'every require must be a node builtin or a declared external');
	});

	maybeIt('the default host bundle carries no automation module code', () => {
		// The compile-time switch's core guarantee (task 6.2): with __AUTOMATION__ false the gate in
		// src/extension/automation/modules.ts is dead-code-eliminated, so no catalog, server or suite-runner
		// content enters dist/extension.js. Catalog action ids and the runner's strings exist only
		// in the automation modules, so their absence here is the proof. (The automation variant of
		// this bundle, dist/automation/extension.js, is covered by distAutomation.test.ts.)
		const source = fs.readFileSync(extensionBundle, 'utf8');
		const automationMarkers = [
			'menu-commit/add-tag',           // a catalog action id (catalog/ domain files)
			'control-bar/author-dropdown',   // the catalog's first action id
			'ScriptedUiPort',                // the automation build's scripted native-UI port (task 4.10)
			'Reset the fixture repository'   // suiteRunner's reseed record title
		];
		for (const marker of automationMarkers) {
			assert.ok(!source.includes(marker), `the default bundle must not contain the automation marker "${marker}"`);
		}
	});

	maybeIt('dist/ contains exactly the host bundle and the askpass helper', () => {
		// dist/automation/ (the --automation variant, verified by distAutomation.test.ts) may
		// sit beside the default artifacts; it is not part of THIS bundle's contract.
		const files = walk(path.join(root, 'dist'), '.js').filter((file) => !file.startsWith('dist/automation/'));
		assert.deepEqual(files, [
			'dist/askpass/askpassMain.js',
			'dist/editors/message.js',
			'dist/editors/sequence.js',
			'dist/extension.js',
		]);
	});

	maybeIt('the askpass launchers ship beside the helper with LF endings', () => {
		for (const name of ['askpass.sh', 'askpass-empty.sh']) {
			const contents = fs.readFileSync(path.join(root, 'dist', 'askpass', name), 'utf8');
			assert.ok(!contents.includes('\r'), name + ' must not contain carriage returns (git runs it through sh)');
		}
		assert.ok(
			fs.readFileSync(path.join(root, 'dist', 'askpass', 'askpass.sh'), 'utf8').includes('VSCODE_GIT_GRAPH_ASKPASS_MAIN'),
			'askpass.sh must launch the bundled askpassMain.js'
		);
	});

	// Parses every dist/ script: several seconds alone, far more while the whole suite competes for the CPU.
	maybeIt('the emitted artifacts pass the ES2018 compatibility gate', () => {
		assert.deepEqual(checkCompat(), []);
	}, 60000);

	maybeIt('the VSIX manifest contract: the packaged file list is exactly the allowlist (task 1.4)', () => {
		// The dry-run listing `vsce ls` prints is the exact set `npm run package` zips (both go
		// through vsce's collect, the same .vscodeignore and the same package.json), so the
		// contract can be asserted without paying for a full packaging run: dist/extension.js,
		// the askpass launchers, the webview assets, the static resources and the engine binaries
		// ship; sources (src/, *.ts), source maps, tooling, docs and the automation variant's
		// files do not.
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).main,
			'./dist/extension.js',
			'package.json#main must point at the dist bundle'
		);
		const vsceEntry = require.resolve('@vscode/vsce/vsce');
		// --no-dependencies: the listing must reflect exactly what `npm run package` zips (the
		// packaging scripts pass the same flag — the VSIX never includes node_modules), and the
		// flag keeps the check deterministic in git worktrees, where npm list cannot classify a
		// shared, junctioned node_modules.
		const listed = execFileSync(process.execPath, [vsceEntry, 'ls', '--no-dependencies'], { cwd: root, encoding: 'utf8' })
			.split(/\r?\n/)
			.map((line) => line.trim())
			// Only real files on disk count; anything else vsce printed is noise.
			.filter((line) => line.length > 0 && fs.existsSync(path.join(root, line)));
		const set = new Set(listed);

		for (const required of [
			'dist/extension.js',
			'dist/askpass/askpass.sh',
			'dist/askpass/askpass-empty.sh',
			'dist/askpass/askpassMain.js',
			'media/out.min.js',
			'media/out.min.css',
			'resources/icon.png',
			'package.json',
			'package.nls.json',
			'package.nls.zh-cn.json',
			'LICENSE'
		]) {
			assert.ok(set.has(required), `${required} must ship in the VSIX`);
		}
		// The vendored webview assets and the engine binaries are build products; whichever are
		// present on this machine must be packaged (a missing one would 404 or silently disable
		// the engine in the shipped extension).
		for (const vendor of ['highlight.min.js']) {
			if (fs.existsSync(path.join(root, 'media', 'vendor', vendor))) {
				assert.ok(set.has(`media/vendor/${vendor}`), `media/vendor/${vendor} must ship in the VSIX`);
			}
		}
		// The on-demand chunks of task 5.9's code splitting: the entry reaches them through
		// relative dynamic import(), so a chunk left out of the VSIX breaks the first open of its
		// widget (and the zh-cn string table, and the Markdown renderer).
		const chunksDir = path.join(root, 'media', 'chunks');
		if (fs.existsSync(chunksDir)) {
			for (const chunk of fs.readdirSync(chunksDir)) {
				if (chunk.endsWith('.js')) {
					assert.ok(set.has(`media/chunks/${chunk}`), `media/chunks/${chunk} must ship in the VSIX`);
				}
			}
		}
		const nativeDir = path.join(root, 'native');
		if (fs.existsSync(nativeDir)) {
			for (const entry of fs.readdirSync(nativeDir)) {
				if (fs.existsSync(path.join(nativeDir, entry, 'git-graph.node'))) {
					assert.ok(set.has(`native/${entry}/git-graph.node`), `native/${entry}/git-graph.node must ship in the VSIX`);
				}
			}
		}
		// At least one license text ships; nothing outside the allowlist does.
		assert.ok([...set].some((file) => file.startsWith('licenses/')), 'the license texts must ship');
		for (const file of listed) {
			assert.ok(!/\.(ts|map)$/.test(file), `source artifacts must not ship: ${file}`);
			assert.ok(
				!/^(src|out|test|scripts|docs|coverage|node_modules|target)\//.test(file),
				`nothing under a source/tooling directory may ship: ${file}`
			);
			assert.ok(!file.startsWith('dist/automation/'), `the automation variant must not ship in the default VSIX: ${file}`);
			assert.ok(!file.startsWith('resources/automation/'), `the automation shim must not ship in the default VSIX: ${file}`);
			assert.ok(!file.startsWith('out/'), `the legacy out/ tree must not ship: ${file}`);
		}
	}, 120000);
});
