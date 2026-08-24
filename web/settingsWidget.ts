interface SettingsWidgetState {
	readonly currentRepo: string | null;
	readonly scrollTop: number;
	readonly repoColumnScrollTop: number;
	readonly globalColumnScrollTop: number;
}

/**
 * Implements the Git Graph View's Settings Widget.
 */
class SettingsWidget {
	private readonly view: GitGraphView;
	private currentRepo: string | null = null;
	private repo: Readonly<GG.GitRepoState> | null = null;
	private config: Readonly<GG.GitRepoConfig> | null = null;
	private loading: boolean = false;
	private scrollTop: number = 0;
	private repoColumnScrollTop: number = 0;
	private globalColumnScrollTop: number = 0;

	private readonly widgetElem: HTMLElement;
	private readonly contentsElem: HTMLElement;
	private readonly loadingElem: HTMLElement;

	/**
	 * Construct a new SettingsWidget instance.
	 * @param view The Git Graph View that the SettingsWidget is for.
	 * @returns The SettingsWidget instance.
	 */
	constructor(view: GitGraphView) {
		this.view = view;

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'settingsWidget';
		this.widgetElem.innerHTML = '<h2>' + strings.settingsTitle + '</h2><div id="settingsContent"></div><div id="settingsLoading"></div><div id="settingsClose"></div>';
		document.body.appendChild(this.widgetElem);

		observeElemScroll('settingsWidget', this.scrollTop, (scrollTop) => {
			this.scrollTop = scrollTop;
		}, () => {
			if (this.currentRepo !== null) {
				this.view.saveState();
			}
		});

		this.contentsElem = document.getElementById('settingsContent')!;
		this.loadingElem = document.getElementById('settingsLoading')!;

		const settingsClose = document.getElementById('settingsClose')!;
		settingsClose.innerHTML = SVG_ICONS.close;
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
		this.currentRepo = currentRepo;
		this.scrollTop = scrollTop;
		this.repoColumnScrollTop = repoColumnScrollTop;
		this.globalColumnScrollTop = globalColumnScrollTop;
		alterClass(this.widgetElem, CLASS_TRANSITION, isInitialLoad);
		this.widgetElem.classList.add(CLASS_ACTIVE);
		this.view.saveState();
		this.refresh();
		if (isInitialLoad) {
			this.view.requestLoadConfig();
		}
	}

	/**
	 * Refresh the Settings Widget after an action affecting it's content has completed.
	 */
	public refresh() {
		if (this.currentRepo === null) return;
		this.repo = this.view.getRepoState(this.currentRepo);
		this.config = this.view.getRepoConfig();
		this.loading = this.view.isConfigLoading();
		this.render();
	}

	/**
	 * Close the Settings Widget, sliding it up out of view.
	 */
	public close() {
		if (this.currentRepo === null) return;
		this.currentRepo = null;
		this.repo = null;
		this.config = null;
		this.loading = false;
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.widgetElem.classList.remove(CLASS_LOADING);
		this.contentsElem.innerHTML = '';
		this.loadingElem.innerHTML = '';
		this.view.saveState();
	}


	/* State */

	/**
	 * Get the current state of the Settings Widget.
	 */
	public getState(): SettingsWidgetState {
		return {
			currentRepo: this.currentRepo,
			scrollTop: this.scrollTop,
			repoColumnScrollTop: this.repoColumnScrollTop,
			globalColumnScrollTop: this.globalColumnScrollTop
		};
	}

	/**
	 * Restore the Settings Widget to an existing state.
	 * @param state The previous Settings Widget state.
	 */
	public restoreState(state: SettingsWidgetState) {
		if (state.currentRepo === null) return;
		this.show(state.currentRepo, false, state.scrollTop, state.repoColumnScrollTop || 0, state.globalColumnScrollTop || 0);
	}

	/**
	 * Is the Settings Widget currently visible.
	 * @returns TRUE => the Settings Widget is visible, FALSE => the Settings Widget is not visible
	 */
	public isVisible() {
		return this.currentRepo !== null;
	}


	/* Render Methods */

	/**
	 * Render the Settings Widget.
	 */
	private render() {
		if (this.currentRepo !== null && this.repo !== null) {
			const escapedRepoName = escapeHtml(this.repo.name || getRepoName(this.currentRepo));

			const initialBranchesLocallyConfigured = this.repo.onRepoLoadShowCheckedOutBranch !== GG.BooleanOverride.Default || this.repo.onRepoLoadShowSpecificBranches !== null;
			const initialBranches: string[] = [];
			if (getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch)) {
				initialBranches.push(strings.settingsCheckedOut);
			}
			const branchOptions = this.view.getBranchOptions();
			getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches).forEach((branch) => {
				const option = branchOptions.find((option) => option.value === branch);
				if (option) {
					initialBranches.push(option.name);
				}
			});
			const initialBranchesStr = initialBranches.length > 0
				? escapeHtml(formatCommaSeparatedList(initialBranches))
				: strings.settingsShowAll;

			let repoHtml = '<div class="settingsSection general"><h3>' + strings.settingsSectionGeneral + '</h3>' +
				'<table>' +
				'<tr class="lineAbove"><td class="left">' + strings.settingsNameLabel + '</td><td class="leftWithEllipsis" title="' + escapedRepoName + (this.repo.name === null ? strings.settingsNameDefault : '') + '">' + escapedRepoName + '</td><td class="btns right"><div id="editRepoName" title="' + strings.settingsEditNameTitle + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div>' + (this.repo.name !== null ? ' <div id="deleteRepoName" title="' + strings.settingsDeleteNameTitle + ELLIPSIS + '">' + SVG_ICONS.close + '</div>' : '') + '</td></tr>' +
				'<tr class="lineBelow"><td class="left">' + strings.settingsInitialBranchesLabel + '</td><td class="leftWithEllipsis" title="' + initialBranchesStr + ' (' + (initialBranchesLocallyConfigured ? strings.settingsLocal : strings.settingsGlobal) + ')">' + initialBranchesStr + '</td><td class="btns right"><div id="editInitialBranches" title="' + strings.settingsEditInitialBranchesTitle + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div>' + (initialBranchesLocallyConfigured ? ' <div id="clearInitialBranches" title="' + strings.settingsClearInitialBranchesTitle + ELLIPSIS + '">' + SVG_ICONS.close + '</div>' : '') + '</td></tr>' +
				'</table>' +
				'<label id="settingsShowStashes"><input type="checkbox" id="settingsShowStashesCheckbox" tabindex="-1"><span class="customCheckbox"></span>' + strings.settingsShowStashes + '</label><br/>' +
				'<label id="settingsShowTags"><input type="checkbox" id="settingsShowTagsCheckbox" tabindex="-1"><span class="customCheckbox"></span>' + strings.settingsShowTags + '</label><br/>' +
				'<label id="settingsIncludeCommitsMentionedByReflogs"><input type="checkbox" id="settingsIncludeCommitsMentionedByReflogsCheckbox" tabindex="-1"><span class="customCheckbox"></span>' + strings.settingsIncludeReflogs + '</label><span class="settingsWidgetInfo" title="' + strings.settingsIncludeReflogsInfo + '">' + SVG_ICONS.info + '</span><br/>' +
				'<label id="settingsOnlyFollowFirstParent"><input type="checkbox" id="settingsOnlyFollowFirstParentCheckbox" tabindex="-1"><span class="customCheckbox"></span>' + strings.settingsOnlyFirstParent + '</label><span class="settingsWidgetInfo" title="' + strings.settingsOnlyFirstParentInfo + '">' + SVG_ICONS.info + '</span>' +
				'</div>';

