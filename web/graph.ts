const CLASS_GRAPH_VERTEX_ACTIVE = 'graphVertexActive';
const NULL_VERTEX_ID = -1;


/* Types */

interface Point {
	readonly x: number;
	readonly y: number;
}
interface Line {
	readonly p1: Point;
	readonly p2: Point;
	readonly lockedFirst: boolean; // TRUE => The line is locked to p1, FALSE => The line is locked to p2
}

interface Pixel {
	x: number;
	y: number;
}
interface PlacedLine {
	readonly p1: Pixel;
	readonly p2: Pixel;
	readonly isCommitted: boolean;
	readonly lockedFirst: boolean; // TRUE => The line is locked to p1, FALSE => The line is locked to p2
}

/**
 * An insertion of extra height after commit row `index`
 * (e.g. the inline Commit Details View).
 */
interface RowExpansion {
	index: number;
	height: number;
}

interface UnavailablePoint {
	readonly connectsTo: VertexOrNull;
	readonly onBranch: Branch;
}

type VertexOrNull = Vertex | null;


/* Branch Class */

class Branch {
	private readonly colour: number;
	private end: number = 0;
	private lines: Line[] = [];
	private numUncommitted: number = 0;

	constructor(colour: number) {
		this.colour = colour;
	}

	public addLine(p1: Point, p2: Point, isCommitted: boolean, lockedFirst: boolean) {
		this.lines.push({ p1: p1, p2: p2, lockedFirst: lockedFirst });
		if (isCommitted) {
			if (p2.x === 0 && p2.y < this.numUncommitted) this.numUncommitted = p2.y;
		} else {
			this.numUncommitted++;
		}
	}


	/* Get / Set */

	public getColour() {
		return this.colour;
	}

	public getEnd() {
		return this.end;
	}

	public setEnd(end: number) {
		this.end = end;
	}


	/* Rendering */

	public draw(svg: SVGElement, config: GG.GraphConfig, expansions: RowExpansion[]) {
		let colour = config.colours[this.colour % config.colours.length], i, x1, y1, x2, y2, lines: PlacedLine[] = [], curPath = '', d = config.grid.y * (config.style === GG.GraphStyle.Angular ? 0.38 : 0.8), line;

		// Convert branch lines into pixel coordinates, respecting row expansions
		// (each expansion inserts extra height after commit row `index`, e.g. the inline Commit Details View)
		let segments: { x1: number, y1: number, row1: number, x2: number, y2: number, row2: number, isCommitted: boolean, lockedFirst: boolean }[] = [];
		for (i = 0; i < this.lines.length; i++) {
			line = this.lines[i];
			segments.push({
				x1: line.p1.x * config.grid.x + config.grid.offsetX, y1: line.p1.y * config.grid.y + config.grid.offsetY, row1: line.p1.y,
				x2: line.p2.x * config.grid.x + config.grid.offsetX, y2: line.p2.y * config.grid.y + config.grid.offsetY, row2: line.p2.y,
				isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst
			});
		}
		for (const expansion of expansions) {
			const next: typeof segments = [];
			for (const s of segments) {
				if (s.row1 > expansion.index) { // If the line starts after the expansion, move the whole line lower
					s.y1 += expansion.height;
					s.y2 += expansion.height;
					next.push(s);
				} else if (s.row2 <= expansion.index) { // The line is entirely above the expansion
					next.push(s);
				} else if (s.x1 === s.x2) { // The line is vertical and crosses the expansion, extend the endpoint past the expansion
					s.y2 += expansion.height;
					next.push(s);
				} else if (s.lockedFirst) { // If the line is locked to the first point, the transition stays in its normal position
					next.push({ x1: s.x1, y1: s.y1, row1: s.row1, x2: s.x2, y2: s.y2, row2: s.row1, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst }); // Display the normal transition
					next.push({ x1: s.x2, y1: s.y1 + config.grid.y, row1: s.row1, x2: s.x2, y2: s.y2 + expansion.height, row2: s.row2, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst }); // Extend the line over the expansion from the transition end point
				} else { // If the line is locked to the second point, the transition moves to after the expansion
					next.push({ x1: s.x1, y1: s.y1, row1: s.row1, x2: s.x1, y2: s.y2 - config.grid.y + expansion.height, row2: s.row2, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst }); // Extend the line over the expansion to the new transition start point
					next.push({ x1: s.x1, y1: s.y1 + expansion.height, row1: s.row2, x2: s.x2, y2: s.y2 + expansion.height, row2: s.row2, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst });
				}
			}
			segments = next;
		}
		for (const s of segments) {
			lines.push({ p1: { x: s.x1, y: s.y1 }, p2: { x: s.x2, y: s.y2 }, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst });
		}

		// Simplify consecutive lines that are straight by removing the 'middle' point
		let j = 0, nextLine: PlacedLine;
		while (j < lines.length - 1) {
			line = lines[j];
			nextLine = lines[j + 1];
			if (line.p1.x === line.p2.x && line.p2.x === nextLine.p1.x && nextLine.p1.x === nextLine.p2.x && line.p2.y === nextLine.p1.y && line.isCommitted === nextLine.isCommitted) {
				line.p2.y = nextLine.p2.y;
				lines.splice(j + 1, 1);
			} else {
				j++;
			}
		}

		// Iterate through all lines, producing and adding the svg paths to the DOM
		for (i = 0; i < lines.length; i++) {
			line = lines[i];
			x1 = line.p1.x; y1 = line.p1.y;
			x2 = line.p2.x; y2 = line.p2.y;

			// If the new point belongs to a different path, render the current path and reset it for the new path
			if (curPath !== '' && i > 0 && line.isCommitted !== lines[i - 1].isCommitted) {
				Branch.drawPath(svg, curPath, lines[i - 1].isCommitted, colour, config.uncommittedChanges);
				curPath = '';
			}

			// If the path hasn't been started or the new point belongs to a different path, move to p1
			if (curPath === '' || (i > 0 && (x1 !== lines[i - 1].p2.x || y1 !== lines[i - 1].p2.y))) curPath += 'M' + x1.toFixed(0) + ',' + y1.toFixed(1);

			if (x1 === x2) { // If the path is vertical, draw a straight line
				curPath += 'L' + x2.toFixed(0) + ',' + y2.toFixed(1);
			} else { // If the path moves horizontal, draw the appropriate transition
				if (config.style === GG.GraphStyle.Angular) {
					curPath += 'L' + (line.lockedFirst ? (x2.toFixed(0) + ',' + (y2 - d).toFixed(1)) : (x1.toFixed(0) + ',' + (y1 + d).toFixed(1))) + 'L' + x2.toFixed(0) + ',' + y2.toFixed(1);
				} else {
					curPath += 'C' + x1.toFixed(0) + ',' + (y1 + d).toFixed(1) + ' ' + x2.toFixed(0) + ',' + (y2 - d).toFixed(1) + ' ' + x2.toFixed(0) + ',' + y2.toFixed(1);
				}
			}
		}

		if (curPath !== '') {
			Branch.drawPath(svg, curPath, lines[lines.length - 1].isCommitted, colour, config.uncommittedChanges); // Draw the remaining path
		}
	}

