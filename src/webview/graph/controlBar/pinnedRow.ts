/**
 * The Pinned row at the top of the graph: lists the pinned branches and commits of the current
 * repository as chips (click to jump, click the ✕ to unpin).
 */

import { formatLongDate } from '../../common/dates';
import { html, joinHtml, SafeHtml, setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { abbrevCommit, UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';

export class PinnedRow {
	/** The markup the pinned chips were last built from: identical content is never re-swapped. */
	private renderedHtml: string | null = null;

	constructor(private readonly ctx: () => GraphContext) { }

	/** Wire the row's chips (one delegated listener). */
	public init() {
		const controls = this.ctx().dom.pinnedControls;
		if (controls !== null) {
			controls.addEventListener('click', (e) => this.onChipClick(<HTMLElement>e.target));
		}
	}

	public togglePinCommit(hash: string, commit: GG.GitCommit | null) {
		const ctx = this.ctx(), store = ctx.store;
		if (hash === UNCOMMITTED) return;
		const wasPinned = store.isCommitPinned(hash);
		const pinned = store.getPinnedCommits().filter((pinned) => pinned.hash !== hash);
		if (!wasPinned && commit !== null) {
			// The author and date are captured alongside the subject, so the chip's tooltip keeps
			// describing the commit even once it has scrolled out of the loaded page.
			pinned.push({
				hash: hash,
				summary: commit.message.split(/\r?\n/)[0],
				author: commit.author,
				email: commit.email,
				date: commit.date
			});
		}
		ctx.persistence.saveRepoStateValue(store.currentRepo, 'pinnedCommits', pinned);
		ctx.renderScheduler.request();
	}

	public togglePinBranch(branch: string) {
		const ctx = this.ctx(), store = ctx.store;
		const wasPinned = store.getPinnedBranches().includes(branch);
		const pinned = store.getPinnedBranches().filter((pinnedBranch) => pinnedBranch !== branch);
		if (!wasPinned) pinned.push(branch);
		ctx.persistence.saveRepoStateValue(store.currentRepo, 'pinnedBranches', pinned);
		ctx.renderScheduler.request();
	}

	/**
	 * The tooltip of a pinned commit chip: what clicking it does, followed by the commit's own
	 * details — subject, author and date. A commit that is in the loaded page is described from
	 * the page (always current); one that has scrolled out falls back to what was captured at pin
	 * time, so the chip never degrades to a bare hash.
	 */
	private chipTitle(pinned: GG.PinnedCommit): string {
		const store = this.ctx().store;
		const commit = store.getCommit(pinned.hash);
		const summary = commit !== undefined ? commit.message.split(/\r?\n/)[0] : pinned.summary;
		const author = commit !== undefined ? commit.author : pinned.author;
		const email = commit !== undefined ? commit.email : pinned.email;
		const date = commit !== undefined ? commit.date : pinned.date;

		let title = formatStr(strings.pinnedCommitChipTitle, pinned.hash);
		if (typeof summary === 'string' && summary !== '') title += '\n' + summary;
		if (typeof author === 'string' && author !== '') {
			title += '\n' + author + (typeof email === 'string' && email !== '' ? ' <' + email + '>' : '');
		}
		if (typeof date === 'number') title += '\n' + formatLongDate(date, store.config.dateFormat);
		return title;
	}

	/** Render the Pinned row. Idempotent: the render pass runs on every scroll window update, so
	 * unchanged chips keep their DOM nodes (and whatever the user is doing with them). */
	public render() {
		const ctx = this.ctx(), store = ctx.store;
		const controls = ctx.dom.pinnedControls;
		if (controls === null) return;
		if (!store.hasCurrentRepo()) {
			controls.style.display = 'none';
			this.renderedHtml = null;
			return;
		}

		const pinnedBranches = store.getPinnedBranches();
		const pinnedCommits = store.getPinnedCommits();

		const chips: SafeHtml[] = [];
		for (const branch of pinnedBranches) {
			chips.push(html`<span class="pinnedChip" data-type="branch" data-value="${branch}" title="${formatStr(strings.pinnedBranchChipTitle, branch)}">📌 ${branch}<span class="pinnedChipRemove" data-type="branch" data-value="${branch}" title="${formatStr(strings.pinnedUnpinBranch, branch)}">&times;</span></span>`);
		}
		for (const pinned of pinnedCommits) {
			const summary = pinned.summary.length > 30 ? pinned.summary.substring(0, 30) + '…' : pinned.summary;
			chips.push(html`<span class="pinnedChip" data-type="commit" data-value="${pinned.hash}" title="${this.chipTitle(pinned)}">📌 <b>${abbrevCommit(pinned.hash)}</b>${summary !== '' ? ' ' + summary : ''}<span class="pinnedChipRemove" data-type="commit" data-value="${pinned.hash}" title="${formatStr(strings.pinnedUnpinCommit, pinned.hash)}">&times;</span></span>`);
		}
		const content = html`<span class="unselectable pinnedRowLabel">${strings.pinnedLabel}</span>${joinHtml(chips)}`;
		if (this.renderedHtml !== content.html) {
			this.renderedHtml = content.html;
			setHtml(controls, content);
		}
		controls.style.display = pinnedBranches.length + pinnedCommits.length > 0 ? 'block' : 'none';
	}

	private onChipClick(target: HTMLElement) {
		const ctx = this.ctx(), store = ctx.store;
		const remove = <HTMLElement | null>target.closest('.pinnedChipRemove');
		if (remove !== null && remove.dataset.value !== undefined) {
			if (remove.dataset.type === 'commit') this.togglePinCommit(remove.dataset.value, null);
			else this.togglePinBranch(remove.dataset.value);
			return;
		}

		const chip = <HTMLElement | null>target.closest('.pinnedChip');
		if (chip === null || chip.dataset.value === undefined) return;
		if (chip.dataset.type === 'commit') {
			if (store.commitLookup[chip.dataset.value] === undefined) {
				if (!store.moreCommitsAvailable) {
					ctx.dialog.showError(strings.pinnedCommitTitle, strings.pinnedCommitNotInView, null, null);
					return;
				}
				// The pinned commit is beyond the currently loaded commits: ask the extension how
				// many commits precede it, so the view can jump straight to it in one load
				ctx.loader.jumpToUnloadedCommit(chip.dataset.value);
				return;
			}
			ctx.viewport.scrollToCommit(chip.dataset.value, true, true);
		} else {
			ctx.controls.branchDropdown.selectOnlyOption(chip.dataset.value);
		}
	}
}
