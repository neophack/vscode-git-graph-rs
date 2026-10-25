/**
 * Localised messages for the extension host (notifications, quick picks, modal dialogs and the
 * fallback webview pages).
 *
 * The dictionary itself is the shared string table of src/shared/i18n (one table for the host and
 * the webview, REFACTOR-PLAN task 6.3); this module only adds the host's lookup: the active
 * language follows the `git-graph-rs.interfaceLanguage` Extension Setting (the same setting that
 * drives the Git Graph View webview), and is read at call time so a configuration change applies
 * to every message shown afterwards.
 */
import { getConfig } from './config';
import { STRINGS_EN, STRINGS_ZH_CN, TextMessageKey } from './shared/i18n';
import { substitutePlaceholders } from './shared/i18n';

export type { MessageKey } from './shared/i18n';

/**
 * Is the interface language of the extension currently Chinese (Simplified)?
 * Follows the resolved `git-graph-rs.interfaceLanguage` setting ("auto" defers to Visual Studio
 * Code's display language).
 * @returns TRUE => zh-cn, FALSE => English (or anything else).
 */
export function isZhCn(): boolean {
	return getConfig().interfaceLanguage === 'zh-cn';
}

/**
 * Get a localised message from the dictionary of the currently configured interface language,
 * substituting `{0}`, `{1}`, ... placeholders with the provided values.
 * @param key The message key.
 * @param args The values to substitute into the placeholders.
 * @returns The localised message.
 */
export function t(key: TextMessageKey, ...args: (string | number)[]): string {
	return substitutePlaceholders(isZhCn() ? STRINGS_ZH_CN[key] : STRINGS_EN[key], args);
}
