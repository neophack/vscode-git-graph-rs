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
 * What remains of the v1.0 file substitution is the OUT/-tree half, needed exactly as long as
 * package.json's `main` points into out/: out/extension.js decides at RUNTIME (a load-when-
 * present require), so the default VSIX must not carry out/automation:
 *   - withAutomationExcluded(task): moves out/automation/ and resources/automation/ aside for
 *     the duration of a vsce run, then restores them. When packaging flips to dist as `main`
 *     (the wave-1 dist pipeline's plan), this is the piece task 6.2 deletes.
 *   - withAutomationContributions(task): temporarily adds the automation contributions (the
 *     Run Automation Test command + editor-title button, and the nls titles) to package.json /
 *     package.nls.json / package.nls.zh-cn.json, then restores the originals. This one stays in
 *     every world: declaring the command is a manifest concern, not a code concern.
 *
 * Both are self-healing: a leftover backup from a killed previous run is restored first.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Directories whose absence defines the default (no-automation) build. */
const AUTOMATION_DIRS = ['out/automation', 'resources/automation'];
/**
 * Entries of out/automation the default build KEEPS (task 6.2): graphViewPort.js is the view's
 * injected-port seam, imported by out/gitGraphView.js unconditionally — view plumbing, not
 * automation-suite code (no catalog, no server, no runner), so it stays while the suite's
 * modules move aside.
 */
const AUTOMATION_KEEP = /^graphViewPort\./;
/** Files the automation build's contributions patch (restored from <file>.automation-bak). */
const CONTRIBUTION_FILES = ['package.json', 'package.nls.json', 'package.nls.zh-cn.json'];

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

function moveDir(source, target) {
	try {
		fs.renameSync(source, target);
	} catch (_) {
		// Cross-volume fallback: copy then remove.
		fs.cpSync(source, target, { recursive: true });
		fs.rmSync(source, { recursive: true, force: true });
	}
}

/** Run `task` with the automation suite's modules absent from the working tree (restored after). */
export async function withAutomationExcluded(task, root = rootDir) {
	const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-automation-stash-'));
	const stashed = [];
	try {
		for (const dir of AUTOMATION_DIRS) {
			const abs = path.join(root, dir);
			if (!fs.existsSync(abs)) continue;
			if (dir === 'out/automation') {
				// The graphViewPort seam stays (see AUTOMATION_KEEP); everything else in the
				// directory is the automation suite.
				for (const entry of fs.readdirSync(abs)) {
					if (AUTOMATION_KEEP.test(entry)) continue;
					const entryAbs = path.join(abs, entry);
					const aside = path.join(stashRoot, dir.replace(/\//g, '_') + '_' + entry);
					moveDir(entryAbs, aside);
					stashed.push({ abs: entryAbs, aside });
				}
			} else {
				const aside = path.join(stashRoot, dir.replace(/\//g, '_'));
				moveDir(abs, aside);
				stashed.push({ abs, aside });
			}
		}
		return await task();
	} finally {
		for (const { abs, aside } of stashed.reverse()) {
			if (fs.existsSync(abs)) {
				fs.rmSync(abs, { recursive: true, force: true });
			}
			moveDir(aside, abs);
		}
		fs.rmSync(stashRoot, { recursive: true, force: true });
	}
}

function applyContributions(root) {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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
}

/** Run `task` with the automation contributions present in package.json / nls (restored after). */
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
 * Build the dist/ bundle in the given compile-time automation mode (task 6.2): false (the
 * default) emits dist/extension.js with every automation require eliminated; true emits
 * dist/automation/extension.js with the automation modules bundled in. Exits the process on a
 * build failure — packaging a stale bundle is worse than not packaging.
 */
export function buildDist(automation = false) {
	const args = [path.join(rootDir, 'scripts', 'build', 'build.mjs'), '--production'];
	if (automation) args.push('--automation');
	const result = spawnSync(process.execPath, args, { cwd: rootDir, stdio: 'inherit' });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

/** Run vsce the same way on every OS (no shell shim dependence) with the given args. */
export function runVsce(args) {
	const vsceEntry = require.resolve('@vscode/vsce/vsce');
	const { execFileSync } = require('node:child_process');
	execFileSync(process.execPath, [vsceEntry, ...args], { cwd: rootDir, stdio: 'inherit' });
}
