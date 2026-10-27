/**
 * Renders block-level Markdown commit messages to markup, for the Commit Details View's message
 * body when `hasMarkdown()` detects it's worth it (the inline formatting of every other text is
 * TextFormatter's).
 *
 * Token-based for XSS safety: `markdownit.parse()` only tokenizes (the vendored instance is also
 * built with `html: false`, so raw HTML embedded in the source is never even recognised as a
 * distinct token type - it falls through as plain text). Every token type below is mapped by hand
 * to a fixed, hand-chosen tag, and every piece of token content is escaped before it is
 * concatenated into the output. The walker's shape (a flat token stream with `_open`/`_close`
 * pairs bracketing their content, rather than a nested tree) matches markdown-it's actual
 * `parse()` output.
 */

import { escapeHtml, raw, SafeHtml } from '../../common/html';
import { CLASS_EXTERNAL_URL } from './textFormatter';
import type MarkdownIt from 'markdown-it';

/**
 * The token shape of markdown-it (the on-demand media/chunks/markdown-it-*.js the webview
 * loads): only the fields this renderer consumes, verified against markdown-it 12.3.2.
 */
interface MarkdownItToken {
	readonly type: string;
	/** +1 = opening a container (e.g. `heading_open`), -1 = closing it, 0 = a leaf token. */
	readonly nesting: -1 | 0 | 1;
	/** The rendered tag this token corresponds to, e.g. `h1`, `p`, `ul`, `a` ('' for `inline`/`text`). */
	readonly tag: string;
	/** Present on `fence` (the code) and `inline` (the raw source text of the inline run). */
	readonly content: string;
	/** Only on `fence`: the info string after the opening ``` (typically a language name). */
	readonly info: string;
	/** Only on `inline`: this token's own nested flat token stream (walked the same way as the top-level one). */
	readonly children: ReadonlyArray<MarkdownItToken> | null;
	/** True on `paragraph_open`/`paragraph_close` inside a "tight" list (no blank lines between items) - the wrapping tag should be omitted for these. */
	readonly hidden: boolean;
	/** Reads an attribute set on this token (e.g. `href` on `link_open`, `src`/`alt` on `image`, `start` on `ordered_list_open`), or NULL if absent. */
	attrGet(name: string): string | number | null;
}

/* The Markdown renderer loads ON DEMAND: markdown-it is one of the heaviest
   dependencies of the webview and the Commit Details View is the only consumer, so it sits in an
   on-demand chunk (see loadMarkdown) and the idle prefetch after the first paint usually has it
   ready before the first click on a commit. */
let markdownit: MarkdownIt | null = null;
let markdownLoader: Promise<void> | null = null;

/** TRUE once the Markdown renderer's module has loaded. */
export function isMarkdownLoaded(): boolean {
	return markdownit !== null;
}

/**
 * Load the Markdown renderer (idempotent). The instance configuration is unchanged from the
 * retired vendored build:
 * html disabled (raw HTML embedded in a commit message is never treated as markup, even before
 * this module's own token-based safety pass), no linkify, line breaks on.
 */
export function loadMarkdown(): Promise<void> {
	if (markdownit !== null) return Promise.resolve();
	if (markdownLoader === null) {
		markdownLoader = import('markdown-it').then((m) => {
			markdownit = new m.default({ html: false, linkify: false, breaks: true });
			markdownLoader = null;
		}, (error) => {
			markdownLoader = null;
			throw error;
		});
	}
	return markdownLoader;
}

/**
 * A conservative heuristic for whether a commit message is worth offering a Markdown/Plain
 * toggle for. Deliberately ignores underscore-emphasis and bare URLs, which would otherwise
 * false-positive on `snake_case`/`__dunder__` identifiers and plain links pasted into an
 * otherwise plain-text message.
 */
