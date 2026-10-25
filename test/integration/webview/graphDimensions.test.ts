/**
 * Graph SVG dimensions: the graph column's <svg> (and the fade-out mask <rect> inside it) get
 * their height from a RECONSTRUCTION - rows × measured row height + header offset - and SVG
 * rejects negative length attributes outright. When the view renders from a layout that reports
 * no height (a backgrounded tab: every clientHeight is 0), the unguarded measurement drove that
 * reconstruction into floating point noise around zero, and whenever it tipped negative the
 * browser logged `Error: <svg> attribute height: A negative value is not valid ("-5.2e-18")` for
 * both elements on every render.
 *
 * Ported from tests/webviewGraphDimensions.test.mjs (REFACTOR-PLAN task 7.1); assertions are
 * unchanged.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { ROW_HEIGHT, bootView, commit } from '../../support/webviewHost';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

type Booted = Awaited<ReturnType<typeof bootView>>;

const HEADER_HEIGHT = 31; // the sticky table column headers, as emulated below when visible

/** The graph svg and its mask rect: the two elements whose height attribute the old code drove
 * negative. They move together, so every assertion checks both. */
function graphHeights(h: Booted) {
	const svg = h.document.querySelector('#commitGraph svg') as SVGElement;
	const rect = svg.querySelector('defs mask rect') as SVGElement;
	return { svg: parseFloat(svg.getAttribute('height')!), rect: parseFloat(rect.getAttribute('height')!) };
}

/** Land a new commit on the checked-out branch: the loadCommits response differs from the last
 * one, so the refresh takes the full re-render path (an identical response early-returns without
 * rendering at all - see the loadCommits handling in the webview's responses). */
function landCommit(h: Booted) {
	const newCommit = commit(0, 1, ['main']);
	newCommit.hash = 'n' + String(h.state.history.length).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
	newCommit.message = 'commit NEW' + h.state.history.length;
	newCommit.parents = [h.state.history[0].hash];
	h.state.history[0].heads = [];
	h.state.history.unshift(newCommit);
	h.state.head = newCommit.hash;
}

async function refreshWithChange(h: Booted, setTableHeight?: (value: number) => void) {
	landCommit(h);
	// The emulated table height must reflect the commit just landed: renderGraph measures the
	// table AFTER the re-render, with the new row already part of the content.
	if (setTableHeight !== undefined) setTableHeight(HEADER_HEIGHT + h.state.history.length * ROW_HEIGHT);
	h.dispatch({ command: 'refresh' });
	await h.pump();
}

/** jsdom has no layout engine, so clientHeight is 0 for everything. Emulate a laid-out table the
 * way renderGraph measures it: `tableH > 0` gives the #commitTable's <table> child its full
 * content height (headers + uniform rows) and the column headers their height; `tableH = 0` is
 * exactly what a hidden view reports for every element. Prototype level, because the table
 * element itself is rebuilt on every re-render. */
function emulateTableHeight(h: Booted) {
	let tableH = 0;
	const proto = h.window.Element.prototype;
	const original = Object.getOwnPropertyDescriptor(proto, 'clientHeight')!;
	Object.defineProperty(proto, 'clientHeight', {
		get(this: HTMLElement) {
			if (this.parentElement !== null && this.parentElement.id === 'commitTable') return tableH;
			if (this.id === 'tableColHeaders') return tableH > 0 ? HEADER_HEIGHT : 0;
			return original.get!.call(this);
		},
		configurable: true
	});
	return (value: number) => { tableH = value; };
}

/** Noise around zero (the old symptom) sits below any conceivable real content height; a genuine
 * height is at least a pixel per rendered commit. */
function assertRealHeight(h: Booted, label: string) {
	const { svg, rect } = graphHeights(h);
	assert.ok(svg >= 0, label + ': the svg height is never negative (got ' + svg + ')');
	assert.ok(rect >= 0, label + ': the mask rect height is never negative (got ' + rect + ')');
	assert.equal(rect, svg, label + ': the mask rect covers the same height as the svg');
	assert.ok(svg > h.state.history.length, label + ': the height is the real content height, not cancellation noise (got ' + svg + ')');
}

describe('the graph svg keeps valid dimensions across measurable and unmeasurable layouts', () => {
	it('a render with no measurable layout (hidden view) keeps the configured grid instead of collapsing to noise', async () => {
		const h = await bootView(150);
		await refreshWithChange(h); // jsdom default: every clientHeight is 0
		assertRealHeight(h, 'rendered from a zero-height layout');
	});

	it('a measurable layout is adopted, and a later hidden render retains it rather than collapsing', async () => {
		const h = await bootView(150);
		const setTableHeight = emulateTableHeight(h);

		await refreshWithChange(h, setTableHeight);
		const measured = graphHeights(h).svg;
		assert.equal(measured, HEADER_HEIGHT + h.state.history.length * ROW_HEIGHT, 'the measured table height is reconstructed exactly');

		setTableHeight(0); // the view goes hidden: every clientHeight reports 0 again
		await refreshWithChange(h);
		const retained = graphHeights(h).svg;
		assertRealHeight(h, 'rendered while hidden');
		assert.ok(retained > measured, 'the retained grid still grows with the new commit (got ' + retained + ' after ' + measured + ')');
	});
});
