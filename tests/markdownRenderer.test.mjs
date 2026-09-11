/**
 * web/markdownRenderer.ts renders a commit message's Markdown to an HTML string for the Commit
 * Details View, assigned via `innerHTML`. Unlike most content this webview renders, a commit
 * message is attacker-controllable text (anyone who can push a commit controls what every viewer
 * of this repository sees rendered here) - so beyond rendering fidelity, the token-based walk's
 * core job is to guarantee that no token's raw text ever reaches the DOM as anything but escaped
 * text or a hand-chosen safe tag/attribute. `hasMarkdown()` (the heuristic gating whether the
 * Markdown/Plain toggle is offered at all) is covered too, including its deliberate
 * false-positive avoidances (snake_case identifiers, bare URLs).
 *
 * The REAL markdown-it library is used (not a stub or a hand-rolled substitute) - transpiled
 * straight from the .ts source with esbuild (already a project devDependency) rather than
 * depending on a prior `npm run compile-web` having produced media/markdownRenderer.js, which
 * package-web.js deletes once its content has been folded into media/out.min.js.
 */

import assert from 'node:assert/strict';
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import MarkdownIt from 'markdown-it';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The same construction as scripts/markdown-entry.js (the real vendored instance the webview
// loads as `window.markdownit`): html disabled, so raw HTML in the source is never even
// recognised as a distinct token type in the first place.
const markdownit = new MarkdownIt({ html: false, linkify: false, breaks: true });

// Mirrors web/utils.ts's escapeHtml (HTML_ESCAPES / HTML_ESCAPER_REGEX) exactly. Duplicated
// rather than evaluated from utils.ts itself, which calls `acquireVsCodeApi()` at module scope
// and pulls in a large amount of unrelated webview-global state.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#x27;', '/': '&#x2F;' };
const escapeHtml = (str) => str.replace(/[&<>"'/]/g, (match) => HTML_ESCAPES[match]);
const CLASS_EXTERNAL_URL = 'externalUrl';

const source = fs.readFileSync(path.join(root, 'web', 'markdownRenderer.ts'), 'utf8');
const { code } = esbuild.transformSync(source, { loader: 'ts' });
// new Function (not eval): web/markdownRenderer.ts is not a module (no import/export - every
// web/*.ts file is designed to be concatenated into one script, see package-web.js), so its
// functions are pulled out by name once, in one execution, rather than depending on strict-mode
// module-eval scoping rules.
const load = new Function('escapeHtml', 'CLASS_EXTERNAL_URL', 'markdownit', code + '\nreturn { hasMarkdown, renderMarkdown };');
const { hasMarkdown, renderMarkdown } = load(escapeHtml, CLASS_EXTERNAL_URL, markdownit);

describe('hasMarkdown', () => {
	it('is false for a typical plain-text commit message', () => {
		assert.equal(hasMarkdown('Fix the thing that was broken\n\nSome more detail here.'), false);
	});

	it('does not false-positive on snake_case / __dunder__ identifiers (deliberately ignores underscore-emphasis)', () => {
		assert.equal(hasMarkdown('Rename get_user_id to __get_user_id__'), false);
	});

	it('does not false-positive on a bare URL pasted into an otherwise plain message', () => {
		assert.equal(hasMarkdown('See https://example.com/issue/123 for details'), false);
	});

	it('is true for a heading', () => {
		assert.equal(hasMarkdown('# Title\n\nBody'), true);
	});

	it('is true for a fenced code block', () => {
		assert.equal(hasMarkdown('```\ncode\n```'), true);
	});

	it('is true for a bullet list', () => {
		assert.equal(hasMarkdown('- one\n- two'), true);
	});

	it('is true for an ordered list', () => {
		assert.equal(hasMarkdown('1. one\n2. two'), true);
	});

	it('is true for a table row', () => {
		assert.equal(hasMarkdown('| a | b |\n|---|---|'), true);
	});

	it('is true for a blockquote', () => {
		assert.equal(hasMarkdown('> quoted'), true);
	});

	it('is true for an explicit markdown link', () => {
		assert.equal(hasMarkdown('[text](https://example.com)'), true);
	});
});

describe('renderMarkdown - rendering fidelity (against the real markdown-it library)', () => {
	it('renders a heading', () => {
		assert.equal(renderMarkdown('# Title'), '<h1>Title</h1>');
	});

	it('renders bold, italic and inline code together', () => {
		assert.equal(renderMarkdown('**bold** *em* `code`'), '<p><strong>bold</strong> <em>em</em> <code>code</code></p>');
	});

	it('renders a tight bullet list without wrapping each item in a <p>', () => {
		assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
	});

	it('renders a loose bullet list (blank line between items) with each item wrapped in a <p>', () => {
		assert.equal(renderMarkdown('- one\n\n- two'), '<ul><li><p>one</p></li><li><p>two</p></li></ul>');
	});

	it('renders an ordered list starting at a non-1 value with a start attribute', () => {
		assert.equal(renderMarkdown('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
	});

	it('renders a table', () => {
		assert.equal(
			renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'),
			'<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
		);
	});

	it('renders a blockquote', () => {
		assert.equal(renderMarkdown('> quoted'), '<blockquote><p>quoted</p></blockquote>');
	});

	it('renders a safe http(s) link with the externalUrl class VS Code\'s webview host already opens externally', () => {
		assert.equal(
			renderMarkdown('[text](https://example.com)'),
			'<p><a class="externalUrl" href="https:&#x2F;&#x2F;example.com" tabindex="-1">text</a></p>'
		);
	});
});

describe('renderMarkdown - XSS safety', () => {
	it('never renders a javascript: link as a clickable anchor', () => {
		// Rejected link targets fall back to the link's own (escaped) inline content, so the
		// literal markdown source text can still appear as inert page text - what matters for
		// safety is that "javascript:" is never placed inside a live href attribute.
		const html = renderMarkdown('[click me](javascript:alert(1))');
		assert.ok(!html.includes('<a '), 'no anchor tag was produced for a javascript: href');
		assert.ok(!/href\s*=\s*"[^"]*javascript:/i.test(html), 'the javascript: scheme never ends up inside an href attribute');
	});

	it('never renders an img for a data: URL disguised as an image target', () => {
		const html = renderMarkdown('![x](data:text/html,<script>alert(1)</script>)');
		assert.ok(!html.includes('<img'), 'no <img> tag was produced for a data: src');
		assert.ok(!/<script[ >]/.test(html), 'no live <script> element either, even though one was embedded in the attempted URL');
	});

	it('escapes a raw <script> tag embedded directly in the message instead of ever rendering it as an element', () => {
		const html = renderMarkdown('before\n<script>alert(1)</script>\nafter');
		assert.ok(!/<script[ >]/.test(html), 'no live <script> element in the output');
		assert.ok(html.includes('&lt;script&gt;'), 'the tag text survives only in its escaped form');
	});

	it('escapes an inline raw HTML event-handler attempt (<img onerror=...>) instead of ever creating the element', () => {
		const html = renderMarkdown('Some text with <img src=x onerror=alert(1)> inline.');
		assert.ok(!/<img\s/.test(html), 'no live <img> element was created from the raw HTML attempt');
		assert.ok(html.includes('&lt;img'), 'the attempt survives only as escaped text');
	});

	it('escapes HTML metacharacters in ordinary paragraph text', () => {
		assert.equal(renderMarkdown('1 < 2 && 3 > 2'), '<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>');
	});

	it('escapes HTML metacharacters inside an inline code span (never lets the highlighted "code" become real markup)', () => {
		const html = renderMarkdown('`<img src=x onerror=alert(1)>`');
		assert.ok(html.includes('<code>&lt;img src=x onerror=alert(1)&gt;</code>'));
		assert.ok(!/<img\s/.test(html));
	});

	it('escapes HTML metacharacters inside a fenced code block', () => {
		const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
		assert.ok(html.includes('&lt;script&gt;alert(1)&lt;&#x2F;script&gt;'));
		assert.ok(!/<script[ >]/.test(html));
	});
});
