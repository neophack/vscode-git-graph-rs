// Bundled by scripts/package-highlight.js into media/vendor/highlight.min.js: a self-contained browser
// script (no module system needed by the consumer) that exposes `window.hljs`, pre-registered
// with the commonly diffed languages (the extension families, scripting and web stacks, and the
// serialization/config formats the comparison view maps by file extension in
// src/webview/comparison/diffParsing.ts). Everything NOT registered here — the long-tail
// languages the view's extension map names no more (less, scala, perl, lua, objectivec,
// makefile, graphql, protobuf, ...) — still renders through highlightAuto, which auto-detects
// the closest registered grammar: dropping a language degrades its colors, never the diff.
// Kept separate from the rest of the webview bundle (which esbuild only concatenates, not bundles)
// because highlight.js's package is authored for bundlers, not for direct <script> use.
const hljs = require('highlight.js/lib/core');

const languages = {
	javascript: require('highlight.js/lib/languages/javascript'),
	typescript: require('highlight.js/lib/languages/typescript'),
	python: require('highlight.js/lib/languages/python'),
	rust: require('highlight.js/lib/languages/rust'),
	go: require('highlight.js/lib/languages/go'),
	java: require('highlight.js/lib/languages/java'),
	kotlin: require('highlight.js/lib/languages/kotlin'),
	swift: require('highlight.js/lib/languages/swift'),
	dart: require('highlight.js/lib/languages/dart'),
	c: require('highlight.js/lib/languages/c'),
	cpp: require('highlight.js/lib/languages/cpp'),
	csharp: require('highlight.js/lib/languages/csharp'),
	php: require('highlight.js/lib/languages/php'),
	ruby: require('highlight.js/lib/languages/ruby'),
	bash: require('highlight.js/lib/languages/bash'),
	powershell: require('highlight.js/lib/languages/powershell'),
	json: require('highlight.js/lib/languages/json'),
	yaml: require('highlight.js/lib/languages/yaml'),
	xml: require('highlight.js/lib/languages/xml'),
	css: require('highlight.js/lib/languages/css'),
	scss: require('highlight.js/lib/languages/scss'),
	markdown: require('highlight.js/lib/languages/markdown'),
	sql: require('highlight.js/lib/languages/sql'),
	dockerfile: require('highlight.js/lib/languages/dockerfile'),
	ini: require('highlight.js/lib/languages/ini'),
	diff: require('highlight.js/lib/languages/diff'),
	plaintext: require('highlight.js/lib/languages/plaintext')
};

for (const name in languages) {
	hljs.registerLanguage(name, languages[name].default || languages[name]);
}

window.hljs = hljs;
