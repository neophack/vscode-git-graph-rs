/**
 * The Markdown renderer of src/webview/graph/text/markdown.ts (ported from
 * tests/markdownRenderer.test.mjs, which bundled the source with esbuild and executed it through
 * `new Function` — banned by REFACTOR-PLAN T2/T3; this is the real module imported directly).
 * A commit message is attacker-controllable text (anyone who can push a commit controls what
 * every viewer of this repository sees rendered), so beyond rendering fidelity the token-based
 * walk's core job is that no token's raw text ever reaches the DOM as anything but escaped text
 * or a hand-chosen safe tag/attribute.
 *
 * The REAL markdown-it library is used - the same construction as scripts/markdown-entry.js
 * (the vendored instance the webview loads as `window.markdownit`): html disabled, so raw HTML
 * in the source is never even recognised as a distinct token type.
 */

import { describe, expect, it } from 'vitest';

import { hasMarkdown, loadMarkdown, renderMarkdown } from './markdown';

// The renderer loads on demand (task 5.9): the same dynamic import the Commit Details View
// triggers, constructing the same preconfigured instance (html disabled, so raw HTML in the
// source is never even recognised as a distinct token type)
await loadMarkdown();

describe('hasMarkdown', () => {
	it('is false for a typical plain-text commit message', () => {
		expect(hasMarkdown('Fix the thing that was broken\n\nSome more detail here.')).toBe(false);
	});

	it('does not false-positive on snake_case / __dunder__ identifiers (deliberately ignores underscore-emphasis)', () => {
		expect(hasMarkdown('Rename get_user_id to __get_user_id__')).toBe(false);
	});

	it('does not false-positive on a bare URL pasted into an otherwise plain message', () => {
		expect(hasMarkdown('See https://example.com/issue/123 for details')).toBe(false);
	});

	it('is true for a heading', () => {
		expect(hasMarkdown('# Title\n\nBody')).toBe(true);
	});

	it('is true for a fenced code block', () => {
		expect(hasMarkdown('```\ncode\n```')).toBe(true);
	});

	it('is true for a bullet list', () => {
		expect(hasMarkdown('- one\n- two')).toBe(true);
	});

	it('is true for an ordered list', () => {
		expect(hasMarkdown('1. one\n2. two')).toBe(true);
	});

	it('is true for a table row', () => {
		expect(hasMarkdown('| a | b |\n|---|---|')).toBe(true);
	});

	it('is true for a blockquote', () => {
		expect(hasMarkdown('> quoted')).toBe(true);
	});

	it('is true for an explicit markdown link', () => {
		expect(hasMarkdown('[text](https://example.com)')).toBe(true);
	});
});

describe('renderMarkdown - rendering fidelity (against the real markdown-it library)', () => {
	it('renders a heading', () => {
		expect(String(renderMarkdown('# Title'))).toBe('<h1>Title</h1>');
	});

	it('renders bold, italic and inline code together', () => {
		expect(String(renderMarkdown('**bold** *em* `code`'))).toBe('<p><strong>bold</strong> <em>em</em> <code>code</code></p>');
	});

	it('renders a tight bullet list without wrapping each item in a <p>', () => {
		expect(String(renderMarkdown('- one\n- two'))).toBe('<ul><li>one</li><li>two</li></ul>');
	});

	it('renders a loose bullet list (blank line between items) with each item wrapped in a <p>', () => {
		expect(String(renderMarkdown('- one\n\n- two'))).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul>');
	});

	it('renders an ordered list starting at a non-1 value with a start attribute', () => {
		expect(String(renderMarkdown('3. three\n4. four'))).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
	});

	it('renders a table', () => {
		expect(String(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'))).toBe(
			'<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
		);
	});

	it('renders a blockquote', () => {
		expect(String(renderMarkdown('> quoted'))).toBe('<blockquote><p>quoted</p></blockquote>');
	});

	it('renders a safe http(s) link with the externalUrl class VS Code\'s webview host already opens externally', () => {
		expect(String(renderMarkdown('[text](https://example.com)'))).toBe(
			'<p><a class="externalUrl" href="https:&#x2F;&#x2F;example.com" tabindex="-1">text</a></p>'
		);
	});
});

describe('renderMarkdown - XSS safety', () => {
	it('never renders a javascript: link as a clickable anchor', () => {
		// Rejected link targets fall back to the link's own (escaped) inline content, so the
		// literal markdown source text can still appear as inert page text - what matters for
		// safety is that "javascript:" is never placed inside a live href attribute.
		const html = String(renderMarkdown('[click me](javascript:alert(1))'));
		expect(html.includes('<a '), 'no anchor tag was produced for a javascript: href').toBe(false);
		expect(/href\s*=\s*"[^"]*javascript:/i.test(html), 'the javascript: scheme never ends up inside an href attribute').toBe(false);
	});

	it('never renders an img for a data: URL disguised as an image target', () => {
		const html = String(renderMarkdown('![x](data:text/html,<script>alert(1)</script>)'));
		expect(html.includes('<img'), 'no <img> tag was produced for a data: src').toBe(false);
		expect(!/<script[ >]/.test(html), 'no live <script> element either, even though one was embedded in the attempted URL').toBe(true);
	});

	it('escapes a raw <script> tag embedded directly in the message instead of ever rendering it as an element', () => {
		const html = String(renderMarkdown('before\n<script>alert(1)</script>\nafter'));
		expect(!/<script[ >]/.test(html), 'no live <script> element in the output').toBe(true);
		expect(html.includes('&lt;script&gt;'), 'the tag text survives only in its escaped form').toBe(true);
	});

	it('escapes an inline raw HTML event-handler attempt (<img onerror=...>) instead of ever creating the element', () => {
		const html = String(renderMarkdown('Some text with <img src=x onerror=alert(1)> inline.'));
		expect(!/<img\s/.test(html), 'no live <img> element was created from the raw HTML attempt').toBe(true);
		expect(html.includes('&lt;img'), 'the attempt survives only as escaped text').toBe(true);
	});

	it('escapes HTML metacharacters in ordinary paragraph text', () => {
		expect(String(renderMarkdown('1 < 2 && 3 > 2'))).toBe('<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>');
	});

	it('escapes HTML metacharacters inside an inline code span (never lets the highlighted "code" become real markup)', () => {
		const html = String(renderMarkdown('`<img src=x onerror=alert(1)>`'));
		expect(html.includes('<code>&lt;img src=x onerror=alert(1)&gt;</code>')).toBe(true);
		expect(!/<img\s/.test(html)).toBe(true);
	});

	it('escapes HTML metacharacters inside a fenced code block', () => {
		const html = String(renderMarkdown('```\n<script>alert(1)</script>\n```'));
		expect(html.includes('&lt;script&gt;alert(1)&lt;&#x2F;script&gt;')).toBe(true);
		expect(!/<script[ >]/.test(html)).toBe(true);
	});
});
