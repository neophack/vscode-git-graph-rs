// @vitest-environment jsdom
/**
 * The markup of a commit row (src/webview/graph/render/commitRow.ts), ported from the row-shape
 * cases of tests/webviewMobileAdaptation.test.mjs: the mobile layout's two-line row reads like a
 * mail list - the subject with a compact date on the right, then the refs, the author and the
 * abbreviated hash on a meta line below - while the wide layout keeps the Date / Author / Commit
 * columns and the refs on the subject line. getCommitRowHtml is pure; the rows are parsed into
 * the DOM exactly as the commit table inserts them.
 */

import { describe, expect, it } from 'vitest';

import { parseHtmlRow } from '../../common/html';
import * as GG from '../../common/protocol';
import { TextFormatter } from '../text/textFormatter';
import { getCommitRowHtml, RowContext } from './commitRow';

const HEAD = 'c000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';

/** A linear-history commit with optional branch heads. */
function commit(hash: string, heads: string[] = []): GG.GitCommit {
	return {
		hash: hash,
		parents: ['c000aaaaaaaaaaaaaaaaaaaaaaaaaaaa99'],
		author: 'Author One',
		email: 'author@example.com',
		date: 1700000000,
		message: 'commit of ' + hash.substring(0, 8),
		heads: heads,
		tags: [],
		remotes: [],
		stash: null
	};
}

/** A row context rendering the given commits in the requested layout. */
function rowContext(commits: ReadonlyArray<GG.GitCommit>, narrow: boolean): RowContext {
	const textFormatter = new TextFormatter(commits, null, { emoji: true, issueLinking: true, markdown: false });
	return {
		config: <GG.GitGraphViewConfig><unknown>{
			dateFormat: { type: GG.DateFormatType.DateAndTime, iso: false },
			referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: false, tagLabelsOnRight: false },
			fetchAvatars: false,
			showBodyInline: false
		},
		commits: commits,
		commitHead: HEAD,
		gitBranchHead: 'main',
		narrow: narrow,
		colVisibility: narrow ? { date: false, author: false, commit: false } : { date: true, author: true, commit: true },
		currentHash: HEAD,
		vertexColours: commits.map((_commit, i) => i),
		widthsAtVertices: [],
		mutedCommits: commits.map(() => false),
		pinnedCommitHashes: new Set<string>(),
		gerritStates: {},
		gerritVisibleChanges: new Set<number>(),
		pullRequestsByHead: {},
		avatars: {},
		commitBodies: {},
		textFormatter: textFormatter,
		formatText: (text) => textFormatter.format(text)
	};
}

describe('the mobile layout\'s two-line row', () => {
	it('moves the dropped columns beside and under the subject', () => {
		const commits = [commit(HEAD)];
		const row = parseHtmlRow(getCommitRowHtml(0, rowContext(commits, true)));

		expect(row.querySelectorAll('td').length).toBe(2); // the graph and description cells only
		const meta = row.querySelector('td:nth-child(2) .mobileMeta');
		expect(meta).not.toBe(null); // the description cell carries the meta line
		expect(meta!.querySelector('.mobileMetaHash')!.textContent).toBe(HEAD.substring(0, 8)); // the abbreviated commit
		expect(meta!.querySelector('.mobileMetaAuthor')!.textContent!.length).toBeGreaterThan(0); // the author
		const date = <HTMLElement>row.querySelector('td:nth-child(2) .description .mobileMetaDate');
		expect(date).not.toBe(null); // the subject line carries the date
		expect(date!.textContent!.length).toBeGreaterThan(0);
		expect(date!.title.length).toBeGreaterThan(0); // with the full date as its tooltip
	});

	it('moves the refs of a commit onto its second line', () => {
		const withRef = commit(HEAD, ['main']);
		const row = parseHtmlRow(getCommitRowHtml(0, rowContext([withRef], true)));

		expect(row.querySelector('.description .gitRef')).toBe(null); // no ref is left on the subject line
		expect(row.querySelector('.mobileMeta .mobileRefs .gitRef')).not.toBe(null); // the refs lead the meta line
	});
});

describe('the wide layout\'s row', () => {
	it('keeps all five cells and its refs on the subject line', () => {
		const withRef = commit(HEAD, ['main']);
		const row = parseHtmlRow(getCommitRowHtml(0, rowContext([withRef], false)));

		expect(row.querySelectorAll('td').length).toBe(5);
		expect(row.querySelector('.mobileMeta')).toBe(null); // no meta line
		expect(row.querySelector('.mobileMetaDate')).toBe(null);
		expect(row.querySelector('.description .gitRef')).not.toBe(null); // the ref stays on the subject line
	});
});
