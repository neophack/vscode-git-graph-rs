/**
 * Safe HTML construction.
 *
 * Every piece of markup the webview inserts into the DOM is a `SafeHtml` value, and this module is
 * the only one that writes HTML into the DOM (`setHtml`, `replaceWithHtml`, `insertHtml`,
 * `parseHtmlRow`) - the build's html gate rejects `innerHTML`, `outerHTML` and
 * `insertAdjacentHTML` anywhere else. A `SafeHtml` can only come from:
 *
 *  - the `html` tagged template, which escapes every interpolated string or number and passes
 *    nested `SafeHtml` through unchanged;
 *  - `escapeHtml(text)`, so text escaped once can never be escaped twice;
 *  - `raw(markup)`, the explicit marker for markup the webview itself authored (icons, the
 *    markup entries of the string tables).
 *
 * A string concatenated onto a `SafeHtml` is a plain string again, which none of the sinks accept.
 */

/** Markup that is safe to insert into the DOM as HTML. */
class SafeHtmlValue {
	/** Makes the type nominal: a structurally similar object is not a SafeHtml. */
	private declare readonly nominal: never;

	constructor(public readonly html: string) { }

	public toString() {
		return this.html;
	}
}

export type SafeHtml = SafeHtmlValue;

/** A value the `html` template accepts: text and numbers are escaped, `false`/`null`/`undefined` render nothing. */
export type HtmlValue = SafeHtml | string | number | false | null | undefined | ReadonlyArray<HtmlValue>;

const HTML_ESCAPES: { [key: string]: string } = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#x27;', '/': '&#x2F;' };
const HTML_UNESCAPES: { [key: string]: string } = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': '\'', '&#x2F;': '/' };
const HTML_ESCAPER_REGEX = /[&<>"'\/]/g;
const HTML_UNESCAPER_REGEX = /&lt;|&gt;|&amp;|&quot;|&#x27;|&#x2F;/g;

export const EMPTY_HTML: SafeHtml = new SafeHtmlValue('');

function escapeText(text: string) {
	return text.replace(HTML_ESCAPER_REGEX, (match) => HTML_ESCAPES[match]);
}

function renderValue(value: HtmlValue): string {
	if (value instanceof SafeHtmlValue) return value.html;
	if (typeof value === 'string') return escapeText(value);
	if (typeof value === 'number') return String(value);
	if (value === false || value === null || value === undefined) return '';
	let out = '';
	for (let i = 0; i < value.length; i++) out += renderValue(value[i]);
	return out;
}

/**
 * The tagged template building markup: every interpolated value is escaped unless it already is
 * a `SafeHtml`.
 */
export function html(parts: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
	let out = parts[0];
	for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + parts[i + 1];
	return new SafeHtmlValue(out);
}

/**
 * Mark markup the webview authored itself as safe. Never call this with text that came from the
 * repository, the user or the extension host - use `html` or `escapeHtml` for those.
 * @param markup The trusted markup.
 */
export function raw(markup: string): SafeHtml {
	return new SafeHtmlValue(markup);
}

/** Is a value a `SafeHtml`. */
export function isSafeHtml(value: unknown): value is SafeHtml {
	return value instanceof SafeHtmlValue;
}

/**
 * Escape text so it renders literally.
 * @param text The text to escape.
 * @returns The escaped markup.
 */
export function escapeHtml(text: string): SafeHtml {
	return new SafeHtmlValue(escapeText(text));
}

/**
 * Turn the escaped form of `escapeHtml` back into text (the value of an attribute the webview
 * wrote escaped, read back through `dataset`).
 * @param text The escaped text.
 * @returns The original text.
 */
export function unescapeHtml(text: string) {
	return text.replace(HTML_UNESCAPER_REGEX, (match) => HTML_UNESCAPES[match]);
}

/**
 * Join markup fragments.
 * @param parts The fragments.
 * @param separator Inserted between consecutive fragments (escaped when it is text).
 */
export function joinHtml(parts: ReadonlyArray<HtmlValue>, separator: SafeHtml | string = ''): SafeHtml {
	const sep = renderValue(separator);
	let out = '';
	for (let i = 0; i < parts.length; i++) out += (i > 0 ? sep : '') + renderValue(parts[i]);
	return new SafeHtmlValue(out);
}

/**
 * Format markup fragments as a list ("A, B & C"), like `formatCommaSeparatedList` does for text.
 */
export function formatCommaSeparatedHtml(items: ReadonlyArray<SafeHtml>): SafeHtml {
	let out = '';
	for (let i = 0; i < items.length; i++) {
		out += (i > 0 ? (i < items.length - 1 ? ', ' : ' &amp; ') : '') + items[i].html;
	}
	return new SafeHtmlValue(out);
}

/**
 * The attribute string of an element that exposes explanatory text through the shared help
 * tooltip (see helpTooltip.ts): the same text serves mouse and keyboard users.
 * @param message The explanatory text.
 * @param className Optional additional CSS classes.
 */
export function helpTooltipAttrs(message: string, className: string = ''): SafeHtml {
	return html`class="${className !== '' ? className + ' ' : ''}gg-helpTooltip" data-tooltip="${message}" aria-label="${message}" tabindex="0"`;
}


/* DOM sinks: the only writers of HTML in the webview */

/** Replace the content of an element. */
export function setHtml(elem: Element, content: SafeHtml) {
	elem.innerHTML = content.html;
}

/** Replace an element (and its subtree) with markup. */
export function replaceWithHtml(elem: Element, content: SafeHtml) {
	elem.outerHTML = content.html;
}

/** Insert markup relative to an element. */
export function insertHtml(elem: Element, position: InsertPosition, content: SafeHtml) {
	elem.insertAdjacentHTML(position, content.html);
}

/**
 * Build a single table row from its markup. Rows must be parsed in table context or the parser
 * drops them, which a `<template>` does correctly.
 */
export function parseHtmlRow(content: SafeHtml) {
	const tpl = document.createElement('template');
	tpl.innerHTML = '<table><tbody>' + content.html + '</tbody></table>';
	return <HTMLElement>tpl.content.querySelector('tr')!;
}
