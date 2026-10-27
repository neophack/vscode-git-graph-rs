/**
 * The commit graph's lane layout: pure computation over the loaded commits (no DOM). Each commit
 * becomes a vertex placed on a lane (x) at its row (y); each branch is the polyline of lane points
 * it occupies. The renderer (render/graphSvg.ts) turns the result into SVG.
 */

import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';

export const NULL_VERTEX_ID = -1;

export interface Point {
	readonly x: number;
	readonly y: number;
}

export interface Line {
	readonly p1: Point;
	readonly p2: Point;
	readonly lockedFirst: boolean; // TRUE => The line is locked to p1, FALSE => The line is locked to p2
}

type VertexOrNull = Vertex | null;

interface UnavailablePoint {
	readonly connectsTo: VertexOrNull;
	readonly onBranch: Branch;
}


/* Branch */

export class Branch {
	private readonly colour: number;
	private end: number = 0;
	private readonly lines: Line[] = [];
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

	public getColour() {
		return this.colour;
	}

	public getEnd() {
		return this.end;
	}

	public setEnd(end: number) {
		this.end = end;
	}

	public getLines(): ReadonlyArray<Line> {
		return this.lines;
	}

	/** The number of leading lines (from the top) that belong to the uncommitted changes. */
	public getNumUncommitted() {
		return this.numUncommitted;
	}
}


/* Vertex */

export class Vertex {
	public readonly id: number;
	public readonly isStash: boolean;

	private x: number = 0;
	private readonly children: Vertex[] = [];
	private readonly parents: Vertex[] = [];
	private nextParent: number = 0;
	private onBranch: Branch | null = null;
	private isCommitted: boolean = true;
	private isCurrent: boolean = false;
	private nextX: number = 0;
	private readonly connections: UnavailablePoint[] = [];

	constructor(id: number, isStash: boolean) {
		this.id = id;
		this.isStash = isStash;
	}

	public addChild(vertex: Vertex) {
		this.children.push(vertex);
	}

	public getChildren(): ReadonlyArray<Vertex> {
		return this.children;
	}

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

	public getColour() {
		return this.onBranch !== null ? this.onBranch.getColour() : 0;
	}

	public getIsCommitted() {
		return this.isCommitted;
	}

	public setNotCommitted() {
		this.isCommitted = false;
	}

	public getIsCurrent() {
		return this.isCurrent;
	}

	public setCurrent() {
		this.isCurrent = true;
	}
}


/* Graph Layout */

export class GraphLayout {
	private vertices: Vertex[] = [];
	private branches: Branch[] = [];
	private availableColours: number[] = [];
	private commits: ReadonlyArray<GG.GitCommit> = [];
	private commitHead: string | null = null;
	private commitLookup: ReadonlyMap<string, number> = new Map<string, number>();

