/**
 * The new path of one `diff --git` section: the file the section belongs to, matched exactly so
 * that a file whose name is a prefix of another's cannot catch its section.
 *
 * Git C-quotes a path containing quotes, backslashes or control characters (spaces and, with
 * `core.quotepath=false`, non-ASCII stay raw), and quotes each side of the header on its own — so
 * a header carries any of the four combinations of quoted and raw sides. A raw path may itself
 * contain " b/", which leaves the header line genuinely ambiguous (`a/x b/y b/x b/y` is one file
 * named `x b/y`, not the file `y`); the extended header lines below it name the sides one per
 * line, so they resolve what the header alone cannot.
 */

/** The new path of the one `diff --git` section that belongs to `file`, or NULL when none does. */
export function diffSectionNewPath(section: string): string | null {
	const end = section.indexOf('\n');
	const candidates = diffHeaderPaths(end === -1 ? section : section.substring(0, end));
	if (candidates.length === 1) return candidates[0].newPath;
	if (candidates.length === 0) return null;
	const named = diffSectionNamedNewPath(section);
	if (named !== null) return named;
	// Nothing named the sides (a mode-only change of an ambiguous path): the split that gives both
	// sides the same name is the one Git itself prefers when re-reading its own headers.
	const same = candidates.find((candidate) => candidate.oldPath === candidate.newPath);
	return (same !== undefined ? same : candidates[0]).newPath;
}

/** Every way the two sides of a `diff --git` header line can be split (see {@link diffSectionNewPath}). */
function diffHeaderPaths(header: string): { oldPath: string; newPath: string }[] {
	const prefix = 'diff --git ';
	if (!header.startsWith(prefix)) return [];
	const body = header.substring(prefix.length);
	const paths: { oldPath: string; newPath: string }[] = [];
	if (body.charAt(0) === '"') {
		// A quoted old side ends at its own closing quote, so the split isn't ambiguous
		const closing = diffClosingQuote(body);
		if (closing === -1 || body.charAt(closing + 1) !== ' ') return [];
		const oldPath = diffSidePath(body.substring(0, closing + 1), 'a/');
		const newPath = diffSidePath(body.substring(closing + 2), 'b/');
		return oldPath !== null && newPath !== null ? [{ oldPath: oldPath, newPath: newPath }] : [];
	}
	for (let space = body.indexOf(' '); space !== -1; space = body.indexOf(' ', space + 1)) {
		const oldPath = diffSidePath(body.substring(0, space), 'a/');
		const newPath = diffSidePath(body.substring(space + 1), 'b/');
		if (oldPath !== null && newPath !== null) paths.push({ oldPath: oldPath, newPath: newPath });
	}
	return paths;
}

/**
 * The new path as named by the extended header lines of a section (`rename to` / `copy to`, or the
 * `+++` line), each of which carries one path that runs to the end of its line.
 * @returns The path, or NULL if no line named it.
 */
function diffSectionNamedNewPath(section: string): string | null {
	const lines = section.split('\n');
	let oldPath: string | null = null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('@@')) break; // the hunks: every extended header line is above them
		if (line.startsWith('rename to ')) return diffNamedPath(line.substring(10));
		if (line.startsWith('copy to ')) return diffNamedPath(line.substring(8));
		if (line.startsWith('--- ')) {
			oldPath = diffSidePath(diffTrimTerminator(line.substring(4)), 'a/');
		} else if (line.startsWith('+++ ')) {
			// `+++ /dev/null` — the file was deleted, so both sides of the header name it
			const newPath = diffSidePath(diffTrimTerminator(line.substring(4)), 'b/');
			return newPath !== null ? newPath : oldPath;
		}
	}
	return null;
}

/**
 * Strip the tab Git terminates a raw `---`/`+++` path with when the path contains a space (so
 * that the end of the path is still findable). A path containing a tab is C-quoted instead — a
 * tab is a control character — so a trailing tab on a raw path is always Git's terminator.
 */
function diffTrimTerminator(side: string): string {
	return side.charAt(0) !== '"' && side.endsWith('\t') ? side.substring(0, side.length - 1) : side;
}

/** One `a/`- or `b/`-prefixed side of a header or `---`/`+++` line, unquoted. NULL => not that side. */
function diffSidePath(side: string, prefix: string): string | null {
	if (side.charAt(0) === '"') {
		if (diffClosingQuote(side) !== side.length - 1) return null;
		const path = unquoteCPath(side.substring(1, side.length - 1));
		return path.startsWith(prefix) ? path.substring(prefix.length) : null;
	}
	// Git quotes every path containing a quote, a backslash or a control character, so a raw
	// side that contains one is not a path at all — it is a mis-split of an ambiguous header
	if (/["\\\x00-\x1f\x7f]/.test(side)) return null;
	return side.startsWith(prefix) ? side.substring(prefix.length) : null;
}

/** One unprefixed path naming a whole line (`rename to <path>`), unquoted. */
function diffNamedPath(text: string): string | null {
	if (text.charAt(0) !== '"') return text;
	return diffClosingQuote(text) === text.length - 1 ? unquoteCPath(text.substring(1, text.length - 1)) : null;
}

/** The index of the quote closing the one opened at index 0 of `text` (-1 => unterminated). */
function diffClosingQuote(text: string): number {
	for (let i = 1; i < text.length; i++) {
		const char = text.charAt(i);
		if (char === '\\') i++;
		else if (char === '"') return i;
	}
	return -1;
}

const C_ESCAPES: { [escape: string]: string } = {
	'a': '\x07', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t', 'v': '\v', '\\': '\\', '"': '"'
};

/**
 * Undo Git's C-quoting of a path (the contents of the quotes, prefix included).
 *
 * Octal escapes are the individual bytes of one UTF-8 sequence, so consecutive ones are decoded
 * together rather than each becoming its own character.
 */
function unquoteCPath(quoted: string): string {
	const parts = quoted.match(/\\(?:[0-7]{1,3}|[\s\S])|[^\\]+/g);
	if (parts === null) return quoted;
	let out = '';
	let bytes: number[] = [];
	const flush = () => {
		if (bytes.length > 0) {
			out += Buffer.from(bytes).toString('utf8');
			bytes = [];
		}
	};
	for (const part of parts) {
		if (part.charAt(0) !== '\\') {
			flush();
			out += part;
		} else if (/^\\[0-7]{1,3}$/.test(part)) {
			bytes.push(parseInt(part.substring(1), 8) & 0xff);
		} else {
			flush();
			const escape = part.substring(1);
			out += typeof C_ESCAPES[escape] === 'string' ? C_ESCAPES[escape] : escape;
		}
	}
	flush();
	return out;
}
