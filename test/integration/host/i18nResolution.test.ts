/**
 * The extension host's language selection (src/config.ts's interfaceLanguage resolution and
 * src/i18n.ts's t()/isZhCn()).
 *
 * Ported from tests/i18n.test.mjs (REFACTOR-PLAN task 7.1); assertions are unchanged.
 *
 * The language is resolved at call time (`t()` re-reads the configuration on every message, so a
 * setting change applies immediately), which these tests pin by mutating the stubbed `vscode`
 * configuration between calls.
 *
 * The remainder of the former file drained into the new tree (REFACTOR-PLAN Appendix B):
 * placeholder substitution, the dictionary invariants (both languages answering every key,
 * placeholder parity, well-formedness, the {N}-for-{N} round-trip) and the sources' round-trip
 * literal scan now live in src/shared/i18n/format.test.ts against the shared tables directly;
 * the webview's live language switch lives in src/webview/common/i18n/index.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { vscodeState, env } from '../../support/vscodeAlias';
import { isZhCn, t } from '../../../src/extension/platform/i18n';

describe('language selection', () => {
	const tryLanguage = (setting: string, displayLanguage: string) => {
		vscodeState.settings.interfaceLanguage = setting;
		env.language = displayLanguage;
		return { chinese: isZhCn(), message: t('compareOneFileChanged') };
	};

	it('uses the explicitly configured language', () => {
		assert.deepEqual(tryLanguage('en', 'zh-cn'),
			{ chinese: false, message: '1 file changed' });
		assert.deepEqual(tryLanguage('zh-cn', 'en'),
			{ chinese: true, message: '1 个文件已更改' });
	});

	it('follows the VS Code display language when set to "auto"', () => {
		assert.deepEqual(tryLanguage('auto', 'zh-CN'),
			{ chinese: true, message: '1 个文件已更改' });
		assert.deepEqual(tryLanguage('auto', 'zh'),
			{ chinese: true, message: '1 个文件已更改' });
		assert.deepEqual(tryLanguage('auto', 'en-US'),
			{ chinese: false, message: '1 file changed' });
		assert.deepEqual(tryLanguage('auto', 'fr'),
			{ chinese: false, message: '1 file changed' });
	});

	it('treats any unrecognised value as "auto"', () => {
		assert.deepEqual(tryLanguage('zh_CN', 'zh-cn'), { chinese: true, message: '1 个文件已更改' });
		assert.deepEqual(tryLanguage('nonsense', 'en'), { chinese: false, message: '1 file changed' });
	});
});
