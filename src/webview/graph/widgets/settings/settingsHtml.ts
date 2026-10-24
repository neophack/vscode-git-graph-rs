/* Markup helpers of the Settings Widget: rows and checkboxes bound to Extension Settings, and the
   backend section. */

import { helpTooltipAttrs, html, joinHtml, SafeHtml } from '../../../common/html';
import { formatStr, strings } from '../../../common/i18n/index';
import { SVG_ICONS } from '../../../common/icons';
import * as GG from '../../../common/protocol';

/**
 * Render the Backend section: which engine serves each area of the extension *on the platform
 * this editor is running on*. The split is computed by the extension host (it depends on
 * whether this installation actually contains an engine binary for this platform) and sent
 * with the view's initial state.
 */
export function renderBackendSection(backend: GG.BackendReport): SafeHtml {
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
		? formatStr(strings.settingsBackendEngineLoaded, backend.engineVersion !== null ? backend.engineVersion : '')
		: strings.settingsBackendEngineMissing;

	return html`<div class="settingsSection backendSection"><h3>${strings.settingsSectionBackend}</h3><table><tr class="lineBelow"><td class="left">${strings.settingsBackendPlatform}</td><td class="left"><code>${backend.platform}</code></td></tr><tr class="lineBelow"><td class="left">${strings.settingsBackendEngine}</td><td class="left backendEngine${backend.engineAvailable ? ' engineLoaded' : ' engineMissing'}">${engineStatus}</td></tr><tr class="lineBelow"><td class="left">${strings.settingsBackendGitCli}</td><td class="left backendEngine${backend.gitCliAvailable ? ' engineLoaded' : ' engineMissing'}">${backend.gitCliAvailable ? strings.settingsBackendGitCliFound : strings.settingsBackendGitCliMissing}</td></tr></table><table class="backendTable"><tr><th class="left">${strings.settingsBackendArea}</th><th class="left">${strings.settingsBackendProvider}</th></tr>${joinHtml(backend.capabilities.map((capability) =>
		html`<tr class="lineAbove"><td class="left">${areaLabels[capability.area] !== undefined ? areaLabels[capability.area] : capability.area}</td><td class="left"><span class="backendBadge ${capability.provider}">${providerLabels[capability.provider] !== undefined ? providerLabels[capability.provider] : capability.provider}</span></td></tr>`
	))}</table></div>`;
}

/**
 * Render a table row containing a `<select>` bound to a Global Setting.
 * @param id The id of the `<select>` element.
 * @param label The label displayed in the first column.
 * @param options The options of the `<select>`, in the order they are displayed.
 * @param value The value of the option that is currently selected.
 */
export function selectRow(id: string, label: string, options: ReadonlyArray<{ name: string, value: string }>, value: string): SafeHtml {
	return html`<tr class="lineAbove"><td class="left">${label}</td><td class="left" colspan="2"><select class="settingsGlobalSelect" id="${id}" tabindex="-1">${options.map((option) =>
		html`<option value="${option.value}"${option.value === value ? html` selected` : ''}>${option.name}</option>`)}</select></td></tr>`;
}

/**
 * Render a table row containing a numeric `<input>` bound to a Global Setting.
 * @param id The id of the `<input>` element.
 * @param label The label displayed in the first column.
 * @param value The current value of the setting.
 * @param min The smallest value the setting accepts.
 * @param max The largest value the setting accepts.
 * @param unit The unit displayed after the input (NULL => no unit).
 */
export function numberRow(id: string, label: string, value: number, min: number, max: number, unit: string | null): SafeHtml {
	return html`<tr class="lineAbove"><td class="left">${label}</td><td class="left" colspan="2"><input class="settingsGlobalNumber" type="number" id="${id}" tabindex="-1" min="${min}" max="${max}" value="${value}">${unit !== null ? html`<span class="settingsInputUnit">${unit}</span>` : ''}</td></tr>`;
}

/**
 * Render a checkbox bound to a Global Setting.
 * @param id The id of the label (the `<input>` gets the id with a "Checkbox" suffix).
 * @param label The text displayed beside the checkbox.
 * @param checked Is the checkbox checked.
 * @param info The tooltip of an information icon rendered after the label (NULL => no icon).
 */
export function checkbox(id: string, label: string, checked: boolean, info: string | null): SafeHtml {
	return html`<label class="settingsGlobalCheckbox" id="${id}"><input type="checkbox" id="${id}Checkbox" tabindex="-1"${checked ? html` checked` : ''}><span class="customCheckbox"></span>${label}</label>${info !== null ? html`<span ${helpTooltipAttrs(info, 'settingsWidgetInfo')}>${SVG_ICONS.info}</span>` : ''}<br/>`;
}

/**
 * The value of the `git-graph-rs.date.format` Extension Setting that produces the given parsed
 * date format (the webview only receives the parsed form).
 */
export function dateFormatSettingValue(dateFormat: GG.DateFormat) {
	if (dateFormat.type === GG.DateFormatType.Relative) return 'Relative';
	return (dateFormat.iso ? 'ISO ' : '') + (dateFormat.type === GG.DateFormatType.DateOnly ? 'Date Only' : 'Date & Time');
}
