/**
 * The Settings Widget: an overlay with the Repository Settings (the persisted state of the
 * current repository, its remotes, commit author, issue linking and pull request integrations,
 * Gerrit) and the Global Settings (the Extension Settings that shape the graph, commit loading,
 * fetching and review integrations), plus the entries of the repository tools.
 */

import { addListenerToClass, alterClass, CLASS_ACTIVE, CLASS_LOADING, CLASS_TRANSITION, makeKeyboardActivatable, makeKeyboardActivatableCollection, observeElemScroll } from '../../../common/dom';
import { helpTooltipAttrs, html, SafeHtml, setHtml } from '../../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../../common/i18n/index';
import { SVG_ICONS } from '../../../common/icons';
import * as GG from '../../../common/protocol';
import { arraysStrictlyEqualIgnoringOrder, formatCommaSeparatedList, getRepoName } from '../../../common/util';
import { GraphContext } from '../../context';
import { getIncludeCommitsMentionedByReflogs, getOnlyFollowFirstParent, getOnRepoLoadShowCheckedOutBranch, getOnRepoLoadShowSpecificBranches, getShowStashes, getShowTags } from '../../state/repoSettings';
import { SettingsWidgetState, TargetType } from '../../state/types';
import { DialogInputType } from '../dialog';
import { showIssueLinkingDialog, showPullRequestIntegrationDialog1 } from './integrationDialogs';
import { checkbox, dateFormatSettingValue, numberRow, renderBackendSection, selectRow } from './settingsHtml';

export class SettingsWidget {
	private currentRepo: string | null = null;
	private repo: Readonly<GG.GitRepoState> | null = null;
	private config: Readonly<GG.GitRepoConfig> | null = null;
	private loading: boolean = false;
	private commitAuthorsSeedAttempted: boolean = false;
	private scrollTop: number = 0;
	private repoColumnScrollTop: number = 0;
	private globalColumnScrollTop: number = 0;

	private readonly widgetElem: HTMLElement;
	private readonly contentsElem: HTMLElement;
	private readonly loadingElem: HTMLElement;

	constructor(private readonly ctx: () => GraphContext) {
		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'settingsWidget';
		setHtml(this.widgetElem, html`<h2>${strings.settingsTitle}</h2><div id="settingsContent"></div><div id="settingsLoading"></div><div id="settingsClose"></div>`);
		document.body.appendChild(this.widgetElem);

		observeElemScroll(this.widgetElem, this.scrollTop, (scrollTop) => {
			this.scrollTop = scrollTop;
		}, () => {
			if (this.currentRepo !== null) {
				this.ctx().persistence.saveState();
			}
		});

		this.contentsElem = document.getElementById('settingsContent')!;
		this.loadingElem = document.getElementById('settingsLoading')!;

		const settingsClose = document.getElementById('settingsClose')!;
		setHtml(settingsClose, SVG_ICONS.close);
		makeKeyboardActivatable(settingsClose);
		settingsClose.addEventListener('click', () => this.close());
	}

	/**
	 * Show the Settings Widget.
	 * @param currentRepo The repository that is currently loaded in the view.
	 * @param isInitialLoad Is this the initial load of the Setting Widget, or is it being shown when restoring a previous state.
	 * @param scrollTop The scrollTop the Settings Widget should initially be set to.
	 * @param repoColumnScrollTop The scrollTop the Repository Settings column should initially be set to.
	 * @param globalColumnScrollTop The scrollTop the Global Settings column should initially be set to.
	 */
	public show(currentRepo: string, isInitialLoad: boolean = true, scrollTop: number = 0, repoColumnScrollTop: number = 0, globalColumnScrollTop: number = 0) {
		if (this.currentRepo !== null) return;
		const ctx = this.ctx();
		this.currentRepo = currentRepo;
		this.scrollTop = scrollTop;
		this.repoColumnScrollTop = repoColumnScrollTop;
		this.globalColumnScrollTop = globalColumnScrollTop;
		alterClass(this.widgetElem, CLASS_TRANSITION, isInitialLoad);
		this.widgetElem.classList.add(CLASS_ACTIVE);
		ctx.persistence.saveState();
		this.refresh();
		if (isInitialLoad) {
			ctx.loader.requestLoadConfig();
		}
	}

	/** Refresh the Settings Widget after an action affecting it's content has completed. */
	public refresh() {
		if (this.currentRepo === null) return;
		const store = this.ctx().store;
		this.repo = store.getRepoState(this.currentRepo);
		this.config = store.gitConfig;
		this.loading = store.isConfigLoading();
		this.maybeSeedCommitAuthors();
		this.render();
	}

	/** Close the Settings Widget, sliding it up out of view. */
	public close() {
		if (this.currentRepo === null) return;
		this.currentRepo = null;
		this.repo = null;
		this.config = null;
		this.loading = false;
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.widgetElem.classList.remove(CLASS_LOADING);
		setHtml(this.contentsElem, html``);
		setHtml(this.loadingElem, html``);
		this.ctx().persistence.saveState();
	}


	/* State */

	public getState(): SettingsWidgetState {
		return {
			currentRepo: this.currentRepo,
			scrollTop: this.scrollTop,
			repoColumnScrollTop: this.repoColumnScrollTop,
			globalColumnScrollTop: this.globalColumnScrollTop
		};
	}

	/** Restore the Settings Widget to an existing state. */
	public restoreState(state: SettingsWidgetState) {
		if (state.currentRepo === null) return;
		this.show(state.currentRepo, false, state.scrollTop, state.repoColumnScrollTop || 0, state.globalColumnScrollTop || 0);
	}

	/** Is the Settings Widget currently visible. */
	public isVisible() {
		return this.currentRepo !== null;
	}


	/* Rendering */

	private render() {
		if (this.currentRepo !== null && this.repo !== null) {
			const ctx = this.ctx();
			const repoHtml = this.renderRepoColumn(this.currentRepo, this.repo);
			const globalHtml = this.renderGlobalColumn();

			setHtml(this.contentsElem, html`<div id="settingsColumns"><div class="settingsColumn" id="settingsRepoColumn"><h3 class="settingsColumnTitle" title="${strings.settingsColumnRepoHint}">${strings.settingsColumnRepo}</h3>${repoHtml}</div><div class="settingsColumn" id="settingsGlobalColumn"><h3 class="settingsColumnTitle" title="${strings.settingsColumnGlobalHint}">${strings.settingsColumnGlobal}</h3>${globalHtml}</div></div>`);

			observeElemScroll(document.getElementById('settingsRepoColumn'), this.repoColumnScrollTop, (scrollTop) => {
				this.repoColumnScrollTop = scrollTop;
			}, () => ctx.persistence.saveState());
			observeElemScroll(document.getElementById('settingsGlobalColumn'), this.globalColumnScrollTop, (scrollTop) => {
				this.globalColumnScrollTop = scrollTop;
			}, () => ctx.persistence.saveState());

			this.wireGlobalSettings();
			this.wireRepoSettings(this.repo);

			makeKeyboardActivatableCollection(this.widgetElem, '.settingsSectionButtons > div, .settingsSection > table td.btns > div, .hideRemoteBtn, .authorSwitchRow');
		}

		alterClass(this.widgetElem, CLASS_LOADING, this.loading);
		setHtml(this.loadingElem, this.loading ? html`<span>${SVG_ICONS.loading}${strings.loading}</span>` : html``);
		this.widgetElem.scrollTop = this.scrollTop;
		this.loadingElem.style.top = (this.scrollTop + (this.widgetElem.clientHeight / 2) - 12) + 'px';
	}

