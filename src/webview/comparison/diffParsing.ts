/**
 * The pure half of the diff view: language detection, word-level (token) diffing between the two
 * sides of a modified line, splicing <mark> tags into the highlighter's HTML, and parsing a
 * unified diff into row descriptors. Everything here is a function of its inputs (the highlighter
 * is injected), so the parsing is testable without a DOM.
 */

import { escapeHtml, raw, SafeHtml } from '../common/html';

/** Highlights one line of code as markup, or NULL when the caller has no highlighter. */
export type Highlighter = (text: string, language: string | null) => SafeHtml;

/** One parsed row of a unified diff, highlighting and word-diff marking already applied - both
 *  are independent of whether the row ends up laid out side-by-side or inline, so a width-only
 *  relayout on resize costs no re-highlighting or re-diffing, just rearranging the markup. */
export type DiffRow =
	| { type: 'hunk'; html: SafeHtml }
	| { type: 'ctx'; o: number; n: number; html: SafeHtml }
	| { type: 'add'; n: number; html: SafeHtml }
	| { type: 'del'; o: number; html: SafeHtml }
	| { type: 'mod'; o: number; n: number; oldHtml: SafeHtml; newHtml: SafeHtml };

const LANG_BY_EXT: { [extension: string]: string } = {
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
	ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
	py: 'python', pyw: 'python', pyi: 'python',
	rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
	c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
	cs: 'csharp', php: 'php', rb: 'ruby',
	sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
	json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml',
	xml: 'xml', html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml',
	css: 'css', scss: 'scss', less: 'less',
	md: 'markdown', markdown: 'markdown', sql: 'sql',
	ini: 'ini', cfg: 'ini', toml: 'ini', conf: 'ini',
	diff: 'diff', patch: 'diff', dart: 'dart', scala: 'scala',
	pl: 'perl', pm: 'perl', lua: 'lua', m: 'objectivec', mm: 'objectivec',
	mk: 'makefile', graphql: 'graphql', gql: 'graphql', proto: 'protobuf'
};

export function detectLanguage(filePath: string): string | null {
	const name = (filePath.split('/').pop() || '').toLowerCase();
	if (name === 'dockerfile') return 'dockerfile';
	if (name === 'makefile') return 'makefile';
	const dot = name.lastIndexOf('.');
	return dot > 0 ? (LANG_BY_EXT[name.substring(dot + 1)] || null) : null;
}

function tokenize(text: string): string[] {
	return text.match(/[A-Za-z0-9_]+|[^\S\n]+|./gs) || [];
}

/** Bounds the O(n*m) LCS table: beyond it (a pathologically long, e.g. minified, line) the whole
 *  line is just treated as changed rather than spending seconds diffing it word by word. */
const WORD_DIFF_MAX_PRODUCT = 40000;

interface ChangeRange { start: number; end: number; }

