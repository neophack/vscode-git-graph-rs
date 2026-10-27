/**
 * The deferred `+N/-M` line counts of the Commit Details View's file list. The commit details
 * arrive without them (every file costs two blob reads, which dominates the load of a many-file
 * commit): the paths near the viewport are settled first, and the rest are filled in by background
 * batches - each response patches the rendered rows in place.
 */

import { setHtml } from '../../common/html';
import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { patchFileRowCounts } from './fileTree';
import { getMobileFilesStatHtml } from './mobileSummary';

/**
 * How far beyond the visible rows counts are still settled eagerly when scrolling, so a fast
 * scroll does not land on empty `( +… | … )` placeholders.
 */
const LINE_COUNTS_VIEWPORT_BUFFER = 400;

/**
 * How many paths one background batch asks for. Bounded so a batch stays quick to compute and to
 * apply, and (for the git CLI backend, where the paths travel on the command line) so the command
 * stays comfortably within the platform's process creation limits.
 */
const LINE_COUNTS_CHUNK_SIZE = 200;

/**
 * The grace period before the background batches start, letting the viewport's own request land
 * first — the rows the user is looking at settle before any of the rest are computed.
 */
const LINE_COUNTS_CHUNK_DELAY = 300;

export class LineCounts {
	/**
	 * @param getRoot The open Commit Details View's element (#cdv): every lookup runs under it
	 * (F3) — the counts patch the open view's rows, never the document's.
	 */
	constructor(private readonly ctx: () => GraphContext, private readonly getRoot: () => HTMLElement | null) { }

	/**
	 * Reset the deferred-counts state for the file list that has just arrived: every path that can
	 * carry counts becomes pending, and the viewport's paths are asked for immediately.
	 */
	public initialise() {
		const ctx = this.ctx(), store = ctx.store, expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null) return;

		const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		// The state is rebuilt here (the deferred-counts subsystem's own cache) and installed
		// through the details slice - the only writer of the expandedCommit's fields.
		const state = {
			pending: null as Set<string> | null,
			requested: new Set<string>(),
			queue: [] as string[],
			byPath: new Map<string, number>(),
			chunkInFlight: false,
			scrollTimer: 0
		};

		if (commitOrder.to !== UNCOMMITTED) {
			const pending = new Set<string>(), queue: string[] = [];
			for (let i = 0; i < expandedCommit.fileChanges.length; i++) {
				const path = expandedCommit.fileChanges[i].newFilePath;
				// Untracked files never carry counts; the rest are pending until asked for.
				if (expandedCommit.fileChanges[i].type !== GG.GitFileStatus.Untracked && !pending.has(path)) {
					pending.add(path);
					queue.push(path);
					state.byPath.set(path, i);
				}
			}
			state.pending = pending;
			state.queue = queue;
		}
		// (A comparison against the working tree reports no counts by design, so there is nothing
		// to settle and no request to make — pending stays null (counts inactive), which every
		// scheduler and renderer treats as "no counts exist", instead of an empty set (which the
		// schedulers would read as "counts active, nothing requested yet" and re-request per file).)
		store.slices.details.resetLineCounts(state);

