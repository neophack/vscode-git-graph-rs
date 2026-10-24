/**
 * The SVG path data of a branch: its lane polyline converted to pixels, respecting the row
 * expansions (extra height inserted after a row, e.g. the inline Commit Details View), simplified,
 * and joined into one path per committed / uncommitted run. Pure - the renderer only appends the
 * resulting `d` strings to the SVG.
 */

import * as GG from '../../common/protocol';
import { Branch } from './graphLayout';

/** An insertion of extra height after commit row `index` (e.g. the inline Commit Details View). */
export interface RowExpansion {
	index: number;
	height: number;
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

interface Segment {
	x1: number;
	y1: number;
	row1: number;
	x2: number;
	y2: number;
	row2: number;
	isCommitted: boolean;
	lockedFirst: boolean;
}

/** One path to draw: its data, and whether it belongs to committed history (else to the uncommitted changes). */
export interface BranchPath {
	readonly d: string;
	readonly isCommitted: boolean;
}

/**
 * Compute the paths of a branch.
 * @param branch The branch.
 * @param config The graph configuration (grid and style).
 * @param expansions The row expansions, sorted by index.
 */
export function computeBranchPaths(branch: Branch, config: GG.GraphConfig, expansions: ReadonlyArray<RowExpansion>): BranchPath[] {
	const grid = config.grid, branchLines = branch.getLines(), numUncommitted = branch.getNumUncommitted();
	const d = grid.y * (config.style === GG.GraphStyle.Angular ? 0.38 : 0.8);
	const paths: BranchPath[] = [];

	// Convert branch lines into pixel coordinates, respecting row expansions
	// (each expansion inserts extra height after commit row `index`, e.g. the inline Commit Details View)
	let segments: Segment[] = [];
	for (let i = 0; i < branchLines.length; i++) {
		const line = branchLines[i];
		segments.push({
			x1: line.p1.x * grid.x + grid.offsetX, y1: line.p1.y * grid.y + grid.offsetY, row1: line.p1.y,
			x2: line.p2.x * grid.x + grid.offsetX, y2: line.p2.y * grid.y + grid.offsetY, row2: line.p2.y,
			isCommitted: i >= numUncommitted, lockedFirst: line.lockedFirst
		});
	}
	for (const expansion of expansions) {
		const next: Segment[] = [];
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
				next.push({ x1: s.x2, y1: s.y1 + grid.y, row1: s.row1, x2: s.x2, y2: s.y2 + expansion.height, row2: s.row2, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst }); // Extend the line over the expansion from the transition end point
			} else { // If the line is locked to the second point, the transition moves to after the expansion
				next.push({ x1: s.x1, y1: s.y1, row1: s.row1, x2: s.x1, y2: s.y2 - grid.y + expansion.height, row2: s.row2, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst }); // Extend the line over the expansion to the new transition start point
				next.push({ x1: s.x1, y1: s.y1 + expansion.height, row1: s.row2, x2: s.x2, y2: s.y2 + expansion.height, row2: s.row2, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst });
			}
		}
		segments = next;
	}
	const lines: PlacedLine[] = [];
	for (const s of segments) {
		lines.push({ p1: { x: s.x1, y: s.y1 }, p2: { x: s.x2, y: s.y2 }, isCommitted: s.isCommitted, lockedFirst: s.lockedFirst });
	}

	// Simplify consecutive lines that are straight by removing the 'middle' point
	let j = 0;
	while (j < lines.length - 1) {
		const line = lines[j], nextLine = lines[j + 1];
		if (line.p1.x === line.p2.x && line.p2.x === nextLine.p1.x && nextLine.p1.x === nextLine.p2.x && line.p2.y === nextLine.p1.y && line.isCommitted === nextLine.isCommitted) {
			line.p2.y = nextLine.p2.y;
			lines.splice(j + 1, 1);
		} else {
			j++;
		}
	}

	// Build the paths: a new one starts wherever the committed state changes
	let curPath = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const x1 = line.p1.x, y1 = line.p1.y, x2 = line.p2.x, y2 = line.p2.y;

		// If the new point belongs to a different path, emit the current path and reset it for the new path
		if (curPath !== '' && i > 0 && line.isCommitted !== lines[i - 1].isCommitted) {
			paths.push({ d: curPath, isCommitted: lines[i - 1].isCommitted });
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
		paths.push({ d: curPath, isCommitted: lines[lines.length - 1].isCommitted }); // The remaining path
	}
	return paths;
}
