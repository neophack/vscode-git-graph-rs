/* Page markup samples for the wide (desktop) layout pages of the theme audit: the main view,
 * the commit details view, the overlay widgets and the slide-down panels. Every sample uses the
 * class names and DOM shapes src/webview renders, so the audit exercises the real component
 * selectors (commitTable, commitRow, commitEmphasis, graph, controlBar, pinnedRow, loader,
 * conflictBanner, findWidget, contextMenu, dropdown, dialog, gerrit, commitDetails, fileTree,
 * settingsWidget, reflogView, statisticsView, worktreeDialog). */

import { icons, gitRef, refChips, wideCommitRow } from './icons.mjs';

const section = (title, body) =>
	`<h2 class="sectionTitle">${title}</h2>\n${body}`;

/** The main view: conflict banner, control bar, pinned row, commit table, footer. */
const viewBody = `
<div id="view">
	<div id="conflictBanner">
		<span class="conflictBannerIcon">${icons.alert}</span>
		<span class="conflictBannerTitle">Merge in progress (1/2)</span>
		<span class="conflictBannerFiles"><b>Conflicts:</b> src/main.ts, package.json</span>
		<div id="conflictBannerContinueBtn" class="roundedBtn">Continue</div>
		<div id="conflictBannerAbortBtn" class="roundedBtn">Abort</div>
	</div>
	<div id="headerRow"><div id="controls" class="fetchSupported">
		<span id="repoControl"><span class="unselectable">Repository:</span>
			<span id="repoDropdown" class="dropdown loaded"><span class="dropdownCurrentValue">vscode-git-graph-rs</span></span>
		</span>
		<span id="branchControl"><span class="unselectable">Branch:</span>
			<span id="branchDropdown" class="dropdown loaded"><span class="dropdownCurrentValue">main</span></span>
		</span>
		<span id="authorControl"><span class="unselectable">Author:</span>
			<span id="authorDropdown" class="dropdown loaded"><span class="dropdownCurrentValue">All</span></span>
		</span>
		<label id="showRemoteBranchesControl"><input type="checkbox" checked><span class="customCheckbox"></span><span>Show Remote Branches</span></label>
		<div id="controlBtns">
			<div id="currentBtn" title="Scroll to the current commit">${icons.current}</div>
			<div id="findBtn" title="Find">${icons.magnifier}</div>
			<div id="filterBtn" class="active" title="Filter">${icons.filter}</div>
			<div id="statisticsBtn" title="Statistics">${icons.stats}</div>
			<div id="terminalBtn" title="Terminal">${icons.terminal}</div>
			<div id="fetchBtn" title="Fetch">${icons.fetch}</div>
			<div id="settingsBtn" title="Settings">${icons.gear}</div>
			<div id="refreshBtn" title="Refresh">${icons.refresh}</div>
		</div>
	</div>
	<div id="pinnedControls"><span class="pinnedRowLabel">📌 Pinned:</span>
		<span class="pinnedChip"><b>main</b><span class="pinnedChipRemove">✕</span></span>
		<span class="pinnedChip">a1b2c3d Fix login<span class="pinnedChipRemove">✕</span></span>
	</div></div>
	<div id="content"><div id="commitTable" class="autoLayout"><table>
		<thead id="tableColHeaders"><tr><th>Graph</th><th>Description</th><th class="dateCol">Date</th><th class="authorCol">Author</th><th>Commit</th></tr></thead>
		<tbody>
			${wideCommitRow('current', 'feat: support themed status colours', gitRef('head active', `${icons.branch}<span class="gitRefName">main</span>`, ' style="--git-graph-color:var(--git-graph-color0)"'), 'neophack', '2026-09-10 12:00', 'a1b2c3d', 0)}
			${wideCommitRow('', 'fix: use theme variables for signature icons', refChips(), 'neophack', '2026-09-09 18:30', '9f8e7d6', 1)}
			${wideCommitRow('mute', 'chore: bump version to 1.0.21', '', 'neophack', '2026-09-08 09:15', '7c6b5a4', 2)}
			${wideCommitRow('commitDetailsOpen', 'docs: update readme badges', gitRef('head', `${icons.branch}<span class="gitRefName">docs</span>`, ' style="--git-graph-color:var(--git-graph-color3)"'), 'contributor', '2026-09-07 16:45', '5d4e3f2', 3)}
			${wideCommitRow('findCurrentCommit', 'refactor: split the stylesheet by component', gitRef('tag', `${icons.tag}<span class="gitRefName">v1.0.20</span>`), 'neophack', '2026-09-06 10:05', '3c2b1a0', 4)}
		</tbody>
	</table></div></div>
	<div id="footer"><div class="roundedBtn" id="loadMoreCommitsBtn">Load More Commits</div></div>
</div>

${section('Commit graph (SVG) and hover tooltip', `
<div style="padding:8px 12px">
<svg id="commitGraph" width="320" height="110" viewBox="0 0 320 110" xmlns="http://www.w3.org/2000/svg">
	<path class="shadow" d="M14 12 C 40 12, 40 55, 66 55"/>
	<path class="line" d="M14 12 C 40 12, 40 55, 66 55" style="stroke:var(--git-graph-color0)"/>
	<path class="shadow" d="M14 12 L 14 98"/>
	<path class="line" d="M14 12 L 14 98" style="stroke:var(--git-graph-color1)"/>
	<path class="line" d="M66 55 L 118 55" style="stroke:var(--git-graph-color0)"/>
	<path class="line" d="M170 30 L 222 30" style="stroke:var(--git-graph-color2)"/>
	<circle cx="14" cy="12" r="4" class="current" style="stroke:var(--git-graph-color1);fill:var(--git-graph-color1)"/>
	<circle cx="14" cy="55" r="4" style="stroke:var(--git-graph-color1);fill:var(--git-graph-color1)"/>
	<circle cx="66" cy="55" r="4" style="stroke:var(--git-graph-color0);fill:var(--git-graph-color0)"/>
	<circle cx="118" cy="55" r="4" style="stroke:var(--git-graph-color0);fill:var(--git-graph-color0)"/>
	<circle cx="170" cy="30" r="4" style="stroke:var(--git-graph-color2);fill:var(--git-graph-color2)"/>
	<circle cx="222" cy="30" r="6" class="stashInner" style="stroke:var(--git-graph-color3)"/>
	<circle cx="14" cy="98" r="4" style="stroke:var(--git-graph-color1);fill:var(--git-graph-color1)"/>