		this.scheduleVisible();
		window.setTimeout(() => this.pumpChunk(), LINE_COUNTS_CHUNK_DELAY);
	}

	/** The diff the open view's counts belong to: a comparison's two sides, a stash's base, or a commit's first parent. */
	private fromTo(): { from: string | null, to: string } | null {
		const store = this.ctx().store, expandedCommit = store.expandedCommit;
		if (expandedCommit === null) return null;

		if (expandedCommit.compareWithHash !== null) {
			const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash);
			return { from: commitOrder.from, to: commitOrder.to };
		}
		const commit = store.getCommit(expandedCommit.commitHash);
		if (commit !== undefined && commit.stash !== null) {
			return { from: commit.stash.baseHash, to: expandedCommit.commitHash };
		}
		return { from: null, to: expandedCommit.commitHash };
	}

	private request(paths: string[]) {
		const ctx = this.ctx(), expandedCommit = ctx.store.expandedCommit, fromTo = this.fromTo();
		if (expandedCommit === null || fromTo === null || paths.length === 0) return;

		for (let i = 0; i < paths.length; i++) expandedCommit.lineCounts.requested.add(paths[i]);
		ctx.bridge.send({
			command: 'commitFileCounts',
			repo: ctx.store.currentRepo,
			commitHash: expandedCommit.commitHash,
			compareWithHash: expandedCommit.compareWithHash,
			from: fromTo.from,
			to: fromTo.to,
			paths: paths
		});
	}

	/** Ask for the counts of the rows in (or near) the viewport, debounced so scrolling stays cheap. */
	public scheduleVisible() {
		const store = this.ctx().store, expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.lineCounts.pending === null) return;

		window.clearTimeout(expandedCommit.lineCounts.scrollTimer);
		store.slices.details.setLineCountsScrollTimer(window.setTimeout(() => {
			if (store.expandedCommit === null) return; // the view closed while debouncing
			this.request(this.collectVisiblePendingPaths());
		}, 120));
	}

	private collectVisiblePendingPaths(): string[] {
		const ctx = this.ctx(), expandedCommit = ctx.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.lineCounts.pending === null || expandedCommit.fileChanges === null) return [];
		const root = this.getRoot();
		if (root === null) return [];
		const filesElem = root.querySelector('#cdvFiles');
		const scrollElem = root.querySelector('#' + ctx.details.getFilesScrollElemId());
		if (filesElem === null || scrollElem === null) return [];
		// The viewport is the file list's scroll container: #cdvFiles itself, or in the mobile sheet
		// #cdvContent (#cdvFiles is unclipped there, so its own rect would count every file as visible)
		const visible = scrollElem.getBoundingClientRect();
		const paths: string[] = [];
		const records = filesElem.getElementsByClassName('fileTreeFileRecord');
		for (let i = 0; i < records.length; i++) {
			const record = <HTMLElement>records[i];
			const rect = record.getBoundingClientRect();
			// A zero-height row sits inside a closed folder; a row outside the buffered viewport will
			// be settled by a later batch.
			if (rect.height === 0 || rect.bottom < visible.top - LINE_COUNTS_VIEWPORT_BUFFER || rect.top > visible.bottom + LINE_COUNTS_VIEWPORT_BUFFER) continue;
			const path = expandedCommit.fileChanges[parseInt(record.dataset.index!)].newFilePath;
			if (!expandedCommit.lineCounts.requested.has(path)) paths.push(path);
		}
		return paths;
	}

	/** Send the next background batch, one batch in flight at a time so the host is never queued up. */
	private pumpChunk() {
		const expandedCommit = this.ctx().store.expandedCommit;
		if (expandedCommit === null || expandedCommit.lineCounts.pending === null || expandedCommit.lineCounts.chunkInFlight) return;
		const queue = expandedCommit.lineCounts.queue;
		while (queue.length > 0 && expandedCommit.lineCounts.requested.has(queue[0])) queue.shift();
		if (queue.length === 0) return;
		this.ctx().store.slices.details.setLineCountsChunkInFlight(true);
		this.request(queue.splice(0, LINE_COUNTS_CHUNK_SIZE));
	}

	/**
	 * Settle one batch of counts into the open view: the records, and the rendered rows, are patched
	 * in place; the placeholder of a binary file is dropped and its row stops being diffable, exactly
	 * as it would have rendered had the counts been known from the start.
	 */
	public apply(msg: GG.ResponseCommitFileCounts) {
		const ctx = this.ctx(), expandedCommit = ctx.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null || expandedCommit.lineCounts.pending === null) return;
		if (expandedCommit.commitHash !== msg.commitHash || expandedCommit.compareWithHash !== msg.compareWithHash) return; // a stale reply for a view that is no longer open
		ctx.store.slices.details.setLineCountsChunkInFlight(false);
		const root = this.getRoot();
		const filesElem = root !== null ? root.querySelector('#cdvFiles') : null;
		for (const path in msg.counts) {
			if (!expandedCommit.lineCounts.pending.has(path)) continue;
			expandedCommit.lineCounts.pending.delete(path);
			const index = expandedCommit.lineCounts.byPath !== null ? expandedCommit.lineCounts.byPath.get(path) : undefined;
			if (index === undefined || index >= expandedCommit.fileChanges.length) continue;
			const file = expandedCommit.fileChanges[index] as { additions: number | null, deletions: number | null };
			file.additions = msg.counts[path].additions;
			file.deletions = msg.counts[path].deletions;
			if (filesElem !== null) {
				const record = filesElem.querySelector('.fileTreeFileRecord[data-index="' + index + '"]');
				if (record !== null) patchFileRowCounts(<HTMLElement>record, expandedCommit.fileChanges[index]);
			}
		}
		const statElem = root !== null ? root.querySelector('#cdvFilesHeader .cdvmFilesStat') : null;
		if (statElem !== null) setHtml(statElem, getMobileFilesStatHtml(expandedCommit.fileChanges, expandedCommit.lineCounts.pending));
		this.pumpChunk();
	}
}
