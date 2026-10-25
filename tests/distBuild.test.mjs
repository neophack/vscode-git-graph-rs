/**
 * Build regression test for the unified dist pipeline (scripts/build/build.mjs and
 * scripts/build/compat.mjs, REFACTOR-PLAN tasks 1.3/1.4): the host bundle exists, parses and
 * loads under a vscode stub, keeps only the declared externals outside the bundle, ships the
 * askpass launchers with LF endings beside the helper, and passes the ES2018 compatibility
 * gate.
 *
 * Like the out/-based legacy tests (which import ../out/*.js and need a compile first), this
 * file verifies artifacts, not sources: the whole suite self-skips when dist/ has not been
 * built, so `npm run test:node` stays green in a source-only checkout.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkCompat } from '../scripts/build/compat.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionBundle = path.join(root, 'dist', 'extension.js');
const skip = fs.existsSync(extensionBundle)
	? false
	: 'dist/ has not been built (run "npm run build:dist"); skipping';

function walk(directory, extension) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walk(full, extension));
		else if (entry.name.endsWith(extension)) files.push(path.relative(root, full).split(path.sep).join('/'));
	}
	return files.sort();
}

test('dist/extension.js parses and loads under a vscode stub', { skip }, () => {
	const original = Module._resolveFilename;
	Module._resolveFilename = function (request, ...rest) {
		return request === 'vscode' ? request : original.call(this, request, ...rest);
	};
	// config.ts builds a module-level table from vscode.ViewColumn; the stub only needs that.
	require.cache['vscode'] = { exports: { ViewColumn: { Active: 1, Beside: 2, One: 3, Two: 4, Three: 5, Four: 6, Five: 7, Six: 8, Seven: 9, Eight: 10, Nine: 11 } } };
	try {
		const bundle = require(extensionBundle);
		assert.equal(typeof bundle.activate, 'function');
		assert.equal(typeof bundle.deactivate, 'function');
	} finally {
		Module._resolveFilename = original;
		delete require.cache['vscode'];
	}
});

test('the host bundle keeps only the declared externals outside the bundle', { skip }, () => {
	const source = fs.readFileSync(extensionBundle, 'utf8');
	const specifiers = new Set();
	// dataSource.ts embeds `require("fs")` inside string literals (the temporary rebase editor
	// scripts); node builtins are allowed for those just as for real requires.
	for (const match of source.matchAll(/require\("([^"]+)"\)/g)) specifiers.add(match[1]);
	assert.ok(specifiers.has('vscode'), 'the vscode API must stay external');
	// The automation modules are NOT allowed as externals any more: the compile-time
	// __AUTOMATION__ switch (task 6.2) either eliminates their requires (default build) or
	// bundles them in (dist/automation), so a require of them here means the gate broke.
	const allowed = new Set(['vscode', 'original-fs']);
	const unexpected = [...specifiers].filter((specifier) => !allowed.has(specifier) && !Module.builtinModules.includes(specifier));
	assert.deepEqual(unexpected, [], 'every require must be a node builtin or a declared external');
});

test('the default host bundle carries no automation module code', { skip }, () => {
	// The compile-time switch's core guarantee (task 6.2): with __AUTOMATION__ false the gate in
	// src/automation/modules.ts is dead-code-eliminated, so no catalog, server or suite-runner
	// content enters dist/extension.js. Catalog action ids and the runner's strings exist only
	// in the automation modules, so their absence here is the proof. (The automation variant of
	// this bundle, dist/automation/extension.js, is covered by tests/distAutomation.test.mjs.)
	const source = fs.readFileSync(extensionBundle, 'utf8');
	const automationMarkers = [
		'menu-commit/add-tag',           // a catalog action id (catalog/ domain files)
		'control-bar/author-dropdown',   // the catalog's first action id
		'native save dialog',            // NATIVE_SAVE_DIALOG_SKIP_REASON
		'Reset the fixture repository'   // suiteRunner's reseed record title
	];
	for (const marker of automationMarkers) {
		assert.ok(!source.includes(marker), `the default bundle must not contain the automation marker "${marker}"`);
	}
});

test('dist/ contains exactly the host bundle and the askpass helper', { skip }, () => {
	// dist/automation/ (the --automation variant, verified by tests/distAutomation.test.mjs) may
	// sit beside the default artifacts; it is not part of THIS bundle's contract.
	const files = walk(path.join(root, 'dist'), '.js').filter((file) => !file.startsWith('dist/automation/'));
	assert.deepEqual(files, ['dist/askpass/askpassMain.js', 'dist/extension.js']);
});

test('the askpass launchers ship beside the helper with LF endings', { skip }, () => {
	for (const name of ['askpass.sh', 'askpass-empty.sh']) {
		const contents = fs.readFileSync(path.join(root, 'dist', 'askpass', name), 'utf8');
		assert.ok(!contents.includes('\r'), name + ' must not contain carriage returns (git runs it through sh)');
	}
	assert.ok(
		fs.readFileSync(path.join(root, 'dist', 'askpass', 'askpass.sh'), 'utf8').includes('VSCODE_GIT_GRAPH_ASKPASS_MAIN'),
		'askpass.sh must launch the bundled askpassMain.js'
	);
});

test('the emitted artifacts pass the ES2018 compatibility gate', { skip }, () => {
	assert.deepEqual(checkCompat(), []);
});
