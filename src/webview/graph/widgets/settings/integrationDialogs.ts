/* The dialogs of the Settings Widget that configure the Issue Linking and Pull Request Creation
   integrations of a repository. */

import { html } from '../../../common/html';
import { markup, strings } from '../../../common/i18n/index';
import * as GG from '../../../common/protocol';
import { GraphContext } from '../../context';
import { DialogInput, DialogInputType, DialogInputValue } from '../dialog';
import { TargetType } from '../../state/types';

/**
 * Automatically detect common issue number formats in the specified commits, returning the most common.
 * @param commits The commits to analyse.
 * @returns The regular expression of the most likely issue number format.
 */
export function autoDetectIssueRegex(commits: ReadonlyArray<GG.GitCommit>) {
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

/**
 * Show the dialog allowing the user to configure the issue linking for this repository.
 * @param defaultIssueRegex The default regular expression used to match issue numbers.
 * @param defaultIssueUrl The default URL for the issue number to be substituted into.
 * @param defaultUseGlobally The default value for the checkbox determining whether the issue linking configuration should be used globally (for all repositories).
 * @param isEdit Is the dialog editing an existing issue linking configuration.
 * @param save Applies the configuration.
 */
export function showIssueLinkingDialog(ctx: GraphContext, defaultIssueRegex: string | null, defaultIssueUrl: string | null, defaultUseGlobally: boolean, isEdit: boolean, save: (config: GG.IssueLinkingConfig, global: boolean) => void) {
	let message = html`${isEdit ? markup.settingsEditIssueLinkingHeader : markup.settingsAddIssueLinkingHeader}<p style="font-size:12px; margin:6px 0;">${markup.settingsIssueExampleText}</p><table style="display:inline-table; width:360px; text-align:left; font-size:12px; margin-bottom:2px;"><tr><td>${strings.settingsIssueRegexLabel}</td><td>#(\\d+)</td></tr><tr><td>${strings.settingsIssueUrlLabel}</td><td>https://github.com/your-org/your-repo/issues/$1</td></tr></tbody></table>`;

	if (!isEdit && defaultIssueRegex === null && defaultIssueUrl === null) {
		defaultIssueRegex = autoDetectIssueRegex(ctx.store.commits);
		if (defaultIssueRegex !== null) {
			message = html`${message}<p style="font-size:12px"><i>${strings.settingsIssueRegexDetected}</i></p>`;
		}
	}

	ctx.dialog.showForm(message, [
		{ type: DialogInputType.Text, name: strings.settingsIssueRegexInput, default: defaultIssueRegex !== null ? defaultIssueRegex : '', placeholder: null, info: strings.settingsIssueRegexInfo },
		{ type: DialogInputType.Text, name: strings.settingsIssueUrlInput, default: defaultIssueUrl !== null ? defaultIssueUrl : '', placeholder: null, info: strings.settingsIssueUrlInfo },
		{ type: DialogInputType.Checkbox, name: strings.settingsUseGlobally, value: defaultUseGlobally, info: strings.settingsUseGloballyIssueInfo }
	], strings.settingsSave, (values) => {
		const issueRegex = (<string>values[0]).trim(), issueUrl = (<string>values[1]).trim(), useGlobally = <boolean>values[2];
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
			ctx.dialog.showError(strings.settingsInvalidIssueRegex, regExpParseError, strings.settingsGoBack, () => {
				showIssueLinkingDialog(ctx, issueRegex, issueUrl, useGlobally, isEdit, save);
			});
		} else if (!(/\$([1-9][0-9]*)/.test(issueUrl))) {
			ctx.dialog.showError(strings.settingsInvalidIssueUrl, strings.settingsIssueUrlNoPlaceholders, strings.settingsGoBack, () => {
				showIssueLinkingDialog(ctx, issueRegex, issueUrl, useGlobally, isEdit, save);
			});
		} else {
			save({ issue: issueRegex, url: issueUrl }, useGlobally);
		}
	}, null, strings.dialogCancel, null, false);
}

