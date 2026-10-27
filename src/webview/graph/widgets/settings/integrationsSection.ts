/* The integration sections of the Settings Widget's Repository column: the Issue Linking and
   Pull Request Creation configurations of the repository (their dialogs live in
   integrationDialogs.ts). */

import { html, SafeHtml } from '../../../common/html';
import { markup, strings } from '../../../common/i18n/index';
import { SVG_ICONS } from '../../../common/icons';
import * as GG from '../../../common/protocol';
import { GraphContext } from '../../context';
import { showIssueLinkingDialog, showPullRequestIntegrationDialog1 } from './integrationDialogs';
import type { SettingsHost } from './settingsHost';

/** Render the Issue Linking section: the configured issue matcher, or the introduction. */
export function renderIssueLinkingSection(ctx: GraphContext, repo: Readonly<GG.GitRepoState>): SafeHtml {
	const issueLinkingConfig = repo.issueLinkingConfig || ctx.store.globalViewState.issueLinkingConfig;
	return html`<div class="settingsSection centered"><h3>${strings.settingsSectionIssueLinking}</h3>${issueLinkingConfig !== null
		? html`<table><tr><td class="left">${strings.settingsIssueRegexLabel}</td><td class="leftWithEllipsis" title="${issueLinkingConfig.issue}">${issueLinkingConfig.issue}</td></tr><tr><td class="left">${strings.settingsIssueUrlLabel}</td><td class="leftWithEllipsis" title="${issueLinkingConfig.url}">${issueLinkingConfig.url}</td></tr></table><div class="settingsSectionButtons"><div id="editIssueLinking" class="editBtn">${SVG_ICONS.pencil}${strings.settingsEdit}</div><div id="removeIssueLinking" class="removeBtn">${SVG_ICONS.close}${strings.settingsRemove}</div></div>`
		: html`<span>${markup.settingsIssueLinkingIntro}</span><div class="settingsSectionButtons"><div id="editIssueLinking" class="addBtn">${SVG_ICONS.plus}${strings.settingsAddIssueLinking}</div></div>`}</div>`;
}

/** Render the Pull Request section: the configured integration, or the introduction. */
export function renderPullRequestSection(repo: Readonly<GG.GitRepoState>): SafeHtml {
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

/** Wire the Issue Linking and Pull Request integration sections of the Repository column. */
export function wireIntegrations(host: SettingsHost, repo: Readonly<GG.GitRepoState>) {
	const ctx = host.ctx(), store = ctx.store;

	host.listenOnSurface(host.byId('editIssueLinking')!, 'click', () => {
		if (host.repo === null) return;
		const globalIssueLinking = store.globalViewState.issueLinkingConfig;
		const issueLinkingConfig = host.repo.issueLinkingConfig || globalIssueLinking;
		const save = (config: GG.IssueLinkingConfig, global: boolean) => setIssueLinkingConfig(host, config, global);
		if (issueLinkingConfig !== null) {
			showIssueLinkingDialog(ctx, issueLinkingConfig.issue, issueLinkingConfig.url, host.repo.issueLinkingConfig === null && globalIssueLinking !== null, true, save);
		} else {
			showIssueLinkingDialog(ctx, null, null, false, false, save);
		}
	});

	if (repo.issueLinkingConfig !== null || store.globalViewState.issueLinkingConfig !== null) {
		host.listenOnSurface(host.byId('removeIssueLinking')!, 'click', () => {
			if (host.repo === null) return;
			const locallyConfigured = host.repo.issueLinkingConfig !== null;
			const globalConfigured = store.globalViewState.issueLinkingConfig !== null;
			ctx.dialog.showConfirmation(html`${strings.settingsRemoveConfirmPrefix}${locallyConfigured ? html`${globalConfigured ? markup.settingsRemoveIssueLinkingLocal : ''}${strings.settingsRemoveIssueLinkingFromRepo}` : markup.settingsRemoveIssueLinkingGlobal}?`, strings.settingsYesRemove, () => {
				setIssueLinkingConfig(host, null, !locallyConfigured);
			}, null);
		});
	}

	if (host.config !== null) {
		host.listenOnSurface(host.byId('editPullRequestIntegration')!, 'click', () => {
			if (host.repo === null || host.config === null) return;

			if (host.config.remotes.length === 0) {
				ctx.dialog.showError(strings.settingsUnableToConfigurePr, strings.settingsPrNeedsRemote, null, null);
				return;
			}

			let config: GG.DeepWriteable<GG.PullRequestConfig>;
			if (host.repo.pullRequestConfig === null) {
				const originIndex = host.config.remotes.findIndex((remote) => remote.name === 'origin');
				const sourceRemoteUrl = host.config.remotes[originIndex > -1 ? originIndex : 0].url;
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
				config = Object.assign({}, host.repo.pullRequestConfig);
			}
			showPullRequestIntegrationDialog1(ctx, config, host.config.remotes, (finished) => setPullRequestConfig(host, finished));
		});

		if (repo.pullRequestConfig !== null) {
			host.listenOnSurface(host.byId('removePullRequestIntegration')!, 'click', () => {
				ctx.dialog.showConfirmation(strings.settingsRemovePrConfirm, strings.settingsYesRemove, () => {
					setPullRequestConfig(host, null);
				}, null);
			});
		}
	}
}

/**
 * Save the issue linking configuration for this repository, and refresh the view so these changes are taken into affect.
 * @param host The Settings Widget the section is rendered in.
 * @param config The issue linking configuration to save.
 * @param global Should this configuration be set globally for all repositories, or locally for this specific repository.
 */
function setIssueLinkingConfig(host: SettingsHost, config: GG.IssueLinkingConfig | null, global: boolean) {
	if (host.currentRepo === null || host.repo === null) return;
	const ctx = host.ctx();

	if (global) {
		if (host.repo.issueLinkingConfig !== null) {
			ctx.persistence.saveRepoStateValue(host.currentRepo, 'issueLinkingConfig', null);
		}
		ctx.persistence.updateGlobalViewState('issueLinkingConfig', config);
	} else {
		ctx.persistence.saveRepoStateValue(host.currentRepo, 'issueLinkingConfig', config);
	}

	ctx.loader.refresh(true);
	host.rerender();
}

/** Save the pull request configuration for this repository. */
function setPullRequestConfig(host: SettingsHost, config: GG.PullRequestConfig | null) {
	if (host.currentRepo === null) return;
	host.ctx().persistence.saveRepoStateValue(host.currentRepo, 'pullRequestConfig', config);
	host.rerender();
}