export function hasMarkdown(text: string): boolean {
	return /^#{1,6}\s/m.test(text) // heading
		|| /^```/m.test(text) // fenced code
		|| /^\s*[-*+]\s/m.test(text) // bullet list
		|| /^\s*\d+[.)]\s/m.test(text) // ordered list
		|| /^\s*\|.+\|\s*$/m.test(text) // table row
		|| /^>\s/m.test(text) // blockquote
		|| /\[.+?\]\(\S+?\)/.test(text); // link
}

const MARKDOWN_SAFE_URL_SCHEME = /^https?:\/\//i;

/** NULL for anything but an http(s) URL - blocks `javascript:` and other dangerous schemes from ever reaching a rendered `href`/`src`. */
function markdownSafeUrl(url: string | number | null): string | null {
	return typeof url === 'string' && MARKDOWN_SAFE_URL_SCHEME.test(url) ? url : null;
}

function escapeText(text: string) {
	return escapeHtml(text).html;
}

/**
 * Tokenize and render a Markdown commit message body.
 * @param text The raw commit message.
 */
export function renderMarkdown(text: string): SafeHtml {
	if (markdownit === null) {
		// Called before the module loaded (the caller renders this only as a placeholder - the
		// Commit Details View re-renders the body once loadMarkdown resolves): plain text, so the
		// message is never blank and never unescaped.
		return raw(escapeHtml(text).html);
	}
	// The one cast across markdown-it's ambient declaration (see markdown-it.d.ts): the loose
	// object[] stands only for markdown-it's own richer token type, whose fields this module's
	// MarkdownItToken mirrors by hand - renderRange reads exactly those fields.
	const tokens = markdownit.parse(text, {}) as MarkdownItToken[];
	return raw(renderRange(tokens, 0, tokens.length));
}

/**
 * Render a balanced range of markdown-it's flat token stream: every container `_open` token at
 * this level has its matching `_close` within `[start, end)`, so this can only be called with a
 * range that came from either the top-level token array or one `_open`'s own contents.
 */
function renderRange(tokens: ReadonlyArray<MarkdownItToken>, start: number, end: number): string {
	let out = '';
	let i = start;
	while (i < end) {
		const token = tokens[i];
		if (token.nesting === 1) {
			const closeIndex = findMatchingClose(tokens, i, end);
			out += renderContainer(token, renderRange(tokens, i + 1, closeIndex));
			i = closeIndex + 1;
		} else if (token.nesting === -1) {
			// An unmatched close within this range should not happen for well-formed output;
			// skip defensively rather than let one malformed token corrupt everything after it.
			i++;
		} else {
			out += renderLeaf(token);
			i++;
		}
	}
	return out;
}

/** The index of `tokens[openIndex]`'s matching `_close` token, by nesting-depth bracket matching. */
function findMatchingClose(tokens: ReadonlyArray<MarkdownItToken>, openIndex: number, end: number): number {
	let depth = 0;
	for (let i = openIndex; i < end; i++) {
		depth += tokens[i].nesting;
		if (depth === 0) return i;
	}
	return end - 1;
}

function renderContainer(token: MarkdownItToken, inner: string): string {
	switch (token.type) {
		case 'heading_open': {
			const tag = /^h[1-6]$/.test(token.tag) ? token.tag : 'h6';
			return '<' + tag + '>' + inner + '</' + tag + '>';
		}
		case 'paragraph_open':
			// Inside a tight list (no blank lines between items), markdown-it marks the item's
			// paragraph tokens `hidden` to signal the <p> wrapper should be omitted - matching
			// GitHub/GitLab/markdown-it's own HTML renderer, which all skip it for tight lists.
			return token.hidden ? inner : '<p>' + inner + '</p>';
		case 'blockquote_open':
			return '<blockquote>' + inner + '</blockquote>';
		case 'bullet_list_open':
			return '<ul>' + inner + '</ul>';
		case 'ordered_list_open': {
			const start = token.attrGet('start');
			return '<ol' + (start !== null && String(start) !== '1' ? ' start="' + escapeText(String(start)) + '"' : '') + '>' + inner + '</ol>';
		}
		case 'list_item_open':
			return '<li>' + inner + '</li>';
		case 'table_open':
			return '<table>' + inner + '</table>';
		case 'thead_open':
			return '<thead>' + inner + '</thead>';
		case 'tbody_open':
			return '<tbody>' + inner + '</tbody>';
		case 'tr_open':
			return '<tr>' + inner + '</tr>';
		case 'th_open':
			return '<th>' + inner + '</th>';
		case 'td_open':
			return '<td>' + inner + '</td>';
		case 'strong_open':
			return '<strong>' + inner + '</strong>';
		case 'em_open':
			return '<em>' + inner + '</em>';
		case 's_open':
			return '<del>' + inner + '</del>';
		case 'link_open': {
			const url = markdownSafeUrl(token.attrGet('href'));
			if (url === null) return inner;
			// The plain <a class="externalUrl" href="..."> shape used everywhere else in this
			// webview - the one VS Code's webview host recognises and opens externally.
			return '<a class="' + CLASS_EXTERNAL_URL + '" href="' + escapeText(url) + '" tabindex="-1">' + inner + '</a>';
		}
		default:
			return inner;
	}
}

function renderLeaf(token: MarkdownItToken): string {
	switch (token.type) {
		case 'inline':
			return token.children !== null ? renderRange(token.children, 0, token.children.length) : '';
		case 'text':
			return escapeText(token.content);
		case 'code_inline':
			return '<code>' + escapeText(token.content) + '</code>';
		case 'fence':
		case 'code_block':
			return '<pre><code>' + escapeText(token.content) + '</code></pre>';
		case 'hr':
			return '<hr>';
		case 'softbreak':
		case 'hardbreak':
			return '<br>';
		case 'image': {
			const url = markdownSafeUrl(token.attrGet('src'));
			return url === null ? escapeText(token.content) : '<img src="' + escapeText(url) + '" alt="' + escapeText(token.content) + '">';
		}
		case 'html_block':
		case 'html_inline':
			// Raw HTML embedded in the Markdown source is never rendered as HTML - shown as plain
			// text instead (belt-and-braces: the vendored instance's `html: false` option already
			// keeps markdown-it itself from ever producing these two token types).
			return escapeText(token.content);
		default:
			return escapeText(token.content || '');
	}
}
