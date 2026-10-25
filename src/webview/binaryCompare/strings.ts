/**
 * Localised strings of the comparison and binary compare frontends.
 *
 * The two extracted frontends (task 6.1) need the `compare*` entries of the extension host's
 * dictionary, which the webview string table (common/i18n) does not carry. Until task 6.3 unifies
 * the dictionaries into shared/i18n, the frontend-facing entries live here as a private table with
 * the same content, and the boot `init` message tells the frontend which language the host rendered
 * the page for (setCompareStringsLanguage applies it before anything renders, exactly the way the
 * main view applies its table during start-up).
 *
 * Entries that carry markup (HTML entities, the statistics <span>s) are listed in MARKUP_KEYS:
 * they must be inserted as markup (raw()), never as escaped text.
 */

/** The entries that hold markup templates; every other entry holds plain text. */
const MARKUP_KEYS = [
	'compareStatsAdditions', 'compareStatsDeletions', 'compareLoadingDiff', 'compareHexAnalysing',
	'compareImageStatsTpl'
] as const;

export type CompareMarkupKey = typeof MARKUP_KEYS[number];

interface CompareStringsTable {
	/* Header */
	readonly compareErrorLabel: string;
	readonly compareFilesChangedLabel: string;
	readonly comparePresentLabel: string;
	readonly compareUncommittedLabel: string;
	readonly compareWorkingTreeLabel: string;
	readonly compareCommitsBetweenOne: string;
	readonly compareCommitsBetween: string;
	readonly compareToggleMessagesTitle: string;
	readonly compareOneFileChanged: string;
	readonly compareFilesChanged: string;
	readonly compareStatsAdditions: string;
	readonly compareStatsDeletions: string;
	readonly compareNoChanges: string;
	/* Diff view */
	readonly compareOpenDiffInEditor: string;
	readonly compareLoadingDiff: string;
	readonly compareNoTextualChanges: string;
	/* Hex view */
	readonly compareHexPrevDiff: string;
	readonly compareHexNextDiff: string;
	readonly compareHexDiffStatus: string;
	readonly compareHexNoDifferences: string;
	readonly compareHexAnalysing: string;
	readonly compareHexToggleButton: string;
	readonly compareHexMenuCopy: string;
	readonly compareHexMenuCopyHex: string;
	readonly compareHexMenuCopyText: string;
	readonly compareHexMenuCopyC: string;
	readonly compareHexMenuCopyBase64: string;
	readonly compareHexMenuCopyAddress: string;
	readonly compareHexMenuClearSelection: string;
	readonly compareHexCopyDone: string;
	readonly compareHexCopyDoneAddress: string;
	readonly compareHexCopyTooLarge: string;
	readonly compareHexCopyReadFailed: string;
	/* Picture view */
	readonly compareImageToggleButton: string;
	readonly compareImageCaptionOld: string;
	readonly compareImageCaptionDiff: string;
	readonly compareImageCaptionNew: string;
	readonly compareImageStatsTpl: string;
	readonly compareImageModeEnhanced: string;
	readonly compareImageModeDifference: string;
	readonly compareImageModeBlend: string;
	readonly compareImageModeHighlight: string;
	readonly compareImageModeBlink: string;
	readonly compareImageAmplify: string;
	readonly compareImageBlendAlpha: string;
	readonly compareImageTolerance: string;
	readonly compareImageNoDifferences: string;
	readonly compareImageDecodeError: string;
	readonly compareImageZoomFit: string;
	readonly compareImageZoomIn: string;
	readonly compareImageZoomOut: string;
}

const EN: CompareStringsTable = {
	compareErrorLabel: 'Error',
	compareFilesChangedLabel: 'Files changed',
	comparePresentLabel: 'Present',
	compareUncommittedLabel: 'Uncommitted changes',
	compareWorkingTreeLabel: 'The current working tree',
	compareCommitsBetweenOne: '1 commit',
	compareCommitsBetween: '{0} commits',
	compareToggleMessagesTitle: 'Show/hide commit messages',
	compareOneFileChanged: '1 file changed',
	compareFilesChanged: '{0} files changed',
	compareStatsAdditions: ' with <span class="additions">+{0}</span>',
	compareStatsDeletions: ' <span class="deletions">&minus;{0}</span>',
	compareNoChanges: 'No changes between these commits.',
	compareOpenDiffInEditor: 'Open Diff in Editor',
	compareLoadingDiff: 'Loading diff&hellip;',
	compareNoTextualChanges: 'No textual changes.',
	compareHexPrevDiff: 'Previous difference',
	compareHexNextDiff: 'Next difference',
	compareHexDiffStatus: 'Difference {0} of {1}',
	compareHexNoDifferences: 'No differences',
	compareHexAnalysing: 'Analysing&hellip;',
	compareHexToggleButton: 'Hex',
	compareHexMenuCopy: 'Copy',
	compareHexMenuCopyHex: 'Copy as Hex',
	compareHexMenuCopyText: 'Copy as Text',
	compareHexMenuCopyC: 'Copy as C Array',
	compareHexMenuCopyBase64: 'Copy as Base64',
	compareHexMenuCopyAddress: 'Copy Address',
	compareHexMenuClearSelection: 'Clear Selection',
	compareHexCopyDone: 'Copied ({0})',
	compareHexCopyDoneAddress: 'Copied the address',
	compareHexCopyTooLarge: 'The selection ({0} bytes) is too large to copy.',
	compareHexCopyReadFailed: 'The selected bytes could not be read.',
	compareImageToggleButton: 'Picture',
	compareImageCaptionOld: 'Original',
	compareImageCaptionDiff: 'Difference',
	compareImageCaptionNew: 'Modified',
	compareImageStatsTpl: '{0} pixels ({1}%) differ &middot; max {2} &middot; avg {3} &middot; MSE {4} &middot; PSNR {5} dB',
	compareImageModeEnhanced: 'Difference enhanced',
	compareImageModeDifference: 'Difference',
	compareImageModeBlend: 'Blend',
	compareImageModeHighlight: 'Highlight',
	compareImageModeBlink: 'Blink',
	compareImageAmplify: 'Amplify',
	compareImageBlendAlpha: 'Blend',
	compareImageTolerance: 'Tolerance',
	compareImageNoDifferences: 'The images are identical',
	compareImageDecodeError: 'The image could not be decoded.',
	compareImageZoomFit: 'Fit',
	compareImageZoomIn: 'Zoom in',
	compareImageZoomOut: 'Zoom out'
};