</svg>
<div id="graphTooltip" style="margin-top:16px">
	<div id="graphTooltipShadow"></div>
	<div id="graphTooltipPointer"></div>
	<div id="graphTooltipContent" style="border-color:var(--vscode-focusBorder)">
		<div class="graphTooltipTitle">Commit: 9f8e7d6</div>
		<div class="graphTooltipSection">This commit is included in HEAD</div>
		<div class="graphTooltipSection"><span class="graphTooltipRef">main</span><span class="graphTooltipRef">develop</span><span class="graphTooltipCombinedRef">origin/main</span></div>
		<div class="graphTooltipSection"><span class="graphTooltipRef">v1.0.20</span></div>
	</div>
</div>
</div>`)}

${section('Loading state', `
<div id="loadingHeader">${icons.loading} Loading Commits…</div>
<div class="skeletonRows"><div class="skeletonRow"></div><div class="skeletonRow"></div><div class="skeletonRow"></div><div class="skeletonRow"></div></div>`)}

${section('Help tooltip popup', `
<div class="gg-helpTooltipPopup" style="left:40px;top:4px">The commit that is currently checked out (HEAD)</div>`)}
`;

/** Harness-only layout neutralisation for the main view page (positioning only, never colours). */
const viewCss = `
#view{position:static !important;overflow:visible !important}
#conflictBanner{display:flex;position:static}
#graphTooltip{position:relative;padding-bottom:10px}
#graphTooltipShadow{position:absolute;height:60px}
#commitGraph{position:relative}
.gg-helpTooltipPopup{position:relative;left:auto;top:auto;display:inline-block;margin:0 12px}
`;

