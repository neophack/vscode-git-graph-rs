/**
 * Tests for the automation action catalog (src/automation/catalog.ts): structural validity,
 * command names that exist in the message protocol, resolvable placeholders, and UI selectors
 * that exist in the real webview DOM.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CATALOG, validateCatalog, expandTemplate } = require(path.join(rootDir, 'out', 'automation', 'catalog.js'));

/* ---------- source-derived reference data ---------- */

function sourceFiles(...relative) {
	return relative.map((rel) => {
		const file = path.join(rootDir, ...rel.split('/'));
		return { name: rel, text: fs.readFileSync(file, 'utf8') };
	});
}

/** Every command literal declared in the message types (requests and responses). */
function extractProtocolCommands() {
	const [{ text }] = sourceFiles('src/types/messages.ts');
	const commands = new Set();
	const re = /readonly command: '([^']+)';/g;
	let match;
	while ((match = re.exec(text)) !== null) commands.add(match[1]);
	return commands;
}

/** The ids the webview DOM is known to carry (programmatic assignment + inline HTML). */
function extractDomIds() {
	const files = sourceFiles(
		'web/main.ts', 'web/commitDetailsView.ts', 'web/settingsWidget.ts', 'web/findWidget.ts',
		'web/reflogView.ts', 'web/worktreeDialog.ts', 'web/statisticsView.ts', 'web/dialog.ts',
		'web/contextMenu.ts', 'web/dropdown.ts', 'src/gitGraphView.ts', 'web/observers.ts'
	);
	const ids = new Set();
	for (const { text } of files) {
		for (const re of [/\bgetElementById\('([^']+)'\)/g, /\bid = '([^']+)'/g, /\bid="([^"]+)"/g, /\bid='([^']+)'/g]) {
			let match;
			while ((match = re.exec(text)) !== null) ids.add(match[1]);
		}
	}
	return ids;
}

/** Placeholders the server's buildContext resolves (plus run params like `name`, `value`). */
const KNOWN_PLACEHOLDERS = new Set([
	'repo', 'head', 'branch', 'branchHead', 'remote', 'remoteBranch', 'stash', 'tag',
	'annotatedTag', 'findQuery', 'author', 'commit', 'commitParent', 'file',
	'binaryFile', 'binaryCommit', 'binaryCommitParent', 'imageFile', 'imageCommit', 'imageCommitParent',
	// run params commonly used by dialog flows
	'name', 'value', 'message', 'path', 'to', 'mode', 'hash'
]);

const KNOWN_GROUPS = new Set([
	'control-bar', 'row', 'menu-commit', 'menu-branch', 'menu-remote-branch', 'menu-stash',
	'menu-tag', 'menu-uncommitted', 'cdv', 'settings', 'find', 'keyboard', 'reflog',
	'worktree', 'statistics', 'host', 'menu-vscode'
]);

/* ---------- tests ---------- */

test('the catalog is structurally valid', () => {
	assert.deepEqual(validateCatalog(CATALOG), []);
	assert.ok(CATALOG.length >= 100, 'expected full control coverage (>= 100 actions), got ' + CATALOG.length);
});

test('groups are from the known set and ids are namespaced by group', () => {
	for (const action of CATALOG) {
		assert.ok(KNOWN_GROUPS.has(action.group), action.id + ': unknown group "' + action.group + '"');
		assert.ok(action.id === action.group + '/' + action.id.slice(action.group.length + 1), action.id + ': id must start with its group');
	}
});

test('every request command and expected response exists in the protocol', () => {
	const commands = extractProtocolCommands();
	for (const action of CATALOG) {
		for (const template of action.request ?? []) {
			assert.ok(commands.has(template.command), action.id + ': unknown request command "' + template.command + '"');
		}
		for (const response of action.expect.responses) {
			assert.ok(commands.has(response), action.id + ': unknown expected response "' + response + '"');
		}
	}
});

test('every placeholder resolves (no typos against the server context)', () => {
	const re = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;
	const check = (action, text) => {
		let match;
		while ((match = re.exec(text)) !== null) {
			assert.ok(KNOWN_PLACEHOLDERS.has(match[1]), action.id + ': unknown placeholder "{{' + match[1] + '}}"');
		}
	};
	for (const action of CATALOG) {
		check(action, JSON.stringify(action.request ?? []));
		check(action, JSON.stringify(action.ui ?? []));
		check(action, JSON.stringify(action.uiAfter ?? []));
		check(action, JSON.stringify(action.vscodeCommand ?? null));
		if (action.verify !== undefined) {
			const name = action.verify.placeholder.replace(/\{\{|\}\}/g, '');
			assert.ok(KNOWN_PLACEHOLDERS.has(name), action.id + ': unknown verify placeholder "' + name + '"');
		}
	}
});

