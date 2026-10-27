/**
 * The commit graph: renders the lane layout (layout/graphLayout.ts) as SVG next to the commit
 * table, limits its width to the Graph column, and shows the tooltip of a hovered vertex.
 */

import { SVG_NAMESPACE } from '../../common/dom';
import { html, joinHtml, SafeHtml, setHtml } from '../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { abbrevCommit, UNCOMMITTED } from '../../common/util';
import { computeBranchPaths, RowExpansion } from '../layout/branchPaths';
import { GraphLayout, Vertex } from '../layout/graphLayout';
import { getBranchLabels } from '../layout/refLabels';
import { Store } from '../state/store';
import { ExpandedCommit } from '../state/types';
import { measureBoundingClientRect, measureClientSize } from './measure';

const CLASS_GRAPH_VERTEX_ACTIVE = 'graphVertexActive';

/** What the graph needs from the rest of the view. */
export interface GraphDeps {
	/** Resolve the rendered row of the commit at an index (NULL if it isn't rendered). */
	findCommitElem(index: number): HTMLElement | null;
	closeDialogAndContextMenu(): void;
}

export class GraphView {
	private readonly layout = new GraphLayout();
	private maxWidth: number = -1;
	private commits: ReadonlyArray<GG.GitCommit> = [];
	private commitHead: string | null = null;
	private commitLookup: ReadonlyMap<string, number> = new Map<string, number>();
	private expansions: RowExpansion[] = [];

	private readonly contentElem: HTMLElement;
	private readonly svg: SVGElement;
	private readonly maskRect: SVGRectElement;
	private readonly gradientStop1: SVGStopElement;
	private readonly gradientStop2: SVGStopElement;
	private group: SVGGElement | null = null;

	private tooltipId: number = -1;
	private tooltipElem: HTMLElement | null = null;
	private tooltipTimeout: number | null = null;
	private tooltipVertex: HTMLElement | null = null;

