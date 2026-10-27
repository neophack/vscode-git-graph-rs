/**
 * The inline text formatter: turns a commit subject / message / tag message into markup - commit
 * hash links, URLs, issue links, emoji shortcodes and (when the Markdown setting is on) inline
 * code and emphasis. Every piece of the input that is not one of those is escaped.
 */

import { escapeHtml, raw, SafeHtml } from '../../common/html';
import * as GG from '../../common/protocol';
import { generateIssueLinkFromMatch, IssueLinking, parseIssueLinkingConfig } from './issueLinking';

export const CLASS_EXTERNAL_URL = 'externalUrl';
export const CLASS_INTERNAL_URL = 'internalUrl';

/** Is an element an external or internal URL. */
export function isUrlElem(elem: Element) {
	return elem.classList.contains(CLASS_EXTERNAL_URL) || elem.classList.contains(CLASS_INTERNAL_URL);
}

/** Is an element an external URL. */
export function isExternalUrlElem(elem: Element) {
	return elem.classList.contains(CLASS_EXTERNAL_URL);
}

/** Is an element an internal URL (a commit hash link). */
export function isInternalUrlElem(elem: Element) {
	return elem.classList.contains(CLASS_INTERNAL_URL);
}

function escapeText(text: string) {
	return escapeHtml(text).html;
}

const enum NodeType {
	Asterisk,
	Code,
	CommitHash,
	DoubleAsterisk,
	DoubleUnderscore,
	Emoji,
	Plain,
	Root,
	Underscore,
	Url
}

interface BaseNode {
	type: NodeType;
	start: number;
	end: number;
	contains: Node[]
}

interface BaseValueNode extends BaseNode {
	value: string;
}

interface AsteriskNode extends BaseNode {
	type: NodeType.Asterisk | NodeType.DoubleAsterisk;
}

interface CodeNode extends BaseValueNode {
	type: NodeType.Code;
}

interface CommitHashNode extends BaseNode {
	type: NodeType.CommitHash;
	commit: string;
}

interface EmojiNode extends BaseNode {
	type: NodeType.Emoji;
	emoji: string;
}

interface PlainNode extends BaseValueNode {
	type: NodeType.Plain;
}

interface UnderscoreNode extends BaseNode {
	type: NodeType.Underscore | NodeType.DoubleUnderscore;
}

interface UrlNode extends BaseNode {
	type: NodeType.Url;
	url: string;
	displayText: string;
}

interface RootNode extends BaseNode {
	type: NodeType.Root;
}

type Node = AsteriskNode | CodeNode | CommitHashNode | EmojiNode | PlainNode | RootNode | UnderscoreNode | UrlNode;

const enum EmphasisDelimiterType {
	Asterisk = '*',
	Underscore = '_'
}

interface EmphasisDelimiter {
	index: number;
	run: number;
}

interface EmphasisRun {
	type: EmphasisDelimiterType;
	size: number;
	open: boolean;
	close: boolean;
	both: boolean;
}

interface BacktickDelimiter {
	index: number;
	run: string;
}

/** Which kinds of formatting a TextFormatter performs (each defaults to off). */
export interface TextFormatterConfig {
	commits?: boolean;
	emoji?: boolean;
	issueLinking?: boolean;
	markdown?: boolean;
	multiline?: boolean;
	urls?: boolean;
}

/**
 * Parses text, and produces formatted markup for the Git Graph View.
 */
export class TextFormatter {
	private readonly config: Readonly<{
		commits: boolean,
		emoji: boolean,
		issueLinking: boolean,
		markdown: boolean,
		multiline: boolean,
		urls: boolean
	}>;
	private readonly commits: ReadonlyArray<GG.GitCommit>;
	private readonly issueLinking: IssueLinking | null = null;

