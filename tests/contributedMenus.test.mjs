/**
 * Static cross-checks for everything the extension contributes to VS Code's own UI (package.json
 * `contributes.menus` / `contributes.commands`): every menu item must point at a declared,
 * registered command; the interface-language variants must stay symmetric (each base command and
 * its .zhCn twin offered together, differing only by the language context); `when` clauses may
 * only use context keys the extension actually sets, plus VS Code built-ins; localized titles
 * must exist in both shipped languages; and every command the menus offer must be exercised by
 * an automation catalog entry (the menu-vscode group) — the dynamic counterpart that runs those
 * entries against the real editor pipeline lives in the automation suites.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const menus = pkg.contributes.menus;
const declaredCommands = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
const menuLocations = Object.keys(menus);

/* ---------- source-derived reference data ---------- */

function readSource(relative) {
	return fs.readFileSync(path.join(rootDir, ...relative.split('/')), 'utf8');
}

/** The commands the CommandManager registers (src/commands.ts). */
function registeredCommands() {
	const text = readSource('src/commands.ts');
	const commands = new Set();
	for (const match of text.matchAll(/registerCommand\('([^']+)'/g)) commands.add(match[1]);
	return commands;
}

/** Context keys the when clauses may use: the ones the extension sets, plus VS Code built-ins. */
const EXTENSION_CONTEXT_KEYS = new Set(['git-graph-rs:interfaceZhCn', 'git-graph-rs:codiconsSupported']);
const BUILTIN_WHEN_KEYS = new Set(['resourceScheme', 'listMultiSelection', 'isInDiffEditor', 'scmProvider']);
/** Bare unquoted literals that appear inside when clauses (scheme names, the false hide). */
const WHEN_LITERALS = new Set(['git', 'file', 'git-graph-rs', 'false', 'true']);

/** Menu commands with a .zhCn twin (a command's title cannot follow a setting). */
const LANGUAGE_PAIRED_COMMANDS = ['amendLastCommit', 'resetCurrentBranchToRemote', 'gerritPushRef', 'gerritFetchCommitMsgHook'];

/* ---------- tests ---------- */

test('every menu item points at a command declared in contributes.commands', () => {
	for (const location of menuLocations) {
		for (const item of menus[location]) {
			assert.ok(declaredCommands.has(item.command), location + ': "' + item.command + '" is not declared in contributes.commands (the menu item would silently not render)');
		}
	}
});

test('every declared command is registered by the CommandManager, and every menu command exists in src', () => {
	const registered = registeredCommands();
	for (const command of declaredCommands.keys()) {
		assert.ok(registered.has(command), '"' + command + '" is declared to VS Code but never registered in src/commands.ts');
	}
	for (const location of menuLocations) {
		for (const item of menus[location]) {
			assert.ok(registered.has(item.command), location + ': "' + item.command + '" is not registered in src/commands.ts');
		}
	}
});

test('the interface-language command variants stay symmetric across every menu and the palette', () => {
	for (const location of menuLocations) {
		const offered = new Set(menus[location].map((i) => i.command));
		for (const base of LANGUAGE_PAIRED_COMMANDS) {
			assert.equal(offered.has('git-graph-rs.' + base + '.zhCn'), offered.has('git-graph-rs.' + base),
				location + ': "' + base + '" and its .zhCn variant must be offered together');
		}
	}
	// Where both variants are offered, their when clauses may differ only by the language context.
	for (const location of menuLocations) {
		for (const base of LANGUAGE_PAIRED_COMMANDS) {
			const en = menus[location].find((i) => i.command === 'git-graph-rs.' + base);
			const zh = menus[location].find((i) => i.command === 'git-graph-rs.' + base + '.zhCn');
			if (en === undefined || zh === undefined) continue;
			assert.equal((en.when ?? '').replace('!git-graph-rs:interfaceZhCn', '\u0001'), (zh.when ?? '').replace('git-graph-rs:interfaceZhCn', '\u0001'),
				location + ': the variants of "' + base + '" differ beyond the interface language context');
		}
	}
	// The palette gates each variant on exactly the interface language context.
	for (const base of LANGUAGE_PAIRED_COMMANDS) {
		const palette = new Map(menus.commandPalette.filter((i) => i.command === 'git-graph-rs.' + base || i.command === 'git-graph-rs.' + base + '.zhCn').map((i) => [i.command, i.when]));
		assert.equal(palette.get('git-graph-rs.' + base), '!git-graph-rs:interfaceZhCn', base + ': the palette entry must hide the English variant under zh-CN');
		assert.equal(palette.get('git-graph-rs.' + base + '.zhCn'), 'git-graph-rs:interfaceZhCn', base + ': the palette entry must show the zh-CN variant only under zh-CN');
	}
});

test('when clauses use only context keys the extension or VS Code itself provides', () => {
	for (const location of menuLocations) {
		for (const item of menus[location]) {
			// Quoted string literals are comparison VALUES ('More Actions', 'Inline'), not keys.
			const clause = (item.when ?? '').replace(/'[^']*'/g, ' ');
			for (const token of clause.match(/[A-Za-z][A-Za-z0-9_.:\-]*/g) ?? []) {
				if (token.indexOf('config.') === 0 || WHEN_LITERALS.has(token)) continue;
				assert.ok(EXTENSION_CONTEXT_KEYS.has(token) || BUILTIN_WHEN_KEYS.has(token),
					location + '/' + item.command + ': when-clause key "' + token + '" is neither set by the extension (setContext in src/commands.ts) nor a known VS Code built-in');
			}
		}
	}
	// The extension-set keys must really be set somewhere in the extension sources.
	const commandsSource = readSource('src/commands.ts');
	for (const key of EXTENSION_CONTEXT_KEYS) {
		assert.ok(commandsSource.includes('"' + key + '"'), 'context key "' + key + '" must be set via setContext in src/commands.ts');
	}
});

test('localized command titles exist in every shipped language', () => {
	const en = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.nls.json'), 'utf8'));
	const zh = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.nls.zh-cn.json'), 'utf8'));
	for (const command of pkg.contributes.commands) {
		const match = /^%(.+)%$/.exec(command.title);
		if (match === null) continue; // literal (language-variant) titles
		assert.ok(en[match[1]] !== undefined, '"' + command.command + '": English title key ' + match[1] + ' missing from package.nls.json');
		assert.ok(zh[match[1]] !== undefined, '"' + command.command + '": zh-CN title key ' + match[1] + ' missing from package.nls.zh-cn.json');
	}
	assert.equal(en['command.git-graph-rs.filterByFile.title'], 'Show File History in Git Graph RS');
});

test('the file-history command is hidden from the palette (it needs a file argument)', () => {
	const paletteEntry = menus.commandPalette.find((i) => i.command === 'git-graph-rs.filterByFile');
	assert.ok(paletteEntry !== undefined, 'filterByFile must declare a commandPalette entry');
	assert.equal(paletteEntry.when, 'false', 'filterByFile cannot run from the palette (no file to filter by)');
	// ...and the menus that DO offer it pass one: the four resource surfaces.
	const offering = menuLocations.filter((location) => location !== 'commandPalette' && menus[location].some((i) => i.command === 'git-graph-rs.filterByFile'));
	assert.deepEqual([...offering].sort(), ['editor/context', 'editor/title/context', 'explorer/context', 'scm/resourceState/context']);
});

test('every menu command is exercised by an automation catalog entry, and vice versa', () => {
	const { CATALOG } = require(path.join(rootDir, 'out', 'automation', 'catalog.js'));
	const commandActions = CATALOG.filter((a) => a.vscodeCommand !== undefined);
	const timesCovered = new Map();
	for (const action of commandActions) {
		timesCovered.set(action.vscodeCommand.command, (timesCovered.get(action.vscodeCommand.command) ?? 0) + 1);
	}

	// Every command any menu offers has a catalog entry (the .zhCn twins run the same handler as
	// their base command, so the base id covers them).
	const menuCommands = new Set();
	for (const location of menuLocations) {
		if (location === 'commandPalette') continue;
		for (const item of menus[location]) menuCommands.add(item.command.replace(/\.zhCn$/, ''));
	}
	for (const command of menuCommands) {
		assert.ok(timesCovered.has(command), 'menu command "' + command + '" (' + menuLocations.filter((l) => l !== 'commandPalette' && menus[l].some((i) => i.command.replace(/\.zhCn$/, '') === command)).join(', ') + ') has no menu-vscode automation entry');
	}

	// Every catalog command action targets a command VS Code can actually reach (a menu or the
	// palette) — otherwise it simulates a surface that does not exist.
	const reachable = new Set(menuCommands);
	for (const item of menus.commandPalette) reachable.add(item.command.replace(/\.zhCn$/, ''));
	for (const action of commandActions) {
		assert.ok(reachable.has(action.vscodeCommand.command), action.id + ' executes "' + action.vscodeCommand.command + '", which no menu or palette offers');
	}

	// The four file-history menu surfaces map to four entries: three URI-shaped (Explorer,
	// Editor, Editor tab) and the Source Control resource shape.
	const filterEntries = commandActions.filter((a) => a.vscodeCommand.command === 'git-graph-rs.filterByFile');
	assert.ok(filterEntries.length >= 4, 'expected one filterByFile entry per menu surface, got ' + filterEntries.length);
	assert.ok(filterEntries.filter((a) => a.vscodeCommand.arg?.kind === 'uri' && a.vscodeCommand.arg.of === 'file').length >= 3,
		'the Explorer / Editor / Editor tab context menus need URI-shaped filterByFile entries');
	assert.ok(filterEntries.some((a) => a.vscodeCommand.arg?.kind === 'resourceStates'),
		'the Source Control resource context menu needs a resourceStates-shaped filterByFile entry');
	for (const action of filterEntries) {
		assert.ok(action.uiAfter !== undefined, action.id + ' must clear the file filter it sets (uiAfter)');
	}

	// The Source Control view's menus pass the repository root.
	for (const command of ['git-graph-rs.view', 'git-graph-rs.amendLastCommit', 'git-graph-rs.gerritPushRef', 'git-graph-rs.gerritFetchCommitMsgHook', 'git-graph-rs.resetCurrentBranchToRemote']) {
		for (const action of commandActions.filter((a) => a.vscodeCommand.command === command)) {
			assert.deepEqual(action.vscodeCommand.arg, { kind: 'rootUri' }, action.id + ' must pass the Source Control menu argument shape ({rootUri})');
		}
	}
});
