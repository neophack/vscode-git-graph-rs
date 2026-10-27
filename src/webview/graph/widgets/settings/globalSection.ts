/* The Global Settings column of the Settings Widget: the Extension Settings that shape the graph
   display, commit loading, the author identities, fetching and the review integrations, plus the
   log and the entries that open the extension settings and the backend report. */

import { html, SafeHtml } from '../../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../../common/i18n/index';
import { SVG_ICONS } from '../../../common/icons';
import * as GG from '../../../common/protocol';
import { GraphContext } from '../../context';
import { getAuthorIndexForBtnEvent, getCommitAuthors, getGlobalAuthorIndex, saveCommitAuthors, showAuthorDialog } from './commitAuthors';
import { saveGlobalSetting } from './settingsHost';
import type { SettingsHost } from './settingsHost';
import { checkbox, dateFormatSettingValue, numberRow, renderBackendSection, selectRow } from './settingsHtml';

/**
 * Render the Global Settings column.
 * @param ctx The view's context.
 * @param config The repository's Git configuration (the Authors section names the global author
 * identity the global Git configuration matches).
 */
export function renderGlobalColumn(ctx: GraphContext, config: Readonly<GG.GitRepoConfig> | null): SafeHtml {
	const store = ctx.store, viewConfig = store.config;

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
	const globalAuthorIndex = getGlobalAuthorIndex(savedAuthors, config);
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

/** Wire the Global Settings column. */
export function wireGlobalSettings(host: SettingsHost) {
	const ctx = host.ctx(), viewConfig = ctx.store.config;
	wireGlobalSelect(host, 'settingsGraphStyle', 'graph.style');
	wireGlobalNumber(host, 'settingsGraphRowHeight', 'graph.rowHeight', 16, 48, viewConfig.graph.rowHeight);
	wireGlobalNumber(host, 'settingsGraphFontSize', 'graph.fontSize', 8, 24, viewConfig.graph.fontSize);
	wireGlobalSelect(host, 'settingsDateType', 'date.type');
	wireGlobalSelect(host, 'settingsDateFormat', 'date.format');
	wireGlobalCheckbox(host, 'settingsCombineBranchLabels', 'referenceLabels.combineLocalAndRemoteBranchLabels');
	wireGlobalCheckbox(host, 'settingsStickyHeader', 'stickyHeader');
	wireGlobalCheckbox(host, 'settingsRenderMarkdown', 'markdown');
	wireGlobalCheckbox(host, 'settingsMobileAdaptation', 'mobileAdaptation');
	wireGlobalCheckbox(host, 'settingsEnableLog', 'enableLog');

	wireGlobalNumber(host, 'settingsInitialLoad', 'repository.commits.initialLoad', 1, 100000, viewConfig.initialLoadCommits);
	wireGlobalNumber(host, 'settingsLoadMore', 'repository.commits.loadMore', 1, 100000, viewConfig.loadMoreCommits);
	wireGlobalSelect(host, 'settingsCommitOrder', 'repository.commits.order');
	wireGlobalCheckbox(host, 'settingsLoadMoreAutomatically', 'repository.commits.loadMoreAutomatically');
	wireGlobalCheckbox(host, 'settingsFetchAvatars', 'repository.commits.fetchAvatars');
	wireGlobalCheckbox(host, 'settingsShowUncommittedChanges', 'repository.showUncommittedChanges');
	wireGlobalCheckbox(host, 'settingsShowUntrackedFiles', 'repository.showUntrackedFiles');

	wireGlobalCheckbox(host, 'settingsFetchAndPrune', 'repository.fetchAndPrune');
	wireGlobalCheckbox(host, 'settingsFetchAndPruneTags', 'repository.fetchAndPruneTags');
	wireGlobalCheckbox(host, 'settingsTrackRemoteTags', 'repository.trackRemoteTags');
	wireGlobalCheckbox(host, 'settingsShowRemoteBranchesGlobal', 'repository.showRemoteBranches');
	wireGlobalCheckbox(host, 'settingsShowRemoteHeads', 'repository.showRemoteHeads');

	wireGlobalCheckbox(host, 'settingsPullRequestsEnabled', 'pullRequests.enabled');

	host.listenOnSurface(host.byId('settingsAddAuthor')!, 'click', () => {
		showAuthorDialog(host.ctx(), -1);
	});
	host.listenToClassOnSurface('editAuthor', 'click', (e) => {
		showAuthorDialog(host.ctx(), getAuthorIndexForBtnEvent(e));
	});
	host.listenToClassOnSurface('deleteAuthor', 'click', (e) => {
		const index = getAuthorIndexForBtnEvent(e);
		const authors = getCommitAuthors(host.ctx());
		const author = authors[index];
		if (author === undefined) return;
		ctx.dialog.showConfirmation(formatStr(markup.settingsDeleteAuthorConfirm, author.name, author.email), strings.settingsYesRemove, () => {
			saveCommitAuthors(host.ctx(), authors.filter((_author, i) => i !== index));
		}, null);
	});

	const interfaceLanguageElem = <HTMLSelectElement>host.byId('settingsInterfaceLanguage');
	interfaceLanguageElem.value = viewConfig.interfaceLanguageSetting;
	host.listenOnSurface(interfaceLanguageElem, 'change', () => {
		const value = interfaceLanguageElem.value;
		const language: 'auto' | 'en' | 'zh-cn' = value === 'en' || value === 'zh-cn' ? value : 'auto';
		if (language === ctx.store.config.interfaceLanguageSetting) return;
		// Saving the setting reloads the Git Graph View, which re-renders everything in the new language
		ctx.actions.run({ command: 'setInterfaceLanguage', language: language }, strings.settingsSavingLanguage);
	});

	host.listenOnSurface(host.byId('openExtensionSettings')!, 'click', () => {
		ctx.bridge.send({ command: 'openExtensionSettings' });
	});

	host.listenOnSurface(host.byId('openLogFile')!, 'click', () => {
		ctx.bridge.send({ command: 'openLogFile' });
	});
}


/* Global Setting wiring helpers */

/** Wire a checkbox rendered by `checkbox()` to the Global Setting it controls. */
function wireGlobalCheckbox(host: SettingsHost, id: string, setting: string) {
	const elem = <HTMLInputElement | null>host.byId(id + 'Checkbox');
	if (elem === null) return;
	host.listenOnSurface(elem, 'change', () => saveGlobalSetting(host.ctx(), setting, elem.checked));
}

/** Wire a `<select>` rendered by `selectRow()` to the Global Setting it controls. */
function wireGlobalSelect(host: SettingsHost, id: string, setting: string) {
	const elem = <HTMLSelectElement | null>host.byId(id);
	if (elem === null) return;
	host.listenOnSurface(elem, 'change', () => saveGlobalSetting(host.ctx(), setting, elem.value));
}

/**
 * Wire a numeric `<input>` rendered by `numberRow()` to the Global Setting it controls.
 * Values outside [min, max] (and non-numeric input) are rejected, restoring the saved value.
 */
function wireGlobalNumber(host: SettingsHost, id: string, setting: string, min: number, max: number, current: number) {
	const elem = <HTMLInputElement | null>host.byId(id);
	if (elem === null) return;
	host.listenOnSurface(elem, 'change', () => {
		const value = parseInt(elem.value, 10);
		if (isNaN(value) || value < min || value > max) {
			elem.value = String(current);
			return;
		}
		if (value === current) return;
		saveGlobalSetting(host.ctx(), setting, value);
	});
}