	private renderRepoColumn(currentRepo: string, repo: Readonly<GG.GitRepoState>): SafeHtml {
		const ctx = this.ctx(), store = ctx.store, viewConfig = store.config;
		const repoName = repo.name || getRepoName(currentRepo);

		const initialBranchesLocallyConfigured = repo.onRepoLoadShowCheckedOutBranch !== GG.BooleanOverride.Default || repo.onRepoLoadShowSpecificBranches !== null;
		const initialBranches: string[] = [];
		if (getOnRepoLoadShowCheckedOutBranch(repo.onRepoLoadShowCheckedOutBranch, viewConfig)) {
			initialBranches.push(strings.settingsCheckedOut);
		}
		const branchOptions = store.getBranchOptions();
		getOnRepoLoadShowSpecificBranches(repo.onRepoLoadShowSpecificBranches, viewConfig).forEach((branch) => {
			const option = branchOptions.find((option) => option.value === branch);
			if (option) {
				initialBranches.push(option.name);
			}
		});
		const initialBranchesStr = initialBranches.length > 0
			? formatCommaSeparatedList(initialBranches)
			: strings.settingsShowAll;

		const general = html`<div class="settingsSection general"><h3>${strings.settingsSectionGeneral}</h3><table><tr class="lineAbove"><td class="left">${strings.settingsNameLabel}</td><td class="leftWithEllipsis" title="${repoName + (repo.name === null ? strings.settingsNameDefault : '')}">${repoName}</td><td class="btns right"><div id="editRepoName" title="${strings.settingsEditNameTitle + ELLIPSIS}">${SVG_ICONS.pencil}</div>${repo.name !== null ? html` <div id="deleteRepoName" title="${strings.settingsDeleteNameTitle + ELLIPSIS}">${SVG_ICONS.close}</div>` : ''}</td></tr><tr class="lineBelow"><td class="left">${strings.settingsInitialBranchesLabel}</td><td class="leftWithEllipsis" title="${initialBranchesStr + ' (' + (initialBranchesLocallyConfigured ? strings.settingsLocal : strings.settingsGlobal) + ')'}">${initialBranchesStr}</td><td class="btns right"><div id="editInitialBranches" title="${strings.settingsEditInitialBranchesTitle + ELLIPSIS}">${SVG_ICONS.pencil}</div>${initialBranchesLocallyConfigured ? html` <div id="clearInitialBranches" title="${strings.settingsClearInitialBranchesTitle + ELLIPSIS}">${SVG_ICONS.close}</div>` : ''}</td></tr></table><label id="settingsShowStashes"><input type="checkbox" id="settingsShowStashesCheckbox" tabindex="-1"><span class="customCheckbox"></span>${strings.settingsShowStashes}</label><br/><label id="settingsShowTags"><input type="checkbox" id="settingsShowTagsCheckbox" tabindex="-1"><span class="customCheckbox"></span>${strings.settingsShowTags}</label><br/><label id="settingsIncludeCommitsMentionedByReflogs"><input type="checkbox" id="settingsIncludeCommitsMentionedByReflogsCheckbox" tabindex="-1"><span class="customCheckbox"></span>${strings.settingsIncludeReflogs}</label><span ${helpTooltipAttrs(strings.settingsIncludeReflogsInfo, 'settingsWidgetInfo')}>${SVG_ICONS.info}</span><br/><label id="settingsOnlyFollowFirstParent"><input type="checkbox" id="settingsOnlyFollowFirstParentCheckbox" tabindex="-1"><span class="customCheckbox"></span>${strings.settingsOnlyFirstParent}</label><span ${helpTooltipAttrs(strings.settingsOnlyFirstParentInfo, 'settingsWidgetInfo')}>${SVG_ICONS.info}</span></div>`;

		let gerrit = html`<div class="settingsSection"><h3>${strings.settingsSectionGerrit}</h3>${checkbox('settingsGerritFetchRefs', strings.settingsGerritFetchRefs, repo.gerritFetchRefs, strings.settingsGerritFetchRefsInfo)}`;
		if (repo.gerritFetchRefs) {
			// The per-repository fetch limit: how many changes are DISPLAYED (the most recent
			// ones passing the status filter). NULL (the default) follows the gerrit.fetchLimit
			// Extension Setting, which the row names so the effective value is always visible.
			const gerritFetchLimit = repo.gerritFetchLimit !== undefined ? repo.gerritFetchLimit : null;
			const fetchLimitStr = gerritFetchLimit !== null
				? String(gerritFetchLimit)
				: formatStr(strings.settingsGerritFetchLimitGlobal, String(viewConfig.gerrit.fetchLimit));
			gerrit = html`${gerrit}<div class="settingsSubLabel">${strings.settingsGerritStatusFilterLabel}</div>${checkbox('settingsGerritStatusNew', strings.settingsGerritStatusOpen, repo.gerritStatusFilter.new, null)}${checkbox('settingsGerritStatusMerged', strings.settingsGerritStatusMerged, repo.gerritStatusFilter.merged, null)}${checkbox('settingsGerritStatusAbandoned', strings.settingsGerritStatusAbandoned, repo.gerritStatusFilter.abandoned, null)}${checkbox('settingsGerritStatusWip', strings.settingsGerritStatusWip, repo.gerritStatusFilter.wip, null)}<table><tr class="lineAbove"><td class="left">${strings.settingsGerritFetchLimitLabel}<span ${helpTooltipAttrs(strings.settingsGerritFetchLimitInfo, 'settingsWidgetInfo')}>${SVG_ICONS.info}</span></td><td class="leftWithEllipsis" title="${fetchLimitStr}">${fetchLimitStr}</td><td class="btns right"><div id="editGerritFetchLimit" title="${strings.settingsGerritFetchLimitEditTitle + ELLIPSIS}">${SVG_ICONS.pencil}</div></td></tr></table>`;
		}
		gerrit = html`${gerrit}</div>`;

		let remotes: SafeHtml | string = '';
		const config = this.config;
		if (config !== null) {
			remotes = html`${this.renderCommitAuthorSection(config)}${this.renderRemotesSection(config, repo)}`;
		}

		const issueLinking = this.renderIssueLinkingSection(repo);
		const pullRequest = config !== null ? this.renderPullRequestSection(repo) : '';

		// The Repository Tools: the entries of the Reflog / Worktrees overlays. (Statistics
		// lives in the toolbar instead, between the path filter and the terminal buttons.)
		// They act on the repository open in the view, so they live in this (Repository) column
		// and follow the same button style as the other section action buttons.
		const tools = html`<div class="settingsSection"><h3>${strings.settingsSectionTools}</h3><div class="settingsSectionButtons"><div id="openReflogView" class="toolBtn">${SVG_ICONS.commit}${strings.settingsOpenReflog}</div><div id="openWorktreeDialog" class="toolBtn">${SVG_ICONS.package}${strings.settingsOpenWorktrees}</div></div></div>`;
		const configSection = html`<div class="settingsSection"><h3>${strings.settingsSectionConfig}</h3><div class="settingsSectionButtons"><div id="exportRepositoryConfig">${SVG_ICONS.package}${strings.settingsExportRepoConfig}</div></div></div>`;

		return html`${general}${gerrit}${remotes}${issueLinking}${pullRequest}${tools}${configSection}`;
	}

	/** The commit author selector: one row per configured author identity, plus the "Use Global Author" default. */
	private renderCommitAuthorSection(config: Readonly<GG.GitRepoConfig>): SafeHtml {
		// Selecting an author sets the repository's local user.name/user.email (so every commit
		// made in the repository - from any tool - uses it); selecting the global author removes
		// the local override. The identities and the global author itself are managed in the
		// Global Settings column.
		const userName = config.user.name, userEmail = config.user.email;
		const commitAuthors = this.ctx().store.config.commitAuthors;
		const hasLocalOverride = userName.local !== null || userEmail.local !== null;
		// The global author the repository follows: the configured identity the global Git
		// configuration matches, defaulting to the first identity (see getGlobalAuthorIndex)
		const globalAuthorIndex = this.getGlobalAuthorIndex(commitAuthors);
		const globalIdentity = globalAuthorIndex >= 0
			? commitAuthors[globalAuthorIndex].name + ' <' + commitAuthors[globalAuthorIndex].email + '>'
			: userName.global !== null || userEmail.global !== null
				? (userName.global !== null ? userName.global : '?') + ' <' + (userEmail.global !== null ? userEmail.global : '?') + '>'
				: strings.settingsNotSet;
		let activeAuthorIndex = -1, customLocalIdentity = hasLocalOverride;
		commitAuthors.forEach((author, i) => {
			if (userName.local === author.name && userEmail.local === author.email) {
				activeAuthorIndex = i;
				customLocalIdentity = false;
			}
		});

		return html`<div class="settingsSection centered"><h3>${strings.settingsSectionCommitAuthor}</h3><table><tr class="lineAbove authorSwitchRow${hasLocalOverride ? '' : ' active'}" id="useGlobalAuthorRow" title="${strings.settingsUseGlobalAuthor + ': ' + globalIdentity}"><td class="leftWithEllipsis">${strings.settingsUseGlobalAuthor} (${globalIdentity})</td><td class="right">${hasLocalOverride ? '' : html`<span class="authorCurrentBadge">${strings.settingsCurrentAuthor}</span>`}</td></tr>${commitAuthors.map((author, i) => {
			const authorStr = author.name + ' <' + author.email + '>';
			return html`<tr class="lineAbove authorSwitchRow${i === activeAuthorIndex ? ' active' : ''}" data-index="${i}" title="${authorStr}"><td class="leftWithEllipsis">${authorStr}</td><td class="right">${i === activeAuthorIndex ? html`<span class="authorCurrentBadge">${strings.settingsCurrentAuthor}</span>` : html`<span class="authorSwitchSelect" title="${authorStr}">${SVG_ICONS.check}</span>`}</td></tr>`;
		})}</table>${customLocalIdentity ? html`<span class="settingsCustomIdentity">${strings.settingsCustomLocalIdentity}</span><br/>` : ''}${commitAuthors.length === 0 ? html`<span class="settingsNoAuthorsHint">${strings.settingsNoAuthorsRepoHint}</span>` : ''}</div>`;
	}

