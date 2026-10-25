/**
 * Build regression test for the automation build variant (REFACTOR-PLAN task 6.2): the
 * `--automation` mode of scripts/build/build.mjs emits dist/automation/extension.js with
 * __AUTOMATION__ defined truthy, so the gate in src/automation/modules.ts keeps its requires
 * and the automation modules (catalog, server, suite runner, report view) are BUNDLED IN —
 * while the default dist/extension.js (built with the flag false) carries none of them.
 *
 * Ported from tests/distAutomation.test.mjs (REFACTOR-PLAN task 7.1); assertions are unchanged.
 * Like distBuild.test.ts, this verifies artifacts, not sources: the suite self-skips when the
 * automation bundle has not been built (`node scripts/build/build.mjs --automation`), and the
 * cross-bundle assertions self-skip unless BOTH bundles exist.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultBundle = path.join(root, 'dist', 'extension.js');
const automationBundle = path.join(root, 'dist', 'automation', 'extension.js');
const skipAutomation = fs.existsSync(automationBundle)
	? false
	: 'dist/automation/ has not been built (run "node scripts/build/build.mjs --automation"); skipping';

const maybeIt = (skipAutomation as boolean) ? it.skip : it;

/** Load an extension bundle under the vscode stub (the pattern of distBuild.test.ts). */
function loadUnderStub(bundlePath: string) {
	const original = (Module as any)._resolveFilename;
	(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
		return request === 'vscode' ? request : original.call(this, request, ...rest);
	};
	(require.cache as any)['vscode'] = { exports: { ViewColumn: { Active: 1, Beside: 2, One: 3, Two: 4, Three: 5, Four: 6, Five: 7, Six: 8, Nine: 10, Eleven: 11 } } };
	try {
		return require(bundlePath);
	} finally {
		(Module as any)._resolveFilename = original;
		delete (require.cache as any)['vscode'];
	}
}

describe('the automation build variant (build.mjs --automation)', () => {
	maybeIt('the automation bundle loads under a vscode stub', () => {
		const bundle = loadUnderStub(automationBundle);
		assert.equal(typeof bundle.activate, 'function');
		assert.equal(typeof bundle.deactivate, 'function');
	});

	maybeIt('the automation bundle carries the automation modules', () => {
		const source = fs.readFileSync(automationBundle, 'utf8');
		// Catalog action ids (the catalog/ domain files) and the suite runner's strings exist only
		// in the automation modules; nothing outside them can produce these markers.
		for (const marker of [
			'menu-commit/add-tag',
			'control-bar/author-dropdown',
			'ScriptedUiPort',
			'Reset the fixture repository'
		]) {
			assert.ok(source.includes(marker), `the automation bundle must contain the marker "${marker}"`);
		}
		// ...and the modules are BUNDLED, not left as requires to files that are not in the VSIX.
		assert.ok(!/require\("\.\/automation\//.test(source), 'the automation modules must be bundled in, not required at runtime');
	});

	maybeIt('the compile-time switch separates the two bundles', () => {
		if (!fs.existsSync(defaultBundle)) {
			return; // the default bundle is distBuild.test.ts's contract; nothing to compare here
		}
		const automationSource = fs.readFileSync(automationBundle, 'utf8');
		const defaultSource = fs.readFileSync(defaultBundle, 'utf8');
		assert.ok(!defaultSource.includes('menu-commit/add-tag'), 'the default bundle must not contain catalog actions');
		assert.ok(automationSource.includes('menu-commit/add-tag'), 'the automation bundle must contain catalog actions');
		// The define replaced the flag in BOTH bundles — no __AUTOMATION__ identifier survives.
		assert.ok(!defaultSource.includes('__AUTOMATION__'), 'the flag must be compiled away in the default bundle');
		assert.ok(!automationSource.includes('__AUTOMATION__'), 'the flag must be compiled away in the automation bundle');
	});
});
