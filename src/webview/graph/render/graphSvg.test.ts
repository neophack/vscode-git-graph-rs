// @vitest-environment jsdom
/**
 * The graph SVG's dimension handling (src/webview/graph/render/graphSvg.ts), ported from the
 * clamp case of tests/webviewGraphDimensions.test.mjs: the <svg> (and the fade-out mask <rect>
 * inside it) get their height from a RECONSTRUCTION - rows x row height + header offset - and
 * SVG rejects negative length attributes outright, logging an error for both elements on every
 * render when the arithmetic tips below zero (the old symptom, a backgrounded tab's zero-height
 * measurement producing floating point noise around zero). The height handed to the SVG is
 * clamped at zero no matter what the arithmetic produced; the mask rect always covers the same
 * height as the svg.
 *
 * (The other guard - a zero-height table measurement never overwriting the
 * last good grid in CommitTable.renderGraph - needs the full render pipeline and lives in the
 * full-page integration tests: test/integration/webview/graphDimensions.test.ts.)
 */

import { beforeEach, describe, expect, it } from 'vitest';

import * as GG from '../../common/protocol';
import type { Store } from '../state/store';
import { GraphView } from './graphSvg';

const GRID = { x: 10, y: 24, offsetX: 8, offsetY: 12, expandY: 100 };

/** A store carrying only the graph configuration GraphView reads. */
function makeStore() {
	return {
		config: {
			graph: { colours: ['#0086d1'], fontSize: 12, rowHeight: 24, style: GG.GraphStyle.Rounded, grid: { x: GRID.x, y: GRID.y, offsetX: GRID.offsetX, offsetY: GRID.offsetY, expandY: GRID.expandY }, uncommittedChanges: GG.GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges },
			mute: { commitsNotAncestorsOfHead: false, mergeCommits: false }
		}
	} as unknown as Store;
}

/** A linear history of `total` commits (index 0 the newest, HEAD at the top). */
function linearHistory(total: number): GG.GitCommit[] {
	const history: GG.GitCommit[] = [];
	for (let i = 0; i < total; i++) {
		const hash = 'c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		history.push({
			hash: hash,
			parents: i + 1 < total ? ['c' + String(i + 1).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] : [],
			author: 'Author ' + i,
			email: 'author' + i + '@example.com',
			date: 1700000000 + (total - i) * 60,
			message: 'commit ' + i,
			heads: i === 0 ? ['main'] : [],
			tags: [],
			remotes: [],
			stash: null
		});
	}
	return history;
}

/** A graph rendered into the page over the given commits. */
function makeGraphView(commits: ReadonlyArray<GG.GitCommit>) {
	document.body.textContent = '';
	const contentElem = document.createElement('div');
	const elem = document.createElement('div');
	contentElem.appendChild(elem);
	document.body.appendChild(contentElem);
	const store = makeStore();
	const view = new GraphView(store, elem, document.body, {
		findCommitElem: () => null,
		closeDialogAndContextMenu: () => { }
	});
	const lookup: Map<string, number> = new Map<string, number>();
	commits.forEach((commit, index) => { lookup.set(commit.hash, index); });
	view.loadCommits(commits, commits.length > 0 ? commits[0].hash : null, lookup, false);
	view.render(null, [], null);
	return { view: view, store: store, svg: elem.querySelector<SVGElement>('svg')!, rect: elem.querySelector<SVGRectElement>('defs mask rect')! };
}

/** The svg and the mask rect heights, as parsed from their attributes. */
const heights = (svg: SVGElement, rect: SVGRectElement) => ({
	svg: parseFloat(svg.getAttribute('height')!),
	rect: parseFloat(rect.getAttribute('height')!)
});

beforeEach(() => {
	document.body.textContent = '';
});

describe('the graph svg dimensions', () => {
	it('reconstructs the height from the grid: rows x row height + offsets, the mask rect covering the same height', () => {
		const { svg, rect } = makeGraphView(linearHistory(5));
		const h = heights(svg, rect);
		// 5 rows of 24px, plus the offset above the first row's centre minus half a row
		expect(h.svg).toBe(5 * GRID.y + GRID.offsetY - GRID.y / 2);
		expect(h.rect).toBe(h.svg);

		// A commit landing grows the reconstruction with it
		const grown = makeGraphView(linearHistory(6));
		expect(heights(grown.svg, grown.rect).svg).toBe(6 * GRID.y + GRID.offsetY - GRID.y / 2);
	});

	it('clamps a negative reconstruction at zero for both the svg and the mask rect, never handing SVG a negative length', () => {
		// The noise the old bug produced: a measurement a hair below zero written into the grid
		const noise = -5.2e-18;
		const store = makeStore();
		store.config.graph.grid.y = noise;
		store.config.graph.grid.offsetY = noise;

		document.body.textContent = '';
		const contentElem = document.createElement('div'), elem = document.createElement('div');
		contentElem.appendChild(elem);
		document.body.appendChild(contentElem);
		const commits = linearHistory(5);
		const lookup: Map<string, number> = new Map<string, number>();
		commits.forEach((commit, index) => { lookup.set(commit.hash, index); });
		const view = new GraphView(store, elem, document.body, { findCommitElem: () => null, closeDialogAndContextMenu: () => { } });
		view.loadCommits(commits, commits[0].hash, lookup, false);
		view.render(null, [], null);

		const svg = elem.querySelector<SVGElement>('svg')!, rect = elem.querySelector<SVGRectElement>('defs mask rect')!;
		const svgHeight = svg.getAttribute('height');
		const rectHeight = rect.getAttribute('height');
		expect(svgHeight!.startsWith('-')).toBe(false); // never a negative length
		expect(svgHeight).toBe('0');
		expect(rectHeight).toBe('0'); // the mask rect clamps with it
		expect(heights(svg, rect).svg).toBeGreaterThanOrEqual(0);
	});
});