	private renderRemotesSection(config: Readonly<GG.GitRepoConfig>, repo: Readonly<GG.GitRepoState>): SafeHtml {
		const hideRemotes = repo.hideRemotes;
		const rows = config.remotes.length > 0
			? config.remotes.map((remote, i) => {
				const hidden = hideRemotes.includes(remote.name);
				const fetchUrl = remote.url || strings.settingsNotSet, pushUrl = remote.pushUrl || remote.url || strings.settingsNotSet;
				return html`<tr class="lineAbove"><td class="left" rowspan="2"><span class="hideRemoteBtn" data-index="${i}" title="${hidden ? strings.settingsHideRemoteTitle : strings.settingsShowRemoteTitle}">${hidden ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen}</span>${remote.name}</td><td class="leftWithEllipsis" title="${strings.settingsFetchUrlInput + ': ' + fetchUrl}">${fetchUrl}</td><td>${strings.settingsFetch}</td><td class="btns remoteBtns" rowspan="2" data-index="${i}"><div class="fetchRemote" title="${strings.settingsFetchFromRemoteTitle + ELLIPSIS}">${SVG_ICONS.download}</div> <div class="pruneRemote" title="${strings.settingsPruneRemoteTitle + ELLIPSIS}">${SVG_ICONS.branch}</div><br><div class="editRemote" title="${strings.settingsEditRemoteTitle + ELLIPSIS}">${SVG_ICONS.pencil}</div> <div class="deleteRemote" title="${strings.settingsDeleteRemoteTitle + ELLIPSIS}">${SVG_ICONS.close}</div></td></tr><tr><td class="leftWithEllipsis" title="${strings.settingsPushUrlInput + ': ' + pushUrl}">${pushUrl}</td><td>${strings.settingsPush}</td></tr>`;
			})
			: [html`<tr class="lineAbove"><td colspan="4">${strings.settingsNoRemotes}</td></tr>`];
		return html`<div class="settingsSection"><h3>${strings.settingsSectionRemotes}</h3><table><tr><th>${strings.settingsRemote}</th><th>${strings.settingsUrl}</th><th>${strings.settingsType}</th><th>${strings.settingsAction}</th></tr>${rows}</table><div class="settingsSectionButtons lineAbove"><div id="settingsAddRemote" class="addBtn">${SVG_ICONS.plus}${strings.settingsAddRemote}</div></div></div>`;
	}

	private renderIssueLinkingSection(repo: Readonly<GG.GitRepoState>): SafeHtml {
		const issueLinkingConfig = repo.issueLinkingConfig || this.ctx().store.globalViewState.issueLinkingConfig;
		return html`<div class="settingsSection centered"><h3>${strings.settingsSectionIssueLinking}</h3>${issueLinkingConfig !== null
			? html`<table><tr><td class="left">${strings.settingsIssueRegexLabel}</td><td class="leftWithEllipsis" title="${issueLinkingConfig.issue}">${issueLinkingConfig.issue}</td></tr><tr><td class="left">${strings.settingsIssueUrlLabel}</td><td class="leftWithEllipsis" title="${issueLinkingConfig.url}">${issueLinkingConfig.url}</td></tr></table><div class="settingsSectionButtons"><div id="editIssueLinking" class="editBtn">${SVG_ICONS.pencil}${strings.settingsEdit}</div><div id="removeIssueLinking" class="removeBtn">${SVG_ICONS.close}${strings.settingsRemove}</div></div>`
			: html`<span>${markup.settingsIssueLinkingIntro}</span><div class="settingsSectionButtons"><div id="editIssueLinking" class="addBtn">${SVG_ICONS.plus}${strings.settingsAddIssueLinking}</div></div>`}</div>`;
	}

	private renderPullRequestSection(repo: Readonly<GG.GitRepoState>): SafeHtml {
		const pullRequestConfig = repo.pullRequestConfig;
		let body: SafeHtml;
		if (pullRequestConfig !== null) {
			const provider = (pullRequestConfig.provider === GG.PullRequestProvider.Bitbucket
				? 'Bitbucket'
				: pullRequestConfig.provider === GG.PullRequestProvider.Custom
					? pullRequestConfig.custom.name
					: pullRequestConfig.provider === GG.PullRequestProvider.GitHub
						? 'GitHub'
						: 'GitLab'
			) + ' (' + pullRequestConfig.hostRootUrl + ')';
			const source = pullRequestConfig.sourceOwner + '/' + pullRequestConfig.sourceRepo + ' (' + pullRequestConfig.sourceRemote + ')';
			const destination = pullRequestConfig.destOwner + '/' + pullRequestConfig.destRepo + (pullRequestConfig.destRemote !== null ? ' (' + pullRequestConfig.destRemote + ')' : '');
			const destinationBranch = pullRequestConfig.destBranch;
			body = html`<table><tr><td class="left">${strings.settingsProviderLabel}</td><td class="leftWithEllipsis" title="${provider}">${provider}</td></tr><tr><td class="left">${strings.settingsSourceRepoLabel}</td><td class="leftWithEllipsis" title="${source}">${source}</td></tr><tr><td class="left">${strings.settingsDestinationRepoLabel}</td><td class="leftWithEllipsis" title="${destination}">${destination}</td></tr><tr><td class="left">${strings.settingsDestinationBranchLabel}</td><td class="leftWithEllipsis" title="${destinationBranch}">${destinationBranch}</td></tr></table><div class="settingsSectionButtons"><div id="editPullRequestIntegration" class="editBtn">${SVG_ICONS.pencil}${strings.settingsEdit}</div><div id="removePullRequestIntegration" class="removeBtn">${SVG_ICONS.close}${strings.settingsRemove}</div></div>`;
		} else {
			body = html`<span>${strings.settingsPrIntro}</span><div class="settingsSectionButtons"><div id="editPullRequestIntegration" class="addBtn">${SVG_ICONS.plus}${strings.settingsConfigurePrIntegration}</div></div>`;
		}
		return html`<div class="settingsSection centered"><h3>${strings.settingsSectionPullRequest}</h3>${body}</div>`;
	}

