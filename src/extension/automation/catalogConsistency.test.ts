/**
 * Tests for the automation action catalog's source-derived consistency (src/extension/automation/catalog.ts):
 * structural validity, command names that exist in the message protocol, resolvable
 * placeholders, and UI selectors that exist in the real webview DOM.
 *
 * Ported from the v1 suite (its tests/automationCatalog.test.mjs, now only in git history);
 * the assertions are unchanged. The structural split-snapshot checks live in catalog.test.ts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { CATALOG, expandTemplate, validateCatalog } from './catalog';

const rootDir = path.resolve(process.cwd());

/* ---------- source-derived reference data ---------- */

function sourceFiles(...relative: string[]) {
	return relative.map((rel) => {
		const file = path.join(rootDir, ...rel.split('/'));
		return { name: rel, text: fs.readFileSync(file, 'utf8') };
	});
}

/** Every .ts source of the webview (src/webview), as repo-relative paths. */
function webviewSources(): string[] {
	const walk = (dir: string): string[] => fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true }).flatMap((entry) => {
		const rel = dir + '/' + entry.name;
		return entry.isDirectory() ? walk(rel) : (entry.name.endsWith('.ts') ? [rel] : []);
	});
	return walk('src/webview');
}

/** Every .ts source of the shared protocol (src/shared/protocol), as repo-relative paths. */
function protocolSources(): string[] {
	const walk = (dir: string): string[] => fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true }).flatMap((entry) => {
		const rel = dir + '/' + entry.name;
		return entry.isDirectory() ? walk(rel) : (entry.name.endsWith('.ts') ? [rel] : []);
	});
	return walk('src/shared/protocol');
}

/** Every command literal declared in the message types (requests and responses). */
function extractProtocolCommands() {
	const text = sourceFiles(...protocolSources()).map((file) => file.text).join('\n');
	const commands = new Set<string>();
	const re = /readonly command: '([^']+)';/g;
	let match;
	while ((match = re.exec(text)) !== null) commands.add(match[1]);
	return commands;
}

/** The ids the webview DOM is known to carry (programmatic assignment + inline HTML). */
function extractDomIds() {
	const files = sourceFiles(...webviewSources(), 'src/extension/graphView/html.ts');
	const ids = new Set<string>();
	for (const { text } of files) {
		for (const re of [/\bgetElementById\('([^']+)'\)/g, /\bid = '([^']+)'/g, /\bid="([^"]+)"/g, /\bid='([^']+)'/g]) {
			let match;
			while ((match = re.exec(text)) !== null) ids.add(match[1]);
		}
		// checkbox('x', ...) renders the native input with the composed id
		// 'xCheckbox' (main.css hides it and draws the .customCheckbox sibling), so both the
		// label id and the composed input id are DOM ids a selector may target.
		let checkboxMatch;
		const checkboxRe = /\bcheckbox\('([^']+)'/g;
		while ((checkboxMatch = checkboxRe.exec(text)) !== null) {
			ids.add(checkboxMatch[1]);
			ids.add(checkboxMatch[1] + 'Checkbox');
		}
	}
	return ids;
}

/** Placeholders the server's buildContext resolves (plus run params like `name`, `value`). */
const KNOWN_PLACEHOLDERS = new Set([
	'repo', 'head', 'branch', 'branchHead', 'remote', 'remoteBranch', 'stash', 'tag',
	'annotatedTag', 'findQuery', 'author', 'commit', 'commitParent', 'commitSubject', 'file',
	'binaryFile', 'binaryCommit', 'binaryCommitParent', 'imageFile', 'imageCommit', 'imageCommitParent',
	// run params commonly used by dialog flows
	'name', 'value', 'message', 'path', 'to', 'mode', 'hash'
]);

const KNOWN_GROUPS = new Set([
	'control-bar', 'row', 'menu-commit', 'menu-branch', 'menu-remote-branch', 'menu-stash',
	'menu-tag', 'menu-uncommitted', 'cdv', 'settings', 'find', 'keyboard', 'reflog',
	'worktree', 'statistics', 'host', 'menu-vscode', 'external'
]);