			let userNameSet = false, userEmailSet = false;
			if (this.config !== null) {
				repoHtml += '<div class="settingsSection centered"><h3>' + strings.settingsSectionUserDetails + '</h3>';
				const userName = this.config.user.name, userEmail = this.config.user.email;
				userNameSet = userName.local !== null || userName.global !== null;
				userEmailSet = userEmail.local !== null || userEmail.global !== null;
				if (userNameSet || userEmailSet) {
					const escapedUserName = escapeHtml(userName.local ?? userName.global ?? strings.settingsNotSet);
					const escapedUserEmail = escapeHtml(userEmail.local ?? userEmail.global ?? strings.settingsNotSet);
					repoHtml += '<table>' +
						'<tr><td class="left">' + strings.settingsUserNameLabel + '</td><td class="leftWithEllipsis" title="' + escapedUserName + (userNameSet ? ' (' + (userName.local !== null ? strings.settingsLocal : strings.settingsGlobal) + ')' : '') + '">' + escapedUserName + '</td></tr>' +
						'<tr><td class="left">' + strings.settingsUserEmailLabel + '</td><td class="leftWithEllipsis" title="' + escapedUserEmail + (userEmailSet ? ' (' + (userEmail.local !== null ? strings.settingsLocal : strings.settingsGlobal) + ')' : '') + '">' + escapedUserEmail + '</td></tr>' +
						'</table>' +
						'<div class="settingsSectionButtons"><div id="editUserDetails" class="editBtn">' + SVG_ICONS.pencil + strings.settingsEdit + '</div><div id="removeUserDetails" class="removeBtn">' + SVG_ICONS.close + strings.settingsRemove + '</div></div>';
				} else {
					repoHtml += '<span>' + strings.settingsUserDetailsIntro + '</span>' +
						'<div class="settingsSectionButtons"><div id="editUserDetails" class="addBtn">' + SVG_ICONS.plus + strings.settingsAddUserDetails + '</div></div>';
				}
				repoHtml += '</div>';

				repoHtml += '<div class="settingsSection"><h3>' + strings.settingsSectionRemotes + '</h3><table><tr><th>' + strings.settingsRemote + '</th><th>' + strings.settingsUrl + '</th><th>' + strings.settingsType + '</th><th>' + strings.settingsAction + '</th></tr>';
				if (this.config.remotes.length > 0) {
					const hideRemotes = this.repo.hideRemotes;
					this.config.remotes.forEach((remote, i) => {
						const hidden = hideRemotes.includes(remote.name);
						const fetchUrl = escapeHtml(remote.url || strings.settingsNotSet), pushUrl = escapeHtml(remote.pushUrl || remote.url || strings.settingsNotSet);
						repoHtml += '<tr class="lineAbove">' +
							'<td class="left" rowspan="2"><span class="hideRemoteBtn" data-index="' + i + '" title="' + (hidden ? strings.settingsHideRemoteTitle : strings.settingsShowRemoteTitle) + '">' + (hidden ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen) + '</span>' + escapeHtml(remote.name) + '</td>' +
							'<td class="leftWithEllipsis" title="' + strings.settingsFetchUrlInput + ': ' + fetchUrl + '">' + fetchUrl + '</td><td>' + strings.settingsFetch + '</td>' +
							'<td class="btns remoteBtns" rowspan="2" data-index="' + i + '"><div class="fetchRemote" title="' + strings.settingsFetchFromRemoteTitle + ELLIPSIS + '">' + SVG_ICONS.download + '</div> <div class="pruneRemote" title="' + strings.settingsPruneRemoteTitle + ELLIPSIS + '">' + SVG_ICONS.branch + '</div><br><div class="editRemote" title="' + strings.settingsEditRemoteTitle + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div> <div class="deleteRemote" title="' + strings.settingsDeleteRemoteTitle + ELLIPSIS + '">' + SVG_ICONS.close + '</div></td>' +
							'</tr><tr><td class="leftWithEllipsis" title="' + strings.settingsPushUrlInput + ': ' + pushUrl + '">' + pushUrl + '</td><td>' + strings.settingsPush + '</td></tr>';
					});
				} else {
					repoHtml += '<tr class="lineAbove"><td colspan="4">' + strings.settingsNoRemotes + '</td></tr>';
				}
				repoHtml += '</table><div class="settingsSectionButtons lineAbove"><div id="settingsAddRemote" class="addBtn">' + SVG_ICONS.plus + strings.settingsAddRemote + '</div></div></div>';
			}

			repoHtml += '<div class="settingsSection centered"><h3>' + strings.settingsSectionIssueLinking + '</h3>';
			const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
			if (issueLinkingConfig !== null) {
				const escapedIssue = escapeHtml(issueLinkingConfig.issue), escapedUrl = escapeHtml(issueLinkingConfig.url);
				repoHtml += '<table><tr><td class="left">' + strings.settingsIssueRegexLabel + '</td><td class="leftWithEllipsis" title="' + escapedIssue + '">' + escapedIssue + '</td></tr><tr><td class="left">' + strings.settingsIssueUrlLabel + '</td><td class="leftWithEllipsis" title="' + escapedUrl + '">' + escapedUrl + '</td></tr></table>' +
					'<div class="settingsSectionButtons"><div id="editIssueLinking" class="editBtn">' + SVG_ICONS.pencil + strings.settingsEdit + '</div><div id="removeIssueLinking" class="removeBtn">' + SVG_ICONS.close + strings.settingsRemove + '</div></div>';
			} else {
				repoHtml += '<span>' + strings.settingsIssueLinkingIntro + '</span>' +
					'<div class="settingsSectionButtons"><div id="editIssueLinking" class="addBtn">' + SVG_ICONS.plus + strings.settingsAddIssueLinking + '</div></div>';
			}
			repoHtml += '</div>';

			if (this.config !== null) {
				repoHtml += '<div class="settingsSection centered"><h3>' + strings.settingsSectionPullRequest + '</h3>';
				const pullRequestConfig = this.repo.pullRequestConfig;
				if (pullRequestConfig !== null) {
					const provider = escapeHtml((pullRequestConfig.provider === GG.PullRequestProvider.Bitbucket
						? 'Bitbucket'
						: pullRequestConfig.provider === GG.PullRequestProvider.Custom
							? pullRequestConfig.custom.name
							: pullRequestConfig.provider === GG.PullRequestProvider.GitHub
								? 'GitHub'
								: 'GitLab'
					) + ' (' + pullRequestConfig.hostRootUrl + ')');
					const source = escapeHtml(pullRequestConfig.sourceOwner + '/' + pullRequestConfig.sourceRepo + ' (' + pullRequestConfig.sourceRemote + ')');
					const destination = escapeHtml(pullRequestConfig.destOwner + '/' + pullRequestConfig.destRepo + (pullRequestConfig.destRemote !== null ? ' (' + pullRequestConfig.destRemote + ')' : ''));
					const destinationBranch = escapeHtml(pullRequestConfig.destBranch);
					repoHtml += '<table><tr><td class="left">' + strings.settingsProviderLabel + '</td><td class="leftWithEllipsis" title="' + provider + '">' + provider + '</td></tr>' +
						'<tr><td class="left">' + strings.settingsSourceRepoLabel + '</td><td class="leftWithEllipsis" title="' + source + '">' + source + '</td></tr>' +
						'<tr><td class="left">' + strings.settingsDestinationRepoLabel + '</td><td class="leftWithEllipsis" title="' + destination + '">' + destination + '</td></tr>' +
						'<tr><td class="left">' + strings.settingsDestinationBranchLabel + '</td><td class="leftWithEllipsis" title="' + destinationBranch + '">' + destinationBranch + '</td></tr></table>' +
						'<div class="settingsSectionButtons"><div id="editPullRequestIntegration" class="editBtn">' + SVG_ICONS.pencil + strings.settingsEdit + '</div><div id="removePullRequestIntegration" class="removeBtn">' + SVG_ICONS.close + strings.settingsRemove + '</div></div>';
				} else {
					repoHtml += '<span>' + strings.settingsPrIntro + '</span>' +
						'<div class="settingsSectionButtons"><div id="editPullRequestIntegration" class="addBtn">' + SVG_ICONS.plus + strings.settingsConfigurePrIntegration + '</div></div>';
				}
				repoHtml += '</div>';
			}