	private renderGlobalColumn(): SafeHtml {
		const store = this.ctx().store, viewConfig = store.config;

		const graphDisplay = html`<div class="settingsSection"><h3>${strings.settingsSectionGraphDisplay}</h3><table>${selectRow('settingsInterfaceLanguage', strings.settingsInterfaceLanguageLabel, [
			{ name: strings.settingsLanguageAuto, value: 'auto' },
			{ name: strings.settingsLanguageEnglish, value: 'en' },
			{ name: strings.settingsLanguageChinese, value: 'zh-cn' }
		], viewConfig.interfaceLanguageSetting)}${selectRow('settingsGraphStyle', strings.settingsGraphStyleLabel, [
			{ name: strings.settingsGraphStyleRounded, value: 'rounded' },
			{ name: strings.settingsGraphStyleAngular, value: 'angular' }
		], viewConfig.graph.style === GG.GraphStyle.Angular ? 'angular' : 'rounded')}${numberRow('settingsGraphRowHeight', strings.settingsGraphRowHeightLabel, viewConfig.graph.rowHeight, 16, 48, null)}${numberRow('settingsGraphFontSize', strings.settingsGraphFontSizeLabel, viewConfig.graph.fontSize, 8, 24, null)}${selectRow('settingsDateType', strings.settingsDateTypeLabel, [
			{ name: strings.settingsDateTypeAuthor, value: 'Author Date' },
			{ name: strings.settingsDateTypeCommit, value: 'Commit Date' }
		], viewConfig.dateType === GG.DateType.Commit ? 'Commit Date' : 'Author Date')}${selectRow('settingsDateFormat', strings.settingsDateFormatLabel, [
			{ name: strings.settingsDateFormatDateAndTime, value: 'Date & Time' },
			{ name: strings.settingsDateFormatDateOnly, value: 'Date Only' },
			{ name: strings.settingsDateFormatIsoDateAndTime, value: 'ISO Date & Time' },
			{ name: strings.settingsDateFormatIsoDateOnly, value: 'ISO Date Only' },
			{ name: strings.settingsDateFormatRelative, value: 'Relative' }
		], dateFormatSettingValue(viewConfig.dateFormat))}</table>${checkbox('settingsCombineBranchLabels', strings.settingsCombineBranchLabels, viewConfig.referenceLabels.combineLocalAndRemoteBranchLabels, null)}${checkbox('settingsStickyHeader', strings.settingsStickyHeader, viewConfig.stickyHeader, null)}${checkbox('settingsRenderMarkdown', strings.settingsRenderMarkdown, viewConfig.markdown, null)}${checkbox('settingsMobileAdaptation', strings.settingsMobileAdaptation, viewConfig.mobileAdaptation, strings.settingsMobileAdaptationInfo)}</div>`;

		const commitLoading = html`<div class="settingsSection"><h3>${strings.settingsSectionCommitLoading}</h3><table>${numberRow('settingsInitialLoad', strings.settingsInitialLoadLabel, viewConfig.initialLoadCommits, 1, 100000, strings.settingsCommitsUnit)}${numberRow('settingsLoadMore', strings.settingsLoadMoreLabel, viewConfig.loadMoreCommits, 1, 100000, strings.settingsCommitsUnit)}${selectRow('settingsCommitOrder', strings.settingsCommitOrderLabel, [
			{ name: strings.settingsCommitOrderDate, value: 'date' },
			{ name: strings.settingsCommitOrderAuthorDate, value: 'author-date' },
			{ name: strings.settingsCommitOrderTopo, value: 'topo' }
		], viewConfig.commitOrdering)}</table>${checkbox('settingsLoadMoreAutomatically', strings.settingsLoadMoreAutomatically, viewConfig.loadMoreCommitsAutomatically, null)}${checkbox('settingsFetchAvatars', strings.settingsFetchAvatars, viewConfig.fetchAvatars, null)}${checkbox('settingsShowUncommittedChanges', strings.settingsShowUncommittedChanges, viewConfig.showUncommittedChanges, null)}${checkbox('settingsShowUntrackedFiles', strings.settingsShowUntrackedFiles, viewConfig.showUntrackedFiles, null)}</div>`;

		// The author identities: managed here. One of them is the global author - the identity
		// every repository without its own selection follows - defaulting to the FIRST identity
		// and changeable with the check button of any author
		const savedAuthors = viewConfig.commitAuthors;
		const globalAuthorIndex = this.getGlobalAuthorIndex(savedAuthors);
		const authors = html`<div class="settingsSection centered"><h3>${strings.settingsSectionAuthors}</h3><span>${strings.settingsAuthorsIntro}</span><table class="authorTable"><tr><th>${strings.settingsAuthorNameInput}</th><th>${strings.settingsAuthorEmailInput}</th><th>${strings.settingsGlobalAuthorBadge}</th><th>${strings.settingsAction}</th></tr>${savedAuthors.length > 0
			? savedAuthors.map((author, i) =>
				html`<tr class="lineAbove"><td class="leftWithEllipsis" title="${author.name}">${author.name}</td><td class="leftWithEllipsis" title="${author.email}">${author.email}</td>${i === globalAuthorIndex
					? html`<td><span class="authorGlobalBadge" title="${strings.settingsGlobalAuthorBadgeTitle}">${strings.settingsGlobalAuthorBadge}</span></td>`
					: html`<td class="btns"><div class="setGlobalAuthor" data-index="${i}" title="${strings.settingsSetGlobalAuthorTitle}">${SVG_ICONS.check}</div></td>`}<td class="btns authorBtns" data-index="${i}"><div class="editAuthor" title="${strings.settingsEditAuthorTitle + ELLIPSIS}">${SVG_ICONS.pencil}</div> <div class="deleteAuthor" title="${strings.settingsDeleteAuthorTitle + ELLIPSIS}">${SVG_ICONS.close}</div></td></tr>`)
			: html`<tr class="lineAbove"><td colspan="4">${strings.settingsNoAuthors}</td></tr>`}</table><div class="settingsSectionButtons lineAbove"><div id="settingsAddAuthor" class="addBtn">${SVG_ICONS.plus}${strings.settingsAddAuthor}</div></div></div>`;

		const fetching = html`<div class="settingsSection"><h3>${strings.settingsSectionRemotesFetching}</h3>${checkbox('settingsFetchAndPrune', strings.settingsFetchAndPrune, viewConfig.fetchAndPrune, null)}${checkbox('settingsFetchAndPruneTags', strings.settingsFetchAndPruneTags, viewConfig.fetchAndPruneTags, strings.settingsFetchAndPruneTagsInfo)}${checkbox('settingsTrackRemoteTags', strings.settingsTrackRemoteTags, viewConfig.trackRemoteTags, null)}${checkbox('settingsShowRemoteBranchesGlobal', strings.settingsShowRemoteBranchesGlobal, viewConfig.showRemoteBranches, null)}${checkbox('settingsShowRemoteHeads', strings.settingsShowRemoteHeads, viewConfig.showRemoteHeads, null)}</div>`;

		const review = html`<div class="settingsSection"><h3>${strings.settingsSectionReviewIntegration}</h3>${checkbox('settingsPullRequestsEnabled', strings.settingsPullRequestsEnabled, viewConfig.pullRequests.enabled, strings.settingsPullRequestsEnabledInfo)}</div>`;

		const log = html`<div class="settingsSection centered"><h3>${strings.settingsSectionLog}</h3>${checkbox('settingsEnableLog', strings.settingsEnableLog, viewConfig.enableLog, strings.settingsEnableLogInfo)}<div class="settingsSectionButtons"><div id="openLogFile">${SVG_ICONS.file}${strings.settingsOpenLogFile}</div></div></div>`;

		const extension = html`<div class="settingsSection"><h3>${strings.settingsSectionConfig}</h3><div class="settingsSectionButtons"><div id="openExtensionSettings">${SVG_ICONS.gear}${strings.settingsOpenExtensionSettings}</div></div></div>`;

		return html`${graphDisplay}${commitLoading}${authors}${fetching}${review}${log}${extension}${renderBackendSection(store.backend)}`;
	}


	/* Wiring */

