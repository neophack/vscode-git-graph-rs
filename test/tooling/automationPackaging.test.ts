/**
 * Tests for the packaging variant mechanism (scripts/automation-packaging.mjs): the default
 * build needs nothing moved out of the working tree (the .vscodeignore allowlist of task 1.4
 * keeps the variant's files out of the VSIX statically), and the automation build temporarily
 * flips `main` to the dist/automation bundle, swaps the .vscodeignore entries and injects the
 * package.json contributions. All exercised against a sandbox copy so the real tree is never
 * touched during the parallel suite.
 *
 * Ported from tests/automationPackaging.test.mjs (REFACTOR-PLAN task 7.1); assertions are
 * unchanged. The former "compiled extension loads with the automation modules absent" describe
 * was machinery of the deleted out/ tree; the shipped bundle's variant separation is
 * distBuild.test.ts's and distAutomation.test.ts's contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { restoreLeftoverBackups, withAutomationContributions, withAutomationExcluded } from '../../scripts/automation-packaging.mjs';

const sandboxRoot = path.join(os.tmpdir(), 'gg-automation-packaging-test');

function writeSandbox() {
	fs.rmSync(sandboxRoot, { recursive: true, force: true });
	fs.mkdirSync(path.join(sandboxRoot, 'out', 'automation', 'catalog'), { recursive: true });
	fs.mkdirSync(path.join(sandboxRoot, 'resources', 'automation'), { recursive: true });
	fs.mkdirSync(path.join(sandboxRoot, 'dist', 'askpass'), { recursive: true });
	fs.mkdirSync(path.join(sandboxRoot, 'dist', 'automation', 'askpass'), { recursive: true });
	fs.writeFileSync(path.join(sandboxRoot, 'out', 'automation', 'server.js'), 'module.exports = {};\n');
	fs.writeFileSync(path.join(sandboxRoot, 'out', 'automation', 'catalog', 'controlBar.js'), 'module.exports = {};\n');
	fs.writeFileSync(path.join(sandboxRoot, 'out', 'automation', 'graphViewPort.js'), 'exports.graphViewPort = {};\n');
	fs.writeFileSync(path.join(sandboxRoot, 'resources', 'automation', 'shim.js'), '// shim\n');
	fs.writeFileSync(path.join(sandboxRoot, 'dist', 'extension.js'), 'exports.activate = () => {};\n');
	fs.writeFileSync(path.join(sandboxRoot, 'dist', 'askpass', 'askpass.sh'), '#!/bin/sh\n');
	fs.writeFileSync(path.join(sandboxRoot, 'dist', 'automation', 'extension.js'), 'exports.activate = () => {};\n');
	fs.writeFileSync(path.join(sandboxRoot, 'dist', 'automation', 'askpass', 'askpass.sh'), '#!/bin/sh\n');
	fs.writeFileSync(path.join(sandboxRoot, 'package.json'), JSON.stringify({
		main: './dist/extension.js',
		contributes: {
			commands: [{ command: 'git-graph-rs.view', title: 'View Git Graph' }],
			menus: {},
			configuration: { type: 'object', properties: { 'git-graph-rs.enableLog': { type: 'boolean', default: false } } }
		}
	}, null, '\t') + '\n');
	fs.writeFileSync(path.join(sandboxRoot, 'package.nls.json'), JSON.stringify({ 'command.git-graph-rs.view.title': 'View Git Graph' }, null, '\t') + '\n');
	fs.writeFileSync(path.join(sandboxRoot, 'package.nls.zh-cn.json'), JSON.stringify({ 'command.git-graph-rs.view.title': '打开 Git Graph' }, null, '\t') + '\n');
	// Mirrors the real allowlist's dist section (the only lines the automation patch touches).
	fs.writeFileSync(path.join(sandboxRoot, '.vscodeignore'), [
		'**',
		'!dist/extension.js',
		'!dist/askpass/askpass.sh',
		'!dist/askpass/askpass-empty.sh',
		'!dist/askpass/askpassMain.js',
		'!resources/icon.png',
		''
	].join('\n'));
}

afterAll(() => {
	fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

describe('the packaging variant mechanism (automation-packaging.mjs)', () => {
	it('withAutomationContributions flips main, swaps the ignore allowlist and injects the contributions for the task, then restores all of it', async () => {
		writeSandbox();
		const result = await withAutomationContributions(async () => {
			const pkg = JSON.parse(fs.readFileSync(path.join(sandboxRoot, 'package.json'), 'utf8'));
			assert.equal(pkg.main, './dist/automation/extension.js');
			assert.ok(pkg.contributes.commands.some((c: any) => c.command === 'git-graph-rs.runAutomationTest'));
			assert.equal(pkg.contributes.menus['editor/title'].length, 1);
			// The external debug port is gone for good: no build carries the setting.
			assert.ok(!('git-graph-rs.automationPort' in pkg.contributes.configuration.properties));
			const nls = JSON.parse(fs.readFileSync(path.join(sandboxRoot, 'package.nls.json'), 'utf8'));
			assert.equal(nls['command.git-graph-rs.runAutomationTest.title'], 'Run Automation Test');
			const ignore = fs.readFileSync(path.join(sandboxRoot, '.vscodeignore'), 'utf8');
			assert.ok(ignore.includes('!dist/automation/extension.js'), 'the automation bundle must be re-included');
			assert.ok(ignore.includes('!resources/automation/shim.js'), 'the in-page shim must be re-included');
			assert.ok(!ignore.includes('!dist/extension.js'), 'the default bundle must not ship beside the variant');
			assert.ok(!ignore.includes('!dist/askpass/askpass.sh'), 'the default askpass launchers must not ship beside the variant');
			assert.ok(ignore.includes('!resources/icon.png'), 'unrelated allowlist entries must survive the patch');
			return 'task-result';
		}, sandboxRoot);
		assert.equal(result, 'task-result');

		// Restored: no automation traces, no backups left behind.
		const pkg = JSON.parse(fs.readFileSync(path.join(sandboxRoot, 'package.json'), 'utf8'));
		assert.equal(pkg.main, './dist/extension.js');
		assert.ok(!pkg.contributes.commands.some((c: any) => c.command === 'git-graph-rs.runAutomationTest'));
		assert.equal(pkg.contributes.menus['editor/title'], undefined);
		assert.ok(!('git-graph-rs.automationPort' in pkg.contributes.configuration.properties));
		const nls = JSON.parse(fs.readFileSync(path.join(sandboxRoot, 'package.nls.json'), 'utf8'));
		assert.equal(nls['command.git-graph-rs.runAutomationTest.title'], undefined);
		const ignore = fs.readFileSync(path.join(sandboxRoot, '.vscodeignore'), 'utf8');
		assert.ok(!ignore.includes('!dist/automation/extension.js'));
		assert.ok(ignore.includes('!dist/extension.js'));
		for (const file of ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', '.vscodeignore']) {
			assert.equal(fs.existsSync(path.join(sandboxRoot, file + '.automation-bak')), false, file + ' backup must be consumed');
		}
	});

	it('withAutomationExcluded leaves the working tree alone (the allowlist is the exclusion now)', async () => {
		writeSandbox();
		const seen = await withAutomationExcluded(async () => {
			// Since task 1.4 the default VSIX needs nothing moved: `main` points at the dist
			// bundle (whose compile-time switch omits the subsystem) and the .vscodeignore
			// allowlist never re-includes the variant's files. The pass-through is kept only for
			// its remaining caller (scripts/package-platforms.mjs).
			assert.equal(fs.readFileSync(path.join(sandboxRoot, 'out', 'automation', 'server.js'), 'utf8'), 'module.exports = {};\n');
			assert.equal(fs.existsSync(path.join(sandboxRoot, 'resources', 'automation', 'shim.js')), true);
			assert.equal(fs.existsSync(path.join(sandboxRoot, 'dist', 'automation', 'extension.js')), true);
			return 'untouched';
		});
		assert.equal(seen, 'untouched');
		assert.equal(fs.readFileSync(path.join(sandboxRoot, 'out', 'automation', 'server.js'), 'utf8'), 'module.exports = {};\n');
		assert.equal(fs.readFileSync(path.join(sandboxRoot, 'resources', 'automation', 'shim.js'), 'utf8'), '// shim\n');
	});

	it('restoreLeftoverBackups recovers from a killed run', () => {
		writeSandbox();
		const pkgPath = path.join(sandboxRoot, 'package.json');
		const original = fs.readFileSync(pkgPath, 'utf8');
		fs.writeFileSync(pkgPath + '.automation-bak', original);
		fs.writeFileSync(pkgPath, JSON.stringify({ contributes: { commands: [{ command: 'x' }] } }));
		assert.equal(restoreLeftoverBackups(sandboxRoot), true);
		assert.equal(fs.readFileSync(pkgPath, 'utf8'), original);
		assert.equal(fs.existsSync(pkgPath + '.automation-bak'), false);
		assert.equal(restoreLeftoverBackups(sandboxRoot), false);
	});
});
