/**
 * Tests for the packaging variant mechanism (scripts/automation-packaging.mjs): the default
 * build needs nothing moved out of the working tree (the .vscodeignore allowlist of task 1.4
 * keeps the variant's files out of the VSIX statically), and the automation build temporarily
 * flips `main` to the dist/automation bundle, swaps the .vscodeignore entries and injects the
 * package.json contributions. All exercised against a sandbox copy so the real tree is never
 * touched during the parallel suite.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { restoreLeftoverBackups, withAutomationContributions, withAutomationExcluded } from '../scripts/automation-packaging.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

test.after(() => {
	fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('withAutomationContributions flips main, swaps the ignore allowlist and injects the contributions for the task, then restores all of it', async () => {
	writeSandbox();
	const result = await withAutomationContributions(async () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(sandboxRoot, 'package.json'), 'utf8'));
		assert.equal(pkg.main, './dist/automation/extension.js');
		assert.ok(pkg.contributes.commands.some((c) => c.command === 'git-graph-rs.runAutomationTest'));
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
	assert.ok(!pkg.contributes.commands.some((c) => c.command === 'git-graph-rs.runAutomationTest'));
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

test('withAutomationExcluded leaves the working tree alone (the allowlist is the exclusion now)', async () => {
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

test('restoreLeftoverBackups recovers from a killed run', () => {
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

test('the compiled extension loads with the automation modules absent (the default build)', () => {
	// Copy out/ and resources/ to a sandbox and remove the automation capability from the copy:
	// the real tree stays untouched (other test files run against it in parallel).
	const copyRoot = path.join(os.tmpdir(), 'gg-stripped-build-test');
	fs.rmSync(copyRoot, { recursive: true, force: true });
	fs.cpSync(path.join(rootDir, 'out'), path.join(copyRoot, 'out'), { recursive: true });
	fs.cpSync(path.join(rootDir, 'resources'), path.join(copyRoot, 'resources'), { recursive: true });
	try {
		// The legacy out/ tree keeps its runtime gate: out/extension.js loads the automation
		// modules exactly when they are present, so the default build's tree is the one with
		// the suite's modules removed and the view's port seam (out/automation/graphViewPort.js,
		// required by out/gitGraphView.js) kept. (The shipped VSIX is the dist bundle, whose
		// compile-time switch omits the subsystem — that side is tests/distBuild.test.mjs's
		// and tests/distAutomation.test.mjs's contract.)
		for (const entry of fs.readdirSync(path.join(copyRoot, 'out', 'automation'))) {
			if (entry.startsWith('graphViewPort.')) continue;
			fs.rmSync(path.join(copyRoot, 'out', 'automation', entry), { recursive: true, force: true });
		}
		fs.rmSync(path.join(copyRoot, 'resources', 'automation'), { recursive: true, force: true });
		const probe = path.join(copyRoot, 'probe.cjs');
		fs.writeFileSync(probe, `
const { Module } = require('node:module');
const universal = new Proxy(function () {}, {
	get: (_t, prop) => prop === Symbol.toPrimitive ? () => 0 : universal,
	apply: () => universal,
	construct: () => universal,
	set: () => true
});
const stub = new Proxy({}, { get: () => universal });
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'vscode') return stub;
	return originalLoad.apply(this, [request, ...rest]);
};
require(${JSON.stringify(path.join(copyRoot, 'out', 'extension.js'))});
require(${JSON.stringify(path.join(copyRoot, 'out', 'commands.js'))});
require(${JSON.stringify(path.join(copyRoot, 'out', 'extension', 'graphView', 'panel.js'))});
console.log('STRIPPED-BUILD-LOADS');
`);
		const output = execFileSync(process.execPath, [probe], { encoding: 'utf8' });
		assert.ok(output.includes('STRIPPED-BUILD-LOADS'));
	} finally {
		fs.rmSync(copyRoot, { recursive: true, force: true });
	}
});
