/**
 * The string tables shared by the extension host and the webview (REFACTOR-PLAN §3.2, task 6.3).
 *
 * Key consistency is a compile-time property: `STRINGS_ZH_CN` in zh-cn.ts is declared
 * `satisfies WebviewStrings` (the type of the English table), so a key missing from either
 * table, an extra key, or an entry of the wrong shape fails `tsc` — no parity script needed.
 * Placeholder consistency (`{0}`, `{1}`, ... agree between the languages) stays a runtime
 * check: tests/i18n.test.mjs asserts it over every key.
 */

export { STRINGS_EN } from './en';
export type { WebviewStrings } from './en';
export { STRINGS_ZH_CN } from './zh-cn';
export { substitutePlaceholders } from './format';