/** The commit details view (docked): summary with markdown body, controls, file tree. */
const detailsBody = `
${section('Commit Details View (docked) — controls column', `
<div style="padding:8px 12px"><div id="cdv" class="docked">
	<div id="cdvContent">
		<div id="cdvSummary">
			<b>feat: support themed status colours</b><br><br>
			Commit: <span class="internalUrl">a1b2c3d4e5f6789abcdef0123456789abcdef0123456</span><br>
			Parents: <span class="internalUrl">9f8e7d6</span><br>
			Author: neophack &lt;neophack@example.com&gt;<span class="signatureInfo G"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg></span><br>
			Committer: neophack &lt;neophack@example.com&gt;<br>
			Date: 2026-09-10 12:00:00 +08:00<br>
			GPG: <i>Verified<span class="signatureInfo G"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg></span></i> /
			<i>Unknown key<span class="signatureInfo U"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg></span></i> /
			<i>Expired<span class="signatureInfo E"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg></span></i> /
			<i>Bad<span class="signatureInfo B"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 3 3v4c0 4.4 2.1 7.4 5 8 2.9-.6 5-3.6 5-8V3L8 1z"/></svg></span></i>
			<div id="cdvMessageBody"><p>Renders every commit-message <code>markdown</code> element:</p>
			<h2>Heading</h2>
			<blockquote>quote block</blockquote>
			<pre><code>preformatted code block</code></pre>
			<ul><li>list item one</li><li>list item two</li></ul>
			<p><a class="internalUrl" href="#">internal link</a> and <a href="#">external link</a></p></div>
		</div>
		<div id="cdvFiles">
			<div id="cdvFilesHeader">
				<span class="cdvmFilesCount">4 FILES CHANGED</span>
				<span class="cdvmFilesStat"><span class="cdvmAdd">+242</span><span class="cdvmDel">-99</span></span>
			</div>
			<ul>
				<li class="fileTreeFolder"><span class="fileTreeFolderIcon">${icons.folder}</span><span class="gitFolderName">src</span></li>
				<li><ul class="fileTreeFolderContents">
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName M">gitGraphView.ts</span></span><span class="fileTreeFileAddDel"><span class="fileTreeFileAdd">+32</span><span class="fileTreeFileDel">-4</span></span><span class="fileTreeFileType">TypeScript</span><button class="fileTreeFileAction copyGitFile" title="Copy path">${icons.file}</button><button class="fileTreeFileAction viewGitFileAtRevision" title="View at revision">${icons.openChanges}</button></li>
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName A">pullRequests.ts</span></span><span class="fileTreeFileAddDel"><span class="fileTreeFileAdd">+210</span></span></li>
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName D">oldFile.ts</span></span><span class="fileTreeFileAddDel"><span class="fileTreeFileDel">-95</span></span></li>
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName R">renamed.ts</span></span><span class="fileTreeFileAddDel countsPending">(+…|-…)</span></li>
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName U">unmerged.ts</span></span><span class="fileTreeFileAddDel countsPending">(+…|-…)</span></li>
				</ul></li>
				<li class="fileTreeRepo"><span class="fileTreeRepoIcon">${icons.folder}</span><span class="gitFolderName">submodule</span></li>
			</ul>
		</div>
		<div id="cdvLoading">${icons.loading} Loading Commit Details…</div>
	</div>
	<div id="cdvControls">
		<div class="cdvControlBtn" id="cdvFileViewTypeList" title="List view">${icons.file}</div>
		<div class="cdvControlBtn active cdvFileViewTypeBtn" id="cdvFileViewTypeTree" title="Tree view">${icons.folder}</div>
		<div class="cdvControlBtn" id="cdvExternalDiff.enabled" title="External diff">${icons.openChanges}</div>
		<div class="cdvControlBtn" id="cdvCodeReview" title="Code review">${icons.review}</div>
		<div class="cdvControlBtn cdvFolderBtn" title="Collapse folders">${icons.close}</div>
		<div class="cdvControlBtn" id="cdvClose" title="Close">${icons.close}</div>
	</div>
</div></div>`)}
`;

const detailsCss = `
#cdv{position:static !important}
#cdvContent{position:static;width:auto}
#cdvControls{position:relative;width:auto;display:inline-block;vertical-align:top}
#cdvSummary, #cdvFiles, #cdvLoading{position:relative;left:auto;width:auto;max-width:none;height:auto;border-right:1px solid rgba(128,128,128,0.2)}
#cdvFiles{width:100%}
`;

/** Overlay widgets: find widget, context menu, dropdown, and the three dialog kinds. */
const overlaysBody = `
${section('Find widget (active, one match; error state below)', `
<div style="padding:8px 12px">
<div class="findWidget active">
	<input id="findInput" type="text" value="feature">
	<button type="button" id="findCaseSensitive" class="findModifier">Aa</button>
	<button type="button" id="findRegex" class="findModifier active">.*</button>
	<span id="findPosition">1 of 2 matches</span>
	<button type="button" id="findPrev">${icons.chevronDown}</button>
	<button type="button" id="findNext" class="disabled">${icons.chevronDown}</button>
	<button type="button" id="findOpenCdv" class="active">${icons.openChanges}</button>
	<button type="button" id="findClose">${icons.close}</button>