	/**
	 * @param elem The element the graph is rendered in (its parent is the content element).
	 * @param viewElem The scrolling view.
	 */
	constructor(private readonly store: Store, elem: HTMLElement, private readonly viewElem: HTMLElement, private readonly deps: GraphDeps) {
		this.contentElem = elem.parentElement!;
		this.svg = document.createElementNS(SVG_NAMESPACE, 'svg');
		// The graph is decoration as far as assistive technology is concerned (F5 accessibility):
		// every commit and ref it draws is carried by the commit table's rows, so exposing the SVG
		// would only duplicate the information in an unusable form
		this.svg.setAttribute('aria-hidden', 'true');
		const defs = this.svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'defs'));

		const linearGradient = defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'linearGradient'));
		linearGradient.setAttribute('id', 'GraphGradient');
		this.gradientStop1 = linearGradient.appendChild(document.createElementNS(SVG_NAMESPACE, 'stop'));
		this.gradientStop1.setAttribute('stop-color', 'white');
		this.gradientStop2 = linearGradient.appendChild(document.createElementNS(SVG_NAMESPACE, 'stop'));
		this.gradientStop2.setAttribute('stop-color', 'black');

		const mask = defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'mask'));
		mask.setAttribute('id', 'GraphMask');
		this.maskRect = mask.appendChild(document.createElementNS(SVG_NAMESPACE, 'rect'));
		this.maskRect.setAttribute('fill', 'url(#GraphGradient)');

		this.setDimensions(0, 0);
		elem.appendChild(this.svg);
	}

	private get config() {
		return this.store.config.graph;
	}


	/* Graph Operations */

	/** Lay out a new commit list. */
	public loadCommits(commits: ReadonlyArray<GG.GitCommit>, commitHead: string | null, commitLookup: ReadonlyMap<string, number>, onlyFollowFirstParent: boolean) {
		this.commits = commits;
		this.commitHead = commitHead;
		this.commitLookup = commitLookup;
		this.layout.load(commits, commitHead, commitLookup, onlyFollowFirstParent, this.config.uncommittedChanges);
	}

	/**
	 * Draw the graph.
	 * @param expandedCommit The commit whose inline Commit Details View is open (its height is inserted below its row).
	 * @param metaExpansions Further row expansions.
	 * @param visibleRange Windowed rendering: only the vertices of these commit rows are drawn (the branch paths always span the whole graph - there are only a few of them).
	 */
	public render(expandedCommit: ExpandedCommit | null, metaExpansions: RowExpansion[] = [], visibleRange: { start: number, end: number } | null = null) {
		const expandedCommitIndex = expandedCommit !== null ? expandedCommit.index : -1;
		this.expansions = (expandedCommitIndex > -1 ? [{ index: expandedCommitIndex, height: this.config.grid.expandY }] : [])
			.concat(metaExpansions)
			.sort((a, b) => a.index - b.index);
		const group = document.createElementNS(SVG_NAMESPACE, 'g'), contentWidth = this.getContentWidth();
		group.setAttribute('mask', 'url(#GraphMask)');

		const branches = this.layout.getBranches();
		for (let i = 0; i < branches.length; i++) {
			this.drawBranch(group, branches[i].getColour(), computeBranchPaths(branches[i], this.config, this.expansions));
		}

		// this.expansions is sorted by index, so the offset for each vertex (in increasing index
		// order) can be accumulated in a single pass, instead of rescanning all expansions per vertex
		const vertices = this.layout.getVertices();
		let expansionOffset = 0, nextExpansion = 0;
		for (let i = 0; i < vertices.length; i++) {
			while (nextExpansion < this.expansions.length && this.expansions[nextExpansion].index < i) {
				expansionOffset += this.expansions[nextExpansion].height;
				nextExpansion++;
			}
			// Windowed rendering: only the vertices of the rendered commit rows are drawn
			if (visibleRange !== null && (i < visibleRange.start || i >= visibleRange.end)) continue;
			this.drawVertex(group, vertices[i], expansionOffset);
		}

		// A single pair of delegated listeners on `group` (recreated together with every vertex on
		// each render, so there's no risk of accumulating stale listeners across renders) replaces
		// one mouseover/mouseout pair PER VERTEX CIRCLE. Only vertex circles carry a `dataset.id`
		// (branch line paths and the stash inner dot don't).
		group.addEventListener('mouseover', (e) => {
			if (e.target !== null && (<HTMLElement>e.target).dataset.id !== undefined) this.vertexOver(e);
		});
		group.addEventListener('mouseout', (e) => {
			if (e.target !== null && (<HTMLElement>e.target).dataset.id !== undefined) this.vertexOut();
		});

		if (this.group !== null) this.svg.removeChild(this.group);
		this.svg.appendChild(group);
		this.group = group;
		this.setDimensions(contentWidth, this.getHeight());
		this.applyMaxWidth(contentWidth);
		this.closeTooltip();
	}

	private drawBranch(svg: SVGElement, colourIndex: number, paths: ReadonlyArray<{ d: string, isCommitted: boolean }>) {
		const colour = this.config.colours[colourIndex % this.config.colours.length];
		for (let i = 0; i < paths.length; i++) {
			const shadow = svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'path')), line = svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'path'));
			shadow.setAttribute('class', 'shadow');
			shadow.setAttribute('d', paths[i].d);
			line.setAttribute('class', 'line');
			line.setAttribute('d', paths[i].d);
			line.setAttribute('stroke', paths[i].isCommitted ? colour : '#808080');
			if (!paths[i].isCommitted && this.config.uncommittedChanges === GG.GraphUncommittedChangesStyle.OpenCircleAtTheCheckedOutCommit) {
				line.setAttribute('stroke-dasharray', '2px');
			}
		}
	}

	private drawVertex(svg: SVGElement, vertex: Vertex, offset: number) {
		const branch = vertex.getBranch();
		if (branch === null) return;

		const config = this.config;
		const colour = vertex.getIsCommitted() ? config.colours[branch.getColour() % config.colours.length] : '#808080';
		const point = vertex.getPoint();
		const cx = (point.x * config.grid.x + config.grid.offsetX).toString();
		const cy = (vertex.id * config.grid.y + config.grid.offsetY + offset).toString();

		const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
		circle.dataset.id = vertex.id.toString();
		circle.setAttribute('cx', cx);
		circle.setAttribute('cy', cy);
		circle.setAttribute('r', '4');
		if (vertex.getIsCurrent()) {
			circle.setAttribute('class', 'current');
			circle.setAttribute('stroke', colour);
		} else {
			circle.setAttribute('fill', colour);
		}
		svg.appendChild(circle);

		if (vertex.isStash && !vertex.getIsCurrent()) {
			circle.setAttribute('r', '4.5');
			circle.setAttribute('class', 'stashOuter');
			const innerCircle = document.createElementNS(SVG_NAMESPACE, 'circle');
			innerCircle.setAttribute('cx', cx);
			innerCircle.setAttribute('cy', cy);
			innerCircle.setAttribute('r', '2');
			innerCircle.setAttribute('class', 'stashInner');
			svg.appendChild(innerCircle);
		}
	}

	/** The total extra height inserted before commit row `index` (the expansions of the rows above it). */
	public getOffsetAt(index: number) {
		let offset = 0;
		for (const expansion of this.expansions) {
			if (expansion.index < index) offset += expansion.height;
		}
		return offset;
	}


	/* Layout queries */

	public getContentWidth() {
		return 2 * this.config.grid.offsetX + (this.layout.getMaxNextX() - 1) * this.config.grid.x;
	}

	public getHeight() {
		let expansionsHeight = 0;
		for (const expansion of this.expansions) expansionsHeight += expansion.height;
		return this.commitCount() * this.config.grid.y + this.config.grid.offsetY - this.config.grid.y / 2 + expansionsHeight;
	}

	private commitCount() {
		return this.layout.getVertices().length;
	}

	public getVertexColours() {
		return this.layout.getVertexColours(this.config.colours.length);
	}

	public getWidthsAtVertices() {
		return this.layout.getWidthsAtVertices(this.config.grid);
	}

	public getMutedCommits(currentHash: string | null) {
		return this.layout.getMutedCommits(this.store.config.mute, currentHash);
	}

	public dropCommitPossible(i: number) {
		return this.layout.dropCommitPossible(i);
	}

	public commitOnRemote(i: number) {
		return this.layout.commitOnRemote(i);
	}

	public getFirstParentIndex(i: number) {
		return this.layout.getFirstParentIndex(i);
	}

	public getAlternativeParentIndex(i: number) {
		return this.layout.getAlternativeParentIndex(i);
	}

	public getFirstChildIndex(i: number) {
		return this.layout.getFirstChildIndex(i);
	}

	public getAlternativeChildIndex(i: number) {
		return this.layout.getAlternativeChildIndex(i);
	}


	/* Width Adjustment */

	/** Limit the width of the graph (-1 => unlimited): the part beyond the limit fades out. */
	public limitMaxWidth(maxWidth: number) {
		this.maxWidth = maxWidth;
		this.applyMaxWidth(this.getContentWidth());
	}

	private setDimensions(contentWidth: number, height: number) {
		this.setSvgWidth(contentWidth);
		// The height is reconstructed from measured dimensions; whatever collapses the
		// measurement (a view rendered from a zero-height layout) can leave it a hair below
		// zero, and SVG rejects negative lengths outright - so it is clamped at zero here.
		const svgHeight = Math.max(0, height);
		this.svg.setAttribute('height', svgHeight.toString());
		this.maskRect.setAttribute('width', contentWidth.toString());
		this.maskRect.setAttribute('height', svgHeight.toString());
	}

	private applyMaxWidth(contentWidth: number) {
		this.setSvgWidth(contentWidth);
		const offset1 = this.maxWidth > -1 ? (this.maxWidth - 12) / contentWidth : 1;
		const offset2 = this.maxWidth > -1 ? this.maxWidth / contentWidth : 1;
		this.gradientStop1.setAttribute('offset', offset1.toString());
		this.gradientStop2.setAttribute('offset', offset2.toString());
	}

	private setSvgWidth(contentWidth: number) {
		const width = this.maxWidth > -1 ? Math.min(contentWidth, this.maxWidth) : contentWidth;
		this.svg.setAttribute('width', width.toString());
	}


	/* Vertex tooltip */

	private vertexOver(event: MouseEvent) {
		if (event.target === null) return;
		this.closeTooltip();

		const vertexElem = <HTMLElement>event.target;
		const id = parseInt(vertexElem.dataset.id!);
		this.tooltipId = id;
		const commitElem = this.deps.findCommitElem(id);
		if (commitElem !== null) commitElem.classList.add(CLASS_GRAPH_VERTEX_ACTIVE);

		if (id < this.commits.length && this.commits[id].hash !== UNCOMMITTED) { // Only show tooltip for commits (not the uncommitted changes)
			this.tooltipTimeout = window.setTimeout(() => {
				this.tooltipTimeout = null;
				const vertexScreenY = measureBoundingClientRect(vertexElem).top + 4; // Get center of the circle
				if (vertexScreenY >= 5 && vertexScreenY <= measureClientSize(this.viewElem).height - 5) {
					// Vertex is completely visible on the screen (not partially off)
					this.tooltipVertex = vertexElem;
					this.deps.closeDialogAndContextMenu();
					this.showTooltip(id, vertexScreenY);
				}
			}, 100);
		}
	}

	private vertexOut() {
		this.closeTooltip();
	}

	private showTooltip(id: number, vertexScreenY: number) {
		if (this.tooltipVertex !== null) {
			this.tooltipVertex.setAttribute('r', this.tooltipVertex.classList.contains('stashOuter') ? '5.5' : '5');
		}

		const children = this.layout.getAllChildren(id);
		const heads: string[] = [], remotes: GG.GitCommitRemote[] = [], stashes: string[] = [], tags: string[] = [];
		let childrenIncludesHead = false;
		for (let i = 0; i < children.length; i++) {
			const commit = this.commits[children[i]];
			for (let j = 0; j < commit.heads.length; j++) heads.push(commit.heads[j]);
			for (let j = 0; j < commit.remotes.length; j++) remotes.push(commit.remotes[j]);
			for (let j = 0; j < commit.tags.length; j++) tags.push(commit.tags[j].name);
			if (commit.stash !== null) stashes.push(commit.stash.selector.substring(5));
			if (commit.hash === this.commitHead) childrenIncludesHead = true;
		}

		const getLimitedRefs = (refs: SafeHtml[]) => {
			if (refs.length > 10) refs.splice(5, refs.length - 10, html` ${ELLIPSIS} `);
			return joinHtml(refs);
		};
		const refSpan = (name: string, combined: ReadonlyArray<string> = []) =>
			html`<span class="graphTooltipRef">${name}${combined.map((remote) => html`<span class="graphTooltipCombinedRef">${remote}</span>`)}</span>`;

		let content = html`<div class="graphTooltipTitle">${formatStr(strings.graphTooltipCommit, abbrevCommit(this.commits[id].hash))}</div>`;
		if (this.commitHead !== null && typeof this.commitLookup.get(this.commitHead) === 'number') {
			content = html`${content}<div class="graphTooltipSection">${strings.graphTooltipThisCommitIs}${childrenIncludesHead ? '' : markup.graphTooltipNot}${markup.graphTooltipIncludedInHead}</div>`;
		}
		if (heads.length > 0 || remotes.length > 0) {
			const branchLabels = getBranchLabels(heads, remotes, this.store.config.referenceLabels.combineLocalAndRemoteBranchLabels);
			const refs: SafeHtml[] = [];
			branchLabels.heads.forEach((head) => refs.push(refSpan(head.name, head.remotes)));
			branchLabels.remotes.forEach((remote) => refs.push(refSpan(remote.name)));
			content = html`${content}<div class="graphTooltipSection">${strings.graphTooltipBranches}${getLimitedRefs(refs)}</div>`;
		}
		if (tags.length > 0) {
			content = html`${content}<div class="graphTooltipSection">${strings.graphTooltipTags}${getLimitedRefs(tags.map((tag) => refSpan(tag)))}</div>`;
		}
		if (stashes.length > 0) {
			content = html`${content}<div class="graphTooltipSection">${strings.graphTooltipStashes}${getLimitedRefs(stashes.map((stash) => refSpan(stash)))}</div>`;
		}

		const point = this.layout.getVertices()[id].getPoint(), colour = 'var(--git-graph-color' + (this.layout.getVertices()[id].getColour() % this.config.colours.length) + ')';
		const anchor = document.createElement('div'), pointer = document.createElement('div'), tooltipContent = document.createElement('div'), shadow = document.createElement('div');
		const pixel = {
			x: point.x * this.config.grid.x + this.config.grid.offsetX,
			y: point.y * this.config.grid.y + this.config.grid.offsetY + this.getOffsetAt(id)
		};

		anchor.setAttribute('id', 'graphTooltip');
		anchor.style.opacity = '0';
		pointer.setAttribute('id', 'graphTooltipPointer');
		pointer.style.backgroundColor = colour;
		tooltipContent.setAttribute('id', 'graphTooltipContent');
		tooltipContent.style.borderColor = colour;
		setHtml(tooltipContent, content);
		tooltipContent.style.maxWidth = Math.min(measureBoundingClientRect(this.contentElem).width - pixel.x - 35, 600) + 'px'; // Tooltip Offset [23px] + Tooltip Border [2 * 2px] + Right Page Margin [8px] = 35px
		shadow.setAttribute('id', 'graphTooltipShadow');
		anchor.appendChild(shadow);
		anchor.appendChild(pointer);
		anchor.appendChild(tooltipContent);
		anchor.style.left = pixel.x + 'px';
		anchor.style.top = pixel.y + 'px';
		this.contentElem.appendChild(anchor);
		this.tooltipElem = anchor;

		const tooltipRect = measureBoundingClientRect(tooltipContent);
		let relativeOffset = -tooltipRect.height / 2; // Center the tooltip vertically on the vertex
		if (vertexScreenY + relativeOffset + tooltipRect.height > measureClientSize(this.viewElem).height - 4) {
			// Not enough height below the vertex to fit the vertex, shift it up.
			relativeOffset = (measureClientSize(this.viewElem).height - vertexScreenY - 4) - tooltipRect.height;
		}
		if (vertexScreenY + relativeOffset < 4) {
			// Not enough height above the vertex to fit the tooltip, shift it down.
			relativeOffset = -vertexScreenY + 4;
		}
		pointer.style.top = (-relativeOffset) + 'px';
		anchor.style.top = (pixel.y + relativeOffset) + 'px';
		shadow.style.width = tooltipRect.width + 'px';
		shadow.style.height = tooltipRect.height + 'px';
		anchor.style.opacity = '1';
	}

	/** Close the vertex tooltip, and clear the hover state of its commit row. */
	public closeTooltip() {
		if (this.tooltipId > -1) {
			const commitElem = this.deps.findCommitElem(this.tooltipId);
			if (commitElem !== null) commitElem.classList.remove(CLASS_GRAPH_VERTEX_ACTIVE);
			this.tooltipId = -1;
		}

		if (this.tooltipElem !== null) {
			this.tooltipElem.remove();
			this.tooltipElem = null;
		}

		if (this.tooltipTimeout !== null) {
			window.clearTimeout(this.tooltipTimeout);
			this.tooltipTimeout = null;
		}

		if (this.tooltipVertex !== null) {
			this.tooltipVertex.setAttribute('r', this.tooltipVertex.classList.contains('stashOuter') ? '4.5' : '4');
			this.tooltipVertex = null;
		}
	}
}