const ZH_CN: CompareStringsTable = {
	compareErrorLabel: '错误',
	compareFilesChangedLabel: '已更改的文件',
	comparePresentLabel: '当前',
	compareUncommittedLabel: '未提交的更改',
	compareWorkingTreeLabel: '当前工作区',
	compareCommitsBetweenOne: '1 个提交',
	compareCommitsBetween: '{0} 个提交',
	compareToggleMessagesTitle: '显示/隐藏提交信息',
	compareOneFileChanged: '1 个文件已更改',
	compareFilesChanged: '{0} 个文件已更改',
	compareStatsAdditions: '，<span class="additions">+{0}</span>',
	compareStatsDeletions: ' <span class="deletions">&minus;{0}</span>',
	compareNoChanges: '这些提交之间没有更改。',
	compareOpenDiffInEditor: '在编辑器中打开差异',
	compareLoadingDiff: '正在加载差异&hellip;',
	compareNoTextualChanges: '没有文本更改。',
	compareHexPrevDiff: '上一处差异',
	compareHexNextDiff: '下一处差异',
	compareHexDiffStatus: '差异 {0} / {1}',
	compareHexNoDifferences: '无差异',
	compareHexAnalysing: '正在分析&hellip;',
	compareHexToggleButton: '十六进制',
	compareHexMenuCopy: '复制',
	compareHexMenuCopyHex: '复制为十六进制',
	compareHexMenuCopyText: '复制为文本',
	compareHexMenuCopyC: '复制为 C 数组',
	compareHexMenuCopyBase64: '复制为 Base64',
	compareHexMenuCopyAddress: '复制地址',
	compareHexMenuClearSelection: '清除选区',
	compareHexCopyDone: '已复制（{0}）',
	compareHexCopyDoneAddress: '已复制地址',
	compareHexCopyTooLarge: '选区（{0} 字节）过大，无法复制。',
	compareHexCopyReadFailed: '无法读取所选字节。',
	compareImageToggleButton: '图片',
	compareImageCaptionOld: '原始',
	compareImageCaptionDiff: '差异',
	compareImageCaptionNew: '修改后',
	compareImageStatsTpl: '{0} 像素差异（{1}%）&middot; 最大 {2} &middot; 平均 {3} &middot; MSE {4} &middot; PSNR {5} dB',
	compareImageModeEnhanced: '差异增强',
	compareImageModeDifference: '差异',
	compareImageModeBlend: '叠加',
	compareImageModeHighlight: '差异高亮',
	compareImageModeBlink: '闪烁',
	compareImageAmplify: '放大',
	compareImageBlendAlpha: '混合',
	compareImageTolerance: '容差',
	compareImageNoDifferences: '两张图片内容相同',
	compareImageDecodeError: '图片无法解码。',
	compareImageZoomFit: '适应',
	compareImageZoomIn: '放大',
	compareImageZoomOut: '缩小'
};

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
 * Substitute `{0}`, `{1}`, ... placeholders with the provided values (the dictionary's
 * substitution helper, identical to the host's `t`).
 */
export function format(template: string, ...args: ReadonlyArray<string | number>): string {
	return template.replace(/\{(\d+)\}/g, (match, index: string) => {
		const value = args[parseInt(index, 10)];
		return typeof value === 'string' || typeof value === 'number' ? String(value) : match;
	});
}

/**
 * Switch the active table (called from the boot code with the language the extension host
 * rendered the page for).
 * @param lang The language code ('zh-cn'; anything else selects English).
 */
export function setCompareStringsLanguage(lang: string) {
	if (lang === 'zh-cn') {
		if (markupZhCn === null) markupZhCn = markupOf(ZH_CN);
		activeMarkup = markupZhCn;
		compareStrings = ZH_CN;
	} else {
		activeMarkup = markupEn;
		compareStrings = EN;
	}
}
