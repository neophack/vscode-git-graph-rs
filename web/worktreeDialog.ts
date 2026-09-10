/**
 * Implements the Git Graph View's Worktree Widget: an overlay (matching the SettingsWidget /
 * ReflogView pattern) listing the repository's worktrees, with Add / Remove / Prune actions.
 * There is no sidebar TreeView in this project (unlike a Worktrees activity-bar view elsewhere) -
 * this stays consistent with how branches/remotes/tags/stashes are already only ever exposed as
 * dropdown filters and dialogs inside this single webview panel, not a second top-level surface.
 */
class WorktreeDialog {
	private readonly view: GitGraphView;
	private readonly widgetElem: HTMLElement;
	private readonly contentElem: HTMLElement;
	private isOpen: boolean = false;
	private worktrees: ReadonlyArray<GG.GitWorktree> = [];

	constructor(view: GitGraphView) {
		this.view = view;

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'worktreeWidget';
		this.widgetElem.innerHTML = '<h2>' + escapeHtml(strings.worktreeDialogTitle) + '</h2><div id="worktreeContent"></div><div id="worktreeClose"></div>';
		document.body.appendChild(this.widgetElem);

		this.contentElem = document.getElementById('worktreeContent')!;

		const closeBtn = document.getElementById('worktreeClose')!;
		closeBtn.innerHTML = SVG_ICONS.close;
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
	}

	/** Re-request the worktree list, e.g. after a refresh-triggering action. */
	public refresh() {
		if (this.isOpen) this.load();
	}

	private load() {
		this.contentElem.innerHTML = '<div class="worktreeLoading">' + SVG_ICONS.loading + '</div>';
		sendMessage({ command: 'worktreeList', repo: this.view.currentRepo });
	}

	public processListResponse(msg: GG.ResponseWorktreeList) {
		if (!this.isOpen) return;
		this.worktrees = msg.worktrees;
		this.render();
	}

	private render() {
		let html = '';
		if (this.worktrees.length === 0) {
			html = '<div class="worktreeEmpty">' + escapeHtml(strings.worktreeNoneFound) + '</div>';
		} else {
			html = '<table class="worktreeTable"><tbody>';
			for (const worktree of this.worktrees) {
				const badges = (worktree.isMain ? ' <span class="worktreeBadge worktreeBadgeMain">' + escapeHtml(strings.worktreeMainBadge) + '</span>' : '')
					+ (worktree.locked ? ' <span class="worktreeBadge worktreeBadgeLocked">' + escapeHtml(strings.worktreeLocked) + '</span>' : '')
					+ (worktree.prunable ? ' <span class="worktreeBadge worktreeBadgePrunable" ' + helpTooltipAttrs(strings.worktreePrunableInfo) + '>' + escapeHtml(strings.worktreePrunable) + '</span>' : '');
				html += '<tr class="worktreeRow" data-path="' + escapeHtml(worktree.path) + '">'
					+ '<td class="worktreePathCol">' + escapeHtml(worktree.path) + badges + '</td>'
					+ '<td class="worktreeBranchCol">' + (worktree.branch !== null ? escapeHtml(worktree.branch) : '<i>' + escapeHtml(strings.worktreeDetached) + ' (' + abbrevCommit(worktree.hash) + ')</i>') + '</td>'
					+ '<td class="worktreeActionsCol">'
					+ (worktree.isMain ? '' : '<span class="worktreeRemoveBtn" role="button" tabindex="0" ' + helpTooltipAttrs(strings.worktreeRemoveTitle) + '>' + SVG_ICONS.trash + '</span>')
					+ '</td></tr>';
			}
			html += '</tbody></table>';
		}
		html += '<div id="worktreeAddBtn" class="roundedBtn" role="button" tabindex="0">' + escapeHtml(strings.worktreeAddTitle) + '</div>'
			+ '<div id="worktreePruneBtn" class="roundedBtn" role="button" tabindex="0">' + escapeHtml(strings.worktreePruneTitle) + '</div>';
		this.contentElem.innerHTML = html;

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
			dialog.showConfirmation(strings.worktreePruneConfirm, strings.worktreePruneTitle, () => {
				runAction({ command: 'worktreePrune', repo: this.view.currentRepo }, strings.worktreePruneTitle);
			}, null);
		});
	}

	private addWorktreeAction() {
		const view = this.view;
		const checkedOutBranches = new Set(this.worktrees.filter((w) => w.branch !== null).map((w) => w.branch));
		const branchOptions = view.gitBranches
			.filter((b) => !b.startsWith('remotes/'))
			.map((b) => ({ name: b + (checkedOutBranches.has(b) ? ' ' + strings.worktreeAlreadyCheckedOut : ''), value: b }));

		dialog.showForm(strings.worktreeAddTitle, [
			{ type: DialogInputType.Text, name: strings.worktreePathLabel, default: '', placeholder: strings.worktreePathPlaceholder },
			{ type: DialogInputType.Select, name: strings.worktreeStartPointLabel, options: branchOptions, default: view.gitBranchHead !== null ? view.gitBranchHead : (branchOptions.length > 0 ? branchOptions[0].value : '') },
			{ type: DialogInputType.Text, name: strings.worktreeNewBranchLabel, default: '', placeholder: strings.worktreeNewBranchPlaceholder, info: strings.worktreeNewBranchInfo }
		], strings.worktreeAddTitle, (values) => {
			const path = (<string>values[0]).trim(), startPoint = <string>values[1], newBranch = (<string>values[2]).trim();
			runAction({
				command: 'worktreeAdd',
				repo: view.currentRepo,
				path: path,
				branch: startPoint,
				newBranch: newBranch === '' ? null : newBranch
			}, strings.addingWorktree);
		}, null);
	}

	private removeWorktreeAction(path: string) {
		const view = this.view;
		dialog.showForm(formatStr(strings.worktreeRemoveConfirm, escapeHtml(path)), [
			{ type: DialogInputType.Checkbox, name: strings.worktreeForceCheckbox, value: false, info: strings.worktreeRemoveForceInfo }
		], strings.worktreeRemoveTitle, (values) => {
			runAction({ command: 'worktreeRemove', repo: view.currentRepo, path: path, force: <boolean>values[0] }, strings.removingWorktree);
		}, null);
	}
}