	private static drawPath(svg: SVGElement, path: string, isCommitted: boolean, colour: string, uncommittedChanges: GG.GraphUncommittedChangesStyle) {
		const shadow = svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'path')), line = svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'path'));
		shadow.setAttribute('class', 'shadow');
		shadow.setAttribute('d', path);
		line.setAttribute('class', 'line');
		line.setAttribute('d', path);
		line.setAttribute('stroke', isCommitted ? colour : '#808080');
		if (!isCommitted && uncommittedChanges === GG.GraphUncommittedChangesStyle.OpenCircleAtTheCheckedOutCommit) {
			line.setAttribute('stroke-dasharray', '2px');
		}
	}
}


/* Vertex Class */

class Vertex {
	public readonly id: number;
	public readonly isStash: boolean;

	private x: number = 0;
	private children: Vertex[] = [];
	private parents: Vertex[] = [];
	private nextParent: number = 0;
	private onBranch: Branch | null = null;
	private isCommitted: boolean = true;
	private isCurrent: boolean = false;
	private nextX: number = 0;
	private connections: UnavailablePoint[] = [];

	constructor(id: number, isStash: boolean) {
		this.id = id;
		this.isStash = isStash;
	}


	/* Children */

	public addChild(vertex: Vertex) {
		this.children.push(vertex);
	}

	public getChildren(): ReadonlyArray<Vertex> {
		return this.children;
	}


	/* Parents */

	public addParent(vertex: Vertex) {
		this.parents.push(vertex);
	}

	public getParents(): ReadonlyArray<Vertex> {
		return this.parents;
	}

	public hasParents() {
		return this.parents.length > 0;
	}

	public getNextParent(): Vertex | null {
		if (this.nextParent < this.parents.length) return this.parents[this.nextParent];
		return null;
	}

	public getLastParent(): Vertex | null {
		if (this.nextParent < 1) return null;
		return this.parents[this.nextParent - 1];
	}

	public registerParentProcessed() {
		this.nextParent++;
	}