			repoHtml += '<div class="settingsSection"><h3>' + strings.settingsSectionConfig + '</h3><div class="settingsSectionButtons">' +
				'<div id="exportRepositoryConfig">' + SVG_ICONS.package + strings.settingsExportRepoConfig + '</div>' +
				'</div></div>';


			/* Global Settings Column */

			const viewConfig = this.view.config;

			let globalHtml = '<div class="settingsSection"><h3>' + strings.settingsSectionGraphDisplay + '</h3><table>' +
				SettingsWidget.selectRow('settingsInterfaceLanguage', strings.settingsInterfaceLanguageLabel, [
					{ name: strings.settingsLanguageAuto, value: 'auto' },
					{ name: strings.settingsLanguageEnglish, value: 'en' },
					{ name: strings.settingsLanguageChinese, value: 'zh-cn' }
				], viewConfig.interfaceLanguageSetting) +
				SettingsWidget.selectRow('settingsGraphStyle', strings.settingsGraphStyleLabel, [
					{ name: strings.settingsGraphStyleRounded, value: 'rounded' },
					{ name: strings.settingsGraphStyleAngular, value: 'angular' }
				], viewConfig.graph.style === GG.GraphStyle.Angular ? 'angular' : 'rounded') +
				SettingsWidget.numberRow('settingsGraphRowHeight', strings.settingsGraphRowHeightLabel, viewConfig.graph.rowHeight, 16, 48, null) +
				SettingsWidget.numberRow('settingsGraphFontSize', strings.settingsGraphFontSizeLabel, viewConfig.graph.fontSize, 8, 24, null) +
				SettingsWidget.selectRow('settingsDateType', strings.settingsDateTypeLabel, [
					{ name: strings.settingsDateTypeAuthor, value: 'Author Date' },
					{ name: strings.settingsDateTypeCommit, value: 'Commit Date' }
				], viewConfig.dateType === GG.DateType.Commit ? 'Commit Date' : 'Author Date') +
				SettingsWidget.selectRow('settingsDateFormat', strings.settingsDateFormatLabel, [
					{ name: strings.settingsDateFormatDateAndTime, value: 'Date & Time' },
					{ name: strings.settingsDateFormatDateOnly, value: 'Date Only' },
					{ name: strings.settingsDateFormatIsoDateAndTime, value: 'ISO Date & Time' },
					{ name: strings.settingsDateFormatIsoDateOnly, value: 'ISO Date Only' },
					{ name: strings.settingsDateFormatRelative, value: 'Relative' }
				], SettingsWidget.dateFormatSettingValue(viewConfig.dateFormat)) +
				'</table>' +
				SettingsWidget.checkbox('settingsCombineBranchLabels', strings.settingsCombineBranchLabels, viewConfig.referenceLabels.combineLocalAndRemoteBranchLabels, null) +
				SettingsWidget.checkbox('settingsStickyHeader', strings.settingsStickyHeader, viewConfig.stickyHeader, null) +
				SettingsWidget.checkbox('settingsRenderMarkdown', strings.settingsRenderMarkdown, viewConfig.markdown, null) +
				'</div>';

			globalHtml += '<div class="settingsSection"><h3>' + strings.settingsSectionCommitLoading + '</h3><table>' +
				SettingsWidget.numberRow('settingsInitialLoad', strings.settingsInitialLoadLabel, viewConfig.initialLoadCommits, 1, 100000, strings.settingsCommitsUnit) +
				SettingsWidget.numberRow('settingsLoadMore', strings.settingsLoadMoreLabel, viewConfig.loadMoreCommits, 1, 100000, strings.settingsCommitsUnit) +
				SettingsWidget.selectRow('settingsCommitOrder', strings.settingsCommitOrderLabel, [
					{ name: strings.settingsCommitOrderDate, value: 'date' },
					{ name: strings.settingsCommitOrderAuthorDate, value: 'author-date' },
					{ name: strings.settingsCommitOrderTopo, value: 'topo' }
				], viewConfig.commitOrdering) +
				'</table>' +
				SettingsWidget.checkbox('settingsLoadMoreAutomatically', strings.settingsLoadMoreAutomatically, viewConfig.loadMoreCommitsAutomatically, null) +
				SettingsWidget.checkbox('settingsFetchAvatars', strings.settingsFetchAvatars, viewConfig.fetchAvatars, null) +
				SettingsWidget.checkbox('settingsShowUncommittedChanges', strings.settingsShowUncommittedChanges, viewConfig.showUncommittedChanges, null) +
				SettingsWidget.checkbox('settingsShowUntrackedFiles', strings.settingsShowUntrackedFiles, viewConfig.showUntrackedFiles, null) +
				'</div>';

			globalHtml += '<div class="settingsSection"><h3>' + strings.settingsSectionRemotesFetching + '</h3>' +
				SettingsWidget.checkbox('settingsFetchAndPrune', strings.settingsFetchAndPrune, viewConfig.fetchAndPrune, null) +
				SettingsWidget.checkbox('settingsFetchAndPruneTags', strings.settingsFetchAndPruneTags, viewConfig.fetchAndPruneTags, strings.settingsFetchAndPruneTagsInfo) +
				SettingsWidget.checkbox('settingsTrackRemoteTags', strings.settingsTrackRemoteTags, viewConfig.trackRemoteTags, null) +
				SettingsWidget.checkbox('settingsShowRemoteBranchesGlobal', strings.settingsShowRemoteBranchesGlobal, viewConfig.showRemoteBranches, null) +
				SettingsWidget.checkbox('settingsShowRemoteHeads', strings.settingsShowRemoteHeads, viewConfig.showRemoteHeads, null) +
				'</div>';

			globalHtml += '<div class="settingsSection"><h3>' + strings.settingsSectionReviewIntegration + '</h3>' +
				SettingsWidget.checkbox('settingsPullRequestsEnabled', strings.settingsPullRequestsEnabled, viewConfig.pullRequests.enabled, strings.settingsPullRequestsEnabledInfo) +
				'</div>';

			globalHtml += '<div class="settingsSection"><h3>' + strings.settingsSectionLog + '</h3>' +
				SettingsWidget.checkbox('settingsEnableLog', strings.settingsEnableLog, viewConfig.enableLog, strings.settingsEnableLogInfo) +
				'<div class="settingsSectionButtons">' +
				'<div id="openLogFile">' + SVG_ICONS.file + strings.settingsOpenLogFile + '</div>' +
				'</div></div>';

			globalHtml += '<div class="settingsSection"><h3>' + strings.settingsSectionConfig + '</h3><div class="settingsSectionButtons">' +
				'<div id="openExtensionSettings">' + SVG_ICONS.gear + strings.settingsOpenExtensionSettings + '</div>' +
				'</div></div>';

			globalHtml += SettingsWidget.renderBackendSection(this.view.backend);

			this.contentsElem.innerHTML = '<div id="settingsColumns">' +
				'<div class="settingsColumn" id="settingsRepoColumn"><h3 class="settingsColumnTitle" title="' + strings.settingsColumnRepoHint + '">' + strings.settingsColumnRepo + '</h3>' + repoHtml + '</div>' +
				'<div class="settingsColumn" id="settingsGlobalColumn"><h3 class="settingsColumnTitle" title="' + strings.settingsColumnGlobalHint + '">' + strings.settingsColumnGlobal + '</h3>' + globalHtml + '</div>' +
				'</div>';

