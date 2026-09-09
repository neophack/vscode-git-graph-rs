const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const MEDIA_DIRECTORY = './media';
const STYLES_DIRECTORY = './web/styles';

const MAIN_CSS_FILE = 'main.css';
const MAIN_JS_FILE = 'main.js';
const UTILS_JS_FILE = 'utils.js';

const OUTPUT_MIN_CSS_FILE = 'out.min.css';
const OUTPUT_MIN_JS_FILE = 'out.min.js';
const OUTPUT_TMP_JS_FILE = 'out.tmp.js';

const DEBUG = process.argv.length > 2 && process.argv[2] === 'debug';


// Determine the JS files to be packaged. The order is: utils.ts, *.ts, and then main.ts
let packageJsFiles = [path.join(MEDIA_DIRECTORY, UTILS_JS_FILE)];
fs.readdirSync(MEDIA_DIRECTORY).forEach((fileName) => {
	if (fileName.endsWith('.js') && fileName !== OUTPUT_MIN_JS_FILE && fileName !== UTILS_JS_FILE && fileName !== MAIN_JS_FILE) {
		packageJsFiles.push(path.join(MEDIA_DIRECTORY, fileName));
	}
});
packageJsFiles.push(path.join(MEDIA_DIRECTORY, MAIN_JS_FILE));

// Determine the CSS files to be packaged. The order is: main.css, and then *.css
let packageCssFiles = [path.join(STYLES_DIRECTORY, MAIN_CSS_FILE)];
fs.readdirSync(STYLES_DIRECTORY).forEach((fileName) => {
	if (fileName.endsWith('.css') && fileName !== MAIN_CSS_FILE) {
		packageCssFiles.push(path.join(STYLES_DIRECTORY, fileName));
	}
});

// Log packaging information
console.log('Packaging Mode = ' + (DEBUG ? "DEBUG" : "PRODUCTION"));
console.log('Packaging CSS files: ' + packageCssFiles.join(', '));
console.log('Packaging JS files: ' + packageJsFiles.join(', '));


// Combine the JS files into an IIFE, with a single "use strict" directive. tsc already emitted
// each one separately (web/tsconfig.json has no bundler configured, so cross-file references are
// plain globals, not imports) - this concatenation is what turns them into one script, in the
// fixed order above (utils, then everything else, then main last, since main.ts is what wires
// the others together at the bottom).
let jsFileContents = '';
packageJsFiles.forEach((fileName) => {
	jsFileContents += fs.readFileSync(fileName).toString().replace('"use strict";\r\n', '') + '\r\n';
	fs.unlinkSync(fileName);
});
const tmpJsFile = path.join(MEDIA_DIRECTORY, OUTPUT_TMP_JS_FILE);
const minJsFile = path.join(MEDIA_DIRECTORY, OUTPUT_MIN_JS_FILE);
const minJsMapFile = minJsFile + '.map';
fs.writeFileSync(tmpJsFile, '"use strict";\r\n(function(document, window){\r\n' + jsFileContents + '})(document, window);\r\n');

// A DEBUG build produces no map (the output is already readable); remove one left behind by an
// earlier production build in the same `media/` directory so a stale map never ships.
if (DEBUG && fs.existsSync(minJsMapFile)) fs.unlinkSync(minJsMapFile);

// esbuild minifies (and, outside DEBUG, emits a real source map alongside the output) without
// needing the file to be a module - it treats this as a single plain script, the same shape
// uglify-js was fed before. DEBUG keeps the code readable (no minify) to make webview console
// errors legible; production gets `out.min.js.map` for readable stack traces from user reports.
// The map must embed its source (sourcesContent): the file it was built from - the temporary
// concatenation - is deleted right after, so without the embedded copy every stack frame the
// map resolves would point at a file that no longer exists and devtools could show nothing.
try {
	esbuild.buildSync({
		entryPoints: [tmpJsFile],
		outfile: minJsFile,
		bundle: false,
		minify: !DEBUG,
		sourcemap: DEBUG ? false : 'linked',
		sourcesContent: true,
		legalComments: 'none',
		logLevel: 'warning'
	});
} catch (err) {
	console.log('ERROR:');
	console.log(err);
	process.exit(1);
}
fs.unlinkSync(tmpJsFile);

// Combine the CSS files
let cssFileContents = '';
packageCssFiles.forEach((fileName) => {
	let contents = fs.readFileSync(fileName).toString();
	if (DEBUG) {
		cssFileContents += contents + '\r\n';
	} else {
		let lines = contents.split(/\r\n|\r|\n/g);
		for (let j = 0; j < lines.length; j++) {
			if (lines[j].startsWith('\t')) lines[j] = lines[j].substring(1);
		}
		let j = 0;
		while (j < lines.length) {
			if (lines[j].startsWith('/*') && lines[j].endsWith('*/')) {
				lines.splice(j, 1);
			} else {
				j++;
			}
		}
		cssFileContents += lines.join('');
	}
});
fs.writeFileSync(path.join(MEDIA_DIRECTORY, OUTPUT_MIN_CSS_FILE), cssFileContents);