	public isMerge() {
		return this.parents.length > 1;
	}


	/* Branch */

	public addToBranch(branch: Branch, x: number) {
		if (this.onBranch === null) {
			this.onBranch = branch;
			this.x = x;
		}
	}

	public isNotOnBranch() {
		return this.onBranch === null;
	}

	public isOnThisBranch(branch: Branch) {
		return this.onBranch === branch;
	}

	public getBranch() {
		return this.onBranch;
	}


	/* Point */

	public getPoint(): Point {
		return { x: this.x, y: this.id };
	}

	public getNextPoint(): Point {
		return { x: this.nextX, y: this.id };
	}

	public getPointConnectingTo(vertex: VertexOrNull, onBranch: Branch) {
		for (let i = 0; i < this.connections.length; i++) {
			if (this.connections[i].connectsTo === vertex && this.connections[i].onBranch === onBranch) {
				return { x: i, y: this.id };
			}
		}
		return null;
	}
	public registerUnavailablePoint(x: number, connectsToVertex: VertexOrNull, onBranch: Branch) {
		if (x === this.nextX) {
			this.nextX = x + 1;
			this.connections[x] = { connectsTo: connectsToVertex, onBranch: onBranch };
		}
	}


	/* Get / Set State */

	public getColour() {
		return this.onBranch !== null ? this.onBranch.getColour() : 0;
	}

	public getIsCommitted() {
		return this.isCommitted;
	}

	public setNotCommitted() {
		this.isCommitted = false;
	}

	public setCurrent() {
		this.isCurrent = true;
	}


	/* Rendering */