			observeElemScroll('settingsRepoColumn', this.repoColumnScrollTop, (scrollTop) => {
				this.repoColumnScrollTop = scrollTop;
			}, () => this.view.saveState());
			observeElemScroll('settingsGlobalColumn', this.globalColumnScrollTop, (scrollTop) => {
				this.globalColumnScrollTop = scrollTop;
			}, () => this.view.saveState());

			this.wireGlobalSelect('settingsGraphStyle', 'graph.style');
			this.wireGlobalNumber('settingsGraphRowHeight', 'graph.rowHeight', 16, 48, viewConfig.graph.rowHeight);
			this.wireGlobalNumber('settingsGraphFontSize', 'graph.fontSize', 8, 24, viewConfig.graph.fontSize);
			this.wireGlobalSelect('settingsDateType', 'date.type');
			this.wireGlobalSelect('settingsDateFormat', 'date.format');
			this.wireGlobalCheckbox('settingsCombineBranchLabels', 'referenceLabels.combineLocalAndRemoteBranchLabels');
			this.wireGlobalCheckbox('settingsStickyHeader', 'stickyHeader');
			this.wireGlobalCheckbox('settingsRenderMarkdown', 'markdown');
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


			document.getElementById('editRepoName')!.addEventListener('click', () => {
				if (this.currentRepo === null || this.repo === null) return;
				dialog.showForm(strings.settingsNameDialogMessage, [
					{ type: DialogInputType.Text, name: strings.settingsNameInput, default: this.repo.name || '', placeholder: getRepoName(this.currentRepo) }
				], strings.settingsNameDialogSave, (values) => {
					if (this.currentRepo === null) return;
					this.view.saveRepoStateValue(this.currentRepo, 'name', <string>values[0] || null);
					this.view.renderRepoDropdownOptions();
					this.render();
				}, null);
			});

			if (this.repo.name !== null) {
				document.getElementById('deleteRepoName')!.addEventListener('click', () => {
					if (this.currentRepo === null || this.repo === null || this.repo.name === null) return;
					dialog.showConfirmation(formatStr(strings.settingsDeleteNameConfirm, escapeHtml(this.repo.name), escapeHtml(getRepoName(this.currentRepo))), strings.settingsYesDelete, () => {
						if (this.currentRepo === null) return;
						this.view.saveRepoStateValue(this.currentRepo, 'name', null);
						this.view.renderRepoDropdownOptions();
						this.render();
					}, null);
				});
			}

