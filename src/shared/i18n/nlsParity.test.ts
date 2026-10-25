/**
 * Package manifest localisation parity (REFACTOR-PLAN task 6.3).
 *
 * package.nls.json and package.nls.zh-cn.json must stay two separate files — Visual Studio Code
 * resolves them by fixed file name — which puts them outside everything the compiler checks: no
 * type relates one file to the other. This test restores the one invariant the compiler cannot
 * see: the two files define exactly the same set of keys. (The TypeScript dictionaries lost
 * their equivalent check on purpose: `STRINGS_ZH_CN satisfies SharedStrings` makes their key
 * parity a compile-time error, replacing scripts/check-i18n-parity.cjs.)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function nlsKeys(file: string): string[] {
	return Object.keys(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))).sort();
}

describe('package.nls parity', () => {
	it('defines the same keys in every language', () => {
		const en = nlsKeys('package.nls.json');
		const zhCn = nlsKeys('package.nls.zh-cn.json');
		assert.deepEqual(en, zhCn, 'package.nls.json and package.nls.zh-cn.json must define the same keys');
	});

	it('is a non-empty manifest dictionary', () => {
		const en = nlsKeys('package.nls.json');
		assert.ok(en.length > 0, 'package.nls.json unexpectedly has no keys');
		assert.deepEqual([...new Set(en)], en, 'keys must be unique');
	});
});
