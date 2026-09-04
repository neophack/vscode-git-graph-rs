const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const SRC_DIRECTORY = './src';
const OUT_DIRECTORY = './out';
const ASKPASS_DIRECTORY = 'askpass';

/**
 * Copy a single- or double-quoted string literal starting at `i` verbatim, returning the index
 * just past its closing quote.
 */
function skipStringLiteral(source, i) {
	const quote = source[i];
	i++;
	while (i < source.length) {
		if (source[i] === '\\') {
			i += 2;
		} else if (source[i] === quote) {
			return i + 1;
		} else {
			i++;
		}
	}
	return i;
}

/**
 * Copy a template literal starting at `i` verbatim, returning the index just past its closing
 * backtick. `${ ... }` interpolations are scanned so that quotes and nested templates inside them
 * do not end the literal early.
 */
function skipTemplateLiteral(source, i) {
	i++;
	while (i < source.length) {
		if (source[i] === '\\') {
			i += 2;
		} else if (source[i] === '`') {
			return i + 1;
		} else if (source[i] === '$' && source[i + 1] === '{') {
			let depth = 1;
			i += 2;
			while (i < source.length && depth > 0) {
				if (source[i] === '{') {
					depth++;
					i++;
				} else if (source[i] === '}') {
					depth--;
					i++;
				} else if (source[i] === '\'' || source[i] === '"') {
					i = skipStringLiteral(source, i);
				} else if (source[i] === '`') {
					i = skipTemplateLiteral(source, i);
				} else {
					i++;
				}
			}
		} else {
			i++;
		}
	}
	return i;
}

/**
 * Copy a regular expression literal starting at `i` verbatim (character classes may contain
 * quotes that would otherwise be mistaken for the start of a string), returning the index just
 * past its closing slash and flags.
 */
function skipRegularExpression(source, i) {
	i++;
	let inCharacterClass = false;
	while (i < source.length) {
		if (source[i] === '\\') {
			i += 2;
		} else if (source[i] === '[') {
			inCharacterClass = true;
			i++;
		} else if (source[i] === ']') {
			inCharacterClass = false;
			i++;
		} else if (source[i] === '/' && !inCharacterClass) {
			i++;
			while (i < source.length && /[a-z]/i.test(source[i])) i++;
			return i;
		} else if (source[i] === '\n') {
			// A regular expression literal never spans lines; stop rather than run away on
			// malformed input.
			return i;
		} else {
			i++;
		}
	}
	return i;
}

// The keywords after which a `/` begins a regular expression rather than a division.
const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

/**
 * Replace `search` with `replacement`, but only at occurrences that are part of actual code;
 * occurrences inside string literals, template literals, comments or regular expressions are left
 * verbatim, returning the rewritten source and the number of code occurrences replaced.
 *
 * The extension embeds the sources of the temporary editor scripts it writes for `git rebase -i`
 * as string literals (they must run standalone under plain Node when git invokes them); the
 * previous blanket replace rewrote their `require("fs")` into a call to the requireWithFallback
 * helper injected below, which is undefined in those standalone scripts — every reword of a
 * non-HEAD commit then failed with "ReferenceError: requireWithFallback is not defined".
 */
function replaceInCode(source, search, replacement) {
	let output = '';
	let count = 0;
	let i = 0;
	// The last significant character / identifier copied as code, used to tell a division from
	// the start of a regular expression literal.
	let lastCodeChar = '';
	let lastCodeWord = '';

	while (i < source.length) {
		const c = source[i];
		if (c === '\'' || c === '"') {
			const end = skipStringLiteral(source, i);
			output += source.slice(i, end);
			i = end;
			lastCodeChar = c;
			lastCodeWord = '';
		} else if (c === '`') {
			const end = skipTemplateLiteral(source, i);
			output += source.slice(i, end);
			i = end;
			lastCodeChar = c;
			lastCodeWord = '';
		} else if (c === '/' && source[i + 1] === '/') {
			let end = i;
			while (end < source.length && source[end] !== '\n') end++;
			output += source.slice(i, end);
			i = end; // the newline itself is copied as plain code
		} else if (c === '/' && source[i + 1] === '*') {
			let end = source.indexOf('*/', i + 2);
			end = end === -1 ? source.length : end + 2;
			output += source.slice(i, end);
			i = end;
		} else if (c === '/') {
			const startsRegularExpression =
				lastCodeChar !== ')' && lastCodeChar !== ']' && lastCodeChar !== '\'' && lastCodeChar !== '"' && lastCodeChar !== '`' &&
				(!IDENTIFIER_PART.test(lastCodeChar) || (!/^[0-9]/.test(lastCodeWord) && REGEX_PRECEDING_KEYWORDS.has(lastCodeWord)));
			if (startsRegularExpression) {
				const end = skipRegularExpression(source, i);
				output += source.slice(i, end);
				i = end;
				lastCodeChar = '/';
				lastCodeWord = '';
			} else {
				output += c;
				i++;
				lastCodeChar = c;
				lastCodeWord = '';
			}
		} else if (source.startsWith(search, i) && lastCodeChar !== '.') {
			output += replacement;
			i += search.length;
			count++;
			lastCodeChar = replacement[replacement.length - 1];
			lastCodeWord = '';
		} else {
			output += c;
			i++;
			if (!/\s/.test(c)) {
				if (IDENTIFIER_PART.test(c)) {
					lastCodeWord = IDENTIFIER_PART.test(lastCodeChar) ? lastCodeWord + c : c;
				} else {
					lastCodeWord = '';
				}
				lastCodeChar = c;
			}
		}
	}
	return { text: output, count: count };
}

// Adjust any scripts that require the Node.js File System Module to use the Node.js version (as Electron overrides the fs module with its own version of the module)
fs.readdirSync(OUT_DIRECTORY).forEach((fileName) => {
	if (fileName.endsWith('.js')) {
		const scriptFilePath = path.join(OUT_DIRECTORY, fileName);
		const mapFilePath = scriptFilePath + '.map';

		let script = fs.readFileSync(scriptFilePath).toString();
		const adjusted = replaceInCode(script, 'require("fs")', 'requireWithFallback("original-fs", "fs")');
		if (adjusted.count > 0) {
			// Adjust the requirement (the helper is undefined until injected, and the injection
			// point is the directive every compiled module starts with)
			adjusted.text = adjusted.text.replace('"use strict";', '"use strict";\r\nfunction requireWithFallback(electronModule, nodeModule) { try { return require(electronModule); } catch (err) {} return require(nodeModule); }');
			fs.writeFileSync(scriptFilePath, adjusted.text);

			// Adjust the mapping file, as we added requireWithFallback on a new line at the start of the file.
			let data = JSON.parse(fs.readFileSync(mapFilePath).toString());
			data.mappings = ';' + data.mappings;
			fs.writeFileSync(mapFilePath, JSON.stringify(data));
		}
	}
});

// Copy the askpass shell scripts to the output directory
fs.readdirSync(path.join(SRC_DIRECTORY, ASKPASS_DIRECTORY)).forEach((fileName) => {
	if (fileName.endsWith('.sh')) {
		// If the file is a shell script, read its contents and write it to the output directory
		const scriptContents = fs.readFileSync(path.join(SRC_DIRECTORY, ASKPASS_DIRECTORY, fileName)).toString();
		fs.writeFileSync(path.join(OUT_DIRECTORY, ASKPASS_DIRECTORY, fileName), scriptContents);
	}
});
