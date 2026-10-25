/**
 * The automation-testing capability is a BUILD VARIANT of the extension: the default build (the
 * default, `npm run package`) ships WITHOUT it, the automation build (`build-and-install.bat
 * automation`, `npm run package:automation`) ships WITH it.
 *
 * Since task 6.2 the dist/ side of the variant is a COMPILE-TIME switch: both package wrappers
 * first build the dist bundle in their mode (buildDist below — `__AUTOMATION__` defined false
 * or true by scripts/build/build.mjs), so the VSIX's dist/ tree is either automation-free
 * (dist/extension.js) or bundles the whole subsystem (dist/automation/extension.js).
 *
 * Since task 1.4 (package.json's `main` points at ./dist/extension.js and .vscodeignore is an
 * allowlist) the variant needs no file substitution at all:
 *   - the default VSIX is automation-free STATICALLY: the compile-time switch keeps the
 *     subsystem out of dist/extension.js, and the allowlist re-includes neither dist/automation/
 *     nor resources/automation/ (nor out/, which no longer packages). withAutomationExcluded
 *     below is therefore a pass-through kept only until its remaining caller
 *     (scripts/package-platforms.mjs) drops it.
 *   - withAutomationContributions(task): temporarily makes the tree package the AUTOMATION
 *     variant — `main` flipped to ./dist/automation/extension.js, .vscodeignore re-including
 *     the variant's files instead of the default bundle, and the automation contributions (the
 *     Run Automation Test command + editor-title button, and the nls titles) added to
 *     package.json / package.nls.json / package.nls.zh-cn.json — then restores the originals.
 *
 * Both are self-healing: a leftover backup from a killed previous run is restored first.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Files the automation build's patch touches (restored from <file>.automation-bak). */
const CONTRIBUTION_FILES = ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', '.vscodeignore'];
/**
 * The .vscodeignore negations of the DEFAULT bundle: the automation patch drops them (the
 * variant's VSIX carries dist/automation/, not dist/extension.js) and re-includes the variant's
 * files instead. Keep in sync with .vscodeignore.
 */
const DEFAULT_BUNDLE_NEGATES = [
	'!dist/extension.js',
	'!dist/askpass/askpass.sh',
	'!dist/askpass/askpass-empty.sh',
	'!dist/askpass/askpassMain.js'
];
const AUTOMATION_NEGATES = [
	'!dist/automation/extension.js',
	'!dist/automation/askpass/askpass.sh',
	'!dist/automation/askpass/askpass-empty.sh',
	'!dist/automation/askpass/askpassMain.js',
	'!resources/automation/shim.js'
];
/** package.json's `main` for the duration of the automation vsce run. */
const AUTOMATION_MAIN = './dist/automation/extension.js';
/** The vendored webview assets the packaged view loads (the allowlist ships media/vendor). */
const VENDOR_SCRIPTS = ['package-highlight.js', 'package-markdown.js'];

const CONTRIBUTIONS = {
	command: {
		category: 'Git Graph RS',
		command: 'git-graph-rs.runAutomationTest',
		title: '%command.git-graph-rs.runAutomationTest.title%',
		icon: '$(beaker)',
		enablement: 'git-graph-rs:codiconsSupported'
	},
	menu: {
		command: 'git-graph-rs.runAutomationTest',
		when: 'activeWebviewPanelId == git-graph-rs && git-graph-rs:codiconsSupported',
		group: 'navigation'
	},
	nls: {
		'package.nls.json': {
			'command.git-graph-rs.runAutomationTest.title': 'Run Automation Test'
		},
		'package.nls.zh-cn.json': {
			'command.git-graph-rs.runAutomationTest.title': '运行自动化测试'
		}
	}
};

function backupPath(root, file) {
	return path.join(root, file + '.automation-bak');
}

/** Restore any backup a killed run left behind; returns TRUE when one existed. */
export function restoreLeftoverBackups(root = rootDir) {
	let restored = false;
	for (const file of CONTRIBUTION_FILES) {
		const bak = backupPath(root, file);
		if (fs.existsSync(bak)) {
			fs.copyFileSync(bak, path.join(root, file));
			fs.rmSync(bak, { force: true });
			restored = true;
		}
	}
	return restored;
}

/**
 * Run `task` with the working tree's automation files left exactly where they are. Since task
 * 1.4 the default VSIX needs nothing moved: `main` points at the dist bundle (whose
 * compile-time switch omits the subsystem) and the .vscodeignore allowlist never re-includes
 * the variant's files. Retained as a pass-through for scripts/package-platforms.mjs until it
 * drops the call.
 */
export async function withAutomationExcluded(task) {
	return await task();
}

function applyContributions(root) {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	pkg.main = AUTOMATION_MAIN;
	pkg.contributes.commands.push({ ...CONTRIBUTIONS.command });
	pkg.contributes.menus = pkg.contributes.menus ?? {};
	pkg.contributes.menus['editor/title'] = [
		...(pkg.contributes.menus['editor/title'] ?? []),
		{ ...CONTRIBUTIONS.menu }
	];
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, '\t') + '\n');
	for (const [file, keys] of Object.entries(CONTRIBUTIONS.nls)) {
		const nls = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
		Object.assign(nls, keys);
		fs.writeFileSync(path.join(root, file), JSON.stringify(nls, null, '\t') + '\n');
	}
	const ignoreFile = path.join(root, '.vscodeignore');
	const lines = fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/).filter((line) => !DEFAULT_BUNDLE_NEGATES.includes(line.trim()));
	fs.writeFileSync(ignoreFile, [...lines, ...AUTOMATION_NEGATES].join('\n').replace(/\n*$/, '\n'));
}

/** Run `task` with the tree packaging the automation variant (originals restored after). */
export async function withAutomationContributions(task, root = rootDir) {
	restoreLeftoverBackups(root);
	for (const file of CONTRIBUTION_FILES) {
		fs.copyFileSync(path.join(root, file), backupPath(root, file));
	}
	try {
		applyContributions(root);
		return await task();
	} finally {
		restoreLeftoverBackups(root);
	}
}

/**
 * Build the complete packaging input in the given compile-time automation mode (task 6.2):
 * false (the default) emits dist/extension.js with every automation require eliminated; true
 * emits dist/automation/extension.js with the automation modules bundled in. The vendored
 * webview assets (media/vendor/*.min.js) are rebuilt too — the allowlist ships them and the
 * view's HTML loads them, so a packaging run must never reuse a stale or missing copy. Exits
 * the process on a build failure — packaging a stale bundle is worse than not packaging.
 */
export function buildDist(automation = false) {
	const args = [path.join(rootDir, 'scripts', 'build', 'build.mjs'), '--production'];
	if (automation) args.push('--automation');
	let result = spawnSync(process.execPath, args, { cwd: rootDir, stdio: 'inherit' });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
	for (const script of VENDOR_SCRIPTS) {
		result = spawnSync(process.execPath, [path.join(rootDir, 'scripts', script)], { cwd: rootDir, stdio: 'inherit' });
		if (result.status !== 0) {
			process.exit(result.status ?? 1);
		}
	}
}

/** Run vsce the same way on every OS (no shell shim dependence) with the given args. */
export function runVsce(args) {
	const vsceEntry = require.resolve('@vscode/vsce/vsce');
	const { execFileSync } = require('node:child_process');
	execFileSync(process.execPath, [vsceEntry, ...args], { cwd: rootDir, stdio: 'inherit' });
}
