/* The Repository Settings column's own sections: the General section (the repository's display
   name and initial branches, the graph content overrides), the Gerrit section, and the entry that
   exports the repository's persisted configuration - all of it the per-repository state the
   extension itself stores. The column's Git-configuration sections (commit author, remotes), the
   integrations and the repository tools live in their own modules; this module composes the
   column from all of them. */

import { helpTooltipAttrs, html, SafeHtml } from '../../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../../common/i18n/index';
import { SVG_ICONS } from '../../../common/icons';
import * as GG from '../../../common/protocol';
import { arraysStrictlyEqualIgnoringOrder, formatCommaSeparatedList, getRepoName } from '../../../common/util';
import { GraphContext } from '../../context';
import { getIncludeCommitsMentionedByReflogs, getOnlyFollowFirstParent, getOnRepoLoadShowCheckedOutBranch, getOnRepoLoadShowSpecificBranches, getShowStashes, getShowTags } from '../../state/repoSettings';
import { DialogInputType } from '../dialog';
import { renderIssueLinkingSection, renderPullRequestSection, wireIntegrations } from './integrationsSection';
import { renderCommitAuthorSection, renderRemotesSection, wireConfigSettings } from './remotesSection';
import { checkbox } from './settingsHtml';
import type { SettingsHost } from './settingsHost';
import { renderToolsSection, wireToolsSection } from './toolsSection';

/**
 * Render the Repository Settings column.
 * @param ctx The view's context.
 * @param currentRepo The repository that is currently loaded in the view.
 * @param repo The persisted state of that repository.
 * @param config The repository's Git configuration (the commit author and remotes sections need
 * it; they are omitted entirely until it has loaded).
 */
export function renderRepoColumn(ctx: GraphContext, currentRepo: string, repo: Readonly<GG.GitRepoState>, config: Readonly<GG.GitRepoConfig> | null): SafeHtml {
	const store = ctx.store, viewConfig = store.config;
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
	if (config !== null) {
		remotes = html`${renderCommitAuthorSection(ctx, config)}${renderRemotesSection(config, repo)}`;
	}

	const issueLinking = renderIssueLinkingSection(ctx, repo);
	const pullRequest = config !== null ? renderPullRequestSection(repo) : '';

	const tools = renderToolsSection();
	const configSection = html`<div class="settingsSection"><h3>${strings.settingsSectionConfig}</h3><div class="settingsSectionButtons"><div id="exportRepositoryConfig">${SVG_ICONS.package}${strings.settingsExportRepoConfig}</div></div></div>`;

	return html`${general}${gerrit}${remotes}${issueLinking}${pullRequest}${tools}${configSection}`;
}