	private static readonly BACKTICK_REGEXP: RegExp = /(\\*)(`+)/gu;
	private static readonly BACKSLASH_ESCAPE_REGEXP: RegExp = /\\[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/gu;
	private static readonly COMMIT_REGEXP: RegExp = /\b([0-9a-fA-F]{6,})\b/gu;
	private static readonly EMOJI_REGEXP: RegExp = /:([A-Za-z0-9-_]+):/gu;
	private static readonly EMPHASIS_REGEXP: RegExp = /(\\+|[^*_]?)([*_]+)(.?)/gu;
	private static readonly INDENT_REGEXP: RegExp = /^[ \t]+/u;
	private static readonly PUNCTUATION_REGEXP: RegExp = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1\u00A7\u00AB\u00B6\u00B7\u00BB\u00BF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061E\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]/u;
	private static readonly URL_REGEXP: RegExp = /https?:\/\/\S+[^,.?!'":;\s]/gu;
	private static readonly WHITESPACE_REGEXP: RegExp = /^([\u0009\u000A\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|)$/u;
	private static readonly EMOJI_MAPPINGS: { [shortcode: string]: string } = { 'adhesive_bandage': '🩹', 'alembic': '⚗', 'alien': '👽', 'ambulance': '🚑', 'apple': '🍎', 'arrow_down': '⬇️', 'arrow_up': '⬆️', 'art': '🎨', 'beers': '🍻', 'bento': '🍱', 'bookmark': '🔖', 'books': '📚', 'boom': '💥', 'bug': '🐛', 'building_construction': '🏗', 'bulb': '💡', 'busts_in_silhouette': '👥', 'camera_flash': '📸', 'card_file_box': '🗃', 'card_index': '📇', 'chart_with_upwards_trend': '📈', 'checkered_flag': '🏁', 'children_crossing': '🚸', 'clown_face': '🤡', 'construction': '🚧', 'construction_worker': '👷', 'dizzy': '💫', 'egg': '🥚', 'exclamation': '❗', 'fire': '🔥', 'globe_with_meridians': '🌐', 'goal_net': '🥅', 'green_apple': '🍏', 'green_heart': '💚', 'hammer': '🔨', 'heavy_check_mark': '✔️', 'heavy_minus_sign': '➖', 'heavy_plus_sign': '➕', 'iphone': '📱', 'label': '🏷️', 'lipstick': '💄', 'lock': '🔒', 'loud_sound': '🔊', 'mag': '🔍', 'memo': '📝', 'mute': '🔇', 'new': '🆕', 'ok_hand': '👌', 'package': '📦', 'page_facing_up': '📄', 'passport_control': '🛂', 'pencil': '📝', 'pencil2': '✏️', 'penguin': '🐧', 'poop': '💩', 'pushpin': '📌', 'racehorse': '🐎', 'recycle': '♻️', 'rewind': '⏪', 'robot': '🤖', 'rocket': '🚀', 'rotating_light': '🚨', 'see_no_evil': '🙈', 'seedling': '🌱', 'shirt': '👕', 'sparkles': '✨', 'speech_balloon': '💬', 'tada': '🎉', 'triangular_flag_on_post': '🚩', 'triangular_ruler': '📐', 'truck': '🚚', 'twisted_rightwards_arrows': '🔀', 'video_game': '🎮', 'wastebasket': '🗑', 'whale': '🐳', 'wheel_of_dharma': '☸️', 'wheelchair': '♿️', 'white_check_mark': '✅', 'wrench': '🔧', 'zap': '⚡️' };
	private static readonly ENCLOSING_GROUPS: { [close: string]: string } = { ')': '(', ']': '[', '}': '{', '>': '<', '*': '*', '_': '_' };

	/**
	 * @param commits The commits loaded in the Git Graph View (commit hash links resolve against them).
	 * @param issueLinkingConfig The Issue Linking configuration in effect (the repository's own, else the global one).
	 * @param config Which kinds of formatting are performed.
	 */
	constructor(commits: ReadonlyArray<GG.GitCommit>, issueLinkingConfig: GG.IssueLinkingConfig | null, config: TextFormatterConfig) {
		this.config = Object.assign({ commits: false, emoji: false, issueLinking: false, markdown: false, multiline: false, urls: false }, config);
		this.commits = commits;
		if (this.config.issueLinking) {
			this.issueLinking = parseIssueLinkingConfig(issueLinkingConfig);
		}
	}

	/**
	 * Convert plain text into formatted markup.
	 * @param input The plain text.
	 */
	public format(input: string): SafeHtml {
		return raw(this.formatToString(input));
	}

	private formatToString(input: string) {
		if (this.config.multiline) {
			const html = [], lines = input.split('\n');
			let i, j, match;
			for (i = 0; i < lines.length; i++) {
				if (i > 0) {
					html.push('<br/>');
				}

				j = 0;
				if (match = lines[i].match(TextFormatter.INDENT_REGEXP)) {
					for (j = 0; j < match[0].length; j++) {
						html.push(match[0][j] === '\t' ? '&nbsp;&nbsp;&nbsp;&nbsp;' : '&nbsp;');
					}
				}

				html.push(this.formatLine(j > 0 ? lines[i].substring(j) : lines[i]));
			}
			return html.join('');
		} else {
			return this.formatLine(input);
		}
	}

	/**
	 * Convert a single line of input text into formatted HTML.
	 * @param input The input plain text.
	 * @returns The formatted HTML.
	 */
	private formatLine(input: string) {
		const tree: RootNode = {
			type: NodeType.Root,
			start: -1,
			end: input.length,
			contains: []
		};

		let match: RegExpExecArray | null;

		if (this.config.markdown) {
			// Backtick Code Blocks
			const backTickStack: BacktickDelimiter[] = [];
			TextFormatter.BACKTICK_REGEXP.lastIndex = 0;
			while (match = TextFormatter.BACKTICK_REGEXP.exec(input)) {
				const backtick = { index: match.index + match[1].length, run: match[2] };
				let i;
				if (backTickStack.length === 0) {
					if (match[1].length % 2 === 1) {
						if (backtick.run.length > 1) {
							backtick.index++;
							backtick.run = backtick.run.substring(1);
						} else {
							continue;
						}
					}
				}

				for (i = backTickStack.length - 1; i >= 0; i--) {
					if (backTickStack[i].run === backtick.run) {
						let value = input.substring(backTickStack[i].index + backtick.run.length, backtick.index);
						if (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value)) {
							value = value.substring(1, value.length - 1);
						}
						TextFormatter.insertIntoTree(tree, {
							type: NodeType.Code,
							start: backTickStack[i].index,
							end: backtick.index + backtick.run.length - 1,
							value: value,
							contains: []
						});
						backTickStack.splice(i);
						break;
					}
				}
				if (i === -1) {
					backTickStack.push(backtick);
				}
			}
		}

		if (this.config.urls) {
			// Url Links
			TextFormatter.URL_REGEXP.lastIndex = 0;
			while (match = TextFormatter.URL_REGEXP.exec(input)) {
				let url = match[0];
				const suffix = url.substring(url.length - 1);
				if (match.index > 0 && typeof TextFormatter.ENCLOSING_GROUPS[suffix] === 'string' && input.substring(match.index - 1, match.index) === TextFormatter.ENCLOSING_GROUPS[suffix]) {
					url = url.substring(0, url.length - 1);
					TextFormatter.URL_REGEXP.lastIndex--;
				}
				TextFormatter.insertIntoTreeIfNoOverlap(tree, {
					type: NodeType.Url,
					start: match.index,
					end: TextFormatter.URL_REGEXP.lastIndex - 1,
					url: url,
					displayText: url,
					contains: []
				});
			}
		}

		if (this.issueLinking !== null) {
			// Issue Links
			this.issueLinking.regexp.lastIndex = 0;
			while (match = this.issueLinking.regexp.exec(input)) {
				if (match[0].length === 0) break;
				TextFormatter.insertIntoTreeIfNoOverlap(tree, {
					type: NodeType.Url,
					start: match.index,
					end: this.issueLinking.regexp.lastIndex - 1,
					url: generateIssueLinkFromMatch(match, this.issueLinking),
					displayText: match[0],
					contains: []
				});
			}
		}

		if (this.config.commits) {
			// Commit Hash Links
			TextFormatter.COMMIT_REGEXP.lastIndex = 0;
			while (match = TextFormatter.COMMIT_REGEXP.exec(input)) {
				const hash = match[0].toLowerCase();
				const commit = this.commits.find((commit) => commit.hash.toLowerCase().startsWith(hash));
				if (commit) {
					TextFormatter.insertIntoTreeIfNoOverlap(tree, {
						type: NodeType.CommitHash,
						commit: commit.hash,
						start: match.index,
						end: TextFormatter.COMMIT_REGEXP.lastIndex - 1,
						contains: []
					});
				}
			}
		}

		if (this.config.markdown) {
			// Backslash Characters
			TextFormatter.BACKSLASH_ESCAPE_REGEXP.lastIndex = 0;
			while (match = TextFormatter.BACKSLASH_ESCAPE_REGEXP.exec(input)) {
				TextFormatter.insertIntoTreeIfNoOverlap(tree, {
					type: NodeType.Plain,
					start: match.index,
					end: TextFormatter.BACKSLASH_ESCAPE_REGEXP.lastIndex - 1,
					value: match[0].substring(1),
					contains: []
				});
			}
		}

		if (this.config.emoji) {
			// Emoji Shortcode
			TextFormatter.EMOJI_REGEXP.lastIndex = 0;
			while (match = TextFormatter.EMOJI_REGEXP.exec(input)) {
				if (typeof TextFormatter.EMOJI_MAPPINGS[match[1]] === 'string') {
					TextFormatter.insertIntoTreeIfNoOverlap(tree, {
						type: NodeType.Emoji,
						start: match.index,
						end: TextFormatter.EMOJI_REGEXP.lastIndex - 1,
						emoji: TextFormatter.EMOJI_MAPPINGS[match[1]],
						contains: []
					});
				}
			}
		}

		if (this.config.markdown) {
			// Emphasis
			const emphasisTokens: EmphasisDelimiter[] = [], emphasisRuns: EmphasisRun[] = [];
			let runLength: number, whitespaceBefore: boolean, whitespaceAfter: boolean, punctuationBefore: boolean, punctuationAfter: boolean, isLeft: boolean, isRight: boolean, isOpen: boolean, isClosed: boolean;
			TextFormatter.EMPHASIS_REGEXP.lastIndex = 0;
			while (match = TextFormatter.EMPHASIS_REGEXP.exec(input)) {
				let prev = 0, cur = 1, next = 2, index = match.index;
				const seq = [match[1]];
				seq.push(...match[2].split(''));
				seq.push(match[3]);

				if (seq[0].startsWith('\\')) {
					if (seq[0].length % 2 === 1) {
						index += seq[0].length;
						seq.shift();
					} else {
						index += seq[0].length - 1;
						seq[0] = '\\';
					}
				}

				index += seq[prev].length;
				while (cur < seq.length - 1) {
					while (next < seq.length - 1 && seq[cur] === seq[next]) next++;

					runLength = next - cur;
					whitespaceBefore = TextFormatter.WHITESPACE_REGEXP.test(seq[prev]);
					whitespaceAfter = TextFormatter.WHITESPACE_REGEXP.test(seq[next]);
					punctuationBefore = TextFormatter.PUNCTUATION_REGEXP.test(seq[prev]);
					punctuationAfter = TextFormatter.PUNCTUATION_REGEXP.test(seq[next]);
					isLeft = !whitespaceAfter && (!punctuationAfter || (punctuationAfter && (whitespaceBefore || punctuationBefore)));
					isRight = !whitespaceBefore && (!punctuationBefore || (punctuationBefore && (whitespaceAfter || punctuationAfter)));

					if (seq[cur] === EmphasisDelimiterType.Asterisk) {
						isOpen = isLeft;
						isClosed = isRight;
					} else {
						isOpen = isLeft && (!isRight || punctuationBefore);
						isClosed = isRight && (!isLeft || punctuationAfter);
					}

					for (let i = 0; i < runLength; i++) {
						if (!TextFormatter.isInTree(tree, index + i, index + i)) {
							emphasisTokens.push({ index: index + i, run: emphasisRuns.length });
						}
					}

					emphasisRuns.push({
						type: <EmphasisDelimiterType>seq[cur],
						size: runLength,
						open: isOpen,
						close: isClosed,
						both: isOpen && isClosed
					});

					index += runLength;
					prev = cur;
					cur = next;
					next = cur + 1;
				}

				TextFormatter.EMPHASIS_REGEXP.lastIndex -= seq[seq.length - 1].length;
			}
			const emphasisStack: EmphasisDelimiter[] = [];
			let stackMatch: number;
			for (let i = 0; i < emphasisTokens.length; i++) {
				const delimiter = emphasisTokens[i];
				const run = emphasisRuns[delimiter.run];
				if (run.close && (stackMatch = TextFormatter.findOpenEmphasis(delimiter, run, emphasisRuns, emphasisStack)) > -1) {
					TextFormatter.insertIntoTree(tree, {
						type: emphasisRuns[emphasisStack[stackMatch].run].type === EmphasisDelimiterType.Asterisk ? NodeType.Asterisk : NodeType.Underscore,
						start: emphasisStack[stackMatch].index,
						end: delimiter.index,
						contains: []
					});
					emphasisStack.splice(stackMatch);
				} else if (run.open) {
					emphasisStack.push(delimiter);
				}
			}
			TextFormatter.combineNestedEmphasis(tree);
		}

		// Generate HTML
		const html = [];
		let nextHtmlIndex = 0;
		const rec = (node: Node) => {
			if (nextHtmlIndex < node.start) {
				html.push(escapeText(input.substring(nextHtmlIndex, node.start)));
			}
			switch (node.type) {
				case NodeType.Asterisk:
				case NodeType.Underscore:
					nextHtmlIndex = node.start + 1;
					html.push('<em>');
					node.contains.forEach(rec);
					if (nextHtmlIndex < node.end) {
						html.push(escapeText(input.substring(nextHtmlIndex, node.end)));
					}
					html.push('</em>');
					break;
				case NodeType.DoubleAsterisk:
				case NodeType.DoubleUnderscore:
					nextHtmlIndex = node.start + 2;
					html.push('<strong>');
					node.contains.forEach(rec);
					if (nextHtmlIndex < node.end - 1) {
						html.push(escapeText(input.substring(nextHtmlIndex, node.end - 1)));
					}
					html.push('</strong>');
					break;
				case NodeType.Plain:
					html.push(escapeText(node.value));
					break;
				case NodeType.Code:
					html.push('<code>', escapeText(node.value), '</code>');
					break;
				case NodeType.CommitHash:
					html.push('<span class="', CLASS_INTERNAL_URL, '" data-type="commit" data-value="', escapeText(node.commit), '" tabindex="-1">', escapeText(input.substring(node.start, node.end + 1)), '</span>');
					break;
				case NodeType.Url:
					html.push('<a class="', CLASS_EXTERNAL_URL, '" href="', escapeText(node.url), '" tabindex="-1">', escapeText(node.displayText), '</a>');
					break;
				case NodeType.Emoji:
					html.push(escapeText(node.emoji));
					break;
				case NodeType.Root:
					// The root is the tree itself, never one of its children.
					break;
			}
			nextHtmlIndex = node.end + 1;
		};
		tree.contains.forEach(rec);
		if (nextHtmlIndex < input.length) {
			html.push(escapeText(input.substring(nextHtmlIndex)));
		}
		return html.join('');
	}

	/**
	 * Register user-defined custom emoji mappings.
	 * @param mappings The user-defined mappings.
	 */
	public static registerCustomEmojiMappings(mappings: ReadonlyArray<GG.CustomEmojiShortcodeMapping>) {
		const validShortcodeRegExp = /^:[A-Za-z0-9-_]+:$/;
		for (let i = 0; i < mappings.length; i++) {
			if (validShortcodeRegExp.test(mappings[i].shortcode) && typeof mappings[i].emoji === 'string' && mappings[i].emoji.length > 0 && mappings[i].emoji.length <= 16) {
				TextFormatter.EMOJI_MAPPINGS[mappings[i].shortcode.substring(1, mappings[i].shortcode.length - 1)] = mappings[i].emoji;
			}
		}
	}

	/**
	 * Find the matching open emphasis delimiter in a stack.
	 * @param delimiter The closing emphasis.
	 * @param run The emphasis run containing the closing emphasis.
	 * @param runs An array of all known emphasis runs.
	 * @param stack The stack of open emphasis delimiters.
	 * @returns The stack index of the matching open emphasis delimiter, or -1 if no match could be found.
	 */
	private static findOpenEmphasis(delimiter: EmphasisDelimiter, run: EmphasisRun, runs: EmphasisRun[], stack: EmphasisDelimiter[]) {
		let i = stack.length - 1;
		while (i >= 0) {
			if (stack[i].run !== delimiter.run && runs[stack[i].run].type === run.type && (!(runs[stack[i].run].both || run.both) || ((runs[stack[i].run].size + run.size) % 3 !== 0) || ((runs[stack[i].run].size % 3 === 0) && (run.size % 3 === 0)))) {
				return i;
			}
			i--;
		}
		return -1;
	}

	/**
	 * Recursively traverse the tree, and combine directly nested emphasis (asterisks & underscores) into double asterisks and double underscores where possible.
	 * @param tree The tree to traverse.
	 */
	private static combineNestedEmphasis(tree: Node) {
		tree.contains.forEach(TextFormatter.combineNestedEmphasis);
		if (tree.contains.length === 1 && tree.type === tree.contains[0].type && (tree.type === NodeType.Asterisk || tree.type === NodeType.Underscore) && tree.start + 1 === tree.contains[0].start && tree.contains[0].end === tree.end - 1) {
			tree.type = tree.type === NodeType.Asterisk
				? NodeType.DoubleAsterisk
				: NodeType.DoubleUnderscore;
			tree.contains = tree.contains[0].contains;
		}
	}

	/**
	 * Inserts a node into a tree of nodes (according to it's start and end).
	 * @param tree The tree the node should be inserted in.
	 * @param node The node to insert.
	 */
	private static insertIntoTree(tree: Node, node: Node) {
		let firstChildIndexOfNode = -1, lastChildIndexOfNode = -1, curNode;
		for (let i = 0; i < tree.contains.length; i++) {
			curNode = tree.contains[i];
			if (node.start < curNode.start && firstChildIndexOfNode === -1) {
				firstChildIndexOfNode = i;
			}
			if (curNode.end < node.end) {
				lastChildIndexOfNode = i;
			} else {
				break;
			}
		}
		if (firstChildIndexOfNode === -1) {
			tree.contains.push(node);
		} else if (lastChildIndexOfNode === -1) {
			tree.contains.unshift(node);
		} else {
			node.contains = tree.contains.slice(firstChildIndexOfNode, lastChildIndexOfNode + 1);
			tree.contains.splice(firstChildIndexOfNode, lastChildIndexOfNode - firstChildIndexOfNode + 1, node);
		}
	}

	/**
	 * Inserts a node into a tree of nodes (according to it's start and end), only if it doesn't overlap with an existing node in the tree.
	 * @param tree The tree the node should be inserted in.
	 * @param node The node to insert.
	 */
	private static insertIntoTreeIfNoOverlap(tree: RootNode, node: Node) {
		let curNode: Node, insertAtIndex = tree.contains.length;
		for (let i = 0; i < tree.contains.length; i++) {
			curNode = tree.contains[i];
			if ((curNode.start <= node.start && node.start <= curNode.end) || (curNode.start <= node.end && node.end <= curNode.end) || (node.start <= curNode.start && curNode.end <= node.end)) {
				return;
			} else if (node.end < curNode.start) {
				insertAtIndex = i;
				break;
			}
		}
		tree.contains.splice(insertAtIndex, 0, node);
	}

	/**
	 * Is a range included (partially or completely) within a tree.
	 * @param tree The tree to check.
	 * @param start The index defining the start of the range.
	 * @param end The index defining the end of the range.
	 * @returns TRUE => The range overlaps with node(s) in the tree, FALSE => There is no overlap between the range and any node in the tree.
	 */
	private static isInTree(tree: RootNode, start: number, end: number) {
		return tree.contains.some((node) => (node.start <= start && start <= node.end) || (node.start <= end && end <= node.end) || (start <= node.start && node.end <= end));
	}
}


