// Bundled by scripts/package-highlight.js into media/highlight.min.js: a self-contained browser
// script (no module system needed by the consumer) that exposes `window.hljs`, pre-registered
// with a curated set of languages covering the large majority of files a diff is likely to touch.
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
	less: require('highlight.js/lib/languages/less'),
	markdown: require('highlight.js/lib/languages/markdown'),
	sql: require('highlight.js/lib/languages/sql'),
	dockerfile: require('highlight.js/lib/languages/dockerfile'),
	ini: require('highlight.js/lib/languages/ini'),
	diff: require('highlight.js/lib/languages/diff'),
	dart: require('highlight.js/lib/languages/dart'),
	scala: require('highlight.js/lib/languages/scala'),
	perl: require('highlight.js/lib/languages/perl'),
	lua: require('highlight.js/lib/languages/lua'),
	objectivec: require('highlight.js/lib/languages/objectivec'),
	makefile: require('highlight.js/lib/languages/makefile'),
	graphql: require('highlight.js/lib/languages/graphql'),
	protobuf: require('highlight.js/lib/languages/protobuf'),
	plaintext: require('highlight.js/lib/languages/plaintext')
};

for (const name in languages) {
	hljs.registerLanguage(name, languages[name].default || languages[name]);
}

window.hljs = hljs;