	public draw(svg: SVGElement, config: GG.GraphConfig, offset: number) {
		if (this.onBranch === null) return;

		const colour = this.isCommitted ? config.colours[this.onBranch.getColour() % config.colours.length] : '#808080';
		const cx = (this.x * config.grid.x + config.grid.offsetX).toString();
		const cy = (this.id * config.grid.y + config.grid.offsetY + offset).toString();

		const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
		circle.dataset.id = this.id.toString();
		circle.setAttribute('cx', cx);
		circle.setAttribute('cy', cy);
		circle.setAttribute('r', '4');
		if (this.isCurrent) {
			circle.setAttribute('class', 'current');
			circle.setAttribute('stroke', colour);
		} else {
			circle.setAttribute('fill', colour);
		}
		svg.appendChild(circle);

		if (this.isStash && !this.isCurrent) {
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
}


/* Graph Class */

class Graph {
	private readonly config: GG.GraphConfig;
	private readonly muteConfig: GG.MuteCommitsConfig;
	private vertices: Vertex[] = [];
	private branches: Branch[] = [];
	private availableColours: number[] = [];
	private maxWidth: number = -1;

	private commits: ReadonlyArray<GG.GitCommit> = [];
	private commitHead: string | null = null;
	private commitLookup: { [hash: string]: number } = {};
	private onlyFollowFirstParent: boolean = false;
	private expandedCommitIndex: number = -1;
	private expansions: RowExpansion[] = [];

	private readonly viewElem: HTMLElement;
	private readonly contentElem: HTMLElement;
	private readonly svg: SVGElement;
	private readonly maskRect: SVGRectElement;
	private readonly gradientStop1: SVGStopElement;
	private readonly gradientStop2: SVGStopElement;
	private group: SVGGElement | null = null;

	private tooltipId: number = -1;
	private tooltipElem: HTMLElement | null = null;
	private tooltipTimeout: NodeJS.Timer | null = null;
	private tooltipVertex: HTMLElement | null = null;

	constructor(id: string, viewElem: HTMLElement, config: GG.GraphConfig, muteConfig: GG.MuteCommitsConfig) {
		this.viewElem = viewElem;
		this.config = config;
		this.muteConfig = muteConfig;

		const elem = document.getElementById(id)!;
		this.contentElem = elem.parentElement!;
		this.svg = document.createElementNS(SVG_NAMESPACE, 'svg');
		let defs = this.svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'defs'));

		let linearGradient = defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'linearGradient'));
		linearGradient.setAttribute('id', 'GraphGradient');
		this.gradientStop1 = linearGradient.appendChild(document.createElementNS(SVG_NAMESPACE, 'stop'));
		this.gradientStop1.setAttribute('stop-color', 'white');
		this.gradientStop2 = linearGradient.appendChild(document.createElementNS(SVG_NAMESPACE, 'stop'));
		this.gradientStop2.setAttribute('stop-color', 'black');

		let mask = defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'mask'));
		mask.setAttribute('id', 'GraphMask');
		this.maskRect = mask.appendChild(document.createElementNS(SVG_NAMESPACE, 'rect'));
		this.maskRect.setAttribute('fill', 'url(#GraphGradient)');

		this.setDimensions(0, 0);
		elem.appendChild(this.svg);
	}


	/* Graph Operations */

	public loadCommits(commits: ReadonlyArray<GG.GitCommit>, commitHead: string | null, commitLookup: { [hash: string]: number }, onlyFollowFirstParent: boolean) {
		this.commits = commits;
		this.commitHead = commitHead;
		this.commitLookup = commitLookup;
		this.onlyFollowFirstParent = onlyFollowFirstParent;
		this.vertices = [];
		this.branches = [];
		this.availableColours = [];
		if (commits.length === 0) return;

		const nullVertex = new Vertex(NULL_VERTEX_ID, false);
		let i: number, j: number;
		for (i = 0; i < commits.length; i++) {
			this.vertices.push(new Vertex(i, commits[i].stash !== null));
		}
		for (i = 0; i < commits.length; i++) {
			for (j = 0; j < commits[i].parents.length; j++) {
				let parentHash = commits[i].parents[j];
				if (typeof commitLookup[parentHash] === 'number') {
					// Parent is the <commitLookup[parentHash]>th vertex
					this.vertices[i].addParent(this.vertices[commitLookup[parentHash]]);
					this.vertices[commitLookup[parentHash]].addChild(this.vertices[i]);
				} else if (!this.onlyFollowFirstParent || j === 0) {
					// Parent is not one of the vertices of the graph, and the parent isn't being hidden by the onlyFollowFirstParent condition.
					this.vertices[i].addParent(nullVertex);
				}
			}
		}

		if (commits[0].hash === UNCOMMITTED) {
			this.vertices[0].setNotCommitted();
		}

		if (commits[0].hash === UNCOMMITTED && this.config.uncommittedChanges === GG.GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges) {
			this.vertices[0].setCurrent();
		} else if (commitHead !== null && typeof commitLookup[commitHead] === 'number') {
			this.vertices[commitLookup[commitHead]].setCurrent();
		}

		i = 0;
		while (i < this.vertices.length) {
			if (this.vertices[i].getNextParent() !== null || this.vertices[i].isNotOnBranch()) {
				this.determinePath(i);
			} else {
				i++;
			}
		}
	}

	public render(expandedCommit: ExpandedCommit | null, metaExpansions: RowExpansion[] = [], visibleRange: { start: number, end: number } | null = null) {
		this.expandedCommitIndex = expandedCommit !== null ? expandedCommit.index : -1;
		this.expansions = (this.expandedCommitIndex > -1 ? [{ index: this.expandedCommitIndex, height: this.config.grid.expandY }] : [])
			.concat(metaExpansions)
			.sort((a, b) => a.index - b.index);
		let group = document.createElementNS(SVG_NAMESPACE, 'g'), i, contentWidth = this.getContentWidth();
		group.setAttribute('mask', 'url(#GraphMask)');

		for (i = 0; i < this.branches.length; i++) {
			this.branches[i].draw(group, this.config, this.expansions);
		}

		// this.expansions is sorted by index, so the offset for each vertex (in increasing index
		// order) can be accumulated in a single pass, instead of rescanning all expansions per vertex
		let expansionOffset = 0, nextExpansion = 0;
		for (i = 0; i < this.vertices.length; i++) {
			while (nextExpansion < this.expansions.length && this.expansions[nextExpansion].index < i) {
				expansionOffset += this.expansions[nextExpansion].height;
				nextExpansion++;
			}
			// Windowed rendering: only the vertices of the rendered commit rows are drawn (the
			// branch paths above always span the whole graph - there are only a few of them)
			if (visibleRange !== null && (i < visibleRange.start || i >= visibleRange.end)) continue;
			this.vertices[i].draw(group, this.config, expansionOffset);
		}

		// A single pair of delegated listeners on `group` (recreated together with every vertex on
		// each render, so there's no risk of accumulating stale listeners across renders) replaces
		// what was previously one addEventListener('mouseover'/'mouseout') pair PER VERTEX CIRCLE.
		// Only vertex circles carry a `dataset.id` (branch line paths and the stash inner dot don't),
		// so this fires in exactly the same cases the old per-circle listeners did.
		group.addEventListener('mouseover', (e) => {
			if (e.target !== null && (<HTMLElement>e.target).dataset.id !== undefined) this.vertexOver(e);
		});
		group.addEventListener('mouseout', (e) => {
			if (e.target !== null && (<HTMLElement>e.target).dataset.id !== undefined) this.vertexOut(e);
		});

		if (this.group !== null) this.svg.removeChild(this.group);
		this.svg.appendChild(group);
		this.group = group;
		this.setDimensions(contentWidth, this.getHeight());
		this.applyMaxWidth(contentWidth);
		this.closeTooltip();
	}

	/**
	 * Get the total extra height inserted before commit row `index` (expansions of rows above it).
	 */
	public getOffsetAt(index: number) {
		let offset = 0;
		for (const expansion of this.expansions) {
			if (expansion.index < index) offset += expansion.height;
		}
		return offset;
	}


	/* Get */

	public getContentWidth() {
		let x = 0, i, p;
		for (i = 0; i < this.vertices.length; i++) {
			p = this.vertices[i].getNextPoint();
			if (p.x > x) x = p.x;
		}
		return 2 * this.config.grid.offsetX + (x - 1) * this.config.grid.x;
	}

	public getHeight() {
		let expansionsHeight = 0;
		for (const expansion of this.expansions) expansionsHeight += expansion.height;
		return this.vertices.length * this.config.grid.y + this.config.grid.offsetY - this.config.grid.y / 2 + expansionsHeight;
	}

	public getVertexColours() {
		let colours = [], i;
		for (i = 0; i < this.vertices.length; i++) {
			colours[i] = this.vertices[i].getColour() % this.config.colours.length;
		}
		return colours;
	}

	public getWidthsAtVertices() {
		let widths = [], i;
		for (i = 0; i < this.vertices.length; i++) {
			widths[i] = this.config.grid.offsetX + this.vertices[i].getNextPoint().x * this.config.grid.x - 2;
		}
		return widths;
	}


	/* Graph Queries */

	/**
	 * Determine whether a commit can be dropped.
	 * @param i Index of the commit to test.
	 * @returns TRUE => Commit can be dropped, FALSE => Commit can't be dropped
	 */
	public dropCommitPossible(i: number) {
		if (this.vertices[i] === undefined || !this.vertices[i].hasParents()) {
			return false; // No vertex (e.g. the commit is no longer loaded), or no parents
		}

		const isPossible = (v: Vertex): boolean | null => {
			if (v.isMerge()) {
				// Commit is a merge - fails topological test
				return null;
			}

			let children = v.getChildren();
			if (children.length > 1) {
				// Commit has multiple children - fails topological test
				return null;
			} else if (children.length === 1) {
				const recursivelyPossible = isPossible(children[0]);
				if (recursivelyPossible !== false) {
					// Topological tests failed (recursivelyPossible === NULL), or the HEAD has already been found (recursivelyPossible === TRUE)
					return recursivelyPossible;
				}
			}

			// Check if the current vertex is the HEAD if it has no children, or the HEAD has not been found in its recursive children.
			return this.commits[v.id].hash === this.commitHead;
		};

		return isPossible(this.vertices[i]) || false;
	}

	private getAllChildren(i: number) {
		let visited: { [id: string]: number } = {};
		const rec = (vertex: Vertex) => {
			const idStr = vertex.id.toString();
			if (typeof visited[idStr] !== 'undefined') return;

			visited[idStr] = vertex.id;
			let children = vertex.getChildren();
			for (let i = 0; i < children.length; i++) rec(children[i]);
		};
		rec(this.vertices[i]);
		return Object.keys(visited).map((key) => visited[key]).sort((a, b) => a - b);
	}

	public getMutedCommits(currentHash: string | null) {
		const muted = [];
		for (let i = 0; i < this.commits.length; i++) {
			muted[i] = false;
		}

		// Mute any merge commits if the Extension Setting is enabled
		if (this.muteConfig.mergeCommits) {
			for (let i = 0; i < this.commits.length; i++) {
				if (this.vertices[i].isMerge() && this.commits[i].stash === null) {
					// The commit is a merge, and is not a stash
					muted[i] = true;
				}
			}
		}

		// Mute any commits that are not ancestors of the commit head if the Extension Setting is enabled, and the head commit is in the graph
		if (this.muteConfig.commitsNotAncestorsOfHead && currentHash !== null && typeof this.commitLookup[currentHash] === 'number') {
			let ancestor: boolean[] = [];
			for (let i = 0; i < this.commits.length; i++) {
				ancestor[i] = false;
			}

			// Recursively discover ancestors of commit head
			const rec = (vertex: Vertex) => {
				if (vertex.id === NULL_VERTEX_ID || ancestor[vertex.id]) return;
				ancestor[vertex.id] = true;

				let parents = vertex.getParents();
				for (let i = 0; i < parents.length; i++) rec(parents[i]);
			};
			rec(this.vertices[this.commitLookup[currentHash]]);

			for (let i = 0; i < this.commits.length; i++) {
				if (!ancestor[i] && (this.commits[i].stash === null || typeof this.commitLookup[this.commits[i].stash!.baseHash] !== 'number' || !ancestor[this.commitLookup[this.commits[i].stash!.baseHash]])) {
					// Commit i is not an ancestor of currentHash, or a stash based on an ancestor of currentHash
					muted[i] = true;
				}
			}
		}

		return muted;
	}


	/**
	 * Get the index of the first parent of the commit at the specified index.
	 * @param i The index of the commit.
	 * @returns The index of the first parent, or -1 if there is no parent.
	 */
	public getFirstParentIndex(i: number) {
		const parents = this.vertices[i].getParents();
		return parents.length > 0
			? parents[0].id
			: -1;
	}

	/**
	 * Get the index of the alternative parent of the commit at the specified index.
	 * @param i The index of the commit.
	 * @returns The index of the alternative parent, or -1 if there is no parent.
	 */
	public getAlternativeParentIndex(i: number) {
		const parents = this.vertices[i].getParents();
		return parents.length > 1
			? parents[1].id
			: parents.length === 1
				? parents[0].id
				: -1;
	}

	/**
	 * Get the index of the first child of the commit at the specified index.
	 * @param i The index of the commit.
	 * @returns The index of the first child, or -1 if there is no child.
	 */
	public getFirstChildIndex(i: number) {
		const children = this.vertices[i].getChildren();
		if (children.length > 1) {
			// The vertex has multiple children
			const branch = this.vertices[i].getBranch();
			let childOnSameBranch: Vertex | undefined;
			if (branch !== null && (childOnSameBranch = children.find((child) => child.isOnThisBranch(branch)))) {
				// If a child could be found on the same branch as the vertex
				return childOnSameBranch.id;
			} else {
				// No child could be found on the same branch as the vertex
				return Math.max(...children.map((child) => child.id));
			}
		} else if (children.length === 1) {
			// The vertex has a single child
			return children[0].id;
		} else {
			// The vertex has no children
			return -1;
		}
	}

	/**
	 * Get the index of the alternative child of the commit at the specified index.
	 * @param i The index of the commit.
	 * @returns The index of the alternative child, or -1 if there is no child.
	 */
	public getAlternativeChildIndex(i: number) {
		const children = this.vertices[i].getChildren();
		if (children.length > 1) {
			// The vertex has multiple children
			const branch = this.vertices[i].getBranch();
			let childOnSameBranch: Vertex | undefined;
			if (branch !== null && (childOnSameBranch = children.find((child) => child.isOnThisBranch(branch)))) {
				// If a child could be found on the same branch as the vertex
				return Math.max(...children.filter(child => child !== childOnSameBranch).map((child) => child.id));
			} else {
				// No child could be found on the same branch as the vertex
				const childIndexes = children.map((child) => child.id).sort();
				return childIndexes[childIndexes.length - 2];
			}
		} else if (children.length === 1) {
			// The vertex has a single child
			return children[0].id;
		} else {
			// The vertex has no children
			return -1;
		}
	}


	/* Width Adjustment Methods */

	public limitMaxWidth(maxWidth: number) {
		this.maxWidth = maxWidth;
		this.applyMaxWidth(this.getContentWidth());
	}

	private setDimensions(contentWidth: number, height: number) {
		this.setSvgWidth(contentWidth);
		this.svg.setAttribute('height', height.toString());
		this.maskRect.setAttribute('width', contentWidth.toString());
		this.maskRect.setAttribute('height', height.toString());
	}

	private applyMaxWidth(contentWidth: number) {
		this.setSvgWidth(contentWidth);
		let offset1 = this.maxWidth > -1 ? (this.maxWidth - 12) / contentWidth : 1;
		let offset2 = this.maxWidth > -1 ? this.maxWidth / contentWidth : 1;
		this.gradientStop1.setAttribute('offset', offset1.toString());
		this.gradientStop2.setAttribute('offset', offset2.toString());
	}

	private setSvgWidth(contentWidth: number) {
		let width = this.maxWidth > -1 ? Math.min(contentWidth, this.maxWidth) : contentWidth;
		this.svg.setAttribute('width', width.toString());
	}


	/* Graph Layout Methods */

	private determinePath(startAt: number) {
		let i = startAt;
		let vertex = this.vertices[i], parentVertex = this.vertices[i].getNextParent(), curVertex;
		let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint(), curPoint;

		if (parentVertex !== null && parentVertex.id !== NULL_VERTEX_ID && vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
			// Branch is a merge between two vertices already on branches
			let foundPointToParent = false, parentBranch = parentVertex.getBranch()!;
			for (i = startAt + 1; i < this.vertices.length; i++) {
				curVertex = this.vertices[i];
				curPoint = curVertex.getPointConnectingTo(parentVertex, parentBranch); // Check if there is already a point connecting the ith vertex to the required parent
				if (curPoint !== null) {
					foundPointToParent = true; // Parent was found
				} else {
					curPoint = curVertex.getNextPoint(); // Parent couldn't be found, choose the next available point for the vertex
				}
				parentBranch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), !foundPointToParent && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true);
				curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch);
				lastPoint = curPoint;

				if (foundPointToParent) {
					vertex.registerParentProcessed();
					break;
				}
			}
		} else {
			// Branch is normal
			let branch = new Branch(this.getAvailableColour(startAt));
			vertex.addToBranch(branch, lastPoint.x);
			vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);
			for (i = startAt + 1; i < this.vertices.length; i++) {
				curVertex = this.vertices[i];
				curPoint = parentVertex === curVertex && !parentVertex.isNotOnBranch() ? curVertex.getPoint() : curVertex.getNextPoint();
				branch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), lastPoint.x < curPoint.x);
				curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
				lastPoint = curPoint;

				if (parentVertex === curVertex) {
					// The parent of <vertex> has been reached, progress <vertex> and <parentVertex> to continue building the branch
					vertex.registerParentProcessed();
					let parentVertexOnBranch = !parentVertex.isNotOnBranch();
					parentVertex.addToBranch(branch, curPoint.x);
					vertex = parentVertex;
					parentVertex = vertex.getNextParent();
					if (parentVertex === null || parentVertexOnBranch) {
						// There are no more parent vertices, or the parent was already on a branch
						break;
					}
				}
			}
			if (i === this.vertices.length && parentVertex !== null && parentVertex.id === NULL_VERTEX_ID) {
				// Vertex is the last in the graph, so no more branch can be formed to the parent
				vertex.registerParentProcessed();
			}
			branch.setEnd(i);
			this.branches.push(branch);
			this.availableColours[branch.getColour()] = i;
		}
	}

	private getAvailableColour(startAt: number) {
		for (let i = 0; i < this.availableColours.length; i++) {
			if (startAt > this.availableColours[i]) {
				return i;
			}
		}
		this.availableColours.push(0);
		return this.availableColours.length - 1;
	}


	/* Vertex Info */

	private vertexOver(event: MouseEvent) {
		if (event.target === null) return;
		this.closeTooltip();

		const vertexElem = <HTMLElement>event.target;
		const id = parseInt(vertexElem.dataset.id!);
		this.tooltipId = id;
		const commitElem = findCommitElemWithId(id);
		if (commitElem !== null) commitElem.classList.add(CLASS_GRAPH_VERTEX_ACTIVE);

		if (id < this.commits.length && this.commits[id].hash !== UNCOMMITTED) { // Only show tooltip for commits (not the uncommitted changes)
			this.tooltipTimeout = setTimeout(() => {
				this.tooltipTimeout = null;
				let vertexScreenY = vertexElem.getBoundingClientRect().top + 4; // Get center of the circle
				if (vertexScreenY >= 5 && vertexScreenY <= this.viewElem.clientHeight - 5) {
					// Vertex is completely visible on the screen (not partially off)
					this.tooltipVertex = vertexElem;
					closeDialogAndContextMenu();
					this.showTooltip(id, vertexScreenY);
				}
			}, 100);
		}
	}

	private vertexOut(event: MouseEvent) {
		if (event.target === null) return;
		this.closeTooltip();
	}

	private showTooltip(id: number, vertexScreenY: number) {
		if (this.tooltipVertex !== null) {
			this.tooltipVertex.setAttribute('r', this.tooltipVertex.classList.contains('stashOuter') ? '5.5' : '5');
		}

		const children = this.getAllChildren(id);
		let heads: string[] = [], remotes: GG.GitCommitRemote[] = [], stashes: string[] = [], tags: string[] = [], childrenIncludesHead = false;
		for (let i = 0; i < children.length; i++) {
			let commit = this.commits[children[i]];
			for (let j = 0; j < commit.heads.length; j++) heads.push(commit.heads[j]);
			for (let j = 0; j < commit.remotes.length; j++) remotes.push(commit.remotes[j]);
			for (let j = 0; j < commit.tags.length; j++) tags.push(commit.tags[j].name);
			if (commit.stash !== null) stashes.push(commit.stash.selector.substring(5));
			if (commit.hash === this.commitHead) childrenIncludesHead = true;
		}

		const getLimitedRefs = (htmlRefs: string[]) => {
			if (htmlRefs.length > 10) htmlRefs.splice(5, htmlRefs.length - 10, ' ' + ELLIPSIS + ' ');
			return htmlRefs.join('');
		};

		let html = '<div class="graphTooltipTitle">Commit ' + abbrevCommit(this.commits[id].hash) + '</div>';
		if (this.commitHead !== null && typeof this.commitLookup[this.commitHead] === 'number') {
			html += '<div class="graphTooltipSection">This commit is ' + (childrenIncludesHead ? '' : '<b><i>not</i></b> ') + 'included in <span class="graphTooltipRef">HEAD</span></div>';
		}
		if (heads.length > 0 || remotes.length > 0) {
			let branchLabels = getBranchLabels(heads, remotes), htmlRefs: string[] = [];
			branchLabels.heads.forEach((head) => {
				let html = head.remotes.reduce((prev, remote) => prev + '<span class="graphTooltipCombinedRef">' + escapeHtml(remote) + '</span>', '');
				htmlRefs.push('<span class="graphTooltipRef">' + escapeHtml(head.name) + html + '</span>');
			});
			branchLabels.remotes.forEach((remote) => htmlRefs.push('<span class="graphTooltipRef">' + escapeHtml(remote.name) + '</span>'));
			html += '<div class="graphTooltipSection">Branches: ' + getLimitedRefs(htmlRefs) + '</div>';
		}
		if (tags.length > 0) {
			let htmlRefs = tags.map((tag) => '<span class="graphTooltipRef">' + escapeHtml(tag) + '</span>');
			html += '<div class="graphTooltipSection">Tags: ' + getLimitedRefs(htmlRefs) + '</div>';
		}
		if (stashes.length > 0) {
			let htmlRefs = stashes.map((stash) => '<span class="graphTooltipRef">' + escapeHtml(stash) + '</span>');
			html += '<div class="graphTooltipSection">Stashes: ' + getLimitedRefs(htmlRefs) + '</div>';
		}

		const point = this.vertices[id].getPoint(), color = 'var(--git-graph-color' + (this.vertices[id].getColour() % this.config.colours.length) + ')';
		const anchor = document.createElement('div'), pointer = document.createElement('div'), content = document.createElement('div'), shadow = document.createElement('div');
		const pixel: Pixel = {
			x: point.x * this.config.grid.x + this.config.grid.offsetX,
			y: point.y * this.config.grid.y + this.config.grid.offsetY + this.getOffsetAt(id)
		};

		anchor.setAttribute('id', 'graphTooltip');
		anchor.style.opacity = '0';
		pointer.setAttribute('id', 'graphTooltipPointer');
		pointer.style.backgroundColor = color;
		content.setAttribute('id', 'graphTooltipContent');
		content.style.borderColor = color;
		content.innerHTML = html;
		content.style.maxWidth = Math.min(this.contentElem.getBoundingClientRect().width - pixel.x - 35, 600) + 'px'; // Tooltip Offset [23px] + Tooltip Border [2 * 2px] + Right Page Margin [8px] = 35px
		shadow.setAttribute('id', 'graphTooltipShadow');
		anchor.appendChild(shadow);
		anchor.appendChild(pointer);
		anchor.appendChild(content);
		anchor.style.left = pixel.x + 'px';
		anchor.style.top = pixel.y + 'px';
		this.contentElem.appendChild(anchor);
		this.tooltipElem = anchor;

		let tooltipRect = content.getBoundingClientRect();
		let relativeOffset = -tooltipRect.height / 2; // Center the tooltip vertically on the vertex
		if (vertexScreenY + relativeOffset + tooltipRect.height > this.viewElem.clientHeight - 4) {
			// Not enough height below the vertex to fit the vertex, shift it up.
			relativeOffset = (this.viewElem.clientHeight - vertexScreenY - 4) - tooltipRect.height;
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

	private closeTooltip() {
		if (this.tooltipId > -1) {
			const commitElem = findCommitElemWithId(this.tooltipId);
			if (commitElem !== null) commitElem.classList.remove(CLASS_GRAPH_VERTEX_ACTIVE);
			this.tooltipId = -1;
		}

		if (this.tooltipElem !== null) {
			this.tooltipElem.remove();
			this.tooltipElem = null;
		}

		if (this.tooltipTimeout !== null) {
			clearTimeout(this.tooltipTimeout);
			this.tooltipTimeout = null;
		}

		if (this.tooltipVertex !== null) {
			this.tooltipVertex.setAttribute('r', this.tooltipVertex.classList.contains('stashOuter') ? '4.5' : '4');
			this.tooltipVertex = null;
		}
	}
}