/** Wire the Repository Settings column (the sections of all the repository column's modules). */
export function wireRepoSettings(host: SettingsHost, repo: Readonly<GG.GitRepoState>) {
	const ctx = host.ctx(), store = ctx.store, viewConfig = store.config;
	const initialBranchesLocallyConfigured = repo.onRepoLoadShowCheckedOutBranch !== GG.BooleanOverride.Default || repo.onRepoLoadShowSpecificBranches !== null;

	host.listenOnSurface(host.byId('editRepoName')!, 'click', () => {
		if (host.currentRepo === null || host.repo === null) return;
		ctx.dialog.showForm(strings.settingsNameDialogMessage, [
			{ type: DialogInputType.Text, name: strings.settingsNameInput, default: host.repo.name || '', placeholder: getRepoName(host.currentRepo) }
		], strings.settingsNameDialogSave, (values) => {
			if (host.currentRepo === null) return;
			ctx.persistence.saveRepoStateValue(host.currentRepo, 'name', <string>values[0] || null);
			ctx.controls.renderRepoDropdownOptions();
			host.rerender();
		}, null);
	});

	if (repo.name !== null) {
		host.listenOnSurface(host.byId('deleteRepoName')!, 'click', () => {
			if (host.currentRepo === null || host.repo === null || host.repo.name === null) return;
			ctx.dialog.showConfirmation(formatStr(markup.settingsDeleteNameConfirm, host.repo.name, getRepoName(host.currentRepo)), strings.settingsYesDelete, () => {
				if (host.currentRepo === null) return;
				ctx.persistence.saveRepoStateValue(host.currentRepo, 'name', null);
				ctx.controls.renderRepoDropdownOptions();
				host.rerender();
			}, null);
		});
	}

	host.listenOnSurface(host.byId('editInitialBranches')!, 'click', () => {
		if (host.repo === null) return;
		const showCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(host.repo.onRepoLoadShowCheckedOutBranch, viewConfig);
		const showSpecificBranches = getOnRepoLoadShowSpecificBranches(host.repo.onRepoLoadShowSpecificBranches, viewConfig);
		ctx.dialog.showForm(html`${markup.settingsInitialBranchesDialogHeader}<p style="margin:6px 0;">${strings.settingsInitialBranchesDialogText}</p><p style="font-size:12px; margin:6px 0 0 0;">${strings.settingsInitialBranchesDialogNote}</p>`, [
			{ type: DialogInputType.Checkbox, name: strings.settingsInitialBranchesCheckedOutInput, value: showCheckedOutBranch },
			{ type: DialogInputType.Select, name: strings.settingsInitialBranchesSpecificInput, options: store.getBranchOptions(), defaults: showSpecificBranches, multiple: true }
		], strings.settingsSaveConfiguration, (values) => {
			if (host.currentRepo === null) return;
			if (showCheckedOutBranch !== values[0] || !arraysStrictlyEqualIgnoringOrder(showSpecificBranches, <string[]>values[1])) {
				ctx.persistence.saveRepoStateValue(host.currentRepo, 'onRepoLoadShowCheckedOutBranch', values[0] ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				ctx.persistence.saveRepoStateValue(host.currentRepo, 'onRepoLoadShowSpecificBranches', <string[]>values[1]);
				host.rerender();
			}
		}, null, strings.dialogCancel, null, false);
	});

	if (initialBranchesLocallyConfigured) {
		host.listenOnSurface(host.byId('clearInitialBranches')!, 'click', () => {
			ctx.dialog.showConfirmation(strings.settingsClearInitialBranchesConfirm, strings.settingsYesClear, () => {
				if (host.currentRepo === null) return;
				ctx.persistence.saveRepoStateValue(host.currentRepo, 'onRepoLoadShowCheckedOutBranch', GG.BooleanOverride.Default);
				ctx.persistence.saveRepoStateValue(host.currentRepo, 'onRepoLoadShowSpecificBranches', null);
				host.rerender();
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
		const elem = <HTMLInputElement>host.byId(field.id);
		elem.checked = field.get(repo[field.key]);
		host.listenOnSurface(elem, 'change', () => {
			if (host.currentRepo === null) return;
			const current = <HTMLInputElement | null>host.byId(field.id);
			if (current === null) return;
			ctx.persistence.saveRepoStateValue(host.currentRepo, field.key, current.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
			ctx.loader.refresh(true);
		});
	}

	const gerritFetchRefsElem = <HTMLInputElement | null>host.byId('settingsGerritFetchRefsCheckbox');
	if (gerritFetchRefsElem !== null) {
		host.listenOnSurface(gerritFetchRefsElem, 'change', () => {
			if (host.currentRepo === null || host.repo === null) return;
			if (gerritFetchRefsElem.checked) {
				// Enabling: the repository is marked stale on the extension host, so the
				// reload triggered by the response runs the Gerrit fetch pipeline
				setGerritFetchRefs(host, true);
			} else {
				// Disabling deletes the locally fetched change refs: confirm first
				ctx.dialog.showConfirmation(markup.settingsGerritDisableConfirm, strings.settingsGerritDisableAction, () => {
					setGerritFetchRefs(host, false);
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
		const elem = <HTMLInputElement | null>host.byId(field.id + 'Checkbox');
		if (elem === null) continue;
		host.listenOnSurface(elem, 'change', () => {
			if (host.currentRepo === null || host.repo === null) return;
			const statusFilter = Object.assign({}, host.repo.gerritStatusFilter);
			statusFilter[field.status] = elem.checked;
			ctx.persistence.saveRepoStateValue(host.currentRepo, 'gerritStatusFilter', statusFilter);
			// The badges re-render instantly from the loaded states; the graph reload (which
			// change refs are injected) follows in the background
			ctx.loader.applyGerritFilterChange();
		});
	}

	const editGerritFetchLimitElem = host.byId('editGerritFetchLimit');
	if (editGerritFetchLimitElem !== null) {
		host.listenOnSurface(editGerritFetchLimitElem, 'click', () => {
			if (host.currentRepo === null || host.repo === null) return;
			const current = host.repo.gerritFetchLimit !== undefined ? host.repo.gerritFetchLimit : null;
			ctx.dialog.showForm(strings.settingsGerritFetchLimitEditTitle, [
				{ type: DialogInputType.Text, name: strings.settingsGerritFetchLimitInput, default: current !== null ? String(current) : '', placeholder: strings.settingsGerritFetchLimitPlaceholder }
			], strings.settingsSave, (values) => {
				if (host.currentRepo === null) return;
				// An empty input (or anything not a positive number) clears the override,
				// following the gerrit.fetchLimit Extension Setting again; a value is clamped
				// into the 1..10000 range the setting allows
				const raw = String(values[0]).trim();
				const parsed = parseInt(raw, 10);
				const limit = raw !== '' && isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), 10000) : null;
				ctx.persistence.saveRepoStateValue(host.currentRepo, 'gerritFetchLimit', limit);
				host.rerender();
				// The set of fetched changes changes with the limit: reload, so the Gerrit
				// pipeline re-fetches under it (the staged load updates the view as it arrives)
				ctx.loader.refresh(false);
			}, null);
		});
	}

	if (host.config !== null) {
		wireConfigSettings(host);
	}

	wireIntegrations(host, repo);

	host.listenOnSurface(host.byId('exportRepositoryConfig')!, 'click', () => {
		ctx.dialog.showConfirmation(strings.settingsExportRepoConfigConfirm, strings.settingsYesExport, () => {
			if (host.currentRepo === null) return;
			ctx.actions.run({ command: 'exportRepoConfig', repo: host.currentRepo }, strings.settingsExportingRepoConfig);
		}, null);
	});

	wireToolsSection(host);
}

/**
 * Persist the "Fetch Gerrit change refs" checkbox of the Repository Settings and run the
 * corresponding host action: enabling marks the repository's Gerrit data stale (so the reload
 * triggered by the response fetches the change refs from the remote), disabling deletes the
 * locally fetched change refs. The response reloads the Git Graph View either way.
 */
function setGerritFetchRefs(host: SettingsHost, enabled: boolean) {
	if (host.currentRepo === null) return;
	const ctx = host.ctx();
	ctx.persistence.saveRepoStateValue(host.currentRepo, 'gerritFetchRefs', enabled);
	ctx.actions.run({ command: 'gerritSetFetchRefs', repo: host.currentRepo, enabled: enabled }, enabled ? strings.settingsGerritEnabling : strings.settingsGerritClearing);
	host.rerender();
}
