/**
 * Build regression test for the automation build variant (REFACTOR-PLAN task 6.2): the
 * `--automation` mode of scripts/build/build.mjs emits dist/automation/extension.js with
 * __AUTOMATION__ defined truthy, so the gate in src/automation/modules.ts keeps its requires
 * and the automation modules (catalog, server, suite runner, report view) are BUNDLED IN —
 * while the default dist/extension.js (built with the flag false) carries none of them.
 *
 * Like tests/distBuild.test.mjs, this verifies artifacts, not sources: the suite self-skips
 * when the automation bundle has not been built (`node scripts/build/build.mjs --automation`),
 * and the cross-bundle assertions self-skip unless BOTH bundles exist.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultBundle = path.join(root, 'dist', 'extension.js');
const automationBundle = path.join(root, 'dist', 'automation', 'extension.js');
const skipAutomation = fs.existsSync(automationBundle)
	? false
	: 'dist/automation/ has not been built (run "node scripts/build/build.mjs --automation"); skipping';

/** Load an extension bundle under the vscode stub (the pattern of tests/distBuild.test.mjs). */
function loadUnderStub(bundlePath) {
	const original = Module._resolveFilename;
	Module._resolveFilename = function (request, ...rest) {
		return request === 'vscode' ? request : original.call(this, request, ...rest);
	};
	require.cache['vscode'] = { exports: { ViewColumn: { Active: 1, Beside: 2, One: 3, Two: 4, Three: 5, Four: 6, Five: 7, Six: 8, Nine: 10, Eleven: 11 } } };
	try {
		return require(bundlePath);
	} finally {
		Module._resolveFilename = original;
		delete require.cache['vscode'];
	}
}

test('the automation bundle loads under a vscode stub', { skip: skipAutomation }, () => {
	const bundle = loadUnderStub(automationBundle);
	assert.equal(typeof bundle.activate, 'function');
	assert.equal(typeof bundle.deactivate, 'function');
});

test('the automation bundle carries the automation modules', { skip: skipAutomation }, () => {
	const source = fs.readFileSync(automationBundle, 'utf8');
	// Catalog action ids (the catalog/ domain files) and the suite runner's strings exist only
	// in the automation modules; nothing outside them can produce these markers.
	for (const marker of [
		'menu-commit/add-tag',
		'control-bar/author-dropdown',
		'native save dialog',
		'Reset the fixture repository'
	]) {
		assert.ok(source.includes(marker), `the automation bundle must contain the marker "${marker}"`);
	}
	// ...and the modules are BUNDLED, not left as requires to files that are not in the VSIX.
	assert.ok(!/require\("\.\/automation\//.test(source), 'the automation modules must be bundled in, not required at runtime');
});

test('the compile-time switch separates the two bundles', { skip: skipAutomation }, () => {
	if (!fs.existsSync(defaultBundle)) {
		return; // the default bundle is distBuild.test.mjs's contract; nothing to compare here
	}
	const automationSource = fs.readFileSync(automationBundle, 'utf8');
	const defaultSource = fs.readFileSync(defaultBundle, 'utf8');
	assert.ok(!defaultSource.includes('menu-commit/add-tag'), 'the default bundle must not contain catalog actions');
	assert.ok(automationSource.includes('menu-commit/add-tag'), 'the automation bundle must contain catalog actions');
	// The define replaced the flag in BOTH bundles — no __AUTOMATION__ identifier survives.
	assert.ok(!defaultSource.includes('__AUTOMATION__'), 'the flag must be compiled away in the default bundle');
	assert.ok(!automationSource.includes('__AUTOMATION__'), 'the flag must be compiled away in the automation bundle');
});