</div>
<div class="findWidget active" data-error="Branch not found" style="margin-top:18px">
	<input id="findInput2" type="text" value="no-such-branch">
	<span id="findPosition">No results</span>
</div>
<p>Inline match highlight: <span class="findMatch">feature</span>/pr-view</p>
</div>`)}

${section('Context menu (plain and checked variants)', `
<div style="padding:8px 12px">
<ul class="contextMenu" style="position:relative;display:inline-block;min-width:270px;vertical-align:top">
	<li class="contextMenuItem">Checkout</li>
	<li class="contextMenuItem">Create Branch…</li>
	<li class="contextMenuDivider"></li>
	<li class="contextMenuItem">Merge into current branch…</li>
	<li class="contextMenuItem">Rebase current Branch on this Commit…</li>
	<li class="contextMenuItem">Cherry Pick</li>
	<li class="contextMenuItem">Add Tag…</li>
</ul>
<ul class="contextMenu checked" style="position:relative;display:inline-block;min-width:270px;vertical-align:top;margin-left:24px">
	<li class="contextMenuItem"><span class="contextMenuItemCheck">${icons.check}</span>Show Remote Branches</li>
	<li class="contextMenuItem"><span class="contextMenuItemCheck"></span>Fetch Avatars</li>
	<li class="contextMenuDivider"></li>
	<li class="contextMenuItem"><span class="contextMenuItemCheck">${icons.check}</span>Commit Details View: Docked</li>
</ul>
</div>`)}

${section('Dropdown (open, with filter, hints, multi-select, info buttons)', `
<div style="padding:8px 12px">
<div class="dropdown loaded dropdownOpen" style="display:inline-block;vertical-align:top">
	<span class="dropdownCurrentValue">feature/pr-view</span>
	<div class="dropdownMenu" style="position:relative;display:block">
		<div class="dropdownFilter"><input class="dropdownFilterInput" value="feat"></div>
		<div class="dropdownOptions">
			<div class="dropdownOption selected">feature/pr-view</div>
			<div class="dropdownOption highlighted">feature/theme-audit</div>
			<div class="dropdownOption">main<span class="dropdownOptionHint">2026-09-10</span><button class="dropdownOptionInfo" type="button">${icons.info}</button></div>
			<div class="dropdownOption">origin/main</div>
		</div>
		<div class="dropdownNoResults">No matching branches</div>
	</div>
</div>
<div class="dropdown multi loaded dropdownOpen" style="display:inline-block;vertical-align:top;margin-left:24px">
	<span class="dropdownCurrentValue">neophack +1</span>
	<div class="dropdownMenu" style="position:relative;display:block">
		<div class="dropdownOptions">
			<div class="dropdownOption selected"><div class="dropdownOptionMultiSelected">${icons.check}</div>neophack</div>
			<div class="dropdownOption"><div class="dropdownOptionMultiSelected"></div>contributor</div>
			<div class="dropdownOption"><div class="dropdownOptionMultiSelected"></div>release-bot</div>
		</div>
	</div>
</div>
</div>`)}

${section('Gerrit review dialog', `
<div class="dialog" style="position:relative;left:auto;transform:none;display:block;max-width:480px;margin:0 12px 20px;text-align:left">
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
</div>`)}

${section('Pull Request details dialog', `
<div class="dialog" style="position:relative;left:auto;transform:none;display:block;max-width:480px;margin:0 12px 20px;text-align:left">
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
</div>`)}

${section('Form dialog (branch name), message dialog, data-loss warning', `
<div class="dialog" style="position:relative;left:auto;transform:none;display:block;max-width:480px;margin:0 12px 20px">
	<span id="dialogCloseIcon">${icons.close}</span>
	<div class="dialogContent">
		<table class="dialogForm single"><tbody>
			<tr><td class="inputCol"><input type="text" value="feature/theme-audit" placeholder="Branch name"></td></tr>
			<tr class="dialogFormCheckbox"><label><input type="checkbox" checked><span class="customCheckbox"></span>Check out after creating</label></tr>
			<tr class="dialogFormRadio"><label><input type="radio" checked name="r"><span class="customRadio"></span>Create branch</label></tr>
			<tr class="dialogFormRadio"><label><input type="radio" name="r"><span class="customRadio"></span>Create tag</label></tr>
		</tbody></table>
		<span class="roundedBtn" id="dialogAction">Create</span>
		<span class="roundedBtn">Cancel</span>
	</div>
