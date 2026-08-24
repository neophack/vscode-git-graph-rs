/**
 * The extension host's localisation: message lookup, placeholder substitution and language
 * selection.
 *
 * The language is resolved at call time (`t()` re-reads the configuration on every message, so a
 * setting change applies immediately), which these tests pin by mutating the stubbed `vscode`
 * configuration between calls. The dictionaries themselves are held against three invariants —
 * key and placeholder parity between the languages, well-formed placeholders, and the round-trip
 * the comparison pages rely on (baking `{0}`/`{1}` back into a template so the webview can
 * `.replace()` them later) — the exact shape of the placeholder that once lost its closing brace
 * and surfaced as literal `{1` in the rendered page.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The mutable stand-in for the extension host: settings and display language change per test. */
const settings = { interfaceLanguage: 'auto' };
const env = { language: 'en' };
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: env,
	/* config.js maps configured column names to these at module load time. */
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	workspace: {
		getConfiguration: () => ({
			get: (section, defaultValue) => section in settings ? settings[section] : defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const { isZhCn, t } = await import('../out/i18n.js');

/** The message keys, scraped from the EN dictionary block of the source (mirrors the parity script). */
function messageKeys() {
	const source = fs.readFileSync(path.join(root, 'src', 'i18n.ts'), 'utf8');
	const block = source.slice(source.indexOf('const EN = {'), source.indexOf('type MessageKey'));
	return [...block.matchAll(/\n\t([a-zA-Z0-9]+): '/g)].map((match) => match[1]);
}

/** `t(key)` with no arguments leaves every placeholder in place, yielding the raw template. */
const templateOf = (key) => {
	settings.interfaceLanguage = 'en';
	return t(key);
};

/** The placeholders of a template, in order of appearance. */
const placeholdersOf = (template) => [...template.matchAll(/\{\d+\}/g)].map((match) => match[0]);

describe('message substitution', () => {
	it('substitutes string and number arguments in order', () => {
		settings.interfaceLanguage = 'en';
		assert.equal(t('nowUsingGit', '/usr/bin/git', '2.43.0'),
			'Git Graph is now using /usr/bin/git (version: 2.43.0)');
		assert.equal(t('compareFilesChanged', 3), '3 files changed');
		assert.equal(t('uncommittedChangesRow', 7), 'Uncommitted Changes (7)');
	});

	it('keeps placeholders whose argument was not provided, and ignores extra arguments', () => {
		settings.interfaceLanguage = 'en';
		assert.equal(t('nowUsingGit', '/usr/bin/git'), 'Git Graph is now using /usr/bin/git (version: {1})');
		assert.equal(t('compareOneFileChanged', 'unused', 'also unused'), '1 file changed');
	});
});

describe('language selection', () => {
	const tryLanguage = (setting, displayLanguage) => {
		settings.interfaceLanguage = setting;
		env.language = displayLanguage;
		return { chinese: isZhCn(), message: t('compareOneFileChanged') };
	};

	it('uses the explicitly configured language', () => {
		assert.deepEqual(tryLanguage('en', 'zh-cn'),
			{ chinese: false, message: '1 file changed' });
		assert.deepEqual(tryLanguage('zh-cn', 'en'),
			{ chinese: true, message: '1 个文件已更改' });
	});

	it('follows the VS Code display language when set to "auto"', () => {
		assert.deepEqual(tryLanguage('auto', 'zh-CN'),
			{ chinese: true, message: '1 个文件已更改' });
		assert.deepEqual(tryLanguage('auto', 'zh'),
			{ chinese: true, message: '1 个文件已更改' });
		assert.deepEqual(tryLanguage('auto', 'en-US'),
			{ chinese: false, message: '1 file changed' });
		assert.deepEqual(tryLanguage('auto', 'fr'),
			{ chinese: false, message: '1 file changed' });
	});

	it('treats any unrecognised value as "auto"', () => {
		assert.deepEqual(tryLanguage('zh_CN', 'zh-cn'), { chinese: true, message: '1 个文件已更改' });
		assert.deepEqual(tryLanguage('nonsense', 'en'), { chinese: false, message: '1 file changed' });
	});
});

describe('the dictionaries', () => {
	const keys = messageKeys();

	it('hold a full key list', () => {
		assert.ok(keys.length >= 150, `expected a complete dictionary, found ${keys.length} keys`);
		assert.deepEqual([...new Set(keys)].sort(), keys.slice().sort(), 'keys must be unique');
	});

	it('answer every key in both languages (a missing ZH entry would throw)', () => {
		settings.interfaceLanguage = 'zh-cn';
		for (const key of keys) assert.ok(t(key).length > 0, `${key} has no zh-cn message`);
		settings.interfaceLanguage = 'en';
		for (const key of keys) assert.ok(t(key).length > 0, `${key} has no en message`);
	});

	it('give both languages the same placeholders for every key', () => {
		settings.interfaceLanguage = 'en';
		const en = new Map(keys.map((key) => [key, placeholdersOf(t(key))]));
		settings.interfaceLanguage = 'zh-cn';
		for (const [key, enPlaceholders] of en) {
			assert.deepEqual(placeholdersOf(t(key)).sort(), [...enPlaceholders].sort(),
				`${key} disagrees on its placeholders between en and zh-cn`);
		}
	});

	it('only contains well-formed placeholders', () => {
		for (const key of keys) {
			for (const template of [templateOf(key), (() => { settings.interfaceLanguage = 'zh-cn'; return t(key); })()]) {
				const remainder = template.replace(/\{\d+\}/g, '');
				assert.ok(!/\{\d/.test(remainder),
					`${key} contains a placeholder that lost its closing brace: ${template}`);
			}
		}
	});

	it('round-trips its placeholders: substituting {N} for {N} reproduces the template', () => {
		// The comparison pages bake templates into the webview by calling t() with the literal
		// placeholders as arguments (t(key, '{0}', '{1}')), for the page to .replace() later — the
		// substitution must hand every placeholder back unchanged.
		const passThrough = ['{0}', '{1}', '{2}', '{3}', '{4}', '{5}', '{6}', '{7}', '{8}', '{9}'];
		for (const language of ['en', 'zh-cn']) {
			settings.interfaceLanguage = language;
			for (const key of keys) {
				assert.equal(t(key, ...passThrough), t(key), `${key} does not survive the round-trip in ${language}`);
			}
		}
	});
});

describe('the round-trip literals of the sources', () => {
	/** Every *.ts file under a directory, recursively. */
	function collect(dir) {
		return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? collect(full) : (entry.name.endsWith('.ts') ? [full] : []);
		});
	}

	it('passes complete placeholders only (a literal like \'{1\' once baked itself into pages)', () => {
		const malformed = [];
		for (const file of [...collect(path.join(root, 'src')), ...collect(path.join(root, 'web'))]) {
			const source = fs.readFileSync(file, 'utf8');
			for (const match of source.matchAll(/'\{\d+'/g)) {
				malformed.push(`${path.relative(root, file)}: ${match[0]}`);
			}
		}
		assert.deepEqual(malformed, [],
			'these string literals are placeholders that lost their closing brace');
	});
});
