/*
 * Regenerates src/webview/common/i18n/subset.generated.ts: the string subset the two
 * single-file IIFE pages (comparison, binaryCompare) bundle instead of the full shared
 * dictionaries. esbuild cannot tree-shake object properties and inlines dynamic imports in
 * an IIFE, so bundling the real tables would embed every host-side message (~150 KB per
 * language) into pages whose whole reachable vocabulary is the compare table, the date
 * fragments and the markup keys (which common/i18n/index.ts materialises eagerly).
 * scripts/build/webview.mjs redirects the pages' imports of the shared tables to the subset;
 * `npm run check:generated` regenerates this file and diffs it, so it can never drift from
 * the dictionaries it is cut from.
 */
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outFile = path.join(root, 'src', 'webview', 'common', 'i18n', 'subset.generated.ts');

// Keys the pages reach outside the compare table: the date fragments (common/dates.ts) and
// the mobile date row. MARKUP_KEYS is included wholesale because common/i18n/index.ts builds
// the markup table over that list at module load, before anything can know which entries the
// page will use.
const EXTRA_KEYS = [
	'dateMonthsShort', 'dateFullDate', 'dateDayDate', 'dateDayDateWithYear', 'dateRelativeUnits',
	'dateRelativePluralSuffix', 'dateRelativeAgo', 'mobileWeekdays', 'mobileYesterday'
];

// Bundle the TypeScript sources (the key lists and both tables) into a CJS module this
// script can evaluate; esbuild resolves the .ts imports, node cannot.
const stdin = `
	import { COMPARE_KEYS } from ${JSON.stringify(path.join(root, 'src', 'webview', 'binaryCompare', 'strings.ts'))};
	import { MARKUP_KEYS } from ${JSON.stringify(path.join(root, 'src', 'webview', 'common', 'i18n', 'index.ts'))};
	import { STRINGS_EN } from ${JSON.stringify(path.join(root, 'src', 'shared', 'i18n', 'en.ts'))};
	import { STRINGS_ZH_CN } from ${JSON.stringify(path.join(root, 'src', 'shared', 'i18n', 'zh-cn.ts'))};
	export default { COMPARE_KEYS, MARKUP_KEYS, STRINGS_EN, STRINGS_ZH_CN };
`;
const bundled = await build({
	stdin: { contents: stdin, resolveDir: root, loader: 'ts' },
	bundle: true,
	format: 'cjs',
	platform: 'node',
	write: false,
	logLevel: 'silent'
});
const module = { exports: {} };
new Function('module', 'exports', bundled.outputFiles[0].text)(module, module.exports);
const { COMPARE_KEYS, MARKUP_KEYS, STRINGS_EN, STRINGS_ZH_CN } = module.exports.default;

const keys = [...new Set([...COMPARE_KEYS, ...MARKUP_KEYS, ...EXTRA_KEYS])].sort();
for (const key of keys) {
	if (!(key in STRINGS_EN)) throw new Error(`key missing from the en dictionary: ${key}`);
	if (!(key in STRINGS_ZH_CN)) throw new Error(`key missing from the zh-cn dictionary: ${key}`);
}

// The export names are the ones the redirected importers use (shared/i18n/en's STRINGS_EN,
// shared/i18n/zh-cn's STRINGS_ZH_CN), so the subset is a drop-in for both modules.
const table = (name, dict) => `export const ${name} = {\n` +
	keys.map((key) => `\t${key}: ${JSON.stringify(dict[key])}`).join(',\n') + `\n};\n`;
const contents =
	'// GENERATED FILE - do not edit; regenerate with node scripts/dev/gen-compare-subset.mjs.\n' +
	'// The string subset the single-file IIFE pages bundle in place of the shared dictionaries.\n\n' +
	table('STRINGS_EN', STRINGS_EN) + '\n' + table('STRINGS_ZH_CN', STRINGS_ZH_CN);
fs.writeFileSync(outFile, contents, 'utf8');
console.log(`i18n subset: ${keys.length} keys written to ${path.relative(root, outFile)}`);