			document.getElementById('editInitialBranches')!.addEventListener('click', () => {
				if (this.repo === null) return;
				const showCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch);
				const showSpecificBranches = getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches);
				dialog.showForm(strings.settingsInitialBranchesDialogHeader + '<p style="margin:6px 0;">' + strings.settingsInitialBranchesDialogText + '</p><p style="font-size:12px; margin:6px 0 0 0;">' + strings.settingsInitialBranchesDialogNote + '</p>', [
					{ type: DialogInputType.Checkbox, name: strings.settingsInitialBranchesCheckedOutInput, value: showCheckedOutBranch },
					{ type: DialogInputType.Select, name: strings.settingsInitialBranchesSpecificInput, options: this.view.getBranchOptions(), defaults: showSpecificBranches, multiple: true }
				], strings.settingsSaveConfiguration, (values) => {
					if (this.currentRepo === null) return;
					if (showCheckedOutBranch !== values[0] || !arraysStrictlyEqualIgnoringOrder(showSpecificBranches, <string[]>values[1])) {
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', values[0] ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', <string[]>values[1]);
						this.render();
					}
				}, null, strings.dialogCancel, null, false);
			});

			if (initialBranchesLocallyConfigured) {
				document.getElementById('clearInitialBranches')!.addEventListener('click', () => {
					dialog.showConfirmation(strings.settingsClearInitialBranchesConfirm, strings.settingsYesClear, () => {
						if (this.currentRepo === null) return;
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', GG.BooleanOverride.Default);
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', null);
						this.render();
					}, null);
				});
			}

			const interfaceLanguageElem = <HTMLSelectElement>document.getElementById('settingsInterfaceLanguage');
			interfaceLanguageElem.value = this.view.config.interfaceLanguageSetting;
			interfaceLanguageElem.addEventListener('change', () => {
				const value = interfaceLanguageElem.value;
				const language: 'auto' | 'en' | 'zh-cn' = value === 'en' || value === 'zh-cn' ? value : 'auto';
				if (language === this.view.config.interfaceLanguageSetting) return;
				// Saving the setting reloads the Git Graph View, which re-renders everything in the new language
				runAction({ command: 'setInterfaceLanguage', language: language }, strings.settingsSavingLanguage);
			});

			const showStashesElem = <HTMLInputElement>document.getElementById('settingsShowStashesCheckbox');
			showStashesElem.checked = getShowStashes(this.repo.showStashes);
			showStashesElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsShowStashesCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'showStashes', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const showTagsElem = <HTMLInputElement>document.getElementById('settingsShowTagsCheckbox');
			showTagsElem.checked = getShowTags(this.repo.showTags);
			showTagsElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsShowTagsCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'showTags', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const includeCommitsMentionedByReflogsElem = <HTMLInputElement>document.getElementById('settingsIncludeCommitsMentionedByReflogsCheckbox');
			includeCommitsMentionedByReflogsElem.checked = getIncludeCommitsMentionedByReflogs(this.repo.includeCommitsMentionedByReflogs);
			includeCommitsMentionedByReflogsElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsIncludeCommitsMentionedByReflogsCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'includeCommitsMentionedByReflogs', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const settingsOnlyFollowFirstParentElem = <HTMLInputElement>document.getElementById('settingsOnlyFollowFirstParentCheckbox');
			settingsOnlyFollowFirstParentElem.checked = getOnlyFollowFirstParent(this.repo.onlyFollowFirstParent);
			settingsOnlyFollowFirstParentElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsOnlyFollowFirstParentCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'onlyFollowFirstParent', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			if (this.config !== null) {
				document.getElementById('editUserDetails')!.addEventListener('click', () => {
					if (this.config === null) return;
					const userName = this.config.user.name, userEmail = this.config.user.email;
					dialog.showForm(strings.settingsUserDetailsDialogMessage, [
						{ type: DialogInputType.Text, name: strings.settingsUserNameInput, default: userName.local ?? userName.global ?? '', placeholder: null },
						{ type: DialogInputType.Text, name: strings.settingsUserEmailInput, default: userEmail.local ?? userEmail.global ?? '', placeholder: null },
						{ type: DialogInputType.Checkbox, name: strings.settingsUseGlobally, value: userName.local === null && userEmail.local === null, info: strings.settingsUseGloballyInfo }
					], strings.settingsSetUserDetails, (values) => {
						if (this.currentRepo === null) return;
						const useGlobally = <boolean>values[2];
						runAction({
							command: 'editUserDetails',
							repo: this.currentRepo,
							name: <string>values[0],
							email: <string>values[1],
							location: useGlobally ? GG.GitConfigLocation.Global : GG.GitConfigLocation.Local,
							deleteLocalName: useGlobally && userName.local !== null,
							deleteLocalEmail: useGlobally && userEmail.local !== null
						}, strings.settingsSettingUserDetails);
					}, null);
				});

				if (userNameSet || userEmailSet) {
					document.getElementById('removeUserDetails')!.addEventListener('click', () => {
						if (this.config === null) return;
						const userName = this.config.user.name, userEmail = this.config.user.email;
						const isGlobal = userName.local === null && userEmail.local === null;
						dialog.showConfirmation(formatStr(strings.settingsRemoveUserDetailsConfirm, isGlobal ? strings.settingsGlobally : strings.settingsLocally), strings.settingsYesRemove, () => {
							if (this.currentRepo === null) return;
							runAction({
								command: 'deleteUserDetails',
								repo: this.currentRepo,
								name: (isGlobal ? userName.global : userName.local) !== null,
								email: (isGlobal ? userEmail.global : userEmail.local) !== null,
								location: isGlobal ? GG.GitConfigLocation.Global : GG.GitConfigLocation.Local
							}, strings.settingsRemovingUserDetails);
						}, null);
					});
				}

				document.getElementById('settingsAddRemote')!.addEventListener('click', () => {
					dialog.showForm(strings.settingsAddRemoteDialogMessage, [
						{ type: DialogInputType.Text, name: strings.settingsNameInput, default: '', placeholder: null },
						{ type: DialogInputType.Text, name: strings.settingsFetchUrlInput, default: '', placeholder: null },
						{ type: DialogInputType.Text, name: strings.settingsPushUrlInput, default: '', placeholder: strings.settingsPushUrlPlaceholder },
						{ type: DialogInputType.Checkbox, name: strings.settingsFetchImmediately, value: true }
					], strings.settingsAddRemote, (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'addRemote', repo: this.currentRepo, name: <string>values[0], url: <string>values[1], pushUrl: <string>values[2] !== '' ? <string>values[2] : null, fetch: <boolean>values[3] }, strings.settingsAddingRemote);
					}, { type: TargetType.Repo });
				});

				addListenerToClass('editRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showForm(formatStr(strings.settingsEditRemoteDialogMessage, escapeHtml(remote.name)), [
						{ type: DialogInputType.Text, name: strings.settingsNameInput, default: remote.name, placeholder: null },
						{ type: DialogInputType.Text, name: strings.settingsFetchUrlInput, default: remote.url !== null ? remote.url : '', placeholder: null },
						{ type: DialogInputType.Text, name: strings.settingsPushUrlInput, default: remote.pushUrl !== null ? remote.pushUrl : '', placeholder: strings.settingsPushUrlPlaceholder }
					], strings.settingsSaveChanges, (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'editRemote', repo: this.currentRepo, nameOld: remote.name, nameNew: <string>values[0], urlOld: remote.url, urlNew: <string>values[1] !== '' ? <string>values[1] : null, pushUrlOld: remote.pushUrl, pushUrlNew: <string>values[2] !== '' ? <string>values[2] : null }, strings.settingsSavingRemoteChanges);
					}, { type: TargetType.Repo });
				});

				addListenerToClass('deleteRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showConfirmation(formatStr(strings.settingsDeleteRemoteConfirm, escapeHtml(remote.name)), strings.settingsYesDelete, () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'deleteRemote', repo: this.currentRepo, name: remote.name }, strings.settingsDeletingRemote);
					}, { type: TargetType.Repo });
				});

				addListenerToClass('fetchRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showForm(formatStr(strings.settingsFetchRemoteConfirm, escapeHtml(remote.name)), [
						{ type: DialogInputType.Checkbox, name: strings.settingsPrune, value: initialState.config.dialogDefaults.fetchRemote.prune, info: strings.settingsPruneInfo },
						{ type: DialogInputType.Checkbox, name: strings.settingsPruneTags, value: initialState.config.dialogDefaults.fetchRemote.pruneTags, info: strings.settingsPruneTagsInfo }
					], strings.settingsYesFetch, (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'fetch', repo: this.currentRepo, name: remote.name, prune: <boolean>values[0], pruneTags: <boolean>values[1] }, strings.settingsFetchingFromRemote);
					}, { type: TargetType.Repo });
				});

				addListenerToClass('pruneRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showConfirmation(formatStr(strings.settingsPruneRemoteConfirm, escapeHtml(remote.name)), strings.settingsYesPrune, () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'pruneRemote', repo: this.currentRepo, name: remote.name }, strings.settingsPruningRemote);
					}, { type: TargetType.Repo });
				});

				addListenerToClass('hideRemoteBtn', 'click', (e) => {
					if (this.currentRepo === null || this.repo === null || this.config === null) return;
					const source = <HTMLElement>(<Element>e.target).closest('.hideRemoteBtn')!;
					const remote = this.config.remotes[parseInt(source.dataset.index!)].name;
					const hideRemote = !this.repo.hideRemotes.includes(remote);
					source.title = hideRemote ? strings.settingsHideRemoteTitle : strings.settingsShowRemoteTitle;
					source.innerHTML = hideRemote ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen;
					if (hideRemote) {
						this.repo.hideRemotes.push(remote);
					} else {
						this.repo.hideRemotes.splice(this.repo.hideRemotes.indexOf(remote), 1);
					}
					this.view.saveRepoStateValue(this.currentRepo, 'hideRemotes', this.repo.hideRemotes);
					this.view.refresh(true);
				});
			}

			document.getElementById('editIssueLinking')!.addEventListener('click', () => {
				if (this.repo === null) return;
				const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
				if (issueLinkingConfig !== null) {
					this.showIssueLinkingDialog(issueLinkingConfig.issue, issueLinkingConfig.url, this.repo.issueLinkingConfig === null && globalState.issueLinkingConfig !== null, true);
				} else {
					this.showIssueLinkingDialog(null, null, false, false);
				}
			});

			if (this.repo.issueLinkingConfig !== null || globalState.issueLinkingConfig !== null) {
				document.getElementById('removeIssueLinking')!.addEventListener('click', () => {
					if (this.repo === null) return;
					const locallyConfigured = this.repo.issueLinkingConfig !== null;
					dialog.showConfirmation(strings.settingsRemoveConfirmPrefix + (locallyConfigured ? (globalState.issueLinkingConfig !== null ? strings.settingsRemoveIssueLinkingLocal : '') + strings.settingsRemoveIssueLinkingFromRepo : strings.settingsRemoveIssueLinkingGlobal) + '?', strings.settingsYesRemove, () => {
						this.setIssueLinkingConfig(null, !locallyConfigured);
					}, null);
				});
			}

			if (this.config !== null) {
				document.getElementById('editPullRequestIntegration')!.addEventListener('click', () => {
					if (this.repo === null || this.config === null) return;

					if (this.config.remotes.length === 0) {
						dialog.showError(strings.settingsUnableToConfigurePr, strings.settingsPrNeedsRemote, null, null);
						return;
					}

					let config: GG.DeepWriteable<GG.PullRequestConfig>;
					if (this.repo.pullRequestConfig === null) {
						let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
						let sourceRemoteUrl = this.config.remotes[originIndex > -1 ? originIndex : 0].url;
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
					this.showCreatePullRequestIntegrationDialog1(config);
				});

				if (this.repo.pullRequestConfig !== null) {
					document.getElementById('removePullRequestIntegration')!.addEventListener('click', () => {
						dialog.showConfirmation(strings.settingsRemovePrConfirm, strings.settingsYesRemove, () => {
							this.setPullRequestConfig(null);
						}, null);
					});
				}
			}

			document.getElementById('openExtensionSettings')!.addEventListener('click', () => {
				sendMessage({ command: 'openExtensionSettings' });
			});

			document.getElementById('openLogFile')!.addEventListener('click', () => {
				sendMessage({ command: 'openLogFile' });
			});

			document.getElementById('exportRepositoryConfig')!.addEventListener('click', () => {
				dialog.showConfirmation(strings.settingsExportRepoConfigConfirm, strings.settingsYesExport, () => {
					if (this.currentRepo === null) return;
					runAction({ command: 'exportRepoConfig', repo: this.currentRepo }, strings.settingsExportingRepoConfig);
				}, null);
			});
		}

		alterClass(this.widgetElem, CLASS_LOADING, this.loading);
		this.loadingElem.innerHTML = this.loading ? '<span>' + SVG_ICONS.loading + strings.loading + '</span>' : '';
		this.widgetElem.scrollTop = this.scrollTop;
		this.loadingElem.style.top = (this.scrollTop + (this.widgetElem.clientHeight / 2) - 12) + 'px';
	}


	/* Global Setting Render Helpers */

	/**
	 * Render the Backend section: which engine serves each area of the extension *on the platform
	 * this editor is running on*. The split is computed by the extension host (it depends on
	 * whether this installation actually contains an engine binary for this platform) and sent
	 * with the view's initial state.
	 * @param backend The backend report from the extension host.
	 * @returns The HTML of the section.
	 */
	private static renderBackendSection(backend: GG.BackendReport) {
		const areaLabels: { [area: string]: string } = {
			repoInfo: strings.settingsBackendAreaRepoInfo,
			commits: strings.settingsBackendAreaCommits,
			details: strings.settingsBackendAreaDetails,
			diffs: strings.settingsBackendAreaDiffs,
			onDemand: strings.settingsBackendAreaOnDemand,
			metadata: strings.settingsBackendAreaMetadata,
			counting: strings.settingsBackendAreaCounting,
			config: strings.settingsBackendAreaConfig,
			writes: strings.settingsBackendAreaWrites
		};
		const providerLabels: { [provider: string]: string } = {
			'rust': strings.settingsBackendProviderRust,
			'git-cli': strings.settingsBackendProviderCli,
			'hybrid': strings.settingsBackendProviderHybrid
		};

		const engineStatus = backend.engineAvailable
			? formatStr(strings.settingsBackendEngineLoaded, backend.engineVersion ?? '')
			: strings.settingsBackendEngineMissing;

		let html = '<div class="settingsSection backendSection"><h3>' + strings.settingsSectionBackend + '</h3>' +
			'<table>' +
			'<tr class="lineBelow"><td class="left">' + escapeHtml(strings.settingsBackendPlatform) + '</td><td class="left"><code>' + escapeHtml(backend.platform) + '</code></td></tr>' +
			'<tr class="lineBelow"><td class="left">' + escapeHtml(strings.settingsBackendEngine) + '</td><td class="left backendEngine' + (backend.engineAvailable ? ' engineLoaded' : ' engineMissing') + '">' + escapeHtml(engineStatus) + '</td></tr>' +
			'<tr class="lineBelow"><td class="left">' + escapeHtml(strings.settingsBackendGitCli) + '</td><td class="left backendEngine' + (backend.gitCliAvailable ? ' engineLoaded' : ' engineMissing') + '">' + escapeHtml(backend.gitCliAvailable ? strings.settingsBackendGitCliFound : strings.settingsBackendGitCliMissing) + '</td></tr>' +
			'</table>' +
			'<table class="backendTable">' +
			'<tr><th class="left">' + escapeHtml(strings.settingsBackendArea) + '</th><th class="left">' + escapeHtml(strings.settingsBackendProvider) + '</th></tr>';

		for (const capability of backend.capabilities) {
			html += '<tr class="lineAbove">' +
				'<td class="left">' + escapeHtml(areaLabels[capability.area] ?? capability.area) + '</td>' +
				'<td class="left"><span class="backendBadge ' + capability.provider + '">' + escapeHtml(providerLabels[capability.provider] ?? capability.provider) + '</span></td>' +
				'</tr>';
		}

		html += '</table></div>';
		return html;
	}

	/**
	 * Render a table row containing a `<select>` bound to a Global Setting.
	 * @param id The id of the `<select>` element.
	 * @param label The label displayed in the first column.
	 * @param options The options of the `<select>`, in the order they are displayed.
	 * @param value The value of the option that is currently selected.
	 * @returns The HTML of the row.
	 */
	private static selectRow(id: string, label: string, options: ReadonlyArray<{ name: string, value: string }>, value: string) {
		let html = '<tr class="lineAbove"><td class="left">' + label + '</td><td class="left" colspan="2"><select class="settingsGlobalSelect" id="' + id + '" tabindex="-1">';
		options.forEach((option) => {
			html += '<option value="' + escapeHtml(option.value) + '"' + (option.value === value ? ' selected' : '') + '>' + option.name + '</option>';
		});
		return html + '</select></td></tr>';
	}

	/**
	 * Render a table row containing a numeric `<input>` bound to a Global Setting.
	 * @param id The id of the `<input>` element.
	 * @param label The label displayed in the first column.
	 * @param value The current value of the setting.
	 * @param min The smallest value the setting accepts.
	 * @param max The largest value the setting accepts.
	 * @param unit The unit displayed after the input (NULL => no unit).
	 * @returns The HTML of the row.
	 */
	private static numberRow(id: string, label: string, value: number, min: number, max: number, unit: string | null) {
		return '<tr class="lineAbove"><td class="left">' + label + '</td><td class="left" colspan="2">' +
			'<input class="settingsGlobalNumber" type="number" id="' + id + '" tabindex="-1" min="' + min + '" max="' + max + '" value="' + value + '">' +
			(unit !== null ? '<span class="settingsInputUnit">' + unit + '</span>' : '') +
			'</td></tr>';
	}

	/**
	 * Render a checkbox bound to a Global Setting.
	 * @param id The id of the label (the `<input>` gets the id with a "Checkbox" suffix).
	 * @param label The text displayed beside the checkbox.
	 * @param checked Is the checkbox checked.
	 * @param info The tooltip of an information icon rendered after the label (NULL => no icon).
	 * @returns The HTML of the checkbox.
	 */
	private static checkbox(id: string, label: string, checked: boolean, info: string | null) {
		return '<label class="settingsGlobalCheckbox" id="' + id + '"><input type="checkbox" id="' + id + 'Checkbox" tabindex="-1"' + (checked ? ' checked' : '') + '><span class="customCheckbox"></span>' + label + '</label>' +
			(info !== null ? '<span class="settingsWidgetInfo" title="' + escapeHtml(info) + '">' + SVG_ICONS.info + '</span>' : '') + '<br/>';
	}

	/**
	 * Get the value of the `git-graph-rs.date.format` Extension Setting that produces the given
	 * parsed date format (the webview only receives the parsed form).
	 * @param dateFormat The parsed date format.
	 * @returns The value of the Extension Setting.
	 */
	private static dateFormatSettingValue(dateFormat: GG.DateFormat) {
		if (dateFormat.type === GG.DateFormatType.Relative) return 'Relative';
		return (dateFormat.iso ? 'ISO ' : '') + (dateFormat.type === GG.DateFormatType.DateOnly ? 'Date Only' : 'Date & Time');
	}


	/* Global Setting Wiring Helpers */

	/**
	 * Save a Global Setting, and display the "Saving Setting" action running state while it is saved.
	 * @param setting The key of the setting, relative to the `git-graph-rs` section.
	 * @param value The new value of the setting.
	 */
	private saveGlobalSetting(setting: string, value: GG.GlobalSettingValue) {
		runAction({ command: 'setGlobalSetting', setting: setting, value: value }, strings.settingsSavingSetting);
	}

	/**
	 * Wire a checkbox rendered by SettingsWidget.checkbox to the Global Setting it controls.
	 * @param id The id passed to SettingsWidget.checkbox.
	 * @param setting The key of the setting, relative to the `git-graph-rs` section.
	 */
	private wireGlobalCheckbox(id: string, setting: string) {
		const elem = <HTMLInputElement | null>document.getElementById(id + 'Checkbox');
		if (elem === null) return;
		elem.addEventListener('change', () => this.saveGlobalSetting(setting, elem.checked));
	}

	/**
	 * Wire a `<select>` rendered by SettingsWidget.selectRow to the Global Setting it controls.
	 * @param id The id passed to SettingsWidget.selectRow.
	 * @param setting The key of the setting, relative to the `git-graph-rs` section.
	 */
	private wireGlobalSelect(id: string, setting: string) {
		const elem = <HTMLSelectElement | null>document.getElementById(id);
		if (elem === null) return;
		elem.addEventListener('change', () => this.saveGlobalSetting(setting, elem.value));
	}

	/**
	 * Wire a numeric `<input>` rendered by SettingsWidget.numberRow to the Global Setting it controls.
	 * Values outside [min, max] (and non-numeric input) are rejected, restoring the saved value.
	 * @param id The id passed to SettingsWidget.numberRow.
	 * @param setting The key of the setting, relative to the `git-graph-rs` section.
	 * @param min The smallest value the setting accepts.
	 * @param max The largest value the setting accepts.
	 * @param current The currently saved value of the setting.
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


	/* Private Helper Methods */

	/**
	 * Save the issue linking configuration for this repository, and refresh the view so these changes are taken into affect.
	 * @param config The issue linking configuration to save.
	 * @param global Should this configuration be set globally for all repositories, or locally for this specific repository.
	 */
	private setIssueLinkingConfig(config: GG.IssueLinkingConfig | null, global: boolean) {
		if (this.currentRepo === null || this.repo === null) return;

		if (global) {
			if (this.repo.issueLinkingConfig !== null) {
				this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', null);
			}
			updateGlobalViewState('issueLinkingConfig', config);
		} else {
			this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', config);
		}

		this.view.refresh(true);
		this.render();
	}

	/**
	 * Save the pull request configuration for this repository.
	 * @param config The pull request configuration to save.
	 */
	private setPullRequestConfig(config: GG.PullRequestConfig | null) {
		if (this.currentRepo === null) return;
		this.view.saveRepoStateValue(this.currentRepo, 'pullRequestConfig', config);
		this.render();
	}

	/**
	 * Show the dialog allowing the user to configure the issue linking for this repository.
	 * @param defaultIssueRegex The default regular expression used to match issue numbers.
	 * @param defaultIssueUrl The default URL for the issue number to be substituted into.
	 * @param defaultUseGlobally The default value for the checkbox determining whether the issue linking configuration should be used globally (for all repositories).
	 * @param isEdit Is the dialog editing an existing issue linking configuration.
	 */
	private showIssueLinkingDialog(defaultIssueRegex: string | null, defaultIssueUrl: string | null, defaultUseGlobally: boolean, isEdit: boolean) {
		let html = isEdit ? strings.settingsEditIssueLinkingHeader : strings.settingsAddIssueLinkingHeader;
		html += '<p style="font-size:12px; margin:6px 0;">' + strings.settingsIssueExampleText + '</p>';
		html += '<table style="display:inline-table; width:360px; text-align:left; font-size:12px; margin-bottom:2px;"><tr><td>' + strings.settingsIssueRegexLabel + '</td><td>#(\\d+)</td></tr><tr><td>' + strings.settingsIssueUrlLabel + '</td><td>https://github.com/your-org/your-repo/issues/$1</td></tr></tbody></table>';

		if (!isEdit && defaultIssueRegex === null && defaultIssueUrl === null) {
			defaultIssueRegex = SettingsWidget.autoDetectIssueRegex(this.view.getCommits());
			if (defaultIssueRegex !== null) {
				html += '<p style="font-size:12px"><i>' + strings.settingsIssueRegexDetected + '</i></p>';
			}
		}

		dialog.showForm(html, [
			{ type: DialogInputType.Text, name: strings.settingsIssueRegexInput, default: defaultIssueRegex !== null ? defaultIssueRegex : '', placeholder: null, info: strings.settingsIssueRegexInfo },
			{ type: DialogInputType.Text, name: strings.settingsIssueUrlInput, default: defaultIssueUrl !== null ? defaultIssueUrl : '', placeholder: null, info: strings.settingsIssueUrlInfo },
			{ type: DialogInputType.Checkbox, name: strings.settingsUseGlobally, value: defaultUseGlobally, info: strings.settingsUseGloballyIssueInfo }
		], strings.settingsSave, (values) => {
			let issueRegex = (<string>values[0]).trim(), issueUrl = (<string>values[1]).trim(), useGlobally = <boolean>values[2];
			let regExpParseError = null;
			try {
				if (issueRegex.indexOf('(') === -1 || issueRegex.indexOf(')') === -1) {
					regExpParseError = strings.settingsIssueRegexNoGroup;
				} else if (new RegExp(issueRegex, 'gu')) {
					regExpParseError = null;
				}
			} catch (e) {
				regExpParseError = (<Error>e).message;
			}
			if (regExpParseError !== null) {
				dialog.showError(strings.settingsInvalidIssueRegex, regExpParseError, strings.settingsGoBack, () => {
					this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
				});
			} else if (!(/\$([1-9][0-9]*)/.test(issueUrl))) {
				dialog.showError(strings.settingsInvalidIssueUrl, strings.settingsIssueUrlNoPlaceholders, strings.settingsGoBack, () => {
					this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
				});
			} else {
				this.setIssueLinkingConfig({ issue: issueRegex, url: issueUrl }, useGlobally);
			}
		}, null, strings.dialogCancel, null, false);
	}

	/**
	 * Show the first dialog for configuring the pull request integration.
	 * @param config The pull request configuration.
	 */
	private showCreatePullRequestIntegrationDialog1(config: GG.DeepWriteable<GG.PullRequestConfig>) {
		if (this.config === null) return;

		let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
		let upstreamIndex = this.config.remotes.findIndex((remote) => remote.name === 'upstream');
		let sourceRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.sourceRemote);
		let destRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.destRemote);

		if (config.sourceRemote === '' || sourceRemoteIndex === -1) {
			sourceRemoteIndex = originIndex > -1 ? originIndex : 0;
		}
		if (config.destRemote === '') {
			destRemoteIndex = upstreamIndex > -1 ? upstreamIndex : originIndex > -1 ? originIndex : 0;
		}

		let defaultProvider = config.provider.toString();
		let providerOptions = [
			{ name: 'Bitbucket', value: (GG.PullRequestProvider.Bitbucket).toString() },
			{ name: 'GitHub', value: (GG.PullRequestProvider.GitHub).toString() },
			{ name: 'GitLab', value: (GG.PullRequestProvider.GitLab).toString() }
		];
		let providerTemplateLookup: { [name: string]: string } = {};
		initialState.config.customPullRequestProviders.forEach((provider) => {
			providerOptions.push({ name: provider.name, value: (providerOptions.length + 1).toString() });
			providerTemplateLookup[provider.name] = provider.templateUrl;
		});
		if (config.provider === GG.PullRequestProvider.Custom) {
			if (!providerOptions.some((provider) => provider.name === config.custom.name)) {
				// The existing custom Pull Request provider no longer exists, so add it.
				providerOptions.push({ name: config.custom.name, value: (providerOptions.length + 1).toString() });
				providerTemplateLookup[config.custom.name] = config.custom.templateUrl;
			}
			defaultProvider = providerOptions.find((provider) => provider.name === config.custom.name)!.value;
		}
		providerOptions.sort((a, b) => a.name.localeCompare(b.name));

		let sourceRemoteOptions = this.config.remotes.map((remote: { name: string }, index: number) => ({ name: remote.name, value: index.toString() }));
		let destRemoteOptions = sourceRemoteOptions.map((option: { name: string, value: string }) => option);
		destRemoteOptions.push({ name: strings.settingsNotARemote, value: '-1' });

		dialog.showForm(strings.settingsPrDialog1Header, [
			{
				type: DialogInputType.Select, name: strings.settingsPrProviderInput,
				options: providerOptions, default: defaultProvider,
				info: strings.settingsPrProviderInfo
			},
			{
				type: DialogInputType.Select, name: strings.settingsPrSourceRemoteInput,
				options: sourceRemoteOptions, default: sourceRemoteIndex.toString(),
				info: strings.settingsPrSourceRemoteInfo
			},
			{
				type: DialogInputType.Select, name: strings.settingsPrDestRemoteInput,
				options: destRemoteOptions, default: destRemoteIndex.toString(),
				info: strings.settingsPrDestRemoteInfo
			}
		], strings.settingsNext, (values) => {
			if (this.config === null) return;

			let newProvider = <GG.PullRequestProvider>parseInt(<string>values[0]);
			if (newProvider > 3) newProvider = GG.PullRequestProvider.Custom;

			const newSourceRemoteIndex = parseInt(<string>values[1]);
			const newDestRemoteIndex = parseInt(<string>values[2]);
			const newSourceRemote = this.config.remotes[newSourceRemoteIndex].name;
			const newDestRemote = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].name : null;
			const newSourceUrl = this.config.remotes[newSourceRemoteIndex].url;
			const newDestUrl = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].url : null;

			if (config.hostRootUrl === '' || config.provider !== newProvider) {
				const remoteUrlForHost = newSourceUrl !== null ? newSourceUrl : newDestUrl;
				if (remoteUrlForHost !== null) {
					const match = remoteUrlForHost.match(/^(https?:\/\/|git@)((?=[^/]+@)[^@]+@|(?![^/]+@))([^/:]+)/);
					config.hostRootUrl = match !== null ? 'https://' + match[3] : '';
				} else {
					config.hostRootUrl = '';
				}
			}

			if (newProvider === GG.PullRequestProvider.Custom) {
				const customProviderName = providerOptions.find((provider) => provider.value === <string>values[0])!.name;
				config.custom = { name: customProviderName, templateUrl: providerTemplateLookup[customProviderName] };
			} else {
				config.custom = null;
			}
			config.provider = newProvider;

			if (config.sourceRemote !== newSourceRemote) {
				config.sourceRemote = newSourceRemote;
				const match = newSourceUrl !== null ? newSourceUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
				config.sourceOwner = match !== null ? match[2] : '';
				config.sourceRepo = match !== null ? match[3] : '';
			}

			if (config.provider !== GG.PullRequestProvider.GitLab || config.destRemote !== newDestRemote) {
				config.destProjectId = '';
			}

			if (config.destRemote !== newDestRemote) {
				config.destRemote = newDestRemote;
				if (newDestRemote !== null) {
					const match = newDestUrl !== null ? newDestUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
					config.destOwner = match !== null ? match[2] : '';
					config.destRepo = match !== null ? match[3] : '';
					const branches = this.view.getBranches()
						.filter((branch) => branch.startsWith('remotes/' + newDestRemote + '/') && branch !== ('remotes/' + newDestRemote + '/HEAD'))
						.map((branch) => branch.substring(newDestRemote.length + 9));
					config.destBranch = branches.length > 0 ? branches.includes('master') ? 'master' : branches[0] : '';
				} else {
					config.destOwner = '';
					config.destRepo = '';
					config.destBranch = '';
				}
			}

			this.showCreatePullRequestIntegrationDialog2(config);
		}, { type: TargetType.Repo });
	}

	/**
	 * Show the second dialog for configuring the pull request integration.
	 * @param config The pull request configuration.
	 */
	private showCreatePullRequestIntegrationDialog2(config: GG.DeepWriteable<GG.PullRequestConfig>) {
		if (this.config === null) return;

		const destBranches = config.destRemote !== null
			? this.view.getBranches()
				.filter((branch) => branch.startsWith('remotes/' + config.destRemote + '/') && branch !== ('remotes/' + config.destRemote + '/HEAD'))
				.map((branch) => branch.substring(config.destRemote!.length + 9))
			: [];

		const updateConfigWithFormValues = (values: DialogInputValue[]) => {
			const hostRootUri = <string>values[0];
			config.hostRootUrl = hostRootUri.endsWith('/') ? hostRootUri.substring(0, hostRootUri.length - 1) : hostRootUri;
			config.sourceOwner = <string>values[1];
			config.sourceRepo = <string>values[2];
			config.destOwner = <string>values[3];
			config.destRepo = <string>values[4];
			config.destProjectId = config.provider === GG.PullRequestProvider.GitLab ? <string>values[5] : '';
			const destBranch = <string>values[config.provider === GG.PullRequestProvider.GitLab ? 6 : 5];
			config.destBranch = config.destRemote === null || destBranches.length === 0
				? destBranch
				: destBranches[parseInt(destBranch)];
		};

		const inputs: DialogInput[] = [
			{ type: DialogInputType.Text, name: strings.settingsHostRootUrlInput, default: config.hostRootUrl, placeholder: null, info: strings.settingsHostRootUrlInfo },
			{ type: DialogInputType.Text, name: strings.settingsSourceOwnerInput, default: config.sourceOwner, placeholder: null, info: strings.settingsSourceOwnerInfo },
			{ type: DialogInputType.Text, name: strings.settingsSourceRepoInput, default: config.sourceRepo, placeholder: null, info: strings.settingsSourceRepoInfo },
			{ type: DialogInputType.Text, name: strings.settingsDestOwnerInput, default: config.destOwner, placeholder: null, info: strings.settingsDestOwnerInfo },
			{ type: DialogInputType.Text, name: strings.settingsDestRepoInput, default: config.destRepo, placeholder: null, info: strings.settingsDestRepoInfo }
		];
		if (config.provider === GG.PullRequestProvider.GitLab) {
			inputs.push({ type: DialogInputType.Text, name: strings.settingsDestProjectIdInput, default: config.destProjectId, placeholder: null, info: strings.settingsDestProjectIdInfo });
		}
		inputs.push(config.destRemote === null || destBranches.length === 0
			? { type: DialogInputType.Text, name: strings.settingsDestBranchInput, default: config.destBranch, placeholder: null, info: strings.settingsDestBranchInfo }
			: {
				type: DialogInputType.Select,
				name: strings.settingsDestBranchInput,
				options: destBranches.map((branch, index) => ({ name: branch, value: index.toString() })),
				default: destBranches.includes(config.destBranch) ? destBranches.indexOf(config.destBranch).toString() : '0',
				info: strings.settingsDestBranchInfo
			}
		);

		dialog.showForm(strings.settingsPrDialog2Header, inputs, strings.settingsSaveConfiguration, (values) => {
			updateConfigWithFormValues(values);
			this.setPullRequestConfig(config);
		}, { type: TargetType.Repo }, strings.settingsBack, (values) => {
			updateConfigWithFormValues(values);
			this.showCreatePullRequestIntegrationDialog1(config);
		});
	}

	/**
	 * Get the remote details corresponding to a mouse event.
	 * @param e The mouse event.
	 * @returns The details of the remote.
	 */
	private getRemoteForBtnEvent(e: Event) {
		return this.config !== null
			? this.config.remotes[parseInt((<HTMLElement>(<Element>e.target).closest('.remoteBtns')!).dataset.index!)]
			: null;
	}

	/**
	 * Automatically detect common issue number formats in the specified commits, returning the most common.
	 * @param commits The commits to analyse.
	 * @returns The regular expression of the most likely issue number format.
	 */
	private static autoDetectIssueRegex(commits: ReadonlyArray<GG.GitCommit>) {
		const patterns = ['#(\\d+)', '^(\\d+)\\.(?=\\s|$)', '^(\\d+):(?=\\s|$)', '([A-Za-z]+-\\d+)'].map((pattern) => {
			const regexp = new RegExp(pattern);
			return {
				pattern: pattern,
				matches: commits.filter((commit) => regexp.test(commit.message)).length
			};
		}).sort((a, b) => b.matches - a.matches);

		if (patterns[0].matches > 0.1 * commits.length) {
			// If the most common pattern was matched in more than 10% of commits, return the pattern
			return patterns[0].pattern;
		}
		return null;
	}
}