</div>
<div class="dialog" style="position:relative;left:auto;transform:none;display:block;max-width:420px;margin:0 12px 20px">
	<div class="dialogContent">
		<div class="messageContent">Are you sure you want to delete branch <b>feature/old</b>?</div>
		<div class="messageContent errorContent dialogAlert warning">${icons.alert} This action cannot be undone — unmerged commits would be lost.</div>
		<span class="roundedBtn" id="dialogAction2">Delete Branch</span>
		<span class="roundedBtn">Cancel</span>
	</div>
</div>`)}
`;

const overlaysCss = `
.findWidget{position:static}
.findWidget[data-error]{display:inline-flex}
.contextMenu{animation:none;position:relative}
.dropdownMenu{animation:none}
.dialog{animation:none}
.gg-open-btn{color:inherit}
`;

/** The four slide-down panels: settings, reflog, statistics, worktrees. */
const panelsBody = `
${section('Settings widget', `
<div id="settingsWidget" class="active" style="position:relative;top:auto;right:auto;display:block;width:880px;max-width:none;margin:0 12px 24px">
	<h2>Settings</h2>
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
						<tr><td class="left"><span class="authorGlobalBadge">Global</span> neophack@example.com <label class="settingsGlobalCheckbox"><input type="checkbox"><span class="customCheckbox"></span></label></td></tr>
						<tr class="lineAbove"><td class="left"><span class="settingsSubLabel">Branches</span></td></tr>
						<tr><td class="leftWithEllipsis">origin — upstream remote</td></tr>
					</tbody></table>
					<div class="settingsSectionButtons"><div class="addBtn">+ Add Remote</div><div class="toolBtn" id="openExtensionSettings">${icons.gear} Extension Settings</div></div>
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
				<div class="settingsSection"><h3>Custom Select</h3>
					<div class="customSelectContainer open">
						<div class="customSelectCurrent">Commit Details View: Docked</div>
						<div class="customSelectOptions" style="position:relative;display:block">
							<div class="customSelectOption focussed">Docked</div>
							<div class="customSelectOption selected">Inline</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>`)}

${section('Reflog widget', `
<div id="reflogWidget" class="active" style="position:relative;top:auto;right:auto;display:block;width:720px;max-width:none;margin:0 12px 24px">
	<h2>Reflog</h2>
	<span id="reflogClose">${icons.close}</span>
	<table class="reflogTable"><tbody>
		<tr class="reflogRow"><td class="reflogDotCol"><span class="reflogDot reflogEdit"></span></td><td class="reflogHashCol">a1b2c3d</td><td class="reflogMessageCol">commit: feat: support themed status colours</td><td class="reflogDateCol">2026-09-10 12:00</td></tr>
		<tr class="reflogRow"><td class="reflogDotCol"><span class="reflogDot reflogCombine"></span></td><td class="reflogHashCol">9f8e7d6</td><td class="reflogMessageCol">rebase (finish): returning to refs/heads/main</td><td class="reflogDateCol">2026-09-09 18:30</td></tr>
		<tr class="reflogRow"><td class="reflogDotCol"><span class="reflogDot reflogIntegrate"></span></td><td class="reflogHashCol">7c6b5a4</td><td class="reflogMessageCol">pull origin main: Fast-forward</td><td class="reflogDateCol">2026-09-08 09:15</td></tr>
		<tr class="reflogRow"><td class="reflogDotCol"><span class="reflogDot reflogFlow"></span></td><td class="reflogHashCol">5d4e3f2</td><td class="reflogMessageCol">checkout: moving from main to docs</td><td class="reflogDateCol">2026-09-07 16:45</td></tr>
		<tr class="reflogRow"><td class="reflogDotCol"><span class="reflogDot reflogAbort"></span></td><td class="reflogHashCol">3c2b1a0</td><td class="reflogMessageCol">${icons.close} rebase (abort): updating HEAD</td><td class="reflogDateCol">2026-09-06 10:05</td></tr>
	</tbody></table>
	<div id="reflogLoadMoreBtn" class="roundedBtn">Load More Reflog Entries</div>
