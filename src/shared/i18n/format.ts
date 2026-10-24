/**
 * Placeholder substitution for the string tables: the `{0}`, `{1}`, ... convention every
 * dictionary entry follows. Shared by the extension host's `t()` (src/i18n.ts) and the webview's
 * `formatStr()` (src/webview/common/i18n/index.ts), so both substitute identically.
 */

/**
 * Substitute the `{0}`, `{1}`, ... placeholders of a template with the provided values. A
 * placeholder whose argument was not provided (or is neither a string nor a number) stays in
 * place; extra arguments are ignored.
 * @param template The message template.
 * @param args The values to substitute into the placeholders.
 * @returns The message with every provided argument substituted.
 */
export function substitutePlaceholders(template: string, args: ReadonlyArray<unknown>): string {
	return template.replace(/\{(\d+)\}/g, (match, index) => {
		const arg = args[index];
		return typeof arg === 'string' || typeof arg === 'number' ? String(arg) : match;
	});
}
