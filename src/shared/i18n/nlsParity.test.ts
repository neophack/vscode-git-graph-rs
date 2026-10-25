/**
 * Package manifest localisation parity (REFACTOR-PLAN task 6.3).
 *
 * package.nls.json and package.nls.zh-cn.json must stay two separate files — Visual Studio Code
 * resolves them by fixed file name — which puts them outside everything the compiler checks: no
 * type relates one file to the other. This test restores the one invariant the compiler cannot
 * see: the two files define exactly the same set of keys. (The TypeScript dictionaries lost their
 * equivalent check on purpose: `STRINGS_ZH_CN satisfies SharedStrings` makes their key parity a
 * compile-time error, which replaced scripts/check-i18n-parity.cjs.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Both vitest and the compiled test run with the repository root as the working directory. */
const root = process.cwd();

function nlsKeys(file: string): string[] {
	return Object.keys(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))).sort();
}

describe('package.nls parity', () => {
	it('defines the same keys in every language', () => {
		expect(nlsKeys('package.nls.zh-cn.json')).toEqual(nlsKeys('package.nls.json'));
	});

	it('is a non-empty manifest dictionary', () => {
		const en = nlsKeys('package.nls.json');
		expect(en.length).toBeGreaterThan(0);
		expect([...new Set(en)]).toEqual(en);
	});
});