</div>`)}

${section('Statistics widget', `
<div id="statisticsWidget" class="active" style="position:relative;top:auto;right:auto;display:block;width:560px;max-width:none;margin:0 12px 24px">
	<h2>Statistics</h2>
	<span id="statisticsClose">${icons.close}</span>
	<div id="statisticsContent">
		<h3>Commits per author (last 90 days)</h3>
		<table class="statisticsAuthorsTable"><tbody>
			<tr><td class="statisticsAuthorName">neophack</td><td class="statisticsAuthorBarCol"><div class="statisticsAuthorBar" style="width:96%"></div></td><td class="statisticsAuthorCount">214</td></tr>
			<tr><td class="statisticsAuthorName">contributor</td><td class="statisticsAuthorBarCol"><div class="statisticsAuthorBar" style="width:42%"></div></td><td class="statisticsAuthorCount">93</td></tr>
			<tr><td class="statisticsAuthorName">release-bot</td><td class="statisticsAuthorBarCol"><div class="statisticsAuthorBar" style="width:11%"></div></td><td class="statisticsAuthorCount">24</td></tr>
		</tbody></table>
		<h3>Commit heatmap</h3>
		<div class="statisticsHeatmap">
			<div class="statisticsHeatmapRow"><span class="statisticsHeatmapLabel">Mon</span><div class="statisticsHeatmapCell" style="flex:0.4 0 0"></div><div class="statisticsHeatmapCell"></div><div class="statisticsHeatmapCell" style="flex:0.7 0 0"></div><div class="statisticsHeatmapCell"></div></div>
			<div class="statisticsHeatmapRow"><span class="statisticsHeatmapLabel">Tue</span><div class="statisticsHeatmapCell"></div><div class="statisticsHeatmapCell" style="flex:0.2 0 0"></div><div class="statisticsHeatmapCell"></div><div class="statisticsHeatmapCell" style="flex:0.9 0 0"></div></div>
			<div class="statisticsHeatmapRow"><span class="statisticsHeatmapLabel">Wed</span><div class="statisticsHeatmapCell" style="flex:0.55 0 0"></div><div class="statisticsHeatmapCell" style="flex:0.3 0 0"></div><div class="statisticsHeatmapCell"></div><div class="statisticsHeatmapCell" style="flex:0.5 0 0"></div></div>
		</div>
	</div>
</div>`)}

${section('Worktree widget', `
<div id="worktreeWidget" class="active" style="position:relative;top:auto;right:auto;display:block;width:620px;max-width:none;margin:0 12px 24px">
	<h2>Worktrees</h2>
	<span id="worktreeClose">${icons.close}</span>
	<table class="worktreeTable"><tbody>
		<tr><td class="worktreePathCol">E:\\ggrs-wt\\wt-theme</td><td class="worktreeBranchCol">task/theme-audit-screenshots</td><td class="worktreeActionsCol"><span class="worktreeRemoveBtn" title="Remove">${icons.close}</span></td></tr>
		<tr><td class="worktreePathCol">E:\\vscode-git-graph-rs<span class="worktreeBadge worktreeBadgeMain">main</span></td><td class="worktreeBranchCol">dev-refactor</td><td class="worktreeActionsCol"><span class="worktreeRemoveBtn">${icons.close}</span></td></tr>
		<tr><td class="worktreePathCol">E:\\ggrs-wt\\wt-locked<span class="worktreeBadge worktreeBadgeLocked">locked</span><span class="worktreeBadge worktreeBadgePrunable">prunable</span></td><td class="worktreeBranchCol">orphaned-branch</td><td class="worktreeActionsCol"><span class="worktreeRemoveBtn">${icons.close}</span></td></tr>
	</tbody></table>
	<div id="worktreeAddBtn" class="roundedBtn">+ Add Worktree</div>
	<div id="worktreePruneBtn" class="roundedBtn">Prune</div>
</div>`)}
`;

const panelsCss = `
#settingsWidget, #reflogWidget, #statisticsWidget, #worktreeWidget{box-shadow:none}
.customSelectOptions{position:relative}
`;

/** The wide-layout pages of the audit (see scripts/dev/theme-audit.mjs for the runner). */
export const mainPages = [
	{ name: 'view', label: 'Main view (table, control bar, banner, graph)', stylesheet: 'out', bodyClass: '', viewport: { width: 1280, height: 900 }, body: viewBody, harnessCss: viewCss },
	{ name: 'details', label: 'Commit details view (docked)', stylesheet: 'out', bodyClass: '', viewport: { width: 1280, height: 900 }, body: detailsBody, harnessCss: detailsCss },
	{ name: 'overlays', label: 'Overlays (find, context menu, dropdown, dialogs)', stylesheet: 'out', bodyClass: '', viewport: { width: 1280, height: 900 }, body: overlaysBody, harnessCss: overlaysCss },
	{ name: 'panels', label: 'Panels (settings, reflog, statistics, worktrees)', stylesheet: 'out', bodyClass: '', viewport: { width: 1280, height: 900 }, body: panelsBody, harnessCss: panelsCss }
];
