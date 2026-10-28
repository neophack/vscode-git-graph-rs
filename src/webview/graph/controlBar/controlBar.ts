/**
 * The control bar at the top of the view: the repository / branch / author dropdowns, the "Show
 * Remote Branches" checkbox and the toolbar buttons (scroll to HEAD, fetch, find, filter by path,
 * statistics, terminal, settings, refresh) - and, in the mobile layout, the overflow menu that
 * takes over every control the narrow app bar has no room for.
 */

import { alterClass, CLASS_ACTIVE, CLASS_MOBILE_MODE, CLASS_TABLET_MODE, makeKeyboardActivatable } from '../../common/dom';
import { html, SafeHtml, setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { getRepoName, getSortedRepositoryPaths, getSubRepoPath, SHOW_ALL_BRANCHES } from '../../common/util';
import { GraphContext } from '../context';
import { fetchFromRemotesAction } from '../actions/dialogActions';
import { measureToolbarOverflow } from '../render/measure';
import { getShowRemoteBranches } from '../state/repoSettings';
import { DialogInputType } from '../widgets/dialog';
import { Dropdown, DropdownOption } from '../widgets/dropdown';

const CLASS_REFRESHING = 'refreshing';
const CLASS_FETCH_SUPPORTED = 'fetchSupported';

/**
 * The tablet toolbar's overflow state, as data attributes rather than classes: the observers that
 * re-measure the toolbar watch class changes, and must not be woken by their own result.
 * ATTR_OVERFLOWED marks an item moved into the ⋯ menu, ATTR_OVERFLOWING the bar that shows ⋯.
 */
const ATTR_OVERFLOWED = 'data-overflowed';
const ATTR_OVERFLOWING = 'data-overflowing';

/**
 * The tablet toolbar's items that move into the ⋯ menu as the bar runs out of room, the first to
 * go first: the less-used actions, then the filters. Find and Refresh always stay in the bar.
 */
const TOOLBAR_OVERFLOW_ORDER = ['statisticsBtn', 'terminalBtn', 'settingsBtn', 'currentBtn', 'filterBtn', 'fetchBtn', 'showRemoteBranchesControl', 'authorControl'];

/**
 * The options of the repository dropdown: a short name for every repository (the closest path
 * suffix that tells it apart from the others), a hint naming the distinguishing directories, and
 * the path relative to the containing repository of a submodule or nested repository.
 */
export function getRepoDropdownOptions(repos: Readonly<GG.GitRepoSet>, repoDropdownOrder: GG.RepoDropdownOrder): DropdownOption[] {
	const repoPaths = getSortedRepositoryPaths(repos, repoDropdownOrder);
	const paths: string[] = [], names: string[] = [], distinctNames: string[] = [], firstSep: number[] = [];
	const resolveAmbiguous = (indexes: number[]) => {
		// Find ambiguous names within indexes
		const firstOccurrence: { [name: string]: number } = {}, ambiguous: { [name: string]: number[] } = {};
		for (let i = 0; i < indexes.length; i++) {
			const name = distinctNames[indexes[i]];
			if (typeof firstOccurrence[name] === 'number') {
				// name is ambiguous
				if (typeof ambiguous[name] === 'undefined') {
					// initialise ambiguous array with the first occurrence
					ambiguous[name] = [firstOccurrence[name]];
				}
				ambiguous[name].push(indexes[i]); // append current ambiguous index
			} else {
				firstOccurrence[name] = indexes[i]; // set the first occurrence of the name
			}
		}

		const ambiguousNames = Object.keys(ambiguous);
		for (let i = 0; i < ambiguousNames.length; i++) {
			// For each ambiguous name, resolve the ambiguous indexes
			const ambiguousIndexes = ambiguous[ambiguousNames[i]], retestIndexes = [];
			for (let j = 0; j < ambiguousIndexes.length; j++) {
				const ambiguousIndex = ambiguousIndexes[j];
				const nextSep = paths[ambiguousIndex].lastIndexOf('/', paths[ambiguousIndex].length - distinctNames[ambiguousIndex].length - 2);
				if (firstSep[ambiguousIndex] < nextSep) {
					// prepend the addition path and retest
					distinctNames[ambiguousIndex] = paths[ambiguousIndex].substring(nextSep + 1);
					retestIndexes.push(ambiguousIndex);
				} else {
					distinctNames[ambiguousIndex] = paths[ambiguousIndex];
				}
			}
			if (retestIndexes.length > 1) {
				// If there are 2 or more indexes that may be ambiguous
				resolveAmbiguous(retestIndexes);
			}
		}
	};

	// Initialise recursion
	const indexes = [];
	for (let i = 0; i < repoPaths.length; i++) {
		firstSep.push(repoPaths[i].indexOf('/'));
		const repo = repos[repoPaths[i]];
		if (repo.name) {
			// A name has been set for the repository
			paths.push(repoPaths[i]);
			names.push(repo.name);
			distinctNames.push(repo.name);
		} else if (firstSep[i] === repoPaths[i].length - 1 || firstSep[i] === -1) {
			// Path has no slashes, or a single trailing slash ==> use the path as the name
			paths.push(repoPaths[i]);
			names.push(repoPaths[i]);
			distinctNames.push(repoPaths[i]);
		} else {
			paths.push(repoPaths[i].endsWith('/') ? repoPaths[i].substring(0, repoPaths[i].length - 1) : repoPaths[i]); // Remove trailing slash if it exists
			const name = paths[i].substring(paths[i].lastIndexOf('/') + 1);
			names.push(name);
			distinctNames.push(name);
			indexes.push(i);
		}
	}
	resolveAmbiguous(indexes);

	// A sub-repository is shown by its short name like every other repository, with its path
	// relative to the closest containing repository as the tooltip of the option
	const subRepoPaths = repoPaths.map((path) => getSubRepoPath(path.endsWith('/') ? path.substring(0, path.length - 1) : path, repos));

	const options: DropdownOption[] = [];
	for (let i = 0; i < repoPaths.length; i++) {
		let hint;
		if (names[i] === distinctNames[i]) {
			// Name is distinct, no hint needed
			hint = '';
		} else {
			// Hint path is the prefix of the distinctName before the common suffix with name
			const hintPath = distinctNames[i].substring(0, distinctNames[i].length - names[i].length - 1);

			// Keep two informative directories
			const hintComps = hintPath.split('/');
			const keepDirs = hintComps[0] !== '' ? 2 : 3;
			if (hintComps.length > keepDirs) hintComps.splice(keepDirs, hintComps.length - keepDirs, '...');

			// Construct the hint
			hint = (distinctNames[i] !== paths[i] ? '.../' : '') + hintComps.join('/');
		}
		options.push({ name: names[i], value: repoPaths[i], hint: hint, title: subRepoPaths[i] !== null ? subRepoPaths[i]! : undefined });
	}
	return options;
}

export class ControlBar {
	public repoDropdown!: Dropdown;
	public branchDropdown!: Dropdown;
	public authorDropdown!: Dropdown;
	public showRemoteBranchesElem!: HTMLInputElement;
	private refreshBtnElem!: HTMLElement;
	/** Disconnect the observers that re-measure the tablet toolbar's overflow. */
	private stopObservingOverflow: (() => void) | null = null;

	constructor(private readonly ctx: () => GraphContext) { }

	/** One of the toolbar's elements, by id, under the skeleton's #controls subtree (F3). */
	private byId(id: string): HTMLElement | null {
		return this.ctx().dom.controls.querySelector<HTMLElement>('#' + id);
	}

	/**
	 * Tear the control bar's own components down (F3): the dropdowns. They own the bar's only
	 * page-level listeners (the document-level capture handlers) besides the toolbar's overflow
	 * observers; the toolbar buttons' handlers sit on the host-rendered skeleton, which lives and
	 * dies with the page itself.
	 */
	public dispose() {
		this.repoDropdown.dispose();
		this.branchDropdown.dispose();
		this.authorDropdown.dispose();
		if (this.stopObservingOverflow !== null) {
			this.stopObservingOverflow();
			this.stopObservingOverflow = null;
		}
	}

	/** Create the dropdowns and wire the controls (once the rest of the view exists). */
	public init() {
		const ctx = this.ctx(), store = ctx.store;
		// The control bar's elements are the skeleton's #controls subtree (F3): look them up there
		const byId = (id: string) => ctx.dom.controls.querySelector<HTMLElement>('#' + id)!;

		this.repoDropdown = new Dropdown(byId('repoDropdown'), true, false, strings.dropdownRepos, (values) => {
			ctx.loader.loadRepo(values[0]);
		}, (option) => {
			ctx.dialog.showMessage(html`<strong>${strings.repoInfoTitle}</strong><br>${formatStr(strings.repoInfoPath, option.value)}`);
		});

		this.branchDropdown = new Dropdown(byId('branchDropdown'), false, true, strings.dropdownBranches, (values) => {
			store.slices.refs.setBranchSelection(values);
			store.slices.commits.setMaxCommits(store.config.initialLoadCommits);
			ctx.persistence.saveState();
			ctx.loader.clearCommits();
			ctx.loader.requestLoadRepoInfoAndCommits(true, true);
		});
		this.authorDropdown = new Dropdown(byId('authorDropdown'), false, true, strings.dropdownAuthors, (values) => {
			store.slices.refs.setAuthorSelection(values);
			store.slices.commits.setMaxCommits(store.config.initialLoadCommits);
			ctx.persistence.saveState();
			ctx.loader.clearCommits();
			ctx.loader.requestLoadRepoInfoAndCommits(true, true);
		});

		this.showRemoteBranchesElem = <HTMLInputElement>byId('showRemoteBranchesCheckbox');
		this.showRemoteBranchesElem.addEventListener('change', () => {
			ctx.persistence.saveRepoStateValue(store.currentRepo, 'showRemoteBranchesV2', this.showRemoteBranchesElem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
			// The hard refresh clears the table while the commit query stays the same: keep the
			// reading position (see the refresh button's capture)
			ctx.viewport.capturePendingViewportAnchor();
			ctx.loader.refresh(true);
		});

		this.refreshBtnElem = byId('refreshBtn');
		this.refreshBtnElem.tabIndex = 0;
		this.refreshBtnElem.setAttribute('role', 'button');
		makeKeyboardActivatable(this.refreshBtnElem);
		this.refreshBtnElem.addEventListener('click', () => {
			// No in-progress guard: a click while a (background or snapshot) refresh cycle is in
			// flight must JOIN that cycle — requestLoadRepoInfoAndCommits re-requests the data and
			// the hard flag escalates it — never be swallowed. The old "ignore the click while the
			// button spins" guard silently dropped the click when a watcher/poll-driven refresh was
			// mid-flight, and the clicker (a user, or an automation step waiting for the
			// loadRepoInfo response that never comes) waited forever.
			// The hard refresh below clears the table (the scroll height collapses with it, and
			// the browser clamps scrollTop to 0): remember where the user was reading, so the
			// reloaded same-query list renders back around it instead of resetting to the top
			ctx.viewport.capturePendingViewportAnchor();
			// An explicit refresh must also re-query the pull request states: the requested
			// repositories are a one-shot cache, so without dropping the entry a request merged
			// since the view loaded keeps its badge showing "open" until the webview is reloaded.
			ctx.loader.forgetPullRequestsRequest(store.currentRepo);
			ctx.loader.refresh(true, true);
		});
		this.renderRefreshButton();
	}

	/** Wire the toolbar buttons (after the initial load was requested, as in the reference behaviour). */
	public initToolbar() {
		const ctx = this.ctx(), store = ctx.store;
		const controls = ctx.dom.controls;
		const currentBtn = controls.querySelector<HTMLElement>('#currentBtn')!, fetchBtn = controls.querySelector<HTMLElement>('#fetchBtn')!, findBtn = controls.querySelector<HTMLElement>('#findBtn')!, settingsBtn = controls.querySelector<HTMLElement>('#settingsBtn')!, terminalBtn = controls.querySelector<HTMLElement>('#terminalBtn')!;
		currentBtn.title = strings.scrollToHeadTitle;
		setHtml(currentBtn, SVG_ICONS.current);
		currentBtn.addEventListener('click', () => {
			if (store.commitHead) {
				ctx.viewport.scrollToCommit(store.commitHead, true, true);
			}
		});
		fetchBtn.title = store.config.fetchAndPrune ? strings.fetchAndPruneTitle : strings.fetchTitle;
		setHtml(fetchBtn, SVG_ICONS.download);
		fetchBtn.addEventListener('click', () => fetchFromRemotesAction(ctx));
		findBtn.title = strings.findTitle;
		setHtml(findBtn, SVG_ICONS.search);
		findBtn.addEventListener('click', () => ctx.widgets.find.show(true));
		settingsBtn.title = strings.settingsTitle;
		setHtml(settingsBtn, SVG_ICONS.gear);
		settingsBtn.addEventListener('click', () => ctx.widgets.settings.show(store.currentRepo));
		terminalBtn.title = strings.terminalTitle;
		setHtml(terminalBtn, SVG_ICONS.terminal);
		terminalBtn.addEventListener('click', () => {
			ctx.actions.run({
				command: 'openTerminal',
				repo: store.currentRepo,
				name: store.repoState.name || getRepoName(store.currentRepo)
			}, strings.openingTerminal);
		});
		const filterBtn = controls.querySelector<HTMLElement>('#filterBtn');
		if (filterBtn !== null) {
			filterBtn.addEventListener('click', () => this.showPathFilterDialog());
			this.renderFilterButton();
		}
		const statisticsBtn = controls.querySelector<HTMLElement>('#statisticsBtn');
		if (statisticsBtn !== null) {
			statisticsBtn.title = strings.statisticsTitle;
			setHtml(statisticsBtn, SVG_ICONS.graph);
			statisticsBtn.addEventListener('click', () => ctx.widgets.statistics.show());
		}
		// The mobile layout's app bar keeps only Find and Refresh: every other control (and the
		// "Show Remote Branches" checkbox) moves into this overflow menu. The tablet toolbar moves
		// only what its width has no room for (updateToolbarOverflow). Hidden in the wide layout.
		const controlBtns = controls.querySelector<HTMLElement>('#controlBtns');
		let moreBtn: HTMLElement | null = null;
		if (controlBtns !== null) {
			moreBtn = document.createElement('div');
			moreBtn.id = 'mobileMoreBtn';
			moreBtn.title = strings.mobileMoreActions;
			setHtml(moreBtn, SVG_ICONS.ellipsis);
			controlBtns.appendChild(moreBtn);
			moreBtn.addEventListener('click', (e) => {
				e.stopPropagation(); // the document listener would close the menu as it opens
				this.showMobileOverflowMenu(e);
			});
		}

		// These toolbar icons are styled <div>s rather than native <button>s, so they need to be
		// wired into the tab order and given Enter/Space activation manually (the CSS already has
		// :focus-visible rules for them, they just weren't reachable by keyboard)
		[currentBtn, fetchBtn, findBtn, settingsBtn, terminalBtn, filterBtn, statisticsBtn, moreBtn].forEach((btn) => {
			if (btn === null) return;
			btn.tabIndex = 0;
			btn.setAttribute('role', 'button');
			makeKeyboardActivatable(btn);
		});

		this.observeToolbarOverflow();
	}

	/**
	 * Re-measure the tablet toolbar's overflow (once per animation frame) whenever its room or its
	 * contents may have changed: the bar's own size (a window resize, the side pane opening), the
	 * layout classes on <body>, and the classes inside the bar (a single repository hiding the
	 * repository filter, the fetch button appearing, the path filter turning active).
	 */
	private observeToolbarOverflow() {
		const controls = this.ctx().dom.controls;
		let rafId: number | null = null;
		const schedule = () => {
			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				this.updateToolbarOverflow();
			});
		};
		const disconnects: Array<() => void> = [];
		if (typeof ResizeObserver !== 'undefined') {
			const resizeObserver = new ResizeObserver(schedule);
			resizeObserver.observe(controls);
			disconnects.push(() => resizeObserver.disconnect());
		} else {
			window.addEventListener('resize', schedule);
			disconnects.push(() => window.removeEventListener('resize', schedule));
		}
		const classObserver = new MutationObserver(schedule);
		classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		classObserver.observe(controls, { attributes: true, attributeFilter: ['class'], subtree: true });
		disconnects.push(() => classObserver.disconnect());
		this.stopObservingOverflow = () => {
			disconnects.forEach((disconnect) => disconnect());
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
		schedule();
	}

	/**
	 * Fit the tablet toolbar to its width: measure the bar with every control in it, and while the
	 * actions are pushed past the bar's end (the filter capsules already shrunk to their floors),
	 * move the next item of TOOLBAR_OVERFLOW_ORDER into the ⋯ menu. An active path filter keeps
	 * its button in the bar as the indicator. The other layouts keep every item in place (the
	 * phone's app bar hides its own set in CSS).
	 */
	public updateToolbarOverflow() {
		const controls = this.ctx().dom.controls;
		const items = TOOLBAR_OVERFLOW_ORDER.map((id) => this.byId(id)).filter((item): item is HTMLElement => item !== null);
		items.forEach((item) => item.removeAttribute(ATTR_OVERFLOWED));
		controls.removeAttribute(ATTR_OVERFLOWING);

		const controlBtns = this.byId('controlBtns');
		if (controlBtns === null || !document.body.classList.contains(CLASS_TABLET_MODE)) return;
		const metrics = measureToolbarOverflow(controls, controlBtns, items, this.byId('findBtn'));
		// An unmeasured bar (a hidden background tab) is left whole until it is shown
		if (metrics.barWidth === 0 || metrics.excess <= 0.5) return;

		controls.setAttribute(ATTR_OVERFLOWING, '');
		let needed = metrics.excess + metrics.moreWidth;
		for (let i = 0; i < items.length && needed > 0.5; i++) {
			// A control not shown in the bar (no remotes to fetch from) frees nothing
			if (metrics.itemWidths[i] === 0 || (items[i].id === 'filterBtn' && items[i].classList.contains(CLASS_ACTIVE))) continue;
			items[i].setAttribute(ATTR_OVERFLOWED, '');
			needed -= metrics.itemWidths[i];
		}
	}

	/** Is a toolbar control in the ⋯ menu rather than the bar: all but the essentials on a phone, the overflowed ones on a tablet. */
	private isInOverflowMenu(id: string) {
		const elem = this.byId(id);
		return elem !== null && (document.body.classList.contains(CLASS_MOBILE_MODE) || elem.hasAttribute(ATTR_OVERFLOWED));
	}

	/**
	 * The mobile app bar's overflow menu (a bottom action sheet; a popover on a tablet): the
	 * toolbar buttons the bar has no room for, each triggering its hidden button so the two can
	 * never disagree, and the "Show Remote Branches" checkbox as a switch.
	 */
	private showMobileOverflowMenu(event: MouseEvent) {
		const ctx = this.ctx(), store = ctx.store;
		const controls = this.ctx().dom.controls;
		const click = (id: string) => () => { const btn = controls.querySelector<HTMLElement>('#' + id); if (btn !== null) btn.click(); };
		const inMenu = (id: string) => this.isInOverflowMenu(id);
		const item = (icon: SafeHtml, label: string): SafeHtml => html`<span class="mobileMenuIcon">${icon}</span><span class="mobileMenuLabel">${label}</span>`;
		const filterLabel = store.commitPathFilter !== null ? formatStr(strings.filterTitleActive, store.commitPathFilter) : strings.filterTitle;
		ctx.contextMenu.show([
			[
				{ title: item(SVG_ICONS.current, strings.mobileGoToHead), visible: store.commitHead !== null && inMenu('currentBtn'), onClick: click('currentBtn') },
				{ title: item(SVG_ICONS.download, store.config.fetchAndPrune ? strings.fetchAndPruneTitle : strings.fetchTitle), visible: store.gitRemotes.length > 0 && inMenu('fetchBtn'), onClick: click('fetchBtn') },
				{ title: item(SVG_ICONS.filter, filterLabel), visible: inMenu('filterBtn'), onClick: click('filterBtn') },
				{ title: item(SVG_ICONS.person, strings.mobileFilterAuthors), visible: store.gitConfig !== null && store.gitConfig.authors.length > 0 && inMenu('authorControl'), onClick: () => this.showMobileAuthorFilter() }
			],
			[
				{
					title: html`${item(SVG_ICONS.branch, strings.mobileShowRemoteBranches)}<span class="mobileMenuSwitch${this.showRemoteBranchesElem.checked ? ' on' : ''}"></span>`,
					visible: inMenu('showRemoteBranchesControl'),
					onClick: () => this.showRemoteBranchesElem.click()
				}
			],
			[
				{ title: item(SVG_ICONS.graph, strings.statisticsTitle), visible: inMenu('statisticsBtn'), onClick: click('statisticsBtn') },
				{ title: item(SVG_ICONS.terminal, strings.terminalTitle), visible: inMenu('terminalBtn'), onClick: click('terminalBtn') },
				{ title: item(SVG_ICONS.gear, strings.settingsTitle), visible: inMenu('settingsBtn'), onClick: click('settingsBtn') }
			]
		], false, null, event, ctx.dom.view, null, 'mobileOverflowMenu');
	}

	/**
	 * The mobile ⋯ sheet's author filter: the app bar has no room for the author dropdown, so its
	 * multi-select is offered as a checkbox dialog that applies the same reload the dropdown does.
	 */
	private showMobileAuthorFilter() {
		const ctx = this.ctx(), store = ctx.store;
		const options = store.getAuthorOptions();
		const selected = new Set(store.currentAuthors !== null ? store.currentAuthors : []);
		ctx.dialog.showForm(strings.mobileFilterAuthors, options.map((option) => ({
			type: DialogInputType.Checkbox as DialogInputType.Checkbox,
			name: option.name,
			value: selected.size === 0 ? option.value === SHOW_ALL_BRANCHES : selected.has(option.value)
		})), strings.dialogApply, (values) => {
			// The same rules as the dropdown's multi-select: "All Authors" is exclusive (dropped once
			// any author is checked), and checking nothing means all authors
			const chosen = options.filter((_option, i) => <boolean>values[i]).map((option) => option.value);
			const authors = chosen.filter((value) => value !== SHOW_ALL_BRANCHES);
			store.slices.refs.setAuthorSelection(authors.length > 0 ? authors : [SHOW_ALL_BRANCHES]);
			store.slices.commits.setMaxCommits(store.config.initialLoadCommits);
			ctx.persistence.saveState();
			ctx.loader.clearCommits();
			ctx.loader.requestLoadRepoInfoAndCommits(true, true);
		}, null);
	}

	/** Reflect whether the repository has remotes (the Fetch button is only offered then). */
	public renderFetchButton() {
		const ctx = this.ctx();
		alterClass(ctx.dom.controls, CLASS_FETCH_SUPPORTED, ctx.store.gitRemotes.length > 0);
	}

	/** Update the filter button to reflect the active path filter. */
	public renderFilterButton() {
		const filterBtn = this.byId('filterBtn');
		if (filterBtn === null) return;
		const store = this.ctx().store;
		setHtml(filterBtn, SVG_ICONS.filter);
		filterBtn.title = store.commitPathFilter !== null
			? formatStr(strings.filterTitleActive, store.commitPathFilter)
			: strings.filterTitle;
		alterClass(filterBtn, CLASS_ACTIVE, store.commitPathFilter !== null);
	}

	/** Show the dialog used to filter the loaded commits by a file path. */
	public showPathFilterDialog() {
		const ctx = this.ctx(), store = ctx.store;
		ctx.dialog.showForm(strings.filterByPathMessage, [{
			type: DialogInputType.Text,
			name: strings.filterPathName,
			default: store.commitPathFilter !== null ? store.commitPathFilter : '',
			placeholder: strings.filterPathPlaceholder
		}], strings.dialogApply, (values) => {
			// Normalise the comma-separated paths: trim whitespace around each path and drop
			// empty segments, so git receives clean pathspecs
			const filterPath = (<string>values[0]).split(',').map((path) => path.trim()).filter((path) => path !== '').join(',');
			store.slices.refs.setPathFilter(filterPath !== '' ? filterPath : null);
			this.renderFilterButton();
			// The filtered list is unrelated to the scrolled position in the full list
			ctx.dom.view.scrollTop = 0;
			ctx.loader.requestLoadRepoInfoAndCommits(true, true);
		}, null, strings.dialogClearFilter, () => {
			store.slices.refs.setPathFilter(null);
			this.renderFilterButton();
			ctx.dom.view.scrollTop = 0;
			ctx.loader.requestLoadRepoInfoAndCommits(true, true);
		});
	}

	/** (Re)apply the interface language to the toolbar's labels and titles. */
	public renderToolbarText() {
		const store = this.ctx().store;
		const setText = (id: string, text: string) => {
			const elem = this.byId(id);
			if (elem !== null) elem.textContent = text;
		};
		setText('repoControlLabel', strings.repoLabel);
		setText('branchControlLabel', strings.branchesLabel);
		setText('authorControlLabel', strings.authorsLabel);
		setText('showRemoteBranchesLabel', strings.showRemoteBranchesLabel);
		const showRemoteBranchesControl = this.byId('showRemoteBranchesControl');
		if (showRemoteBranchesControl !== null) showRemoteBranchesControl.title = strings.showRemoteBranchesTitle;
		const filterBtn = this.byId('filterBtn');
		if (filterBtn !== null) {
			filterBtn.title = store.commitPathFilter !== null
				? formatStr(strings.filterTitleActive, store.commitPathFilter)
				: strings.filterTitle;
		}
		setText('pinnedRowLabel', strings.pinnedLabel);
	}

	/** Reflect whether a refresh is in progress on the refresh button (also while a painted first-paint snapshot awaits its fresh data, D10). */
	public renderRefreshButton() {
		const refreshState = this.ctx().store.refreshState;
		const enabled = !refreshState.inProgress && !refreshState.snapshotRefreshing;
		this.refreshBtnElem.title = enabled ? strings.refreshTitle : strings.refreshingTitle;
		setHtml(this.refreshBtnElem, enabled ? SVG_ICONS.refresh : SVG_ICONS.loading);
		alterClass(this.refreshBtnElem, CLASS_REFRESHING, !enabled);
	}

	/** Set the options of the repository dropdown. */
	public renderRepoDropdownOptions(repo?: string) {
		const store = this.ctx().store;
		this.repoDropdown.setOptions(getRepoDropdownOptions(store.repos, store.config.repoDropdownOrder), [repo || store.currentRepo]);
	}

	/** Reflect the "Show Remote Branches" state of a repository on the checkbox. */
	public syncShowRemoteBranches() {
		const store = this.ctx().store;
		this.showRemoteBranchesElem.checked = getShowRemoteBranches(store.repoState.showRemoteBranchesV2, store.config);
	}
}
