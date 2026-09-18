/**
 * The automation-testing capability is a packaging variant, not a runtime setting: the default
 * build (original bats + CI, `npm run package`) ships WITHOUT it, the automation build (the
 * `build-and-install-automation.bat` chain, `npm run package:automation`) ships WITH it.
 *
 * This module is the shared mechanism both wrappers and scripts/package-platforms.mjs use:
 *   - withAutomationExcluded(task): moves out/automation/ and resources/automation/ aside for
 *     the duration of a vsce run, then restores them (the extension host never loads them in
 *     the default build — extension.ts/commands.ts gate their requires, and the view page
 *     tolerates the shim's absence).
 *   - withAutomationContributions(task): temporarily adds the automation contributions (the
 *     Run Automation Test command + editor-title button, the automationPort setting, and the
 *     nls titles) to package.json / package.nls.json / package.nls.zh-cn.json, then restores
 *     the originals.
 *
 * Both are self-healing: a leftover backup from a killed previous run is restored first.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** Directories whose absence defines the default (no-automation) build. */
const AUTOMATION_DIRS = ['out/automation', 'resources/automation'];
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
	configuration: {
		type: 'number',
		default: 0,
		minimum: 0,
		maximum: 65535,
		description: '%config.git-graph-rs.automationPort.description%',
		markdownDescription: '%config.git-graph-rs.automationPort.markdownDescription%'
	},
	nls: {
		'package.nls.json': {
			'command.git-graph-rs.runAutomationTest.title': 'Run Automation Test',
			'config.git-graph-rs.automationPort.description': 'TCP port of the remote automation & debugging interface (0 = disabled).',
			'config.git-graph-rs.automationPort.markdownDescription': 'TCP port of the remote automation & debugging interface, listening on 127.0.0.1 only (0 = disabled). When set, a test driver (see the "Automation testing" README section) can connect to drive every Git Graph view control and collect per-action timings. **Only enable while testing.**'
		},
		'package.nls.zh-cn.json': {
			'command.git-graph-rs.runAutomationTest.title': '运行自动化测试',
			'config.git-graph-rs.automationPort.description': '远程自动化与调试接口的 TCP 端口(0 = 关闭)。',
			'config.git-graph-rs.automationPort.markdownDescription': '远程自动化与调试接口的 TCP 端口,仅监听 127.0.0.1(0 = 关闭)。设置后,测试程序(见 README 的 "Automation testing" 一节)可连接并驱动 Git Graph 视图的每个控件、统计每个动作的耗时。**仅在测试时开启。**'
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

/** Run `task` with the automation modules absent from the working tree (restored after). */
export async function withAutomationExcluded(task, root = rootDir) {
	const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-automation-stash-'));
	const stashed = [];
	try {
		for (const dir of AUTOMATION_DIRS) {
			const abs = path.join(root, dir);
			if (fs.existsSync(abs)) {
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
	pkg.contributes.configuration.properties['git-graph-rs.automationPort'] = { ...CONTRIBUTIONS.configuration };
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

/** Run vsce the same way on every OS (no shell shim dependence) with the given args. */
export function runVsce(args) {
	const vsceEntry = require.resolve('@vscode/vsce/vsce');
	const { execFileSync } = require('node:child_process');
	execFileSync(process.execPath, [vsceEntry, ...args], { cwd: rootDir, stdio: 'inherit' });
}