test('expandTemplate expands nested structures and rejects unknown placeholders', () => {
	const template = { a: '{{repo}}', b: [{ c: 'x{{head}}y' }], d: 4, e: null };
	assert.deepEqual(expandTemplate(template, { repo: 'R', head: 'H' }), { a: 'R', b: [{ c: 'xHy' }], d: 4, e: null });
	assert.throws(() => expandTemplate({ a: '{{nope}}' }, { repo: 'R' }), /Unknown automation placeholder/);
});

test('hash-prefixed UI selectors reference ids that exist in the webview DOM', () => {
	const domIds = extractDomIds();
	// Ids assigned with dynamic suffixes (dialogForm inputs) — match by prefix.
	const dynamicPrefixes = ['dialogInput'];
	for (const action of CATALOG) {
		for (const step of [...(action.ui ?? []), ...(action.uiAfter ?? [])]) {
			if (!('selector' in step) || typeof step.selector !== 'string') continue;
			const match = /^#([A-Za-z][A-Za-z0-9_-]*)$/.exec(step.selector);
			if (match === null) continue; // attribute/compound selectors: checked by hand
			const id = match[1];
			if (domIds.has(id)) continue;
			if (dynamicPrefixes.some((prefix) => id.indexOf(prefix) === 0)) continue;
			assert.fail(action.id + ': selector #' + id + ' matches no id in the webview sources');
		}
	}
});

test('write actions declare how they are verified or are pure host commands', () => {
	for (const action of CATALOG) {
		if (!action.mutable) continue;
		// `host` and `menu-vscode` write entries are pure VS Code commands answered through
		// editor notifications, not the view pipeline — there is no response or repo state to check.
		if (action.group === 'host' || action.group === 'menu-vscode') continue;
		assert.ok(action.verify !== undefined || action.expect.responses.length > 0,
			action.id + ': a write action needs a verify state check or an expected ack');
	}
});

test('command-mode entries execute commands the extension actually contributes', () => {
	const commandsSource = fs.readFileSync(path.join(rootDir, 'src', 'commands.ts'), 'utf8');
	const registered = new Set([...commandsSource.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]));
	for (const action of CATALOG) {
		if (action.vscodeCommand === undefined) continue;
		assert.ok(registered.has(action.vscodeCommand.command), action.id + ': VS Code command "' + action.vscodeCommand.command + '" is not registered in src/commands.ts');
		assert.ok(['uri', 'rootUri', 'resourceStates', 'diffUri'].includes(action.vscodeCommand.arg?.kind ?? '') || action.vscodeCommand.arg === undefined,
			action.id + ': unknown command argument kind');
	}
});

test('exact-text steps stay in sync with the shipped interface languages', () => {
	// The shim matches menu items and expected text exactly, so the catalog carries one candidate
	// per interface language (bi(en, zh)). Every candidate must literally appear in web/strings.ts
	// (as a whole value, a substring of a format template, or without the render-time ellipsis) —
	// otherwise the entry silently stops matching under that language.
	const [{ text }] = sourceFiles('web/strings.ts');
	const zhStart = text.indexOf('const STRINGS_ZH_CN');
	assert.ok(zhStart > 0, 'web/strings.ts must declare STRINGS_ZH_CN');
	const enBlock = text.slice(0, zhStart), zhBlock = text.slice(zhStart);

	const candidates = [];
	for (const action of CATALOG) {
		for (const step of [...(action.ui ?? []), ...(action.uiAfter ?? [])]) {
			if (step.op === 'contextmenu') candidates.push([action.id, ...(Array.isArray(step.item) ? step.item : [step.item])]);
			if (step.op === 'expectText') candidates.push([action.id, ...(Array.isArray(step.contains) ? step.contains : [step.contains])]);
		}
	}
	assert.ok(candidates.length >= 45, 'expected the catalog to exercise exact-text matching broadly');

	for (const [id, ...texts] of candidates) {
		for (const text of texts) {
			const bare = text.replace(/…$/, '').replace(/\.\.\.$/, '');
			const present = [text, bare].some((form) => enBlock.includes(form) || zhBlock.includes(form));
			assert.ok(present, id + ': exact-text candidate ' + JSON.stringify(text) + ' matches nothing in web/strings.ts');
		}
	}
});
