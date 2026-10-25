/**
 * The webview's interface language: the active string table and the substitution helper.
 *
 * The tables themselves live in the shared dictionary (src/shared/i18n, re-exported below) so
 * the extension host and the webview localise from one source (REFACTOR-PLAN task 6.3); this
 * module keeps what is webview-specific — the markup split and the live language switch.
 *
 * The keys listed in MARKUP_KEYS hold markup templates (bold names, line breaks, ...); every
 * other key holds text. The two are exposed separately so the compiler keeps them apart:
 * `strings` carries the text entries (escaped when interpolated into markup), `markup` the markup
 * entries as SafeHtml - a markup entry can never be used as text by accident, and text can never
 * be inserted unescaped.
 *
 * `setInterfaceLanguage` (called at start-up with the `git-graph-rs.interfaceLanguage` setting
 * forwarded by the extension host) switches both. `strings` and `markup` are live bindings, so
 * every importer reads the active table.
 */

export * from '../../../shared/i18n';

import { escapeHtml, isSafeHtml, raw, SafeHtml } from '../html';
import { STRINGS_EN, SharedStrings } from '../../../shared/i18n';
import { STRINGS_ZH_CN } from '../../../shared/i18n';
import { substitutePlaceholders } from '../../../shared/i18n';

/** The entries of the string tables that are markup templates. */
export const MARKUP_KEYS = [
	'riskResetHard', 'riskCleanUntrackedFiles', 'riskCleanUntrackedDirectories', 'riskDeleteBranchForce',
	'riskDeleteRemoteBranch', 'riskPushForce', 'riskPushForceWithLease', 'riskFetchIntoLocalBranchForce',
	'riskDropStash', 'riskResetFile', 'settingsDeleteNameConfirm', 'settingsInitialBranchesDialogHeader',
	'settingsDeleteAuthorConfirm', 'settingsEditRemoteDialogMessage', 'settingsDeleteRemoteConfirm',
	'settingsFetchRemoteConfirm', 'settingsPruneRemoteConfirm', 'settingsIssueLinkingIntro',
	'settingsEditIssueLinkingHeader', 'settingsAddIssueLinkingHeader', 'settingsIssueExampleText',
	'settingsRemoveIssueLinkingLocal', 'settingsRemoveIssueLinkingGlobal', 'settingsPrDialog1Header',
	'settingsPrDialog2Header', 'settingsGerritDisableConfirm', 'addTagToCommit', 'tagExistsReplace',
	'checkoutNewBranchPrompt', 'branchNameInUse', 'createBranchAtCommit', 'branchExistsReplace', 'mergeConfirm',
	'rebaseConfirm', 'editCommitMessagePrompt', 'selectBranchToCompare', 'renameBranchPrompt',
	'deleteBranchConfirm', 'pushToRemoteOf', 'pushBranchConfirm', 'updateBranchConfirm',
	'createPullRequestConfirm', 'checkoutCommitConfirm', 'cherryPickConfirm', 'revertMergeCommitConfirm',
	'revertCommitConfirm', 'dropCommitConfirm', 'dropCommitFirstParentNote', 'resetToCommitConfirm',
	'deleteRemoteBranchConfirm', 'fetchIntoLocalConfirm', 'pullBranchConfirm', 'applyStashConfirm',
	'popStashConfirm', 'branchFromStashPrompt', 'dropStashConfirm', 'deleteTagConfirm', 'alsoDeleteTagOnRemote',
	'pushTagToRemoteConfirm', 'pushTagSelectRemotes', 'stashUncommittedConfirm', 'resetUncommittedConfirm',
	'branchNotFullyMerged', 'tagCommitNotOnRemoteSingular', 'tagCommitNotOnRemotePlural', 'tagDetailsTitle',
	'tagDetailsObject', 'tagDetailsCommit', 'tagDetailsTagger', 'tagDetailsDate', 'cdvCommitLabel',
	'cdvParentsLabel', 'cdvAuthorLabel', 'cdvAuthorDateLabel', 'cdvCommitterLabel', 'cdvDateLabel',
	'cdvCommitterDateLabel', 'displayingChangesFromTo', 'resetFileConfirm', 'graphTooltipNot',
	'graphTooltipIncludedInHead'
] as const;

export type MarkupKey = typeof MARKUP_KEYS[number];

/** The text entries of a string table. */
export type TextStrings = Readonly<Omit<SharedStrings, MarkupKey>>;

/** The markup entries of a string table. */
export type MarkupStrings = { readonly [K in MarkupKey]: SafeHtml };

function markupOf(table: SharedStrings): MarkupStrings {
	const result: { [key: string]: SafeHtml } = {};
	for (let i = 0; i < MARKUP_KEYS.length; i++) result[MARKUP_KEYS[i]] = raw(table[MARKUP_KEYS[i]]);
	return <MarkupStrings><unknown>result;
}

const MARKUP_EN = markupOf(STRINGS_EN);
let markupZhCn: MarkupStrings | null = null;

/** The text entries of the active string table. */
export let strings: TextStrings = STRINGS_EN;

/** The markup entries of the active string table. */
export let markup: MarkupStrings = MARKUP_EN;

let interfaceLanguage = 'en';

/** The interface language applied to the webview ('en' or 'zh-cn'). */
export function getInterfaceLanguage(): string {
	return interfaceLanguage;
}

/**
 * Switch the active string table (called during start-up).
 * @param lang The language code ('zh-cn'; anything else selects English).
 */
export function setInterfaceLanguage(lang: string) {
	if (lang === 'zh-cn') {
		if (markupZhCn === null) markupZhCn = markupOf(STRINGS_ZH_CN);
		strings = STRINGS_ZH_CN;
		markup = markupZhCn;
		interfaceLanguage = 'zh-cn';
	} else {
		strings = STRINGS_EN;
		markup = MARKUP_EN;
		interfaceLanguage = 'en';
	}
}

/**
 * Substitute the {0}, {1}, ... placeholders of a template (shared/i18n/format.ts). A markup
 * template produces markup, its text arguments escaped; a text template produces text.
 * @param template The template.
 * @param args The values to substitute.
 */
export function formatStr(template: SafeHtml, ...args: Array<string | SafeHtml>): SafeHtml;
export function formatStr(template: string, ...args: string[]): string;
export function formatStr(template: string | SafeHtml, ...args: Array<string | SafeHtml>): string | SafeHtml {
	if (isSafeHtml(template)) {
		return raw(template.html.replace(/\{(\d+)\}/g, (match, index) => {
			const arg = args[index];
			return isSafeHtml(arg) ? arg.html : typeof arg === 'string' ? escapeHtml(arg).html : match;
		}));
	}
	return substitutePlaceholders(template, args);
}

/** The "…" that marks a menu item or button opening a dialog. */
export const ELLIPSIS = '…';
