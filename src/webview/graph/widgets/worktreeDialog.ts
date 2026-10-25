/**
 * The Worktree Widget: an overlay (matching the Settings and Reflog widgets) listing the
 * repository's worktrees, with Add / Remove / Prune actions. There is no sidebar TreeView in this
 * project - this stays consistent with how branches / remotes / tags / stashes are only ever
 * exposed as dropdown filters and dialogs inside this single webview panel.
 */

import { CLASS_ACTIVE, makeKeyboardActivatable } from '../../common/dom';
import { escapeHtml, helpTooltipAttrs, html, setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { injectOnDemandStyles } from '../../common/onDemandStyles';
import * as GG from '../../common/protocol';
import { abbrevCommit } from '../../common/util';
import { GraphContext } from '../context';
import { DialogInputType } from './dialog';
import { WorktreeDialogSurface } from './surfaces';
import worktreeCss from '../../styles/worktreeDialog.css';
import panelsCss from '../../styles/mobile/panels.css';

// This module sits in an on-demand chunk (task 5.9): its stylesheet rides the chunk as text
injectOnDemandStyles(worktreeCss);
injectOnDemandStyles(panelsCss);

export class WorktreeDialog implements WorktreeDialogSurface {
	private readonly widgetElem: HTMLElement;
	private readonly contentElem: HTMLElement;
	private isOpen: boolean = false;
	private worktrees: ReadonlyArray<GG.GitWorktree> = [];

	constructor(private readonly ctx: () => GraphContext) {
		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'worktreeWidget';
		setHtml(this.widgetElem, html`<h2>${strings.worktreeDialogTitle}</h2><div id="worktreeContent"></div><div id="worktreeClose"></div>`);
		document.body.appendChild(this.widgetElem);

		this.contentElem = document.getElementById('worktreeContent')!;

		const closeBtn = document.getElementById('worktreeClose')!;
		setHtml(closeBtn, SVG_ICONS.close);
		makeKeyboardActivatable(closeBtn);
		closeBtn.addEventListener('click', () => this.close());
	}

	public show() {
		if (this.isOpen) return;
		this.isOpen = true;
		this.widgetElem.classList.add(CLASS_ACTIVE);
		this.load();
	}

	public close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		// The widget is hidden by sliding up to top:-158px: the content must be cleared so the
		// widget collapses below that offset, otherwise the lower part of a tall worktree list
		// stays visible on screen (the same approach the Settings Widget takes)
		setHtml(this.contentElem, html``);
	}

	public isVisible() {
		return this.isOpen;
	}

	/** Re-request the worktree list, e.g. after a refresh-triggering action. */
	public refresh() {
		if (this.isOpen) this.load();
	}

	private load() {
		const ctx = this.ctx();
		setHtml(this.contentElem, html`<div class="worktreeLoading">${SVG_ICONS.loading}</div>`);
		ctx.bridge.send({ command: 'worktreeList', repo: ctx.store.currentRepo });
	}

	public processListResponse(msg: GG.ResponseWorktreeList) {
		// A response for another repository is stale: the host serves requests concurrently, so
		// a slow answer for the previous repo can arrive after the switch — it must not replace
		// this (re-opened) dialog's list. A response without the repo echo (a mismatched build)
		// is accepted, like the conflict banner treats its omitted fields.
		if (!this.isOpen || (msg.repo !== undefined && msg.repo !== this.ctx().store.currentRepo)) return;
		this.worktrees = msg.worktrees;
		this.render();
	}

	private render() {
		const ctx = this.ctx();
		let content;
		if (this.worktrees.length === 0) {
			content = html`<div class="worktreeEmpty">${strings.worktreeNoneFound}</div>`;
		} else {
			content = html`<table class="worktreeTable"><tbody>${this.worktrees.map((worktree) => {
				// The tooltip targets (the prunable badge, the remove button) must pass their own
				// classes through helpTooltipAttrs' className parameter: a separate class attribute
				// before it would win over the tooltip's, and the parser would drop the latter -
				// silently disabling the tooltip
				return html`<tr class="worktreeRow" data-path="${worktree.path}"><td class="worktreePathCol">${worktree.path}${worktree.isMain ? html` <span class="worktreeBadge worktreeBadgeMain">${strings.worktreeMainBadge}</span>` : ''}${worktree.locked ? html` <span class="worktreeBadge worktreeBadgeLocked">${strings.worktreeLocked}</span>` : ''}${worktree.prunable ? html` <span ${helpTooltipAttrs(strings.worktreePrunableInfo, 'worktreeBadge worktreeBadgePrunable')}>${strings.worktreePrunable}</span>` : ''}</td><td class="worktreeBranchCol">${worktree.branch !== null ? escapeHtml(worktree.branch) : html`<i>${strings.worktreeDetached} (${abbrevCommit(worktree.hash)})</i>`}</td><td class="worktreeActionsCol">${worktree.isMain ? '' : html`<span ${helpTooltipAttrs(strings.worktreeRemoveTitle, 'worktreeRemoveBtn')} role="button">${SVG_ICONS.trash}</span>`}</td></tr>`;
			})}</tbody></table>`;
		}
		setHtml(this.contentElem, html`${content}<div id="worktreeAddBtn" class="roundedBtn" role="button" tabindex="0">${strings.worktreeAddTitle}</div><div id="worktreePruneBtn" class="roundedBtn" role="button" tabindex="0">${strings.worktreePruneTitle}</div>`);

		const removeBtns = this.contentElem.querySelectorAll('.worktreeRemoveBtn');
		for (let i = 0; i < removeBtns.length; i++) {
			const btn = <HTMLElement>removeBtns[i];
			const path = (<HTMLElement>btn.closest('.worktreeRow'))!.getAttribute('data-path')!;
			makeKeyboardActivatable(btn);
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.removeWorktreeAction(path);
			});
		}

		const addBtn = document.getElementById('worktreeAddBtn')!;
		makeKeyboardActivatable(addBtn);
		addBtn.addEventListener('click', () => this.addWorktreeAction());

		const pruneBtn = document.getElementById('worktreePruneBtn')!;
		makeKeyboardActivatable(pruneBtn);
		pruneBtn.addEventListener('click', () => {
			ctx.dialog.showConfirmation(strings.worktreePruneConfirm, strings.worktreePruneTitle, () => {
				ctx.actions.run({ command: 'worktreePrune', repo: ctx.store.currentRepo }, strings.worktreePruneTitle);
			}, null);
		});
	}

	private addWorktreeAction() {
		const ctx = this.ctx(), store = ctx.store;
		const checkedOutBranches = new Set(this.worktrees.filter((w) => w.branch !== null).map((w) => w.branch));
		const branchOptions = store.gitBranches
			.filter((b) => !b.startsWith('remotes/'))
			.map((b) => ({ name: b + (checkedOutBranches.has(b) ? ' ' + strings.worktreeAlreadyCheckedOut : ''), value: b }));
		// Default to a branch git will actually accept: an already-checked-out branch cannot be
		// checked out in a NEW worktree (git refuses), so defaulting to the current branch made
		// the dialog's own default submission fail every time. A branch that is checked out is
		// still selectable explicitly — as the start point of a new branch.
		const defaultOption = branchOptions.find((option) => !checkedOutBranches.has(option.value)) || branchOptions[0] || { value: '' };

		ctx.dialog.showForm(strings.worktreeAddTitle, [
			{ type: DialogInputType.Text, name: strings.worktreePathLabel, default: '', placeholder: strings.worktreePathPlaceholder },
			{ type: DialogInputType.Select, name: strings.worktreeStartPointLabel, options: branchOptions, default: defaultOption.value },
			{ type: DialogInputType.Text, name: strings.worktreeNewBranchLabel, default: '', placeholder: strings.worktreeNewBranchPlaceholder, info: strings.worktreeNewBranchInfo }
		], strings.worktreeAddTitle, (values) => {
			const path = (<string>values[0]).trim(), startPoint = <string>values[1], newBranch = (<string>values[2]).trim();
			ctx.actions.run({
				command: 'worktreeAdd',
				repo: store.currentRepo,
				path: path,
				branch: startPoint,
				newBranch: newBranch === '' ? null : newBranch
			}, strings.addingWorktree);
		}, null);
	}

	private removeWorktreeAction(path: string) {
		const ctx = this.ctx();
		ctx.dialog.showForm(formatStr(strings.worktreeRemoveConfirm, path), [
			{ type: DialogInputType.Checkbox, name: strings.worktreeForceCheckbox, value: false, info: strings.worktreeRemoveForceInfo }
		], strings.worktreeRemoveTitle, (values) => {
			ctx.actions.run({ command: 'worktreeRemove', repo: ctx.store.currentRepo, path: path, force: <boolean>values[0] }, strings.removingWorktree);
		}, null);
	}
}
