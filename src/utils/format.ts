// Presentation helpers: safe inline-script encoding, text truncation, relative
// time formatting, the webview nonce, and the extension's own version.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isZhCn } from '../i18n';

/**
 * Encode a JSON string so that it can be safely embedded inside an inline `<script>` element.
 * Escapes characters that could terminate the script block (e.g. `</script>`, `<!--`), and
 * characters that are invalid in JavaScript string literals (U+2028, U+2029).
 * The escaped sequences are decoded identically when the script is evaluated.
 * @param json The JSON string to encode.
 * @returns The encoded JSON string.
 */
export function encodeJsonForInlineScript(json: string): string {
	return json
		.replace(/</g, '\\u003C')
		.replace(/>/g, '\\u003E')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

/**
 * Abbreviate a string to the specified number of characters.
 * @param text The string to abbreviate.
 * @param toChars The number of characters to abbreviate the string to.
 * @returns The abbreviated string.
 */
export function abbrevText(text: string, toChars: number) {
	return text.length <= toChars ? text : text.substring(0, toChars - 1) + '...';
}

/**
 * Get the relative time difference between the current time and a Unix timestamp.
 * @param unixTimestamp The Unix timestamp.
 * @returns The relative time difference (e.g. 12 minutes ago).
 */
export function getRelativeTimeDiff(unixTimestamp: number) {
	let diff = Math.round((new Date()).getTime() / 1000) - unixTimestamp, unit;
	if (diff < 60) {
		unit = 'second';
	} else if (diff < 3600) {
		unit = 'minute';
		diff /= 60;
	} else if (diff < 86400) {
		unit = 'hour';
		diff /= 3600;
	} else if (diff < 604800) {
		unit = 'day';
		diff /= 86400;
	} else if (diff < 2629800) {
		unit = 'week';
		diff /= 604800;
	} else if (diff < 31557600) {
		unit = 'month';
		diff /= 2629800;
	} else {
		unit = 'year';
		diff /= 31557600;
	}
	diff = Math.round(diff);
	if (isZhCn()) {
		const units: { [unit: string]: string } = { second: '秒', minute: '分钟', hour: '小时', day: '天', week: '周', month: '个月', year: '年' };
		return diff + ' ' + units[unit] + '前';
	}
	return diff + ' ' + unit + (diff !== 1 ? 's' : '') + ' ago';
}

/**
 * Gets the version of Git Graph.
 * @param extensionContext The extension context of Git Graph.
 * @returns The Git Graph version.
 */
export function getExtensionVersion(extensionContext: vscode.ExtensionContext) {
	return new Promise<string>((resolve, reject) => {
		fs.readFile(path.join(extensionContext.extensionPath, 'package.json'), (err, data) => {
			if (err) {
				reject();
			} else {
				try {
					resolve(JSON.parse(data.toString()).version);
				} catch (_) {
					reject();
				}
			}
		});
	});
}

/**
 * Randomly generate a nonce.
 * @returns The nonce.
 */
export function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
