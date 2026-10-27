/* The Git-configuration sections of the Settings Widget's Repository column: the commit author
   selector (which identity the repository's local user.name/user.email follows) and the
   repository's remotes. Both render only once the repository's Git configuration has loaded, and
   their actions write to that configuration. The author identity MODEL (the shared list, the
   global author) lives in commitAuthors.ts. */

import { html, SafeHtml, setHtml } from '../../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../../common/i18n/index';
import { SVG_ICONS } from '../../../common/icons';
import * as GG from '../../../common/protocol';
import { GraphContext } from '../../context';
import { TargetType } from '../../state/types';
import { DialogInputType } from '../dialog';
import { getAuthorIndexForBtnEvent, getCommitAuthors, getGlobalAuthorIndex } from './commitAuthors';
import type { SettingsHost } from './settingsHost';

/**
 * The commit author selector of the Repository column: one row per configured author identity,
 * plus the "Use Global Author" default.
 */
export function renderCommitAuthorSection(ctx: GraphContext, config: Readonly<GG.GitRepoConfig>): SafeHtml {
	// Selecting an author sets the repository's local user.name/user.email (so every commit
	// made in the repository - from any tool - uses it); selecting the global author removes
	// the local override. The identities and the global author itself are managed in the
	// Global Settings column.
	const userName = config.user.name, userEmail = config.user.email;
	const commitAuthors = ctx.store.config.commitAuthors;
	const hasLocalOverride = userName.local !== null || userEmail.local !== null;
	// The global author the repository follows: the configured identity the global Git
	// configuration matches, defaulting to the first identity (see getGlobalAuthorIndex)
	const globalAuthorIndex = getGlobalAuthorIndex(commitAuthors, config);
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

/** Render the remotes section: one row per configured remote, with its fetch/push URLs. */
export function renderRemotesSection(config: Readonly<GG.GitRepoConfig>, repo: Readonly<GG.GitRepoState>): SafeHtml {
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

/** The actions that need the repository's configuration: authors, remotes. */
export function wireConfigSettings(host: SettingsHost) {
	const ctx = host.ctx(), store = ctx.store;

	// Applying an author identity to this repository writes its name and email to the
	// repository's local Git configuration, so every commit made in the repository -
	// from any tool - uses the selected identity
	host.listenToClassOnSurface('authorSwitchRow', 'click', (e) => {
		if (host.currentRepo === null || host.config === null) return;
		const row = <HTMLElement>(<Element>e.target).closest('.authorSwitchRow')!;
		if (row.id === 'useGlobalAuthorRow') return; // handled by its own listener
		const author = getCommitAuthors(host.ctx())[parseInt(row.dataset.index!)];
		if (author === undefined) return;
		const userName = host.config.user.name, userEmail = host.config.user.email;
		if (userName.local === author.name && userEmail.local === author.email) return; // already applied
		ctx.actions.run({
			command: 'editUserDetails',
			repo: host.currentRepo,
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
	host.listenOnSurface(host.byId('useGlobalAuthorRow')!, 'click', () => {
		if (host.currentRepo === null || host.config === null) return;
		const userName = host.config.user.name, userEmail = host.config.user.email;
		const hasLocalOverride = userName.local !== null || userEmail.local !== null;
		const authors = getCommitAuthors(host.ctx());
		const globalMatches = authors.some((author) => userName.global === author.name && userEmail.global === author.email);
		if (globalMatches) {
			if (!hasLocalOverride) return; // already following the global author
			ctx.actions.run({
				command: 'deleteUserDetails',
				repo: host.currentRepo,
				name: userName.local !== null,
				email: userEmail.local !== null,
				location: GG.GitConfigLocation.Local
			}, strings.settingsRemovingUserDetails);
		} else if (authors.length > 0) {
			ctx.actions.run({
				command: 'editUserDetails',
				repo: host.currentRepo,
				name: authors[0].name,
				email: authors[0].email,
				location: GG.GitConfigLocation.Global,
				deleteLocalName: userName.local !== null,
				deleteLocalEmail: userEmail.local !== null
			}, strings.settingsSettingUserDetails);
		} else if (hasLocalOverride) {
			ctx.actions.run({
				command: 'deleteUserDetails',
				repo: host.currentRepo,
				name: userName.local !== null,
				email: userEmail.local !== null,
				location: GG.GitConfigLocation.Local
			}, strings.settingsRemovingUserDetails);
		}
	});

	// Setting an author as the global default writes it to the global Git
	// configuration; repositories without their own selection follow it
	host.listenToClassOnSurface('setGlobalAuthor', 'click', (e) => {
		if (host.currentRepo === null || host.config === null) return;
		const author = getCommitAuthors(host.ctx())[getAuthorIndexForBtnEvent(e)];
		if (author === undefined) return;
		ctx.actions.run({
			command: 'editUserDetails',
			repo: host.currentRepo,
			name: author.name,
			email: author.email,
			location: GG.GitConfigLocation.Global,
			deleteLocalName: false,
			deleteLocalEmail: false
		}, strings.settingsSettingUserDetails);
	});

	host.listenOnSurface(host.byId('settingsAddRemote')!, 'click', () => {
		ctx.dialog.showForm(strings.settingsAddRemoteDialogMessage, [
			{ type: DialogInputType.Text, name: strings.settingsNameInput, default: '', placeholder: null },
			{ type: DialogInputType.Text, name: strings.settingsFetchUrlInput, default: '', placeholder: null },
			{ type: DialogInputType.Text, name: strings.settingsPushUrlInput, default: '', placeholder: strings.settingsPushUrlPlaceholder },
			{ type: DialogInputType.Checkbox, name: strings.settingsFetchImmediately, value: true }
		], strings.settingsAddRemote, (values) => {
			if (host.currentRepo === null) return;
			ctx.actions.run({ command: 'addRemote', repo: host.currentRepo, name: <string>values[0], url: <string>values[1], pushUrl: <string>values[2] !== '' ? <string>values[2] : null, fetch: <boolean>values[3] }, strings.settingsAddingRemote);
		}, { type: TargetType.Repo });
	});

	host.listenToClassOnSurface('editRemote', 'click', (e) => {
		const remote = getRemoteForBtnEvent(host.config, e);
		if (remote === null) return;
		ctx.dialog.showForm(formatStr(markup.settingsEditRemoteDialogMessage, remote.name), [
			{ type: DialogInputType.Text, name: strings.settingsNameInput, default: remote.name, placeholder: null },
			{ type: DialogInputType.Text, name: strings.settingsFetchUrlInput, default: remote.url !== null ? remote.url : '', placeholder: null },
			{ type: DialogInputType.Text, name: strings.settingsPushUrlInput, default: remote.pushUrl !== null ? remote.pushUrl : '', placeholder: strings.settingsPushUrlPlaceholder }
		], strings.settingsSaveChanges, (values) => {
			if (host.currentRepo === null) return;
			ctx.actions.run({ command: 'editRemote', repo: host.currentRepo, nameOld: remote.name, nameNew: <string>values[0], urlOld: remote.url, urlNew: <string>values[1] !== '' ? <string>values[1] : null, pushUrlOld: remote.pushUrl, pushUrlNew: <string>values[2] !== '' ? <string>values[2] : null }, strings.settingsSavingRemoteChanges);
		}, { type: TargetType.Repo });
	});

	host.listenToClassOnSurface('deleteRemote', 'click', (e) => {
		const remote = getRemoteForBtnEvent(host.config, e);
		if (remote === null) return;
		ctx.dialog.showConfirmation(formatStr(markup.settingsDeleteRemoteConfirm, remote.name), strings.settingsYesDelete, () => {
			if (host.currentRepo === null) return;
			ctx.actions.run({ command: 'deleteRemote', repo: host.currentRepo, name: remote.name }, strings.settingsDeletingRemote);
		}, { type: TargetType.Repo });
	});

	host.listenToClassOnSurface('fetchRemote', 'click', (e) => {
		const remote = getRemoteForBtnEvent(host.config, e);
		if (remote === null) return;
		ctx.dialog.showForm(formatStr(markup.settingsFetchRemoteConfirm, remote.name), [
			{ type: DialogInputType.Checkbox, name: strings.settingsPrune, value: store.config.dialogDefaults.fetchRemote.prune, info: strings.settingsPruneInfo },
			{ type: DialogInputType.Checkbox, name: strings.settingsPruneTags, value: store.config.dialogDefaults.fetchRemote.pruneTags, info: strings.settingsPruneTagsInfo }
		], strings.settingsYesFetch, (values) => {
			if (host.currentRepo === null) return;
			ctx.actions.run({ command: 'fetch', repo: host.currentRepo, name: remote.name, prune: <boolean>values[0], pruneTags: <boolean>values[1] }, strings.settingsFetchingFromRemote);
		}, { type: TargetType.Repo });
	});

	host.listenToClassOnSurface('pruneRemote', 'click', (e) => {
		const remote = getRemoteForBtnEvent(host.config, e);
		if (remote === null) return;
		ctx.dialog.showConfirmation(formatStr(markup.settingsPruneRemoteConfirm, remote.name), strings.settingsYesPrune, () => {
			if (host.currentRepo === null) return;
			ctx.actions.run({ command: 'pruneRemote', repo: host.currentRepo, name: remote.name }, strings.settingsPruningRemote);
		}, { type: TargetType.Repo });
	});

	host.listenToClassOnSurface('hideRemoteBtn', 'click', (e) => {
		if (host.currentRepo === null || host.repo === null || host.config === null) return;
		const source = <HTMLElement>(<Element>e.target).closest('.hideRemoteBtn')!;
		const remote = host.config.remotes[parseInt(source.dataset.index!)].name;
		const hideRemote = !host.repo.hideRemotes.includes(remote);
		source.title = hideRemote ? strings.settingsHideRemoteTitle : strings.settingsShowRemoteTitle;
		setHtml(source, hideRemote ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen);
		if (hideRemote) {
			host.repo.hideRemotes.push(remote);
		} else {
			host.repo.hideRemotes.splice(host.repo.hideRemotes.indexOf(remote), 1);
		}
		ctx.persistence.saveRepoStateValue(host.currentRepo, 'hideRemotes', host.repo.hideRemotes);
		ctx.loader.refresh(true);
	});
}

/** The remote whose button a settings widget event came from. */
function getRemoteForBtnEvent(config: Readonly<GG.GitRepoConfig> | null, e: Event) {
	return config !== null
		? config.remotes[parseInt((<HTMLElement>(<Element>e.target).closest('.remoteBtns')!).dataset.index!)]
		: null;
}
