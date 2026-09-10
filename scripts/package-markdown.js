// Bundles markdown-it (see markdown-entry.js) into a single self-contained browser script at
// media/vendor/markdown-it.min.js, used by the Commit Details View to render Markdown commit
// messages. Unlike package-web.js (which only concatenates already-compiled files), this needs
// esbuild's real bundler: markdown-it's package is authored as CJS/ESM modules for a bundler to
// resolve, not as a script a browser can load directly.
const esbuild = require('esbuild');
const path = require('path');

const DEBUG = process.argv.length > 2 && process.argv[2] === 'debug';

try {
	esbuild.buildSync({
		entryPoints: [path.join(__dirname, 'markdown-entry.js')],
		// Under media/vendor/, not media/ directly: package-web.js globs every *.js file sitting
		// directly in media/ into the main Git Graph webview's bundle, and this one must stay out
		// of that (it is loaded on its own, and its bundled `require()` calls are meaningless
		// outside the esbuild IIFE that resolves them).
		outfile: path.join(__dirname, '..', 'media', 'vendor', 'markdown-it.min.js'),
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