/* ---------- tests ---------- */

describe('the automation catalog against its sources', () => {
	it('the catalog is structurally valid', () => {
		assert.deepEqual(validateCatalog(CATALOG), []);
		assert.ok(CATALOG.length >= 100, 'expected full control coverage (>= 100 actions), got ' + CATALOG.length);
	});

	it('groups are from the known set and ids are namespaced by group', () => {
		for (const action of CATALOG) {
			assert.ok(KNOWN_GROUPS.has(action.group), action.id + ': unknown group "' + action.group + '"');
			assert.ok(action.id === action.group + '/' + action.id.slice(action.group.length + 1), action.id + ': id must start with its group');
		}
	});

	it('every request command and expected response exists in the protocol', () => {
		const commands = extractProtocolCommands();
		for (const action of CATALOG) {
			for (const template of action.request ?? []) {
				assert.ok(commands.has(String((template as { command: unknown }).command)), action.id + ': unknown request command "' + (template as { command: unknown }).command + '"');
			}
			for (const response of action.expect.responses) {
				assert.ok(commands.has(String(response)), action.id + ': unknown expected response "' + response + '"');
			}
		}
	});

	it('every placeholder resolves (no typos against the server context)', () => {
		const re = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;
		const check = (action: any, text: string) => {
			let match;
			while ((match = re.exec(text)) !== null) {
				assert.ok(KNOWN_PLACEHOLDERS.has(match[1]), action.id + ': unknown placeholder "{{' + match[1] + '}}"');
			}
		};
		for (const action of CATALOG as any[]) {
			check(action, JSON.stringify(action.request ?? []));
			check(action, JSON.stringify(action.ui ?? []));
			check(action, JSON.stringify(action.uiAfter ?? []));
			check(action, JSON.stringify(action.vscodeCommand ?? null));
			if (action.verify !== undefined) {
				// A verify target is either a {{name}} context reference or the plain literal the
				// action itself names (e.g. 'automation-branch'); only the references are checked here.
				if (action.verify.placeholder.indexOf('{{') !== -1) {
					const name = action.verify.placeholder.replace(/\{\{|\}\}/g, '');
					assert.ok(KNOWN_PLACEHOLDERS.has(name), action.id + ': unknown verify placeholder "' + name + '"');
				} else {
					assert.ok(action.verify.placeholder.trim() !== '', action.id + ': empty verify literal');
				}
			}
		}
	});

	it('expandTemplate expands nested structures and rejects unknown placeholders', () => {
		const template = { a: '{{repo}}', b: [{ c: 'x{{head}}y' }], d: 4, e: null };
		assert.deepEqual(expandTemplate(template as never, { repo: 'R', head: 'H' } as never), { a: 'R', b: [{ c: 'xHy' }], d: 4, e: null });
		assert.throws(() => expandTemplate({ a: '{{nope}}' } as never, { repo: 'R' } as never), /Unknown automation placeholder/);
	});

	it('hash-prefixed UI selectors reference ids that exist in the webview DOM', () => {
		const domIds = extractDomIds();
		// Ids assigned with dynamic suffixes (dialogForm inputs) — match by prefix.
		const dynamicPrefixes = ['dialogInput'];
		for (const action of CATALOG as any[]) {
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

	it('write actions declare how they are verified or are pure host commands', () => {
		for (const action of CATALOG as any[]) {
			if (!action.mutable) continue;
			// `host` and `menu-vscode` write entries are pure VS Code commands answered through
			// editor notifications, not the view pipeline — the deterministic ones assert their
			// captured notification (see the test below); amend/reset answers depend on the
			// machine's Git identity and upstream, so only their capture is reported, not asserted.
			if (action.group === 'host' || action.group === 'menu-vscode') continue;
			assert.ok(action.verify !== undefined || action.expect.responses.length > 0,
				action.id + ': a write action needs a verify state check or an expected ack');
		}
	});

	it('deterministic refusal commands assert their captured notifications', () => {
		// The shared dictionary: the messages live in src/shared/i18n (both interface languages).
		const i18n = sourceFiles('src/shared/i18n/en.ts', 'src/shared/i18n/zh-cn.ts').map((file) => file.text).join('\n');
		const deterministic = CATALOG.filter((a: any) => a.group === 'menu-vscode' && a.mutable && a.expectNotifications !== undefined);
		// The two designed refusals of the fixture: the local-path remote offers no Gerrit server to
		// fetch the commit-msg hook from, and main == origin/main after the reseed pushes the
		// "already pushed, no Change-Id" refusal.
		assert.deepEqual(deterministic.map((a: any) => a.id), ['menu-vscode/scm-gerrit-fetch-commit-msg-hook', 'menu-vscode/scm-gerrit-push-ref']);
		for (const action of deterministic as any[]) {
			assert.ok(action.expectNotifications.length > 0, action.id + ': expectNotifications must not be empty');
			// The captured text is the localized message: every needle must occur in the i18n sources
			// (both interface languages) or it can never match.
			for (const needle of action.expectNotifications) {
				assert.ok(i18n.includes(needle), action.id + ': expectNotifications needle "' + needle + '" appears nowhere in src/shared/i18n');
			}
		}
	});

	it('command-mode entries execute commands the extension actually contributes', () => {
		// Command registration is split by group: the registration sites live under
		// src/extension/commands/.
		const commandsDir = path.join(rootDir, 'src', 'extension', 'commands');
		const commandsSource = fs.readdirSync(commandsDir)
			.filter((entry) => entry.endsWith('.ts'))
			.map((entry) => fs.readFileSync(path.join(commandsDir, entry), 'utf8'))
			.join('\n');
		const registered = new Set([...commandsSource.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]));
		for (const action of CATALOG as any[]) {
			if (action.vscodeCommand === undefined) continue;
			assert.ok(registered.has(action.vscodeCommand.command), action.id + ': VS Code command "' + action.vscodeCommand.command + '" is not registered in src/extension/commands/');
			assert.ok(['uri', 'rootUri', 'resourceStates', 'diffUri'].includes(action.vscodeCommand.arg?.kind ?? '') || action.vscodeCommand.arg === undefined,
				action.id + ': unknown command argument kind');
		}
	});

	it('exact-text steps stay in sync with the shipped interface languages', () => {
		// The shim matches menu items and expected text exactly, so the catalog carries one candidate
		// per interface language (bi(en, zh)). Every candidate must literally appear in the webview string tables
		// (as a whole value, a substring of a format template, or without the render-time ellipsis) —
		// otherwise the entry silently stops matching under that language.
		const [{ text: enBlock }, { text: zhBlock }] = sourceFiles('src/shared/i18n/en.ts', 'src/shared/i18n/zh-cn.ts');

		const candidates: Array<[string, ...string[]]> = [];
		for (const action of CATALOG as any[]) {
			for (const step of [...(action.ui ?? []), ...(action.uiAfter ?? [])]) {
				if (step.op === 'contextmenu') candidates.push([action.id, ...(Array.isArray(step.item) ? step.item : [step.item])]);
				if (step.op === 'expectText') candidates.push([action.id, ...(Array.isArray(step.contains) ? step.contains : [step.contains])]);
			}
		}
		assert.ok(candidates.length >= 45, 'expected the catalog to exercise exact-text matching broadly');

		for (const [id, ...texts] of candidates) {
			for (const text of texts) {
				// A candidate that is exactly one {{placeholder}} expands from live repository data
				// at run time (e.g. contains: '{{branch}}') — nothing to pin in the shipped strings.
				if (/^\{\{[a-zA-Z][a-zA-Z0-9]*\}\}$/.test(text)) continue;
				const bare = text.replace(/…$/, '').replace(/\.\.\.$/, '');
				const present = [text, bare].some((form) => enBlock.includes(form) || zhBlock.includes(form));
				assert.ok(present, id + ': exact-text candidate ' + JSON.stringify(text) + ' matches nothing in the webview string tables');
			}
		}
	});
});
