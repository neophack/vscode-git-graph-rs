/**
 * Localised messages for the extension host (notifications, quick picks, modal dialogs and the
 * fallback webview pages).
 *
 * The dictionary itself is the shared string table of src/shared/i18n (one table for the host and
 * the webview); this module only adds the host's lookup: the active
 * language follows the `git-graph-rs.interfaceLanguage` Extension Setting, read from the
 * configuration source the composition root installs at activation (the
 * setting is never re-read per message; the source answers from the held snapshot), and applied
 * at call time so a configuration change applies to every message shown afterwards.
 */
import * as vscode from 'vscode';
import { resolvedInterfaceLanguage } from './config';
import { STRINGS_EN, STRINGS_ZH_CN, TextMessageKey } from '../../shared/i18n';
import { substitutePlaceholders } from '../../shared/i18n';

export type { MessageKey } from '../../shared/i18n';

/**
 * Where the current `interfaceLanguage` setting value comes from. Unwired (a bare unit test)
 * it answers the manifest default `auto`, which defers to Visual Studio Code's display
 * language — the exact pre-wiring behaviour.
 */
let interfaceLanguageSource: () => 'auto' | 'en' | 'zh-cn' = () => 'auto';

/**
 * Point the localizer at the configuration source (the composition root wires this to the
 * configuration service's current snapshot at activation).
 * @param source Answers the current raw `git-graph-rs.interfaceLanguage` setting.
 */
export function setInterfaceLanguageSource(source: () => 'auto' | 'en' | 'zh-cn'): void {
	interfaceLanguageSource = source;
}

/**
 * Is the interface language of the extension currently Chinese (Simplified)?
 * Follows the resolved `git-graph-rs.interfaceLanguage` setting ("auto" defers to Visual Studio
 * Code's display language).
 * @returns TRUE => zh-cn, FALSE => English (or anything else).
 */
export function isZhCn(): boolean {
	return resolvedInterfaceLanguage(interfaceLanguageSource(), vscode.env.language) === 'zh-cn';
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
