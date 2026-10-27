/**
 * The compare pages' string adapter over the shared dictionary.
 *
 * Every localised entry of the comparison and binary-compare frontends lives in the ONE
 * dictionary, src/shared/i18n (the flat compare* keys, used by the extension host's fallback
 * pages as well); the former private duplicate tables are gone. This module selects those keys
 * for the two compare frontends and keeps the small API their modules
 * consume: the text entries, the markup entries, the placeholder substitution and the language
 * switch the boot `init` message drives - the extension host tells each page which language it
 * rendered it for, and the boot applies it before anything renders.
 *
 * The module still exists because src/webview/comparison imports it too; once that frontend
 * reads the shared dictionary directly, it can be deleted and its importers pointed at
 * src/shared/i18n.
 *
 * Entries that carry markup (HTML entities, the statistics <span>s) are listed in MARKUP_KEYS:
 * they must be inserted as markup (raw()), never as escaped text.
 */

import { STRINGS_EN } from '../../shared/i18n/en';
import type { SharedStrings, TextMessageKey } from '../../shared/i18n/en';
import { substitutePlaceholders } from '../../shared/i18n/format';
import { STRINGS_ZH_CN } from '../../shared/i18n/zh-cn';

/** The entries that hold markup templates; every other entry holds plain text. */
const MARKUP_KEYS = [
	'compareStatsAdditions', 'compareStatsDeletions', 'compareLoadingDiff', 'compareHexAnalysing',
	'compareImageStatsTpl'
] as const;

export type CompareMarkupKey = typeof MARKUP_KEYS[number];

/** The compare entries the two frontends consume (a subset of the shared dictionary's keys; the
 * `satisfies` makes a key the dictionary does not carry - in either language - a compile error). */
export const COMPARE_KEYS = [
	/* Header */
	'compareErrorLabel',
	'compareFilesChangedLabel',
	'comparePresentLabel',
	'compareUncommittedLabel',
	'compareWorkingTreeLabel',
	'compareCommitsBetweenOne',
	'compareCommitsBetween',
	'compareToggleMessagesTitle',
	'compareOneFileChanged',
	'compareFilesChanged',
	'compareStatsAdditions',
	'compareStatsDeletions',
	'compareNoChanges',
	/* Diff view */
	'compareOpenDiffInEditor',
	'compareLoadingDiff',
	'compareNoTextualChanges',
	/* Hex view */
	'compareHexPrevDiff',
	'compareHexNextDiff',
	'compareHexDiffStatus',
	'compareHexNoDifferences',
	'compareHexAnalysing',
	'compareHexToggleButton',
	'compareHexMenuCopy',
	'compareHexMenuCopyHex',
	'compareHexMenuCopyText',
	'compareHexMenuCopyC',
	'compareHexMenuCopyBase64',
	'compareHexMenuCopyAddress',
	'compareHexMenuClearSelection',
	'compareHexCopyDone',
	'compareHexCopyDoneAddress',
	'compareHexCopyTooLarge',
	'compareHexCopyReadFailed',
	/* Picture view */
	'compareImageToggleButton',
	'compareImageCaptionOld',
	'compareImageCaptionDiff',
	'compareImageCaptionNew',
	'compareImageStatsTpl',
	'compareImageModeEnhanced',
	'compareImageModeDifference',
	'compareImageModeBlend',
	'compareImageModeHighlight',
	'compareImageModeBlink',
	'compareImageAmplify',
	'compareImageBlendAlpha',
	'compareImageTolerance',
	'compareImageNoDifferences',
	'compareImageDecodeError',
	'compareImageZoomFit',
	'compareImageZoomIn',
	'compareImageZoomOut'
] as const satisfies readonly TextMessageKey[];

export type CompareKey = typeof COMPARE_KEYS[number];

/** The compare entries of one shared string table (every entry a plain string template). */
export type CompareStringsTable = Readonly<Record<CompareKey, string>>;

function subsetOf(table: SharedStrings): CompareStringsTable {
	const out = {} as { [K in CompareKey]: string };
	for (const key of COMPARE_KEYS) out[key] = table[key];
	return out;
}

const EN: CompareStringsTable = subsetOf(STRINGS_EN);
const ZH_CN: CompareStringsTable = subsetOf(STRINGS_ZH_CN);

/** The text entries of the active table. */
export let compareStrings: CompareStringsTable = EN;

/** The markup entries of the active table (insert as markup, never as text). */
const markupEn = markupOf(EN);
let markupZhCn: { readonly [K in CompareMarkupKey]: string } | null = null;
let activeMarkup = markupEn;

function markupOf(table: CompareStringsTable): { readonly [K in CompareMarkupKey]: string } {
	const out: { [key: string]: string } = {};
	for (const key of MARKUP_KEYS) out[key] = table[key];
	return <{ readonly [K in CompareMarkupKey]: string }><unknown>out;
}

/** The markup entries of the active table. */
export function compareMarkup<K extends CompareMarkupKey>(key: K): string {
	return activeMarkup[key];
}

/**
 * Substitute `{0}`, `{1}`, ... placeholders with the provided values (the shared dictionary's
 * substitution helper).
 */
export function format(template: string, ...args: ReadonlyArray<string | number>): string {
	return substitutePlaceholders(template, args);
}

/**
 * Switch the active table (called from the boot code with the language the extension host
 * rendered the page for).
 * @param lang The language code ('zh-cn'; anything else selects English).
 */
export function setCompareStringsLanguage(lang: string) {
	if (lang === 'zh-cn') {
		if (markupZhCn === null) {
			markupZhCn = markupOf(ZH_CN);
		}
		activeMarkup = markupZhCn;
		compareStrings = ZH_CN;
	} else {
		activeMarkup = markupEn;
		compareStrings = EN;
	}
}
