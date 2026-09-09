// Bundles highlight.js (core + a curated language set, see highlight-entry.js) into a single
// self-contained browser script at media/highlight.min.js, used by the Commit Comparison View to
// syntax-highlight diffed code. Unlike package-web.js (which only concatenates already-compiled
// files), this needs esbuild's real bundler: highlight.js's package is authored as CJS/ESM modules
// for a bundler to resolve, not as a script a browser can load directly.
const esbuild = require('esbuild');
const path = require('path');

const DEBUG = process.argv.length > 2 && process.argv[2] === 'debug';

try {
	esbuild.buildSync({
		entryPoints: [path.join(__dirname, 'highlight-entry.js')],
		// Under media/vendor/, not media/ directly: package-web.js globs every *.js file sitting
		// directly in media/ into the main Git Graph webview's bundle, and this one must stay out
		// of that (it is loaded on its own by the separate Commit Comparison View webview, and its
		// bundled `require()` calls are meaningless outside the esbuild IIFE that resolves them).
		outfile: path.join(__dirname, '..', 'media', 'vendor', 'highlight.min.js'),
		bundle: true,
		format: 'iife',
		minify: !DEBUG,
		sourcemap: false,
		legalComments: 'none',
		logLevel: 'warning'
	});
} catch (err) {
	console.log('ERROR:');
	console.log(err);
	process.exit(1);
}
