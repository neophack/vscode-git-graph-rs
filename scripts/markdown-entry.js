// Bundled by scripts/package-markdown.js into media/vendor/markdown-it.min.js: exposes a
// pre-configured `window.markdownit` MarkdownIt instance (html disabled - raw HTML embedded in a
// commit message is never treated as markup, even before web/markdownRenderer.ts's own
// token-based safety pass) used by the Commit Details View to render block-level Markdown commit
// messages. Kept separate from the rest of the webview bundle (which esbuild only concatenates,
// not bundles) because markdown-it's package is authored for bundlers, not for direct <script>
// use - same reason highlight.js gets its own entry point (see highlight-entry.js).
const MarkdownIt = require('markdown-it');

window.markdownit = new MarkdownIt({ html: false, linkify: false, breaks: true });
