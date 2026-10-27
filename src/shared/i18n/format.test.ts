/**
 * Placeholder substitution and the dictionary invariants of the shared string tables (ported
 * from legacy/tests/i18n.test.mjs; the table's key parity is a
 * compile-time property of `STRINGS_ZH_CN satisfies SharedStrings`, so only the runtime
 * invariants remain here): substitution semantics, both languages answering every key,
 * placeholder parity between the languages, well-formed placeholders, and the round-trip the
 * comparison pages rely on (baking `{0}`/`{1}` back into a template so the webview can
 * `.replace()` them later). The host-side language resolution ("auto" following the editor's
 * display language) lives in `src/extension/platform/i18n.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { SharedStrings, STRINGS_EN, STRINGS_ZH_CN } from './index';

/** A table indexed by an arbitrary key (the literal-keyed type has no index signature). */
const entryOf = (table: SharedStrings, key: string) => String((<{ [index: string]: unknown }>table)[key]);
import { substitutePlaceholders } from './format';

/** Every key of the shared dictionary, and the keys whose entry is a single string template. */
const keys = Object.keys(STRINGS_EN);
const textKeys = keys.filter((key) => typeof (<{ [index: string]: unknown }><unknown>STRINGS_EN)[key] === 'string');

/** The placeholders of a template, in order of appearance. */
const placeholdersOf = (template: string) => [...template.matchAll(/\{\d+\}/g)].map((match) => match[0]);

describe('substitutePlaceholders', () => {
	it('substitutes string and number arguments in order', () => {
		expect(substitutePlaceholders(STRINGS_EN.nowUsingGit, ['/usr/bin/git', '2.43.0'])).toBe('Git Graph is now using /usr/bin/git (version: 2.43.0)');
		expect(substitutePlaceholders(STRINGS_EN.compareFilesChanged, [3])).toBe('3 files changed');
		expect(substitutePlaceholders(STRINGS_EN.uncommittedChangesRow, [7])).toBe('Uncommitted Changes (7)');
	});

	it('keeps placeholders whose argument was not provided, and ignores extra arguments', () => {
		expect(substitutePlaceholders(STRINGS_EN.nowUsingGit, ['/usr/bin/git'])).toBe('Git Graph is now using /usr/bin/git (version: {1})');
		expect(substitutePlaceholders(STRINGS_EN.compareOneFileChanged, ['unused', 'also unused'])).toBe('1 file changed');
	});

	it('leaves a placeholder in place when its argument is neither a string nor a number', () => {
		expect(substitutePlaceholders('{0} and {1}', [<never>null, <never>{ x: 1 }])).toBe('{0} and {1}');
	});
});

describe('the dictionaries', () => {
	it('hold a full key list', () => {
		expect(keys.length).toBeGreaterThanOrEqual(1000);
		expect([...new Set(keys)].sort()).toEqual(keys.slice().sort());
	});

	it('answer every key in both languages (a missing ZH entry would be a compile error, an empty one is not)', () => {
		// dateRelativePluralSuffix is the one legitimately EMPTY entry: English pluralises the
		// relative-time unit ("2 seconds ago") and Chinese does not, so the suffix is '' there.
		const mayBeEmpty = new Set(['dateRelativePluralSuffix']);
		for (const key of textKeys) {
			if (!mayBeEmpty.has(key)) {
				expect(entryOf(STRINGS_ZH_CN, key).length, key + ' has no zh-cn message').toBeGreaterThan(0);
			}
			expect(entryOf(STRINGS_EN, key).length, key + ' has no en message').toBeGreaterThan(0);
		}
	});

	it('give both languages the same placeholders for every key', () => {
		const en = new Map(textKeys.map((key) => [key, placeholdersOf(entryOf(STRINGS_EN, key))]));
		for (const [key, enPlaceholders] of en) {
			expect(placeholdersOf(entryOf(STRINGS_ZH_CN, key)).sort(), key + ' disagrees on its placeholders between en and zh-cn')
				.toEqual([...enPlaceholders].sort());
		}
	});

	it('only contain well-formed placeholders', () => {
		for (const key of textKeys) {
			for (const table of [STRINGS_EN, STRINGS_ZH_CN]) {
				const template = entryOf(table, key);
				const remainder = template.replace(/\{\d+\}/g, '');
				expect(/\{\d/.test(remainder), key + ' contains a placeholder that lost its closing brace: ' + template).toBe(false);
			}
		}
	});

	it('round-trip their placeholders: substituting {N} for {N} reproduces the template', () => {
		// The comparison pages bake templates into the webview by substituting the literal
		// placeholders as arguments (t(key, '{0}', '{1}')), for the page to .replace() later - the
		// substitution must hand every placeholder back unchanged.
		const passThrough = ['{0}', '{1}', '{2}', '{3}', '{4}', '{5}', '{6}', '{7}', '{8}', '{9}'];
		for (const key of textKeys) {
			for (const table of [STRINGS_EN, STRINGS_ZH_CN]) {
				const template = entryOf(table, key);
				expect(substitutePlaceholders(template, passThrough), key).toBe(template);
			}
		}
	});
});

describe('the round-trip literals of the sources', () => {
	/** Every *.ts file under a directory, recursively. */
	function collect(dir: string): string[] {
		return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? collect(full) : (entry.name.endsWith('.ts') ? [full] : []);
		});
	}

	it('passes complete placeholders only (a literal like \'{1\' once baked itself into pages)', () => {
		const malformed: string[] = [];
		for (const file of collect(path.join(process.cwd(), 'src'))) {
			const source = fs.readFileSync(file, 'utf8');
			for (const match of source.matchAll(/'\{\d+'/g)) {
				malformed.push(path.relative(process.cwd(), file) + ': ' + match[0]);
			}
		}
		expect(malformed).toEqual([]);
	});
});