	private wireGlobalSettings() {
		const ctx = this.ctx(), viewConfig = ctx.store.config;
		this.wireGlobalSelect('settingsGraphStyle', 'graph.style');
		this.wireGlobalNumber('settingsGraphRowHeight', 'graph.rowHeight', 16, 48, viewConfig.graph.rowHeight);
		this.wireGlobalNumber('settingsGraphFontSize', 'graph.fontSize', 8, 24, viewConfig.graph.fontSize);
		this.wireGlobalSelect('settingsDateType', 'date.type');
		this.wireGlobalSelect('settingsDateFormat', 'date.format');
		this.wireGlobalCheckbox('settingsCombineBranchLabels', 'referenceLabels.combineLocalAndRemoteBranchLabels');
		this.wireGlobalCheckbox('settingsStickyHeader', 'stickyHeader');
		this.wireGlobalCheckbox('settingsRenderMarkdown', 'markdown');
		this.wireGlobalCheckbox('settingsMobileAdaptation', 'mobileAdaptation');
		this.wireGlobalCheckbox('settingsEnableLog', 'enableLog');

		this.wireGlobalNumber('settingsInitialLoad', 'repository.commits.initialLoad', 1, 100000, viewConfig.initialLoadCommits);
		this.wireGlobalNumber('settingsLoadMore', 'repository.commits.loadMore', 1, 100000, viewConfig.loadMoreCommits);
		this.wireGlobalSelect('settingsCommitOrder', 'repository.commits.order');
		this.wireGlobalCheckbox('settingsLoadMoreAutomatically', 'repository.commits.loadMoreAutomatically');
		this.wireGlobalCheckbox('settingsFetchAvatars', 'repository.commits.fetchAvatars');
		this.wireGlobalCheckbox('settingsShowUncommittedChanges', 'repository.showUncommittedChanges');
		this.wireGlobalCheckbox('settingsShowUntrackedFiles', 'repository.showUntrackedFiles');

		this.wireGlobalCheckbox('settingsFetchAndPrune', 'repository.fetchAndPrune');
		this.wireGlobalCheckbox('settingsFetchAndPruneTags', 'repository.fetchAndPruneTags');
		this.wireGlobalCheckbox('settingsTrackRemoteTags', 'repository.trackRemoteTags');
		this.wireGlobalCheckbox('settingsShowRemoteBranchesGlobal', 'repository.showRemoteBranches');
		this.wireGlobalCheckbox('settingsShowRemoteHeads', 'repository.showRemoteHeads');

		this.wireGlobalCheckbox('settingsPullRequestsEnabled', 'pullRequests.enabled');

		document.getElementById('settingsAddAuthor')!.addEventListener('click', () => {
			this.showAuthorDialog(-1);
		});
		addListenerToClass(document, 'editAuthor', 'click', (e) => {
			this.showAuthorDialog(this.getAuthorIndexForBtnEvent(e));
		});
		addListenerToClass(document, 'deleteAuthor', 'click', (e) => {
			const index = this.getAuthorIndexForBtnEvent(e);
			const authors = this.getCommitAuthors();
			const author = authors[index];
			if (author === undefined) return;
			ctx.dialog.showConfirmation(formatStr(markup.settingsDeleteAuthorConfirm, author.name, author.email), strings.settingsYesRemove, () => {
				this.saveCommitAuthors(authors.filter((_author, i) => i !== index));
			}, null);
		});

		const interfaceLanguageElem = <HTMLSelectElement>document.getElementById('settingsInterfaceLanguage');
		interfaceLanguageElem.value = viewConfig.interfaceLanguageSetting;
		interfaceLanguageElem.addEventListener('change', () => {
			const value = interfaceLanguageElem.value;
			const language: 'auto' | 'en' | 'zh-cn' = value === 'en' || value === 'zh-cn' ? value : 'auto';
			if (language === ctx.store.config.interfaceLanguageSetting) return;
			// Saving the setting reloads the Git Graph View, which re-renders everything in the new language
			ctx.actions.run({ command: 'setInterfaceLanguage', language: language }, strings.settingsSavingLanguage);
		});

		document.getElementById('openExtensionSettings')!.addEventListener('click', () => {
			ctx.bridge.send({ command: 'openExtensionSettings' });
		});

		document.getElementById('openLogFile')!.addEventListener('click', () => {
			ctx.bridge.send({ command: 'openLogFile' });
		});
	}

