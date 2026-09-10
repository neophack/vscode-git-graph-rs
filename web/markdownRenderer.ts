/**
 * Renders block-level Markdown commit messages to an HTML string, matching how the rest of this
 * webview (including `TextFormatter.format()`, the existing inline-only formatter) builds panel
 * content: one big string assembled and assigned via `innerHTML` once, not a DOM tree appended
 * node by node.
 *
 * Token-based for XSS safety: `markdownit.parse()` only tokenizes (the vendored instance is also
 * built with `html: false`, so raw HTML embedded in the source is never even recognised as a
 * distinct token type in the first place - it falls through as plain text). Every token type
 * below is mapped by hand to a fixed, hand-chosen tag, with `escapeHtml()` run on every piece of
 * token content before it is ever concatenated into the output - the same escape-on-the-way-in
 * discipline the rest of this file already uses for commit metadata. This walker's shape (a flat
 * token stream with `_open`/`_close` pairs bracketing their content, rather than a nested tree)
 * matches markdown-it's actual `parse()` output, verified directly against the library rather
 * than assumed from documentation.
 *
 * `web/textFormatter.ts` is untouched - this is a separate renderer for the block-level case,
 * used only by the Commit Details View's message body when `hasMarkdown()` detects it's worth it.
 */

/**
 * A conservative heuristic for whether a commit message is worth offering a Markdown/Plain
 * toggle for. Deliberately ignores underscore-emphasis and bare URLs, which would otherwise
 * false-positive on `snake_case`/`__dunder__` identifiers and plain links pasted into an
 * otherwise plain-text message.
 */
function hasMarkdown(text: string): boolean {
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

/**
 * Tokenize and render a Markdown commit message body.
 * @param text The raw commit message.
 * @returns The rendered (escaped) HTML string.
 */
function renderMarkdown(text: string): string {
	const tokens = markdownit.parse(text, {});
	return renderMarkdownRange(tokens, 0, tokens.length);
}

/**
 * Render a balanced range of markdown-it's flat token stream: every container `_open` token at
 * this level has its matching `_close` within `[start, end)`, so this can only be called with a
 * range that came from either the top-level token array or one `_open`'s own contents.
 */
function renderMarkdownRange(tokens: ReadonlyArray<MarkdownItToken>, start: number, end: number): string {
	let html = '';
	let i = start;
	while (i < end) {
		const token = tokens[i];
		if (token.nesting === 1) {
			const closeIndex = findMatchingClose(tokens, i, end);
			html += renderMarkdownContainer(token, renderMarkdownRange(tokens, i + 1, closeIndex));
			i = closeIndex + 1;
		} else if (token.nesting === -1) {
			// An unmatched close within this range should not happen for well-formed output;
			// skip defensively rather than let one malformed token corrupt everything after it.
			i++;
		} else {
			html += renderMarkdownLeaf(token);
			i++;
		}
	}
	return html;
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

function renderMarkdownContainer(token: MarkdownItToken, innerHtml: string): string {
	switch (token.type) {
		case 'heading_open': {
			const tag = /^h[1-6]$/.test(token.tag) ? token.tag : 'h6';
			return '<' + tag + '>' + innerHtml + '</' + tag + '>';
		}
		case 'paragraph_open':
			return '<p>' + innerHtml + '</p>';
		case 'blockquote_open':
			return '<blockquote>' + innerHtml + '</blockquote>';
		case 'bullet_list_open':
			return '<ul>' + innerHtml + '</ul>';
		case 'ordered_list_open': {
			const start = token.attrGet('start');
			return '<ol' + (start !== null && String(start) !== '1' ? ' start="' + escapeHtml(String(start)) + '"' : '') + '>' + innerHtml + '</ol>';
		}
		case 'list_item_open':
			return '<li>' + innerHtml + '</li>';
		case 'table_open':
			return '<table>' + innerHtml + '</table>';
		case 'thead_open':
			return '<thead>' + innerHtml + '</thead>';
		case 'tbody_open':
			return '<tbody>' + innerHtml + '</tbody>';
		case 'tr_open':
			return '<tr>' + innerHtml + '</tr>';
		case 'th_open':
			return '<th>' + innerHtml + '</th>';
		case 'td_open':
			return '<td>' + innerHtml + '</td>';
		case 'strong_open':
			return '<strong>' + innerHtml + '</strong>';
		case 'em_open':
			return '<em>' + innerHtml + '</em>';
		case 's_open':
			return '<del>' + innerHtml + '</del>';
		case 'link_open': {
			const url = markdownSafeUrl(token.attrGet('href'));
			if (url === null) return innerHtml;
			// Matches the plain <a class="externalUrl" href="..."> shape used everywhere else in
			// this webview (e.g. textFormatter.ts, gerritView.ts) - the same one VS Code's webview
			// host already recognises and opens externally, with no extra click handler needed.
			return '<a class="' + CLASS_EXTERNAL_URL + '" href="' + escapeHtml(url) + '" tabindex="-1">' + innerHtml + '</a>';
		}
		default:
			return innerHtml;
	}
}

function renderMarkdownLeaf(token: MarkdownItToken): string {
	switch (token.type) {
		case 'inline':
			return token.children !== null ? renderMarkdownRange(token.children, 0, token.children.length) : '';
		case 'text':
			return escapeHtml(token.content);
		case 'code_inline':
			return '<code>' + escapeHtml(token.content) + '</code>';
		case 'fence':
		case 'code_block':
			return '<pre><code>' + escapeHtml(token.content) + '</code></pre>';
		case 'hr':
			return '<hr>';
		case 'softbreak':
		case 'hardbreak':
			return '<br>';
		case 'image': {
			const url = markdownSafeUrl(token.attrGet('src'));
			return url === null ? escapeHtml(token.content) : '<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(token.content) + '">';
		}
		case 'html_block':
		case 'html_inline':
			// Raw HTML embedded in the Markdown source is never rendered as HTML - shown as plain
			// text instead (belt-and-braces: the vendored instance's `html: false` option already
			// keeps markdown-it itself from ever producing these two token types).
			return escapeHtml(token.content);
		default:
			return escapeHtml(token.content || '');
	}
}