/**
 * Show the first dialog for configuring the pull request integration.
 * @param config The pull request configuration.
 * @param remotes The remotes of the repository.
 * @param save Applies the finished configuration.
 */
export function showPullRequestIntegrationDialog1(ctx: GraphContext, config: GG.DeepWriteable<GG.PullRequestConfig>, remotes: ReadonlyArray<GG.GitRepoSettingsRemote>, save: (config: GG.PullRequestConfig) => void) {
	const store = ctx.store;
	const originIndex = remotes.findIndex((remote) => remote.name === 'origin');
	const upstreamIndex = remotes.findIndex((remote) => remote.name === 'upstream');
	let sourceRemoteIndex = remotes.findIndex((remote) => remote.name === config.sourceRemote);
	let destRemoteIndex = remotes.findIndex((remote) => remote.name === config.destRemote);

	if (config.sourceRemote === '' || sourceRemoteIndex === -1) {
		sourceRemoteIndex = originIndex > -1 ? originIndex : 0;
	}
	if (config.destRemote === '') {
		destRemoteIndex = upstreamIndex > -1 ? upstreamIndex : originIndex > -1 ? originIndex : 0;
	}

	let defaultProvider = config.provider.toString();
	const providerOptions = [
		{ name: 'Bitbucket', value: (GG.PullRequestProvider.Bitbucket).toString() },
		{ name: 'GitHub', value: (GG.PullRequestProvider.GitHub).toString() },
		{ name: 'GitLab', value: (GG.PullRequestProvider.GitLab).toString() }
	];
	const providerTemplateLookup: { [name: string]: string } = {};
	store.config.customPullRequestProviders.forEach((provider) => {
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

	const sourceRemoteOptions = remotes.map((remote: { name: string }, index: number) => ({ name: remote.name, value: index.toString() }));
	const destRemoteOptions = sourceRemoteOptions.map((option: { name: string, value: string }) => option);
	destRemoteOptions.push({ name: strings.settingsNotARemote, value: '-1' });

	ctx.dialog.showForm(markup.settingsPrDialog1Header, [
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
		let newProvider = <GG.PullRequestProvider>parseInt(<string>values[0]);
		if (newProvider > 3) newProvider = GG.PullRequestProvider.Custom;

		const newSourceRemoteIndex = parseInt(<string>values[1]);
		const newDestRemoteIndex = parseInt(<string>values[2]);
		const newSourceRemote = remotes[newSourceRemoteIndex].name;
		const newDestRemote = newDestRemoteIndex > -1 ? remotes[newDestRemoteIndex].name : null;
		const newSourceUrl = remotes[newSourceRemoteIndex].url;
		const newDestUrl = newDestRemoteIndex > -1 ? remotes[newDestRemoteIndex].url : null;

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
				const branches = store.gitBranches
					.filter((branch) => branch.startsWith('remotes/' + newDestRemote + '/') && branch !== ('remotes/' + newDestRemote + '/HEAD'))
					.map((branch) => branch.substring(newDestRemote.length + 9));
				config.destBranch = branches.length > 0 ? branches.includes('master') ? 'master' : branches[0] : '';
			} else {
				config.destOwner = '';
				config.destRepo = '';
				config.destBranch = '';
			}
		}

		showPullRequestIntegrationDialog2(ctx, config, remotes, save);
	}, { type: TargetType.Repo });
}

/**
 * Show the second dialog for configuring the pull request integration.
 */
function showPullRequestIntegrationDialog2(ctx: GraphContext, config: GG.DeepWriteable<GG.PullRequestConfig>, remotes: ReadonlyArray<GG.GitRepoSettingsRemote>, save: (config: GG.PullRequestConfig) => void) {
	const store = ctx.store;
	const destBranches = config.destRemote !== null
		? store.gitBranches
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

	ctx.dialog.showForm(markup.settingsPrDialog2Header, inputs, strings.settingsSaveConfiguration, (values) => {
		updateConfigWithFormValues(values);
		save(config);
	}, { type: TargetType.Repo }, strings.settingsBack, (values) => {
		updateConfigWithFormValues(values);
		showPullRequestIntegrationDialog1(ctx, config, remotes, save);
	});
}
