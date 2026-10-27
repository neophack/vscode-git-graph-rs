/**
 * The webview's live language switch: the
 * host resolves `git-graph-rs.interfaceLanguage` ("auto" defers to the editor's display
 * language) and forwards the resolved language with the initial state; this module's
 * `ensureInterfaceLanguage` is what every rendered string then follows. The zh-cn table loads on
 * demand - exactly what the boot awaits before rendering - so the
 * switch to Chinese goes through the async loader here too. Both the text table and the markup
 * table (whose entries arrive as SafeHtml) must switch together, and the switch is idempotent in
 * either direction.
 */

import { describe, expect, it } from 'vitest';

import { ensureInterfaceLanguage, formatStr, getInterfaceLanguage, markup, setInterfaceLanguage, strings } from './index';
import { STRINGS_EN, STRINGS_ZH_CN } from '../../../shared/i18n';

describe('ensureInterfaceLanguage / setInterfaceLanguage', () => {
	it('loads the on-demand zh-cn table and switches the text table between the languages', async () => {
		setInterfaceLanguage('en');
		expect(strings).toBe(STRINGS_EN);
		expect(strings.compareOneFileChanged).toBe('1 file changed');

		await ensureInterfaceLanguage('zh-cn');
		expect(strings).toBe(STRINGS_ZH_CN);
		expect(strings.compareOneFileChanged).toBe('1 个文件已更改');
		expect(getInterfaceLanguage()).toBe('zh-cn');
	});

	it('switches the markup table together with the text table', async () => {
		await ensureInterfaceLanguage('zh-cn');
		expect(markup.createBranchAtCommit.html).toBe(STRINGS_ZH_CN.createBranchAtCommit);
		setInterfaceLanguage('en');
		expect(markup.createBranchAtCommit.html).toBe(STRINGS_EN.createBranchAtCommit);
	});

	it('resolves immediately for a language whose table is already loaded (the synchronous boot path of an English page)', async () => {
		await ensureInterfaceLanguage('zh-cn');
		await ensureInterfaceLanguage('en');
		expect(strings).toBe(STRINGS_EN);
		// The loaded Chinese table makes every later switch synchronous, as the running page needs
		await ensureInterfaceLanguage('zh-cn');
		expect(strings).toBe(STRINGS_ZH_CN);
	});

	it('treats any other value as English (the host resolves "auto"; the webview only receives a resolved language)', async () => {
		setInterfaceLanguage('zh_CN');
		expect(strings).toBe(STRINGS_EN);
		expect(getInterfaceLanguage()).toBe('en');
		await ensureInterfaceLanguage('zh-cn');
		await ensureInterfaceLanguage('');
		expect(strings).toBe(STRINGS_EN);
	});

	it('substitutes into the active table\'s templates (formatStr follows the live table)', async () => {
		setInterfaceLanguage('en');
		expect(formatStr(strings.compareFilesChanged, '3')).toBe('3 files changed');
		await ensureInterfaceLanguage('zh-cn');
		expect(formatStr(strings.compareFilesChanged, '3')).toBe('3 个文件已更改');
	});
});
