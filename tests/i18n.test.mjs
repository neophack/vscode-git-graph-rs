/**
 * The extension host's language selection (src/config.ts's interfaceLanguage resolution and
 * src/i18n.ts's t()/isZhCn()).
 *
 * The language is resolved at call time (`t()` re-reads the configuration on every message, so a
 * setting change applies immediately), which these tests pin by mutating the stubbed `vscode`
 * configuration between calls.
 *
 * The remainder of the former file drained into the new tree (REFACTOR-PLAN Appendix B):
 * placeholder substitution, the dictionary invariants (both languages answering every key,
 * placeholder parity, well-formedness, the {N}-for-{N} round-trip) and the sources' round-trip
 * literal scan now live in src/shared/i18n/format.test.ts against the shared tables directly;
 * the webview's live language switch lives in src/webview/common/i18n/index.test.ts. What stays
 * here is the host-side resolution — the explicitly configured language, "auto" following the VS
 * Code display language, and unrecognised values falling back to "auto" — whose owning modules
 * (src/config.ts, src/i18n.ts) are not yet covered by colocated tests of their own.
 */

import assert from 'node:assert/strict';
import { Module } from 'node:module';
import { describe, it } from 'node:test';

/* The mutable stand-in for the extension host: settings and display language change per test. */
const settings = { interfaceLanguage: 'auto' };
const env = { language: 'en' };
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: env,
	/* config.js maps configured column names to these at module load time. */
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	workspace: {
		getConfiguration: () => ({
			get: (section, defaultValue) => section in settings ? settings[section] : defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const { isZhCn, t } = await import('../out/i18n.js');

describe('language selection', () => {
	const tryLanguage = (setting, displayLanguage) => {
		settings.interfaceLanguage = setting;
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