	/**
	 * Lay out a commit list.
	 * @param commits The commits, newest first.
	 * @param commitHead The hash of the commit HEAD points at.
	 * @param commitLookup Commit hash => index in `commits`.
	 * @param onlyFollowFirstParent Only the first parent of a commit outside the list is drawn.
	 * @param uncommittedChanges How the "Uncommitted Changes" row is drawn.
	 */
	public load(commits: ReadonlyArray<GG.GitCommit>, commitHead: string | null, commitLookup: ReadonlyMap<string, number>, onlyFollowFirstParent: boolean, uncommittedChanges: GG.GraphUncommittedChangesStyle) {
		this.commits = commits;
		this.commitHead = commitHead;
		this.commitLookup = commitLookup;
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
				const parentHash = commits[i].parents[j];
				const parentIndex = commitLookup.get(parentHash);
				if (typeof parentIndex === 'number') {
					// Parent is the <parentIndex>th vertex
					this.vertices[i].addParent(this.vertices[parentIndex]);
					this.vertices[parentIndex].addChild(this.vertices[i]);
				} else if (!onlyFollowFirstParent || j === 0) {
					// Parent is not one of the vertices of the graph, and the parent isn't being hidden by the onlyFollowFirstParent condition.
					this.vertices[i].addParent(nullVertex);
				}
			}
		}

		if (commits[0].hash === UNCOMMITTED) {
			this.vertices[0].setNotCommitted();
		}

		if (commits[0].hash === UNCOMMITTED && uncommittedChanges === GG.GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges) {
			this.vertices[0].setCurrent();
		} else if (commitHead !== null && typeof commitLookup.get(commitHead) === 'number') {
			this.vertices[commitLookup.get(commitHead) as number].setCurrent();
		}

		i = 0;
		/* Termination guard: determinePath resolves a vertex's parents by scanning DOWNWARD for
		 * them, which requires every parent to sit below its child in the list (the case for the
		 * extension's date/topology orderings). A repository whose commit dates are skewed (a
		 * clock jump, a cherry-pick preserving an old author date under date ordering) can violate
		 * that: the scan never reaches such a parent, registerParentProcessed is never called and
		 * this loop would spin forever, freezing the view. No legitimate layout needs to revisit
		 * one vertex more times than there are vertices, so past that bound the remaining parent
		 * edges are dropped and the layout continues (the offending edges simply draw no line). */
		let visitsAtI = 0;
		while (i < this.vertices.length) {
			if (this.vertices[i].getNextParent() !== null || this.vertices[i].isNotOnBranch()) {
				if (++visitsAtI > this.vertices.length) {
					while (this.vertices[i].getNextParent() !== null) this.vertices[i].registerParentProcessed();
					i++; // force past a vertex the layout cannot resolve (drawn without its branch lines)
					visitsAtI = 0;
				} else {
					this.determinePath(i);
				}
			} else {
				i++;
				visitsAtI = 0;
			}
		}
	}

	public getVertices(): ReadonlyArray<Vertex> {
		return this.vertices;
	}

	public getBranches(): ReadonlyArray<Branch> {
		return this.branches;
	}

	/** The rightmost lane any vertex occupies the next point of (the graph's width, in lanes). */
	public getMaxNextX() {
		let x = 0;
		for (let i = 0; i < this.vertices.length; i++) {
			const p = this.vertices[i].getNextPoint();
			if (p.x > x) x = p.x;
		}
		return x;
	}

	/** The colour index (modulo the number of colours) of every vertex. */
	public getVertexColours(numColours: number) {
		const colours = [];
		for (let i = 0; i < this.vertices.length; i++) {
			colours[i] = this.vertices[i].getColour() % numColours;
		}
		return colours;
	}

	/** The width (px) the graph occupies at every vertex's row. */
	public getWidthsAtVertices(grid: GG.GraphConfig['grid']) {
		const widths = [];
		for (let i = 0; i < this.vertices.length; i++) {
			widths[i] = grid.offsetX + this.vertices[i].getNextPoint().x * grid.x - 2;
		}
		return widths;
	}


	/* Graph Queries */

	/**
	 * Determine whether a commit can be dropped: it is not a merge, and HEAD is reached from it
	 * through a single line of non-merge descendants.
	 * @param i Index of the commit to test.
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

			const children = v.getChildren();
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

	/**
	 * Determine whether a commit has been published to a remote: it counts as pushed when it, or
	 * any of its descendants, carries a remote-tracking ref. The descendants are exactly the newer
	 * commits, which the top-down loaded window always contains, so the walk over the loaded graph
	 * is complete. Used to hide the message-editing actions for commits already on a remote.
	 * @param i Index of the commit to test.
	 * @returns TRUE => Commit is on a remote (or unknown, in which case editing is not offered)
	 */
	public commitOnRemote(i: number): boolean {
		if (this.vertices[i] === undefined) return true;
		return this.getAllChildren(i).some((id) => this.commits[id].remotes.length > 0);
	}

	/** The indexes of a commit and all of its descendants, ascending. */
	public getAllChildren(i: number) {
		const visited: { [id: string]: number } = {};
		const rec = (vertex: Vertex) => {
			const idStr = vertex.id.toString();
			if (typeof visited[idStr] !== 'undefined') return;

			visited[idStr] = vertex.id;
			const children = vertex.getChildren();
			for (let i = 0; i < children.length; i++) rec(children[i]);
		};
		rec(this.vertices[i]);
		return Object.keys(visited).map((key) => visited[key]).sort((a, b) => a - b);
	}

	/**
	 * Which commits are rendered muted.
	 * @param mute The configuration of the commits to mute.
	 * @param currentHash The hash of the current commit (the uncommitted changes, or HEAD).
	 */
	public getMutedCommits(mute: GG.MuteCommitsConfig, currentHash: string | null) {
		const muted: boolean[] = [];
		for (let i = 0; i < this.commits.length; i++) {
			muted[i] = false;
		}

		// Mute any merge commits if the Extension Setting is enabled
		if (mute.mergeCommits) {
			for (let i = 0; i < this.commits.length; i++) {
				if (this.vertices[i].isMerge() && this.commits[i].stash === null) {
					// The commit is a merge, and is not a stash
					muted[i] = true;
				}
			}
		}

		// Mute any commits that are not ancestors of the commit head if the Extension Setting is enabled, and the head commit is in the graph
		const headIndex = currentHash !== null ? this.commitLookup.get(currentHash) : undefined;
		if (mute.commitsNotAncestorsOfHead && typeof headIndex === 'number') {
			const ancestor: boolean[] = [];
			for (let i = 0; i < this.commits.length; i++) {
				ancestor[i] = false;
			}

			// Recursively discover ancestors of commit head
			const rec = (vertex: Vertex) => {
				if (vertex.id === NULL_VERTEX_ID || ancestor[vertex.id]) return;
				ancestor[vertex.id] = true;

				const parents = vertex.getParents();
				for (let i = 0; i < parents.length; i++) rec(parents[i]);
			};
			rec(this.vertices[headIndex as number]);

			for (let i = 0; i < this.commits.length; i++) {
				const stash = this.commits[i].stash;
				const stashBaseIndex = stash !== null ? this.commitLookup.get(stash.baseHash) : undefined;
				if (!ancestor[i] && (stash === null || typeof stashBaseIndex !== 'number' || !ancestor[stashBaseIndex])) {
					// Commit i is not an ancestor of currentHash, or a stash based on an ancestor of currentHash
					muted[i] = true;
				}
			}
		}

		return muted;
	}

	/** The index of the first parent of a commit, or -1. */
	public getFirstParentIndex(i: number) {
		const parents = this.vertices[i].getParents();
		return parents.length > 0 ? parents[0].id : -1;
	}

	/** The index of the alternative (second, else first) parent of a commit, or -1. */
	public getAlternativeParentIndex(i: number) {
		const parents = this.vertices[i].getParents();
		return parents.length > 1
			? parents[1].id
			: parents.length === 1
				? parents[0].id
				: -1;
	}

	/** The index of the first child of a commit (preferring the child on its own branch), or -1. */
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

	/** The index of the alternative child of a commit (a child on another branch), or -1. */
	public getAlternativeChildIndex(i: number) {
		const children = this.vertices[i].getChildren();
		if (children.length > 1) {
			// The vertex has multiple children
			const branch = this.vertices[i].getBranch();
			let childOnSameBranch: Vertex | undefined;
			if (branch !== null && (childOnSameBranch = children.find((child) => child.isOnThisBranch(branch)))) {
				// If a child could be found on the same branch as the vertex
				return Math.max(...children.filter((child) => child !== childOnSameBranch).map((child) => child.id));
			} else {
				// No child could be found on the same branch as the vertex
				const childIndexes = children.map((child) => child.id).sort((a, b) => a - b);
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


	/* Layout */

	private determinePath(startAt: number) {
		let i = startAt;
		let vertex = this.vertices[i], parentVertex = this.vertices[i].getNextParent(), curVertex;
		let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint(), curPoint;

		if (parentVertex !== null && parentVertex.id !== NULL_VERTEX_ID && vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
			// Branch is a merge between two vertices already on branches
			let foundPointToParent = false;
			const parentBranch = parentVertex.getBranch()!;
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
			const branch = new Branch(this.getAvailableColour(startAt));
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
					const parentVertexOnBranch = !parentVertex.isNotOnBranch();
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
}
