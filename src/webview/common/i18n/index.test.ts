/**
 * The webview's live language switch (the language-selection half of tests/i18n.test.mjs): the
 * host resolves `git-graph-rs.interfaceLanguage` ("auto" defers to the editor's display
 * language) and forwards the resolved language with the initial state; this module's
 * `setInterfaceLanguage` is what every rendered string then follows. Both the text table and the
 * markup table (whose entries arrive as SafeHtml) must switch together, and the switch is
 * idempotent in either direction.
 */

import { describe, expect, it } from 'vitest';

import { formatStr, getInterfaceLanguage, markup, setInterfaceLanguage, strings } from './index';
import { STRINGS_EN, STRINGS_ZH_CN } from '../../../shared/i18n';

describe('setInterfaceLanguage', () => {
	it('switches the text table between the languages', () => {
		setInterfaceLanguage('en');
		expect(strings).toBe(STRINGS_EN);
		expect(strings.compareOneFileChanged).toBe('1 file changed');

		setInterfaceLanguage('zh-cn');
		expect(strings).toBe(STRINGS_ZH_CN);
		expect(strings.compareOneFileChanged).toBe('1 个文件已更改');
		expect(getInterfaceLanguage()).toBe('zh-cn');
	});

	it('switches the markup table together with the text table', () => {
		setInterfaceLanguage('zh-cn');
		expect(markup.createBranchAtCommit.html).toBe(STRINGS_ZH_CN.createBranchAtCommit);
		setInterfaceLanguage('en');
		expect(markup.createBranchAtCommit.html).toBe(STRINGS_EN.createBranchAtCommit);
	});

	it('treats any other value as English (the host resolves "auto"; the webview only receives a resolved language)', () => {
		setInterfaceLanguage('zh_CN');
		expect(strings).toBe(STRINGS_EN);
		expect(getInterfaceLanguage()).toBe('en');
		setInterfaceLanguage('zh-cn');
		setInterfaceLanguage('');
		expect(strings).toBe(STRINGS_EN);
	});

	it('substitutes into the active table\'s templates (formatStr follows the live table)', () => {
		setInterfaceLanguage('en');
		expect(formatStr(strings.compareFilesChanged, '3')).toBe('3 files changed');
		setInterfaceLanguage('zh-cn');
		expect(formatStr(strings.compareFilesChanged, '3')).toBe('3 个文件已更改');
	});
});
