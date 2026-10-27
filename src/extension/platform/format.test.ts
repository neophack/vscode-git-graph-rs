/**
 * The presentation helpers of src/utils/format.ts (ported from tests/utils.test.mjs): inline
 * script encoding, text truncation, the webview nonce, the extension's own version, and the
 * relative time diff (including its Chinese units when the interface language is zh-cn). The
 * interface language is resolved at call time through the faked `vscode` configuration: the
 * localizer's language source is pointed at the fake settings map (the stand-in for the
 * configuration service the composition root wires, OPTIMIZATION-PLAN A4), so a setting change
 * applies mid-test exactly as it does in the editor.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { afterAll, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
	const settings: { [key: string]: unknown } = {};
	return {
		settings: settings,
		Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
		ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		env: { language: 'en' },
		workspace: {
			getConfiguration: (section: string) => ({
				get: (key: string, defaultValue?: unknown) => {
					const value = settings[section + '.' + key];
					return value === undefined ? defaultValue : value;
				},
				has: () => false,
				inspect: () => undefined,
				update: () => Promise.resolve()
			})
		}
	};
});

vi.mock('vscode', () => vscodeMock);

import { abbrevText, encodeJsonForInlineScript, getExtensionVersion, getNonce, getRelativeTimeDiff } from './format';
import { setInterfaceLanguageSource } from './i18n';

// The localizer follows the fake settings map (the stand-in for the wired configuration service).
setInterfaceLanguageSource(() => {
	const value = vscodeMock.settings['git-graph-rs.interfaceLanguage'];
	return value === 'en' || value === 'zh-cn' ? value : 'auto';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-format-'));

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('format helpers', () => {
	it('abbreviates text to the requested number of characters', () => {
		expect(abbrevText('short', 10)).toBe('short');
		expect(abbrevText('a much longer string', 8)).toBe('a much ...');
	});

	it('encodes JSON for inline scripts, escaping script-terminating and literal-invalid characters', () => {
		expect(encodeJsonForInlineScript('{"a":"</script><!--&\u2028\u2029"}')).toBe('{"a":"\\u003C/script\\u003E\\u003C!--\\u0026\\u2028\\u2029"}');
	});

	it('getRelativeTimeDiff picks the largest whole unit and pluralises', () => {
		vscodeMock.settings['git-graph-rs.interfaceLanguage'] = 'en';
		const now = Math.round(Date.now() / 1000);
		expect(getRelativeTimeDiff(now - 1)).toBe('1 second ago');
		expect(getRelativeTimeDiff(now - 30)).toBe('30 seconds ago');
		expect(getRelativeTimeDiff(now - 120)).toBe('2 minutes ago');
		expect(getRelativeTimeDiff(now - 3600)).toBe('1 hour ago');
		expect(getRelativeTimeDiff(now - 2 * 86400)).toBe('2 days ago');
		expect(getRelativeTimeDiff(now - 3 * 604800)).toBe('3 weeks ago');
		expect(getRelativeTimeDiff(now - 2 * 2629800)).toBe('2 months ago');
		expect(getRelativeTimeDiff(now - 5 * 31557600)).toBe('5 years ago');
	});

	it('getRelativeTimeDiff uses the Chinese units when the interface language is zh-cn', () => {
		vscodeMock.settings['git-graph-rs.interfaceLanguage'] = 'zh-cn';
		try {
			const now = Math.round(Date.now() / 1000);
			expect(getRelativeTimeDiff(now - 120)).toBe('2 分钟前');
			expect(getRelativeTimeDiff(now - 2 * 2629800)).toBe('2 个月前');
		} finally {
			delete vscodeMock.settings['git-graph-rs.interfaceLanguage'];
		}
	});

	it('getExtensionVersion reads package.json and rejects when it is missing or malformed', async () => {
		// Only the extension path of the context is read; the rest is irrelevant here
		const context = (extensionPath: string) => <vscode.ExtensionContext><unknown>{ extensionPath: extensionPath };
		const version = await getExtensionVersion(context(process.cwd()));
		expect(version).toMatch(/^\d+\.\d+\.\d+/);
		await expect(getExtensionVersion(context(path.join(tmp, 'nope')))).rejects.toEqual(undefined);
		fs.writeFileSync(path.join(tmp, 'package.json'), '{not json');
		await expect(getExtensionVersion(context(tmp))).rejects.toEqual(undefined);
	});

	it('getNonce is 32 alphanumeric characters and differs between calls', () => {
		const a = getNonce(), b = getNonce();
		expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
		expect(a).not.toBe(b);
	});
});
