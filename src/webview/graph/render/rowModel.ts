/**
 * The row MODEL of the commit table: everything the rows of one render are built from, computed
 * before any DOM is touched. Builds the per-render RowContext (render/commitRow.ts consumes it),
 * the render-wide row seed, and caches the formatted message texts.
 */

import { SafeHtml } from '../../common/html';
import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { TextFormatter } from '../text/textFormatter';
import { RowContext } from './commitRow';

const FORMATTED_TEXT_CACHE_LIMIT = 5000;

/**
 * What one rendered row was built from: the render-wide inputs (a seed string) plus the row's own
 * inputs that live OUTSIDE the commit object. A row whose recorded inputs all match is provably
 * unchanged - its markup would come out identical - so it is kept without building that markup at
 * all. Reference-compared where the store swaps whole objects (the commit, the Gerrit states, the
 * pull requests), flag-compared where it mutates in place (avatars, bodies).
 */
export interface RowBuildInputs {
	/** The render-wide seed (see RowModelFactory.computeRowSeed): layout, config, HEAD, formatters. */
	readonly seed: string;
	/** The commit object the row was built from (its identity covers message, author, refs). */
	readonly commit: GG.GitCommit;
	readonly muted: boolean;
	readonly pinned: boolean;
	/** Was an avatar rendered for the commit's author (the image itself is patched in place). */
	readonly avatarPresent: boolean;
	/** Was an inline body rendered (bodies arrive after the rows, changing the row's markup). */
	readonly bodyPresent: boolean;
	/** The Gerrit state the row's badge was built from (undefined = no badge). */
	readonly gerritState: GG.GerritChangeState | undefined;
	/** Was the badge actually displayed (the fetch limit may hide an existing state). */
	readonly gerritVisible: boolean;
	/** The pull request the row's badge was built from (undefined = no badge). */
	readonly pullRequest: GG.PullRequestInfo | undefined;
	/** The branch-label offset at the vertex (only used when the labels align to the graph). */
	readonly widthAtVertex: number;
}

/**
 * Builds the row model of the commit table: the RowContext each render's rows are built from, the
 * render-wide row seed, and the bounded cache of formatted message texts.
 */
export class RowModelFactory {
	/**
	 * Cache of formatted message texts (keyed by the raw text): commit subjects repeat heavily in
	 * large repositories (merges, reverts, chores), and the regex-heavy formatting is a major
	 * per-row render cost. Bounded, and simply cleared when the bound is exceeded.
	 */
	private readonly formattedTextCache = new Map<string, SafeHtml>();
	private formattedTextCacheSignature = '';

	constructor(private readonly ctx: () => GraphContext) { }

	private get store() {
		return this.ctx().store;
	}

	/**
	 * Context shared by the commit row rendering: computed once per render (full or incremental)
	 * and consumed once per rendered commit row.
	 */
	public createRowContext(): RowContext {
		const ctx = this.ctx(), store = ctx.store, config = store.config;
		const currentHash = store.commits.length > 0 && store.commits[0].hash === UNCOMMITTED ? UNCOMMITTED : store.commitHead;
		const textFormatter = new TextFormatter(store.commits, store.getIssueLinkingConfig(), {
			emoji: true,
			issueLinking: true,
			markdown: config.markdown
		});
		return {
			config: config,
			commits: store.commits,
			commitHead: store.commitHead,
			gitBranchHead: store.gitBranchHead,
			narrow: ctx.layout.isTwoLineRows(),
			colVisibility: ctx.layout.getColumnVisibility(),
			currentHash: currentHash,
			vertexColours: ctx.graph.getVertexColours(),
			widthsAtVertices: config.referenceLabels.branchLabelsAlignedToGraph ? ctx.graph.getWidthsAtVertices() : [],
			mutedCommits: ctx.graph.getMutedCommits(currentHash),
			pinnedCommitHashes: new Set(store.getPinnedCommits().map((pinned) => pinned.hash)),
			gerritStates: store.gerritStates,
			// The Gerrit badges displayable under the fetch limit: computed once per render, so the
			// rows built and the rows reconciled during the same render check the same set
			gerritVisibleChanges: store.getGerritVisibleChanges(),
			pullRequestsByHead: store.pullRequestsByHead,
			avatars: store.avatars,
			commitBodies: ctx.commitBodies.bodies,
			textFormatter: textFormatter,
			formatText: (text) => this.formatText(textFormatter, text)
		};
	}

	private formatText(textFormatter: TextFormatter, text: string): SafeHtml {
		const store = this.store;
		// The cache is only valid for the current formatting configuration (markdown setting and
		// the issue linking configuration): bust it when either changes
		const signature = (store.config.markdown ? '1' : '0') + '|' + JSON.stringify(store.getIssueLinkingConfig());
		if (signature !== this.formattedTextCacheSignature) {
			this.formattedTextCache.clear();
			this.formattedTextCacheSignature = signature;
		}
		const cached = this.formattedTextCache.get(text);
		if (cached !== undefined) return cached;
		const formatted = textFormatter.format(text);
		if (this.formattedTextCache.size >= FORMATTED_TEXT_CACHE_LIMIT) {
			this.formattedTextCache.clear();
		}
		this.formattedTextCache.set(text, formatted);
		return formatted;
	}

	/**
	 * The render-wide part of a row's key: everything outside the commit object itself that feeds
	 * `getCommitRowHtml` - the layout, the column visibility, the checked-out branch and HEAD (the
	 * active branch label and the commit dot), the date and text formatting settings, and the
	 * reference label configuration. Computed once per render and compared as one string.
	 */
	public computeRowSeed(rowContext: RowContext): string {
		const config = rowContext.config, colVisibility = rowContext.colVisibility, dateFormat = config.dateFormat;
		return [
			rowContext.gitBranchHead, rowContext.commitHead,
			rowContext.narrow ? 'n' : 'w',
			colVisibility.date ? 'd' : '', colVisibility.author ? 'a' : '', colVisibility.commit ? 'c' : '',
			dateFormat.type + (dateFormat.iso ? 'i' : ''),
			config.fetchAvatars ? 'f' : '', config.showBodyInline ? 'b' : '', config.markdown ? 'm' : '',
			config.gerrit.showReviewProgress ? 'r' : '',
			config.referenceLabels.combineLocalAndRemoteBranchLabels ? 'l' : '',
			config.referenceLabels.tagLabelsOnRight ? 't' : '',
			config.referenceLabels.branchLabelsAlignedToGraph ? 'g' : '',
			// The issue linking configuration feeds the text formatter alongside the markdown flag
			// above (the same signature that busts the formatted-text cache)
			JSON.stringify(this.store.getIssueLinkingConfig())
		].join('\u0003');
	}
}
