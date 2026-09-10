/* Theme audit harness: renders representative markup of every Git Graph page (commit table,
 * commit details view, dialogs, context menu, dropdown, find widget, settings widget) under the
 * four VS Code theme kinds, using the extension's real stylesheet. Produces one HTML file per
 * theme next to this script (open in a browser, or screenshot headlessly) for visual contrast
 * checking. Not part of the extension build.
 *
 * Usage: node scripts/theme-audit-harness.mjs [outDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || join(root, '.theme-audit');
mkdirSync(outDir, { recursive: true });

const css = ['main.css', 'contextMenu.css', 'dialog.css', 'dropdown.css', 'findWidget.css', 'settingsWidget.css']
	.map((f) => readFileSync(join(root, 'web', 'styles', f), 'utf8')).join('\n');

const icons = {
	review: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill-rule="evenodd" d="m4,4.7 -4,7.3 4,7.3 2.5,0 -4,-7.3 4,-7.3zM11.5,6C9,5.5 6.6,7.1 6.1,9.6c-0.5,2.6 1.1,5 3.6,5.5 1,0.2 1.8,0.1 2.7,-0.3l2.5,3.3c0.1,0.1 0.3,0.2 0.5,0.3 0.2,0 0.4,0 0.6,-0.1 0.3,-0.2 0.4,-0.4 0.4,-0.6 0,-0.2 0,-0.4 -0.1,-0.6 0,-0.2 -2.4,-3.3 -2.4,-3.3 0.7,-0.6 1,-1.5 1.3,-2.4C15.7,8.9 14,6.5 11.5,6zm8.5,-1.3 -2.5,0 4,7.3 -4.2,7.3 2.5,0L24,12zm-8.8,3c1.6,0.3 2.6,1.8 2.3,3.4 -0.3,1.6 -1.8,2.6 -3.4,2.3C8.5,13 7.4,11.6 7.8,10 8,8.4 9.6,7.3 11.2,7.7z"/></svg>',
	pullRequest: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>',
	linkExternal: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4 3.5h3V2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V10h-1.5v3h-9v-9H4ZM8.5 2H14v5.5h-1.5V4.56l-4.72 4.72-.7-.7 4.22-4.22L11 7.5h.5V2h-3V2Z"/></svg>',
	chevronDown: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill-rule="evenodd" d="M7,10.5L1.2,4.7l1.4,-1.4L7,7.7l4.4,-4.4l1.4,1.4z"/></svg>',
	folder: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M7.71 3h6.79A1.5 1.5 0 0 1 16 4.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-10A1.5 1.5 0 0 1 1.5 1h3.71l2.5 2z"/></svg>',
	file: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4 1h5l4 4v10H4V1zm4 1v4h4L8 2z"/></svg>',
	openChanges: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13 12V4.414C13 4.014 12.844 3.637 12.561 3.353L9.64602.439C9.36302.156 8.98602 0 8.58502 0H3.99902C2.89602 0 1.99902.897 1.99902 2V12C1.99902 13.103 2.89602 14 3.99902 14H10.999C12.102 14 12.999 13.103 12.999 12H13Z"/></svg>',
	loading: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="20" viewBox="0 0 12 16"><circle cx="6" cy="8" r="5"/></svg>'
};

const themes = {
	'dark': {
		label: 'Dark+ (default dark)',
		bodyClass: 'vscode-dark',
		vars: {
			'--vscode-editor-background': '#1e1e1e', '--vscode-editor-foreground': '#cccccc',
			'--vscode-menu-background': '#252526', '--vscode-menu-foreground': '#cccccc',
			'--vscode-menu-selectionBackground': '#04395e', '--vscode-menu-selectionForeground': '#ffffff',
			'--vscode-descriptionForeground': '#ccccccb3',
			'--vscode-editorWidget-background': '#252526', '--vscode-editorSuggestWidget-foreground': '#cccccc',
			'--vscode-input-background': '#3c3c3c', '--vscode-input-foreground': '#cccccc',
			'--vscode-input-placeholderForeground': '#6f6f6f', '--vscode-inputValidation-errorBackground': '#5a1d1d',
			'--vscode-inputOption-activeBackground': '#245f9e',
			'--vscode-textLink-foreground': '#3794ff', '--vscode-textLink-activeForeground': '#3794ff',
			'--vscode-focusBorder': '#007fd4', '--vscode-widget-shadow': 'rgba(0,0,0,0.36)',
			'--vscode-errorForeground': '#f48771',
			'--vscode-editorWarning-foreground': '#cca700', '--vscode-editorLightBulb-foreground': '#ffcc00',
			'--vscode-charts-green': '#89d185', '--vscode-charts-purple': '#b180d7', '--vscode-charts-red': '#f14c4c',
			'--vscode-charts-blue': '#59a4f9', '--vscode-charts-yellow': '#cca700',
			'--vscode-testing-iconPassed': '#73c991', '--vscode-testing-iconFailed': '#f14c4c',
			'--vscode-gitDecoration-modifiedResourceForeground': '#e2c08d',
			'--vscode-gitDecoration-addedResourceForeground': '#81b88b',
			'--vscode-gitDecoration-deletedResourceForeground': '#c74e39',
			'--vscode-panel-border': '#454545', '--vscode-button-background': '#0e639c',
			'--vscode-dropdown-foreground': '#cccccc', '--vscode-dropdown-background': '#3c3c3c', '--vscode-dropdown-border': '#3c3c3c',
			'--vscode-textCodeBlock-background': '#3c3c3c66'
		}
	},
	'light': {
		label: 'Light+ (default light)',
		bodyClass: 'vscode-light',
		vars: {
			'--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#333333',
			'--vscode-menu-background': '#ffffff', '--vscode-menu-foreground': '#333333',
			'--vscode-menu-selectionBackground': '#0060c0', '--vscode-menu-selectionForeground': '#ffffff',
			'--vscode-descriptionForeground': '#717171',
			'--vscode-editorWidget-background': '#f3f3f3', '--vscode-editorSuggestWidget-foreground': '#333333',
			'--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#333333',
			'--vscode-input-placeholderForeground': '#767676', '--vscode-inputValidation-errorBackground': '#fceaea',
			'--vscode-inputOption-activeBackground': '#d0e4f5',
			'--vscode-textLink-foreground': '#006ab1', '--vscode-textLink-activeForeground': '#006ab1',
			'--vscode-focusBorder': '#0090f1', '--vscode-widget-shadow': 'rgba(0,0,0,0.16)',
			'--vscode-errorForeground': '#e51400',
			'--vscode-editorWarning-foreground': '#bf8803', '--vscode-editorLightBulb-foreground': '#ffcc00',
			'--vscode-charts-green': '#388a34', '--vscode-charts-purple': '#652d90', '--vscode-charts-red': '#e51400',
			'--vscode-charts-blue': '#0063d3', '--vscode-charts-yellow': '#bf8803',
			'--vscode-testing-iconPassed': '#107c10', '--vscode-testing-iconFailed': '#e51400',
			'--vscode-gitDecoration-modifiedResourceForeground': '#895d3a',
			'--vscode-gitDecoration-addedResourceForeground': '#587c1c',
			'--vscode-gitDecoration-deletedResourceForeground': '#ad0707',
			'--vscode-panel-border': '#c8c8c8', '--vscode-button-background': '#007acc',
			'--vscode-dropdown-foreground': '#333333', '--vscode-dropdown-background': '#ffffff', '--vscode-dropdown-border': '#cecece',
			'--vscode-textCodeBlock-background': '#00000010'
		}
	},
	'hc-dark': {
		label: 'Default High Contrast (dark)',
		bodyClass: 'vscode-high-contrast',
		vars: {
			'--vscode-editor-background': '#000000', '--vscode-editor-foreground': '#ffffff',
			'--vscode-menu-background': '#000000', '--vscode-menu-foreground': '#ffffff',
			'--vscode-menu-selectionBackground': '#0f4a85', '--vscode-menu-selectionForeground': '#ffffff',
			'--vscode-descriptionForeground': '#ffffffb3',
			'--vscode-editorWidget-background': '#0c141f', '--vscode-editorSuggestWidget-foreground': '#ffffff',
			'--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#000000',
			'--vscode-input-placeholderForeground': '#767676', '--vscode-inputValidation-errorBackground': '#5a1d1d',
			'--vscode-inputOption-activeBackground': '#245f9e',
			'--vscode-textLink-foreground': '#f38518', '--vscode-textLink-activeForeground': '#f38518',
			'--vscode-focusBorder': '#f38518', '--vscode-widget-shadow': 'rgba(0,0,0,0.36)',
			'--vscode-errorForeground': '#f48771',
			'--vscode-editorWarning-foreground': '#ffd370', '--vscode-editorLightBulb-foreground': '#ffcc00',
			'--vscode-charts-green': '#89d185', '--vscode-charts-purple': '#b180d7', '--vscode-charts-red': '#f14c4c',
			'--vscode-charts-blue': '#59a4f9', '--vscode-charts-yellow': '#ffd370',
			'--vscode-testing-iconPassed': '#73c991', '--vscode-testing-iconFailed': '#f14c4c',
			'--vscode-gitDecoration-modifiedResourceForeground': '#1cc41c',
			'--vscode-gitDecoration-addedResourceForeground': '#1cc41c',
			'--vscode-gitDecoration-deletedResourceForeground': '#f14c4c',
			'--vscode-panel-border': '#6fc3df', '--vscode-button-background': '#0e639c',
			'--vscode-dropdown-foreground': '#ffffff', '--vscode-dropdown-background': '#000000', '--vscode-dropdown-border': '#6fc3df',
			'--vscode-textCodeBlock-background': '#ffffff20'
		}
	},
	'hc-light': {
		label: 'Default High Contrast Light',
		bodyClass: 'vscode-high-contrast-light',
		vars: {
			'--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#292929',
			'--vscode-menu-background': '#ffffff', '--vscode-menu-foreground': '#292929',
			'--vscode-menu-selectionBackground': '#0f4a85', '--vscode-menu-selectionForeground': '#ffffff',
			'--vscode-descriptionForeground': '#292929b3',
			'--vscode-editorWidget-background': '#fdfdfd', '--vscode-editorSuggestWidget-foreground': '#292929',
			'--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#292929',
			'--vscode-input-placeholderForeground': '#767676', '--vscode-inputValidation-errorBackground': '#fceaea',
			'--vscode-inputOption-activeBackground': '#d0e4f5',
			'--vscode-textLink-foreground': '#0063d3', '--vscode-textLink-activeForeground': '#0063d3',
			'--vscode-focusBorder': '#f38518', '--vscode-widget-shadow': 'rgba(0,0,0,0.16)',
			'--vscode-errorForeground': '#b5200d',
			'--vscode-editorWarning-foreground': '#895503', '--vscode-editorLightBulb-foreground': '#895503',
			'--vscode-charts-green': '#374e06', '--vscode-charts-purple': '#652d90', '--vscode-charts-red': '#b5200d',
			'--vscode-charts-blue': '#0063d3', '--vscode-charts-yellow': '#895503',
			'--vscode-testing-iconPassed': '#107c10', '--vscode-testing-iconFailed': '#b5200d',
			'--vscode-gitDecoration-modifiedResourceForeground': '#587c1c',
			'--vscode-gitDecoration-addedResourceForeground': '#587c1c',
			'--vscode-gitDecoration-deletedResourceForeground': '#ad0707',
			'--vscode-panel-border': '#0f4a85', '--vscode-button-background': '#0f4a85',
			'--vscode-dropdown-foreground': '#292929', '--vscode-dropdown-background': '#ffffff', '--vscode-dropdown-border': '#0f4a85',
			'--vscode-textCodeBlock-background': '#00000010'
		}
	}
};

function gitRef(kind, inner, extra) {
	return '<span class="gitRef ' + kind + '"' + (extra || '') + '>' + inner + '</span>';
}

const gitRefChips =
	gitRef('', '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Z"/></svg><span class="gitRefName">main</span>', ' data-color="0" style="--git-graph-color:var(--git-graph-color0)"') +
	gitRef('', '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M2 2v4.5A1.5 1.5 0 0 0 3.5 8h9l-2.5-2.5L13 3.5 16 6.5 13 9.5l-2.5-2.5h-7A3 3 0 0 1 .5 4V2H2z"/></svg><span class="gitRefName">origin/main</span><span class="gitRefHeadRemote">origin</span>') +
	gitRef('tag', '<span class="gitRefName">v1.0.21</span>') +
	gitRef('gerrit', icons.review + '<span class="gitRefName">#42501/3</span><span class="gg-label cr2">CR+2</span><span class="gg-label v1">V+1</span>') +
	gitRef('gerrit', icons.review + '<span class="gitRefName">#42502/1</span><span class="gg-label cr1">CR+1</span><span class="gg-label cr0">CR 0</span><span class="gg-label cr-1">CR-1</span><span class="gg-label cr-2">CR-2</span><span class="gg-status merged">MERGED</span>') +
	gitRef('gerrit', icons.review + '<span class="gitRefName">#42503/2</span><span class="gg-label cr0">CR 0</span><span class="gg-status abandoned">ABANDONED</span>') +
	gitRef('gerrit', icons.review + '<span class="gitRefName">#42504/1</span><span class="gg-label cr-1">CR-1</span><span class="gg-status wip">WIP</span>') +
	gitRef('pr', icons.pullRequest + '<span class="gitRefName">#128</span><span class="gg-status open">OPEN</span>') +
	gitRef('pr', icons.pullRequest + '<span class="gitRefName">#129</span><span class="gg-status merged">MERGED</span>') +
	gitRef('pr', icons.pullRequest + '<span class="gitRefName">#130</span><span class="gg-status abandoned">CLOSED</span>') +
	gitRef('pr', icons.pullRequest + '<span class="gitRefName">#131</span><span class="gg-status wip">DRAFT</span>');

const commitRows = [
	['current', 'feat: support themed status colours', gitRefChips, 'neophack', '2026-09-10 12:00'],
	['', 'fix: use theme variables for signature icons', gitRef('gerrit', icons.review + '<span class="gitRefName">#42501/3</span><span class="gg-label cr2">CR+2</span><span class="gg-status wip">WIP</span>') + gitRef('pr', icons.pullRequest + '<span class="gitRefName">#129</span><span class="gg-status merged">MERGED</span>'), 'neophack', '2026-09-09 18:30'],
	['mute', 'chore: bump version to 1.0.21', '', 'neophack', '2026-09-08 09:15'],
	['commitDetailsOpen', 'docs: update readme badges', gitRef('', '<span class="gitRefName">docs</span>', ' data-color="1" style="--git-graph-color:var(--git-graph-color1)"'), 'contributor', '2026-09-07 16:45']
].map(([cls, msg, refs, author, date]) =>
	'<tr class="commit ' + cls + '" data-color="0" style="--git-graph-color:var(--git-graph-color0)"><td class="graphCol"><span class="commitHeadDot"></span></td><td class="text"><span class="description">' + refs + '<span class="text">' + msg + '</span><span class="openChangesBtn">' + icons.openChanges + '</span></span></td><td class="text authorCol">' + author + '</td><td class="text dateCol">' + date + '</td></tr>'
).join('');

const svg16 = (path) => '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' + path + '</svg>';
const iconCollapse = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 9H4V10H9V9Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3L6 2H13L14 3V10L13 11H11V13L10 14H3L2 13V6L3 5H5V3ZM6 5H10L11 6V10H13V3H6V5ZM10 6H3V13H10V6Z"/></svg>';
const iconExpand = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 9H4V10H9V9Z"/><path d="M7 12L7 7L6 7L6 12L7 12Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3L6 2H13L14 3V10L13 11H11V13L10 14H3L2 13V6L3 5H5V3ZM6 5H10L11 6V10H13V3H6V5ZM10 6H3V13H10V6Z"/></svg>';

const body = `
<div id="view" style="position:static;overflow:visible">
	<div id="headerRow"><div id="controls">
		<span id="repoControl"><span class="unselectable">Repository:</span>
			<div id="repoDropdown" class="dropdown"><span class="customSelectCurrent" style="position:relative;display:inline-block;padding:4px 22px 4px 6px;background-color:rgba(128,128,128,0.1);border:1px solid rgba(128,128,128,0.5);border-radius:4px">vscode-git-graph-rs</span></div>
		</span>
		<span id="branchControl"><span class="unselectable">Branch:</span>
			<div id="branchDropdown" class="dropdown"><span class="dropdownCurrentValue">main</span><span style="display:inline-block;width:0;height:0;border:4px solid transparent;border-color:inherit"></span></div>
		</span>
		<label id="showRemoteBranchesControl"><input type="checkbox" checked><span class="customCheckbox"></span><span>Show Remote Branches</span></label>
	</div>
	<div id="pinnedControls" style="display:block"><span class="pinnedRowLabel">📌 Pinned:</span>
		<span class="pinnedChip"><b>main</b><span class="pinnedChipRemove">✕</span></span>
		<span class="pinnedChip">a1b2c3d Fix login<span class="pinnedChipRemove">✕</span></span>
	</div></div>

	<div id="content"><div id="commitTable"><table>
		<thead id="tableColHeaders"><tr><th class="graphCol">Graph</th><th>Description</th><th class="authorCol">Author</th><th class="dateCol">Date</th></tr></thead>
		<tbody>${commitRows}</tbody>
	</table></div></div>

	<div id="footer"><div class="roundedBtn" id="loadMoreCommitsBtn">Load More Commits</div></div>
</div>

<h2 class="sectionTitle">Commit Details View (docked) — summary, signature states, file tree, view-type buttons</h2>
<div id="cdv" class="docked" style="position:static">
	<div id="cdvContent">
		<div id="cdvSummary" style="position:relative;width:auto;padding:10px">
			<b>feat: support themed status colours</b><br><br>
			Commit: <span class="internalUrl">a1b2c3d4e5f6...</span><br>
			Parents: <span class="internalUrl">9f8e7d6</span><br>
			Author: neophack &lt;neophack@example.com&gt;<span class="signatureInfo G">${svg16('<path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg>')}</span><br>
			Date: 2026-09-10 12:00:00 +08:00<br>
			GPG: <i>Unknown key<span class="signatureInfo U">${svg16('<path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg>')}</span></i> /
			<i>Expired<span class="signatureInfo E">${svg16('<path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg>')}</span></i> /
			<i>Bad<span class="signatureInfo B">${svg16('<path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg>')}</span></i>
		</div>
		<div id="cdvFiles" style="position:relative;left:auto;width:auto;padding:4px 8px">
			<div style="position:relative;height:32px;margin:2px 0 6px 0">
				<div class="cdvControlBtn" title="List view">${icons.file}</div>
				<div class="cdvControlBtn" title="Tree view">${icons.folder}</div>
				<div class="cdvControlBtn" title="Collapse folders">${iconCollapse}</div>
				<div class="cdvControlBtn active" title="Expand folders">${iconExpand}</div>
			</div>
			<ul>
				<li class="fileTreeFolder">${icons.folder}<span class="gitFolderName">src</span></li>
				<li><ul>
					<li class="fileTreeFile">${icons.file}<span class="gitFileName M">gitGraphView.ts</span><span class="fileTreeFileAddDel"><span class="fileTreeFileAdd">+32</span><span class="fileTreeFileDel">-4</span></span></li>
					<li class="fileTreeFile">${icons.file}<span class="gitFileName A">pullRequests.ts</span><span class="fileTreeFileAddDel"><span class="fileTreeFileAdd">+210</span></span></li>
					<li class="fileTreeFile">${icons.file}<span class="gitFileName D">oldFile.ts</span><span class="fileTreeFileAddDel"><span class="fileTreeFileDel">-95</span></span></li>
					<li class="fileTreeFile">${icons.file}<span class="gitFileName U">renamed.ts</span><span class="fileTreeFileAddDel countsPending">(+…|-…)</span></li>
				</ul></li>
			</ul>
		</div>
	</div>
</div>

<h2 class="sectionTitle">Gerrit review dialog</h2>
<div class="dialog" style="position:relative;left:auto;transform:none;display:block;max-width:480px;margin:0 auto 20px;text-align:left">
	<div class="gg-dialog">
		<div class="gg-head">
			<span class="gg-head-icon">${icons.review}</span>
			<div class="gg-head-main">
				<div class="gg-title">Gerrit Change 42501</div>
				<div class="gg-meta">
					<span class="gg-pill st-open">OPEN</span><span class="gg-pill st-merged">MERGED</span><span class="gg-pill st-abandoned">ABANDONED</span><span class="gg-pill st-wip">WIP</span>
					<span class="gg-meta-item">Patch Set 3</span><span class="gg-meta-item">Owner: neophack</span>
				</div>
			</div>
			<a class="gg-open-btn">${icons.linkExternal}Open in Gerrit</a>
		</div>
		<div class="gg-scores">
			<div class="gg-score"><span class="gg-score-name">Code-Review</span><span class="gg-score-value cr2">+2</span></div>
			<div class="gg-score"><span class="gg-score-name">Verified</span><span class="gg-score-value v1">+1</span></div>
			<div class="gg-score"><span class="gg-score-name">Weak</span><span class="gg-score-value cr1">+1</span></div>
			<div class="gg-score"><span class="gg-score-name">Neutral</span><span class="gg-score-value cr0">0</span></div>
			<div class="gg-score"><span class="gg-score-name">Weak Disapproval</span><span class="gg-score-value cr-1">-1</span></div>
			<div class="gg-score"><span class="gg-score-name">Rejected</span><span class="gg-score-value cr-2">-2</span></div>
		</div>
		<div class="gg-section">Timeline</div>
		<div class="gg-timeline">
			<div class="gg-event gg-event-expandable"><div class="gg-event-row"><span class="gg-event-toggle">${icons.chevronDown}</span><span class="gg-event-icon">✓</span><span class="gg-event-text">Patch Set 2: Code-Review+2</span><span class="gg-event-reviewer">reviewer@example.com</span><span class="gg-event-date">2026-09-09 18:30</span></div></div>
			<div class="gg-event"><div class="gg-event-row"><span class="gg-event-icon">✎</span><span class="gg-event-text">Created change</span><span class="gg-event-reviewer">neophack</span><span class="gg-event-date">2026-09-08 09:15</span></div></div>
		</div>
		<span class="gg-hint">Click an event to toggle its detailed NoteDb record</span>
	</div>
</div>

<h2 class="sectionTitle">Pull Request details dialog</h2>
<div class="dialog" style="position:relative;left:auto;transform:none;display:block;max-width:480px;margin:0 auto 20px;text-align:left">
	<div class="gg-dialog pr-dialog">
		<div class="gg-head">
			<span class="gg-head-icon">${icons.pullRequest}</span>
			<div class="gg-head-main">
				<div class="gg-title">Add pull request integration</div>
				<div class="gg-meta">
					<span class="gg-meta-item">#129</span>
					<span class="gg-pill merged">MERGED</span><span class="gg-pill open">OPEN</span><span class="gg-pill abandoned">CLOSED</span><span class="gg-pill wip">DRAFT</span>
					<span class="gg-meta-item">Author: neophack</span>
				</div>
			</div>
			<a class="gg-open-btn">${icons.linkExternal}Open on GitHub</a>
		</div>
		<div class="gg-scores">
			<div class="gg-score"><span class="gg-score-name">Branches</span><span class="gg-score-value">feature/pr → main</span></div>
			<div class="gg-score"><span class="gg-score-name">Head Commit</span><span class="gg-score-value">a1b2c3d</span></div>
		</div>
		<div class="gg-section">Description</div>
		<div class="pr-body">Adds GitHub / GitLab pull request badges and a details dialog, reusing the Gerrit dialog styles.</div>
	</div>
</div>

<h2 class="sectionTitle">Generic message / warning dialog</h2>
<div class="dialog" style="position:relative;left:auto;transform:none;display:block;max-width:420px;margin:0 auto 20px">
	<div class="dialogContent">
		<div class="messageContent">Are you sure you want to delete branch <b>feature/old</b>?</div>
		<div class="messageContent errorContent dialogAlert warning">${icons.loading} This action cannot be undone — unmerged commits would be lost.</div>
		<span class="roundedBtn" id="dialogAction">Delete Branch</span>
		<span class="roundedBtn">Cancel</span>
	</div>
</div>

<h2 class="sectionTitle">Context menu</h2>
<ul class="contextMenu" style="position:relative;display:inline-block;min-width:260px">
	<li class="contextMenuItem"><span class="contextMenuItemLabel">Checkout</span><span class="contextMenuItemShortcut">C</span></li>
	<li class="contextMenuItem"><span class="contextMenuItemLabel">Create Branch…</span><span class="contextMenuItemShortcut">B</span></li>
	<li class="contextMenuItem separator"></li>
	<li class="contextMenuItem"><span class="contextMenuItemLabel">Merge into current branch…</span><span class="contextMenuItemShortcut">M</span></li>
	<li class="contextMenuItem"><span class="contextMenuItemLabel">Rebase current Branch on this Commit…</span><span class="contextMenuItemShortcut">R</span></li>
	<li class="contextMenuItem inActive"><span class="contextMenuItemLabel">Cherry Pick</span></li>
	<li class="contextMenuItem"><span class="contextMenuItemLabel actionIcon">Add Tag…</span></li>
</ul>

<h2 class="sectionTitle">Dropdown (branches)</h2>
<div class="dropdown" style="display:inline-block;position:relative">
	<span class="dropdownCurrentValue">main</span>
	<ul class="dropdownOptions" style="position:relative;display:inline-block;min-width:220px">
		<li class="dropdownOption">main</li>
		<li class="dropdownOption selected">feature/pr-view</li>
		<li class="dropdownOption">origin/main</li>
		<li class="dropdownOption inActive">locked-branch</li>
	</ul>
</div>

<h2 class="sectionTitle">Find widget</h2>
<div id="findWidget" style="position:relative;display:inline-block;padding:6px">
	<div id="findInputContainer" style="display:inline-block;position:relative">
		<input type="text" id="findInput" value="feature" style="background-color:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-inputValidation-errorBackground);padding:2px 4px">
	</div>
	<label><input type="checkbox" checked><span class="customCheckbox"></span>Regex</label>
	<div id="findMessage" class="error">1 of 1 matches — branch not found</div>
</div>

<h2 class="sectionTitle">Settings widget</h2>
<div id="settingsWidget" style="position:relative;top:auto;right:auto;display:block;width:840px;max-width:none;margin:0 auto 20px">
	<div id="settingsContent">
		<div id="settingsColumns">
			<div class="settingsColumn">
				<div class="settingsColumnTitle">Repository Settings</div>
				<div class="settingsSection general">
					<h3>General</h3>
					<table><tbody>
						<tr><td class="left">Interface Language</td><td><select style="color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background)"><option>English</option></select></td></tr>
						<tr><td class="leftWithEllipsis"><label><input type="checkbox" checked><span class="customCheckbox"></span>Show Remote Branches</label></td></tr>
						<tr><td class="left"><code>rich hover</code> backend <span class="backendBadge rust">Rust</span> <span class="backendBadge hybrid">Hybrid</span> <span class="backendBadge git-cli">Git CLI</span></td></tr>
						<tr><td class="left"><span class="authorGlobalBadge">Global</span> neophack@example.com</td></tr>
						<tr class="lineAbove"><td class="left"><span class="settingsSubLabel">Branches</span></td></tr>
						<tr><td class="leftWithEllipsis">origin — upstream remote</td></tr>
					</tbody></table>
					<div class="settingsSectionButtons"><div class="addBtn">+ Add Remote</div></div>
				</div>
			</div>
			<div class="settingsColumn">
				<div class="settingsColumnTitle">Global Settings</div>
				<div class="settingsSection"><h3>Gerrit Integration</h3>
					<table><tbody>
						<tr><td><label><input type="checkbox" checked><span class="customCheckbox"></span>Enabled</label></td></tr>
						<tr><td class="left">The following example links <b>#123</b> in commit messages.</td></tr>
					</tbody></table>
				</div>
			</div>
		</div>
	</div>
</div>

<h2 class="sectionTitle">Loading / skeleton rows</h2>
<div id="loadingHeader">${icons.loading} Loading Commits…</div>
<div class="skeletonRows"><div class="skeletonRow"></div><div class="skeletonRow"></div><div class="skeletonRow"></div></div>
`;

for (const [name, t] of Object.entries(themes)) {
	const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v};`).join('\n\t\t') +
		'\n\t\t--git-graph-color0:#0085d9; --git-graph-color1:#d9007c; --git-graph-color2:#00d3a7; --git-graph-color3:#c37ece;';
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Git Graph theme audit — ${t.label}</title>
<style>
${css}
</style>
<style>
/* Harness-only: neutralise fixed/absolute layout so every page renders in document flow */
body{position:static;display:block;overflow:visible;background-color:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family, sans-serif);font-size:13px;padding:0 0 40px 0}
#view{position:static !important;overflow:visible !important}
.sectionTitle{margin:28px 12px 10px 12px;font-size:15px;border-bottom:1px solid rgba(128,128,128,0.35);padding-bottom:4px}
:root{${vars}}
body.vscode-high-contrast, body.vscode-high-contrast-light, body.vscode-light{ }
.gg-open-btn{color:inherit}
a{color:var(--vscode-textLink-foreground)}
.contextMenu li.contextMenuItem:hover{background-color:var(--vscode-menu-selectionBackground)}
</style>
</head>
<body class="${t.bodyClass}">
<h1 style="text-align:center;font-size:16px;margin:12px">${t.label}</h1>
${body}
</body>
</html>`;
	writeFileSync(join(outDir, `audit-${name}.html`), html);
	console.log(`wrote audit-${name}.html`);
}