	private wireRepoSettings(repo: Readonly<GG.GitRepoState>) {
		const ctx = this.ctx(), store = ctx.store, viewConfig = store.config;
		const initialBranchesLocallyConfigured = repo.onRepoLoadShowCheckedOutBranch !== GG.BooleanOverride.Default || repo.onRepoLoadShowSpecificBranches !== null;

		document.getElementById('editRepoName')!.addEventListener('click', () => {
			if (this.currentRepo === null || this.repo === null) return;
			ctx.dialog.showForm(strings.settingsNameDialogMessage, [
				{ type: DialogInputType.Text, name: strings.settingsNameInput, default: this.repo.name || '', placeholder: getRepoName(this.currentRepo) }
			], strings.settingsNameDialogSave, (values) => {
				if (this.currentRepo === null) return;
				ctx.persistence.saveRepoStateValue(this.currentRepo, 'name', <string>values[0] || null);
				ctx.controls.renderRepoDropdownOptions();
				this.render();
			}, null);
		});

		if (repo.name !== null) {
			document.getElementById('deleteRepoName')!.addEventListener('click', () => {
				if (this.currentRepo === null || this.repo === null || this.repo.name === null) return;
				ctx.dialog.showConfirmation(formatStr(markup.settingsDeleteNameConfirm, this.repo.name, getRepoName(this.currentRepo)), strings.settingsYesDelete, () => {
					if (this.currentRepo === null) return;
					ctx.persistence.saveRepoStateValue(this.currentRepo, 'name', null);
					ctx.controls.renderRepoDropdownOptions();
					this.render();
				}, null);
			});
		}

		document.getElementById('editInitialBranches')!.addEventListener('click', () => {
			if (this.repo === null) return;
			const showCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch, viewConfig);
			const showSpecificBranches = getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches, viewConfig);
			ctx.dialog.showForm(html`${markup.settingsInitialBranchesDialogHeader}<p style="margin:6px 0;">${strings.settingsInitialBranchesDialogText}</p><p style="font-size:12px; margin:6px 0 0 0;">${strings.settingsInitialBranchesDialogNote}</p>`, [
				{ type: DialogInputType.Checkbox, name: strings.settingsInitialBranchesCheckedOutInput, value: showCheckedOutBranch },
				{ type: DialogInputType.Select, name: strings.settingsInitialBranchesSpecificInput, options: store.getBranchOptions(), defaults: showSpecificBranches, multiple: true }
			], strings.settingsSaveConfiguration, (values) => {
				if (this.currentRepo === null) return;
				if (showCheckedOutBranch !== values[0] || !arraysStrictlyEqualIgnoringOrder(showSpecificBranches, <string[]>values[1])) {
					ctx.persistence.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', values[0] ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
					ctx.persistence.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', <string[]>values[1]);
					this.render();
				}
			}, null, strings.dialogCancel, null, false);
		});

		if (initialBranchesLocallyConfigured) {
			document.getElementById('clearInitialBranches')!.addEventListener('click', () => {
				ctx.dialog.showConfirmation(strings.settingsClearInitialBranchesConfirm, strings.settingsYesClear, () => {
					if (this.currentRepo === null) return;
					ctx.persistence.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', GG.BooleanOverride.Default);
					ctx.persistence.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', null);
					this.render();
				}, null);
			});
		}

		const repoBooleanOverrides: ReadonlyArray<{ id: string, key: 'showStashes' | 'showTags' | 'includeCommitsMentionedByReflogs' | 'onlyFollowFirstParent', get: (value: GG.BooleanOverride) => boolean }> = [
			{ id: 'settingsShowStashesCheckbox', key: 'showStashes', get: (value) => getShowStashes(value, viewConfig) },
			{ id: 'settingsShowTagsCheckbox', key: 'showTags', get: (value) => getShowTags(value, viewConfig) },
			{ id: 'settingsIncludeCommitsMentionedByReflogsCheckbox', key: 'includeCommitsMentionedByReflogs', get: (value) => getIncludeCommitsMentionedByReflogs(value, viewConfig) },
			{ id: 'settingsOnlyFollowFirstParentCheckbox', key: 'onlyFollowFirstParent', get: (value) => getOnlyFollowFirstParent(value, viewConfig) }
		];
		for (const field of repoBooleanOverrides) {
			const elem = <HTMLInputElement>document.getElementById(field.id);
			elem.checked = field.get(repo[field.key]);
			elem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const current = <HTMLInputElement | null>document.getElementById(field.id);
				if (current === null) return;
				ctx.persistence.saveRepoStateValue(this.currentRepo, field.key, current.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				ctx.loader.refresh(true);
			});
		}

		const gerritFetchRefsElem = <HTMLInputElement | null>document.getElementById('settingsGerritFetchRefsCheckbox');
		if (gerritFetchRefsElem !== null) {
			gerritFetchRefsElem.addEventListener('change', () => {
				if (this.currentRepo === null || this.repo === null) return;
				if (gerritFetchRefsElem.checked) {
					// Enabling: the repository is marked stale on the extension host, so the
					// reload triggered by the response runs the Gerrit fetch pipeline
					this.setGerritFetchRefs(true);
				} else {
					// Disabling deletes the locally fetched change refs: confirm first
					ctx.dialog.showConfirmation(markup.settingsGerritDisableConfirm, strings.settingsGerritDisableAction, () => {
						this.setGerritFetchRefs(false);
					}, null);
					gerritFetchRefsElem.checked = true; // restored unless the confirmation runs the disable
				}
			});
		}

		const gerritStatusFields: ReadonlyArray<{ id: string, status: keyof GG.GerritStatusFilter }> = [
			{ id: 'settingsGerritStatusNew', status: 'new' },
			{ id: 'settingsGerritStatusMerged', status: 'merged' },
			{ id: 'settingsGerritStatusAbandoned', status: 'abandoned' },
			{ id: 'settingsGerritStatusWip', status: 'wip' }
		];
		for (const field of gerritStatusFields) {
			const elem = <HTMLInputElement | null>document.getElementById(field.id + 'Checkbox');
			if (elem === null) continue;
			elem.addEventListener('change', () => {
				if (this.currentRepo === null || this.repo === null) return;
				const statusFilter = Object.assign({}, this.repo.gerritStatusFilter);
				statusFilter[field.status] = elem.checked;
				ctx.persistence.saveRepoStateValue(this.currentRepo, 'gerritStatusFilter', statusFilter);
				// The badges re-render instantly from the loaded states; the graph reload (which
				// change refs are injected) follows in the background
				ctx.loader.applyGerritFilterChange();
			});
		}

		const editGerritFetchLimitElem = document.getElementById('editGerritFetchLimit');
		if (editGerritFetchLimitElem !== null) {
			editGerritFetchLimitElem.addEventListener('click', () => {
				if (this.currentRepo === null || this.repo === null) return;
				const current = this.repo.gerritFetchLimit !== undefined ? this.repo.gerritFetchLimit : null;
				ctx.dialog.showForm(strings.settingsGerritFetchLimitEditTitle, [
					{ type: DialogInputType.Text, name: strings.settingsGerritFetchLimitInput, default: current !== null ? String(current) : '', placeholder: strings.settingsGerritFetchLimitPlaceholder }
				], strings.settingsSave, (values) => {
					if (this.currentRepo === null) return;
					// An empty input (or anything not a positive number) clears the override,
					// following the gerrit.fetchLimit Extension Setting again; a value is clamped
					// into the 1..10000 range the setting allows
					const raw = String(values[0]).trim();
					const parsed = parseInt(raw, 10);
					const limit = raw !== '' && isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), 10000) : null;
					ctx.persistence.saveRepoStateValue(this.currentRepo, 'gerritFetchLimit', limit);
					this.render();
					// The set of fetched changes changes with the limit: reload, so the Gerrit
					// pipeline re-fetches under it (the staged load updates the view as it arrives)
					ctx.loader.refresh(false);
				}, null);
			});
		}

		if (this.config !== null) {
			this.wireConfigSettings();
		}

		document.getElementById('editIssueLinking')!.addEventListener('click', () => {
			if (this.repo === null) return;
			const globalIssueLinking = store.globalViewState.issueLinkingConfig;
			const issueLinkingConfig = this.repo.issueLinkingConfig || globalIssueLinking;
			const save = (config: GG.IssueLinkingConfig, global: boolean) => this.setIssueLinkingConfig(config, global);
			if (issueLinkingConfig !== null) {
				showIssueLinkingDialog(ctx, issueLinkingConfig.issue, issueLinkingConfig.url, this.repo.issueLinkingConfig === null && globalIssueLinking !== null, true, save);
			} else {
				showIssueLinkingDialog(ctx, null, null, false, false, save);
			}
		});

		if (repo.issueLinkingConfig !== null || store.globalViewState.issueLinkingConfig !== null) {
			document.getElementById('removeIssueLinking')!.addEventListener('click', () => {
				if (this.repo === null) return;
				const locallyConfigured = this.repo.issueLinkingConfig !== null;
				const globalConfigured = store.globalViewState.issueLinkingConfig !== null;
				ctx.dialog.showConfirmation(html`${strings.settingsRemoveConfirmPrefix}${locallyConfigured ? html`${globalConfigured ? markup.settingsRemoveIssueLinkingLocal : ''}${strings.settingsRemoveIssueLinkingFromRepo}` : markup.settingsRemoveIssueLinkingGlobal}?`, strings.settingsYesRemove, () => {
					this.setIssueLinkingConfig(null, !locallyConfigured);
				}, null);
			});
		}

		if (this.config !== null) {
			document.getElementById('editPullRequestIntegration')!.addEventListener('click', () => {
				if (this.repo === null || this.config === null) return;

				if (this.config.remotes.length === 0) {
					ctx.dialog.showError(strings.settingsUnableToConfigurePr, strings.settingsPrNeedsRemote, null, null);
					return;
				}

				let config: GG.DeepWriteable<GG.PullRequestConfig>;
				if (this.repo.pullRequestConfig === null) {
					const originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
					const sourceRemoteUrl = this.config.remotes[originIndex > -1 ? originIndex : 0].url;
					let provider: GG.PullRequestProvider;
					if (sourceRemoteUrl !== null) {
						if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*github/) !== null) {
							provider = GG.PullRequestProvider.GitHub;
						} else if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*gitlab/) !== null) {
							provider = GG.PullRequestProvider.GitLab;
						} else {
							provider = GG.PullRequestProvider.Bitbucket;
						}
					} else {
						provider = GG.PullRequestProvider.Bitbucket;
					}
					config = {
						provider: provider, hostRootUrl: '',
						sourceRemote: '', sourceOwner: '', sourceRepo: '',
						destRemote: '', destOwner: '', destRepo: '', destProjectId: '', destBranch: '',
						custom: null
					};
				} else {
					config = Object.assign({}, this.repo.pullRequestConfig);
				}
				showPullRequestIntegrationDialog1(ctx, config, this.config.remotes, (finished) => this.setPullRequestConfig(finished));
			});

			if (repo.pullRequestConfig !== null) {
				document.getElementById('removePullRequestIntegration')!.addEventListener('click', () => {
					ctx.dialog.showConfirmation(strings.settingsRemovePrConfirm, strings.settingsYesRemove, () => {
						this.setPullRequestConfig(null);
					}, null);
				});
			}
		}

		document.getElementById('exportRepositoryConfig')!.addEventListener('click', () => {
			ctx.dialog.showConfirmation(strings.settingsExportRepoConfigConfirm, strings.settingsYesExport, () => {
				if (this.currentRepo === null) return;
				ctx.actions.run({ command: 'exportRepoConfig', repo: this.currentRepo }, strings.settingsExportingRepoConfig);
			}, null);
		});

		// The Repository Tools open as overlays over the view: close the Settings Widget first,
		// so the tool slides down in its place instead of the two overlays stacking
		document.getElementById('openReflogView')!.addEventListener('click', () => this.openRepositoryTool(ctx.widgets.reflog));
		document.getElementById('openWorktreeDialog')!.addEventListener('click', () => this.openRepositoryTool(ctx.widgets.worktree));
	}

	/** The actions that need the repository's configuration: authors, remotes. */
	private wireConfigSettings() {
		const ctx = this.ctx(), store = ctx.store;

		// Applying an author identity to this repository writes its name and email to the
		// repository's local Git configuration, so every commit made in the repository -
		// from any tool - uses the selected identity
		addListenerToClass(document, 'authorSwitchRow', 'click', (e) => {
			if (this.currentRepo === null || this.config === null) return;
			const row = <HTMLElement>(<Element>e.target).closest('.authorSwitchRow')!;
			if (row.id === 'useGlobalAuthorRow') return; // handled by its own listener
			const author = this.getCommitAuthors()[parseInt(row.dataset.index!)];
			if (author === undefined) return;
			const userName = this.config.user.name, userEmail = this.config.user.email;
			if (userName.local === author.name && userEmail.local === author.email) return; // already applied
			ctx.actions.run({
				command: 'editUserDetails',
				repo: this.currentRepo,
				name: author.name,
				email: author.email,
				location: GG.GitConfigLocation.Local,
				deleteLocalName: false,
				deleteLocalEmail: false
			}, strings.settingsSettingUserDetails);
		});

		// "Use Global Author" makes the repository follow the global author again: the local
		// override is removed. When the global author is still the implicit default (the
		// first identity, not materialised into the global Git configuration yet), it is
		// written there as part of the same action, so the commits really use it
		document.getElementById('useGlobalAuthorRow')!.addEventListener('click', () => {
			if (this.currentRepo === null || this.config === null) return;
			const userName = this.config.user.name, userEmail = this.config.user.email;
			const hasLocalOverride = userName.local !== null || userEmail.local !== null;
			const authors = this.getCommitAuthors();
			const globalMatches = authors.some((author) => userName.global === author.name && userEmail.global === author.email);
			if (globalMatches) {
				if (!hasLocalOverride) return; // already following the global author
				ctx.actions.run({
					command: 'deleteUserDetails',
					repo: this.currentRepo,
					name: userName.local !== null,
					email: userEmail.local !== null,
					location: GG.GitConfigLocation.Local
				}, strings.settingsRemovingUserDetails);
			} else if (authors.length > 0) {
				ctx.actions.run({
					command: 'editUserDetails',
					repo: this.currentRepo,
					name: authors[0].name,
					email: authors[0].email,
					location: GG.GitConfigLocation.Global,
					deleteLocalName: userName.local !== null,
					deleteLocalEmail: userEmail.local !== null
				}, strings.settingsSettingUserDetails);
			} else if (hasLocalOverride) {
				ctx.actions.run({
					command: 'deleteUserDetails',
					repo: this.currentRepo,
					name: userName.local !== null,
					email: userEmail.local !== null,
					location: GG.GitConfigLocation.Local
				}, strings.settingsRemovingUserDetails);
			}
		});

		// Setting an author as the global default writes it to the global Git
		// configuration; repositories without their own selection follow it
		addListenerToClass(document, 'setGlobalAuthor', 'click', (e) => {
			if (this.currentRepo === null || this.config === null) return;
			const author = this.getCommitAuthors()[this.getAuthorIndexForBtnEvent(e)];
			if (author === undefined) return;
			ctx.actions.run({
				command: 'editUserDetails',
				repo: this.currentRepo,
				name: author.name,
				email: author.email,
				location: GG.GitConfigLocation.Global,
				deleteLocalName: false,
				deleteLocalEmail: false
			}, strings.settingsSettingUserDetails);
		});

		document.getElementById('settingsAddRemote')!.addEventListener('click', () => {
			ctx.dialog.showForm(strings.settingsAddRemoteDialogMessage, [
				{ type: DialogInputType.Text, name: strings.settingsNameInput, default: '', placeholder: null },
				{ type: DialogInputType.Text, name: strings.settingsFetchUrlInput, default: '', placeholder: null },
				{ type: DialogInputType.Text, name: strings.settingsPushUrlInput, default: '', placeholder: strings.settingsPushUrlPlaceholder },
				{ type: DialogInputType.Checkbox, name: strings.settingsFetchImmediately, value: true }
			], strings.settingsAddRemote, (values) => {
				if (this.currentRepo === null) return;
				ctx.actions.run({ command: 'addRemote', repo: this.currentRepo, name: <string>values[0], url: <string>values[1], pushUrl: <string>values[2] !== '' ? <string>values[2] : null, fetch: <boolean>values[3] }, strings.settingsAddingRemote);
			}, { type: TargetType.Repo });
		});

		addListenerToClass(document, 'editRemote', 'click', (e) => {
			const remote = this.getRemoteForBtnEvent(e);
			if (remote === null) return;
			ctx.dialog.showForm(formatStr(markup.settingsEditRemoteDialogMessage, remote.name), [
				{ type: DialogInputType.Text, name: strings.settingsNameInput, default: remote.name, placeholder: null },
				{ type: DialogInputType.Text, name: strings.settingsFetchUrlInput, default: remote.url !== null ? remote.url : '', placeholder: null },
				{ type: DialogInputType.Text, name: strings.settingsPushUrlInput, default: remote.pushUrl !== null ? remote.pushUrl : '', placeholder: strings.settingsPushUrlPlaceholder }
			], strings.settingsSaveChanges, (values) => {
				if (this.currentRepo === null) return;
				ctx.actions.run({ command: 'editRemote', repo: this.currentRepo, nameOld: remote.name, nameNew: <string>values[0], urlOld: remote.url, urlNew: <string>values[1] !== '' ? <string>values[1] : null, pushUrlOld: remote.pushUrl, pushUrlNew: <string>values[2] !== '' ? <string>values[2] : null }, strings.settingsSavingRemoteChanges);
			}, { type: TargetType.Repo });
		});

		addListenerToClass(document, 'deleteRemote', 'click', (e) => {
			const remote = this.getRemoteForBtnEvent(e);
			if (remote === null) return;
			ctx.dialog.showConfirmation(formatStr(markup.settingsDeleteRemoteConfirm, remote.name), strings.settingsYesDelete, () => {
				if (this.currentRepo === null) return;
				ctx.actions.run({ command: 'deleteRemote', repo: this.currentRepo, name: remote.name }, strings.settingsDeletingRemote);
			}, { type: TargetType.Repo });
		});

		addListenerToClass(document, 'fetchRemote', 'click', (e) => {
			const remote = this.getRemoteForBtnEvent(e);
			if (remote === null) return;
			ctx.dialog.showForm(formatStr(markup.settingsFetchRemoteConfirm, remote.name), [
				{ type: DialogInputType.Checkbox, name: strings.settingsPrune, value: store.config.dialogDefaults.fetchRemote.prune, info: strings.settingsPruneInfo },
				{ type: DialogInputType.Checkbox, name: strings.settingsPruneTags, value: store.config.dialogDefaults.fetchRemote.pruneTags, info: strings.settingsPruneTagsInfo }
			], strings.settingsYesFetch, (values) => {
				if (this.currentRepo === null) return;
				ctx.actions.run({ command: 'fetch', repo: this.currentRepo, name: remote.name, prune: <boolean>values[0], pruneTags: <boolean>values[1] }, strings.settingsFetchingFromRemote);
			}, { type: TargetType.Repo });
		});

		addListenerToClass(document, 'pruneRemote', 'click', (e) => {
			const remote = this.getRemoteForBtnEvent(e);
			if (remote === null) return;
			ctx.dialog.showConfirmation(formatStr(markup.settingsPruneRemoteConfirm, remote.name), strings.settingsYesPrune, () => {
				if (this.currentRepo === null) return;
				ctx.actions.run({ command: 'pruneRemote', repo: this.currentRepo, name: remote.name }, strings.settingsPruningRemote);
			}, { type: TargetType.Repo });
		});

		addListenerToClass(document, 'hideRemoteBtn', 'click', (e) => {
			if (this.currentRepo === null || this.repo === null || this.config === null) return;
			const source = <HTMLElement>(<Element>e.target).closest('.hideRemoteBtn')!;
			const remote = this.config.remotes[parseInt(source.dataset.index!)].name;
			const hideRemote = !this.repo.hideRemotes.includes(remote);
			source.title = hideRemote ? strings.settingsHideRemoteTitle : strings.settingsShowRemoteTitle;
			setHtml(source, hideRemote ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen);
			if (hideRemote) {
				this.repo.hideRemotes.push(remote);
			} else {
				this.repo.hideRemotes.splice(this.repo.hideRemotes.indexOf(remote), 1);
			}
			ctx.persistence.saveRepoStateValue(this.currentRepo, 'hideRemotes', this.repo.hideRemotes);
			ctx.loader.refresh(true);
		});
	}


	/* Global Setting wiring helpers */

	/**
	 * Save a Global Setting, and display the "Saving Setting" action running state while it is saved.
	 * @param setting The key of the setting, relative to the `git-graph-rs` section.
	 * @param value The new value of the setting.
	 * @param previousValue What the widget last rendered for the setting, when the host needs
	 * what the user saw rather than its own (possibly lagging) configuration read.
	 */
	private saveGlobalSetting(setting: string, value: GG.GlobalSettingValue, previousValue?: GG.GlobalSettingValue) {
		this.ctx().actions.run({ command: 'setGlobalSetting', setting: setting, value: value, previousValue: previousValue }, strings.settingsSavingSetting);
	}

	/** Wire a checkbox rendered by `checkbox()` to the Global Setting it controls. */
	private wireGlobalCheckbox(id: string, setting: string) {
		const elem = <HTMLInputElement | null>document.getElementById(id + 'Checkbox');
		if (elem === null) return;
		elem.addEventListener('change', () => this.saveGlobalSetting(setting, elem.checked));
	}

	/** Wire a `<select>` rendered by `selectRow()` to the Global Setting it controls. */
	private wireGlobalSelect(id: string, setting: string) {
		const elem = <HTMLSelectElement | null>document.getElementById(id);
		if (elem === null) return;
		elem.addEventListener('change', () => this.saveGlobalSetting(setting, elem.value));
	}

	/**
	 * Wire a numeric `<input>` rendered by `numberRow()` to the Global Setting it controls.
	 * Values outside [min, max] (and non-numeric input) are rejected, restoring the saved value.
	 */
	private wireGlobalNumber(id: string, setting: string, min: number, max: number, current: number) {
		const elem = <HTMLInputElement | null>document.getElementById(id);
		if (elem === null) return;
		elem.addEventListener('change', () => {
			const value = parseInt(elem.value, 10);
			if (isNaN(value) || value < min || value > max) {
				elem.value = String(current);
				return;
			}
			if (value === current) return;
			this.saveGlobalSetting(setting, value);
		});
	}


	/* Private helpers */

	/**
	 * Open one of the Repository Tools (the Reflog or Worktrees overlay) from the Settings Widget:
	 * the Settings Widget is closed first, so the tool takes its place instead of the two overlays
	 * stacking on top of each other.
	 */
	private openRepositoryTool(tool: { show(): void }) {
		if (this.currentRepo === null) return;
		this.close();
		tool.show();
	}

	/**
	 * While the `git-graph-rs.commitAuthors` Extension Setting is empty, the author list shown
	 * by the widget is seeded from the identity already configured in the global Git
	 * configuration (user.name/user.email): that identity becomes the first author - and
	 * therefore the global author - so adding further identities can never silently replace
	 * it. An empty list means "follow what Git already has"; Git having no complete global
	 * identity leaves the list empty until the user configures one.
	 *
	 * The seeding is one-shot: it is attempted at most once per widget, and never once the
	 * list has held any identity. Saving the setting re-loads the configuration, which
	 * synchronously re-renders the widget before the saved setting is visible, so re-running
	 * the seeding would recurse without end - and a list the user emptied deliberately must
	 * stay empty instead of being re-seeded with the global identity.
	 */
	private maybeSeedCommitAuthors() {
		if (this.commitAuthorsSeedAttempted) return;
		if (this.config === null) return;
		if (this.ctx().store.config.commitAuthors.length > 0) {
			// The list is managed by the user: emptying it later is deliberate, not a fresh
			// start the global Git identity should be seeded into again
			this.commitAuthorsSeedAttempted = true;
			return;
		}
		const name = this.config.user.name.global, email = this.config.user.email.global;
		if (name === null || email === null) return;
		this.commitAuthorsSeedAttempted = true;
		this.saveCommitAuthors([{ name: name, email: email }]);
	}

	/** The author identities of the `git-graph-rs.commitAuthors` Extension Setting as a writeable copy, ready to be modified and saved back. */
	private getCommitAuthors(): GG.CommitAuthor[] {
		return this.ctx().store.config.commitAuthors.map((author) => ({ name: author.name, email: author.email }));
	}

	/**
	 * The index of the author identity that is the global author: the identity the global Git
	 * configuration matches or - when it matches none - the FIRST identity (the default), so
	 * repositories following the global configuration always have a well-defined author. The
	 * default is materialised into the global Git configuration by the extension host whenever
	 * the identity list is saved, and can be changed with the check button of any author.
	 */
	private getGlobalAuthorIndex(authors: ReadonlyArray<GG.CommitAuthor>) {
		if (this.config === null) return -1;
		const name = this.config.user.name.global, email = this.config.user.email.global;
		const matched = authors.findIndex((author) => name === author.name && email === author.email);
		return matched >= 0 ? matched : authors.length > 0 ? 0 : -1;
	}

	/**
	 * Save the author identities of the `git-graph-rs.commitAuthors` Extension Setting. The
	 * extension host may default the global author to the first identity while saving (writing
	 * the global Git configuration), or clear the global author when the list is emptied; the
	 * save's response tells the view to reload the repository configuration once those writes
	 * have completed, and the fresh snapshot re-renders the Settings Widget. A reload issued HERE
	 * would race the save's Git writes and render the pre-save global author. Values the setting
	 * rejects (e.g. an empty name or email) are reported through the save action's response dialog.
	 */
	private saveCommitAuthors(authors: GG.CommitAuthor[]) {
		// The list the widget rendered is what the global-author side effects of the save are
		// judged against on the host: deleting the last identity clears the global author it
		// held, even when the host's own configuration read has not caught up with the editor.
		this.saveGlobalSetting('commitAuthors', authors, this.getCommitAuthors());
	}

	/** The index of the author identity a settings widget element event belongs to. */
	private getAuthorIndexForBtnEvent(e: Event) {
		return parseInt((<HTMLElement>(<Element>e.target).closest('[data-index]')!).dataset.index!);
	}

	/** Show the dialog for adding (index -1) or editing (index of the author) an author identity. */
	private showAuthorDialog(index: number) {
		const authors = this.getCommitAuthors();
		const author = index >= 0 && index < authors.length ? authors[index] : null;
		this.ctx().dialog.showForm(author !== null ? strings.settingsEditAuthorDialogMessage : strings.settingsAddAuthorDialogMessage, [
			{ type: DialogInputType.Text, name: strings.settingsAuthorNameInput, default: author !== null ? author.name : '', placeholder: null },
			{ type: DialogInputType.Text, name: strings.settingsAuthorEmailInput, default: author !== null ? author.email : '', placeholder: null }
		], strings.settingsSaveAuthor, (values) => {
			const name = (<string>values[0]).trim(), email = (<string>values[1]).trim();
			if (author !== null && author.name === name && author.email === email) return; // unchanged
			const next = this.getCommitAuthors();
			if (author !== null) {
				next[index] = { name: name, email: email };
			} else {
				next.push({ name: name, email: email });
			}
			this.saveCommitAuthors(next);
		}, null);
	}

	/**
	 * Save the issue linking configuration for this repository, and refresh the view so these changes are taken into affect.
	 * @param config The issue linking configuration to save.
	 * @param global Should this configuration be set globally for all repositories, or locally for this specific repository.
	 */
	private setIssueLinkingConfig(config: GG.IssueLinkingConfig | null, global: boolean) {
		if (this.currentRepo === null || this.repo === null) return;
		const ctx = this.ctx();

		if (global) {
			if (this.repo.issueLinkingConfig !== null) {
				ctx.persistence.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', null);
			}
			ctx.persistence.updateGlobalViewState('issueLinkingConfig', config);
		} else {
			ctx.persistence.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', config);
		}

		ctx.loader.refresh(true);
		this.render();
	}

	/**
	 * Persist the "Fetch Gerrit change refs" checkbox of the Repository Settings and run the
	 * corresponding host action: enabling marks the repository's Gerrit data stale (so the reload
	 * triggered by the response fetches the change refs from the remote), disabling deletes the
	 * locally fetched change refs. The response reloads the Git Graph View either way.
	 */
	private setGerritFetchRefs(enabled: boolean) {
		if (this.currentRepo === null) return;
		const ctx = this.ctx();
		ctx.persistence.saveRepoStateValue(this.currentRepo, 'gerritFetchRefs', enabled);
		ctx.actions.run({ command: 'gerritSetFetchRefs', repo: this.currentRepo, enabled: enabled }, enabled ? strings.settingsGerritEnabling : strings.settingsGerritClearing);
		this.render();
	}

	/** Save the pull request configuration for this repository. */
	private setPullRequestConfig(config: GG.PullRequestConfig | null) {
		if (this.currentRepo === null) return;
		this.ctx().persistence.saveRepoStateValue(this.currentRepo, 'pullRequestConfig', config);
		this.render();
	}

	/** The remote whose button a settings widget event came from. */
	private getRemoteForBtnEvent(e: Event) {
		return this.config !== null
			? this.config.remotes[parseInt((<HTMLElement>(<Element>e.target).closest('.remoteBtns')!).dataset.index!)]
			: null;
	}
}