function tokenChangeRanges(oldText: string, newText: string): { oldRanges: ChangeRange[], newRanges: ChangeRange[] } {
	const oldTokens = tokenize(oldText), newTokens = tokenize(newText);
	const n = oldTokens.length, m = newTokens.length;
	if (n * m > WORD_DIFF_MAX_PRODUCT) {
		return {
			oldRanges: oldText.length > 0 ? [{ start: 0, end: oldText.length }] : [],
			newRanges: newText.length > 0 ? [{ start: 0, end: newText.length }] : []
		};
	}
	const dp = new Array<Int32Array>(n + 1);
	for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = oldTokens[i] === newTokens[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const oldChanged = new Array<boolean>(n).fill(true), newChanged = new Array<boolean>(m).fill(true);
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (oldTokens[i] === newTokens[j]) {
			oldChanged[i] = false;
			newChanged[j] = false;
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return { oldRanges: changedTokenRanges(oldTokens, oldChanged), newRanges: changedTokenRanges(newTokens, newChanged) };
}

/** Converts a per-token changed[] flag array into merged character ranges within the joined text.
 *  Whitespace-only tokens never enter a range: a change that is entirely whitespace (indent or
 *  trailing-space edits) would otherwise render the <mark> tint as a bare coloured bar with no
 *  visible text under it - VS Code's diff editor shows no word highlight for such lines either. */
function changedTokenRanges(tokens: ReadonlyArray<string>, changed: ReadonlyArray<boolean>): ChangeRange[] {
	const ranges: ChangeRange[] = [];
	let offset = 0, rangeStart = -1;
	for (let i = 0; i < tokens.length; i++) {
		if (changed[i] && !/^\s+$/.test(tokens[i])) {
			if (rangeStart === -1) rangeStart = offset;
		} else if (rangeStart !== -1) {
			ranges.push({ start: rangeStart, end: offset });
			rangeStart = -1;
		}
		offset += tokens[i].length;
	}
	if (rangeStart !== -1) ranges.push({ start: rangeStart, end: offset });
	return ranges;
}

/** Splices <mark> tags into the highlighter's HTML output at plain-text character offsets,
 *  without disturbing its own tags/entities: it walks the HTML counting only characters that are
 *  actual text content, skipping over "<...>" tags and treating "&...;" entities as one character
 *  each. A range can end up straddling one of the highlighter's <span> boundaries (a word-diff
 *  range rarely lines up with a token boundary); the browser's HTML parser silently re-nests
 *  overlapping tags like that into valid markup once this is assigned to the row's cell. */
export function markRanges(highlighted: string, ranges: ReadonlyArray<ChangeRange>): string {
	if (ranges.length === 0) return highlighted;
	const events: Array<{ pos: number, text: string }> = [];
	for (const r of ranges) {
		events.push({ pos: r.start, text: '<mark>' });
		events.push({ pos: r.end, text: '</mark>' });
	}
	let out = '', pos = 0, ei = 0, i = 0;
	while (i < highlighted.length) {
		while (ei < events.length && events[ei].pos === pos) { out += events[ei].text; ei++; }
		const ch = highlighted[i];
		if (ch === '<') {
			const close = highlighted.indexOf('>', i);
			out += highlighted.slice(i, close + 1);
			i = close + 1;
		} else if (ch === '&') {
			const semi = highlighted.indexOf(';', i);
			if (semi === -1) { out += ch; i++; pos++; } else { out += highlighted.slice(i, semi + 1); i = semi + 1; pos++; }
		} else {
			out += ch;
			i++;
			pos++;
		}
	}
	while (ei < events.length) { out += events[ei].text; ei++; }
	return out;
}

/** The highlighter of the page: the vendored highlight.js the host loads before this bundle,
 *  falling back to plain escaped text if the script failed to load or knows no matching language. */
export function pageHighlighter(): Highlighter {
	const hljs = (<{ hljs?: Hljs }>window).hljs;
	if (hljs === undefined) return (text) => escapeHtml(text);
	return (text, language) => {
		try {
			if (language !== null && hljs.getLanguage(language)) return raw(hljs.highlight(text, { language: language, ignoreIllegals: true }).value);
			return raw(hljs.highlightAuto(text).value);
		} catch (e) {
			return escapeHtml(text);
		}
	};
}

interface Hljs {
	getLanguage(name: string): unknown;
	highlight(code: string, options: { language: string, ignoreIllegals: boolean }): { value: string };
	highlightAuto(code: string): { value: string };
}

/** Parse a unified diff into row descriptors (not DOM yet - see the diff view's layout). Consecutive
 *  removed/added lines within one hunk are paired up as "modified" descriptors (with the exact
 *  changed words marked via word-level diffing) instead of being kept as separate one-sided lines -
 *  the same line-replacement VS Code's own diff editor (and GitHub) work with. */
export function parseDiff(diffText: string, language: string | null, highlight: Highlighter): { rows: DiffRow[], binary: boolean } {
	const rowsOut: DiffRow[] = [];
	let oldLine = 0, newLine = 0;
	let pendingDel: string[] = [], pendingAdd: string[] = [];
	const flushChangeBlock = () => {
		const pairCount = Math.min(pendingDel.length, pendingAdd.length);
		for (let k = 0; k < pairCount; k++) {
			const wordDiff = tokenChangeRanges(pendingDel[k], pendingAdd[k]);
			rowsOut.push({
				type: 'mod', o: oldLine++, n: newLine++,
				oldHtml: raw(markRanges(highlight(pendingDel[k], language).html, wordDiff.oldRanges)),
				newHtml: raw(markRanges(highlight(pendingAdd[k], language).html, wordDiff.newRanges))
			});
		}
		for (let k = pairCount; k < pendingDel.length; k++) rowsOut.push({ type: 'del', o: oldLine++, html: highlight(pendingDel[k], language) });
		for (let k = pairCount; k < pendingAdd.length; k++) rowsOut.push({ type: 'add', n: newLine++, html: highlight(pendingAdd[k], language) });
		pendingDel = [];
		pendingAdd = [];
	};
	const lines = diffText.split('\n');
	let binary = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) binary = true;
		const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (hunk !== null) {
			flushChangeBlock();
			rowsOut.push({ type: 'hunk', html: escapeHtml(line) });
			oldLine = parseInt(hunk[1], 10);
			newLine = parseInt(hunk[3], 10);
			continue;
		}
		if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
			line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('old mode') || line.startsWith('new mode') ||
			line.startsWith('similarity index') || line.startsWith('rename ') || line.startsWith('copy ') || line.startsWith('\\ No newline') || hunk === null && !line.startsWith(' ') && !line.startsWith('+') && !line.startsWith('-')) {
			continue;
		}
		if (line.startsWith('+')) {
			pendingAdd.push(line.substring(1));
		} else if (line.startsWith('-')) {
			pendingDel.push(line.substring(1));
		} else {
			flushChangeBlock();
			rowsOut.push({ type: 'ctx', o: oldLine++, n: newLine++, html: highlight(line.substring(1), language) });
		}
	}
	flushChangeBlock();
	return { rows: rowsOut, binary: binary };
}
