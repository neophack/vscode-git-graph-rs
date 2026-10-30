/* The mobile-layout pages of the theme audit (docs/MOBILE-DESIGN.md): rendered with
 * body.mobileMode under a phone-sized viewport, covering the mobile app bar, the two-line commit
 * list, the fast scroller, the overflow sheet, the mobile find bar, the full-screen commit
 * details sheet and the mobile dialog styling — every rule set under styles/mobile/. */

import { icons, gitRef, narrowCommitRow, wideCommitRow } from './icons.mjs';

const section = (title, body) =>
	`<h2 class="sectionTitle">${title}</h2>\n${body}`;

const mobileRef = (kind, name, lane, extra) =>
	gitRef(kind, `${icons.branch}<span class="gitRefName">${name}</span>`, ` style="--git-graph-color:var(--git-graph-color${lane})"${extra || ''}`);

/** The mobile main screen: app bar, pinned chips, commit list, footer, fast scroller. */
const mobileViewBody = `
<div id="view">
	<div id="headerRow"><div id="controls">
		<span id="repoControl">
			<span id="repoDropdown" class="dropdown loaded"><span class="dropdownCurrentValue">vscode-git-graph-rs</span></span>
		</span>
		<span id="branchControl">
			<span id="branchDropdown" class="dropdown loaded"><span class="dropdownCurrentValue">main</span></span>
		</span>
		<div id="controlBtns">
			<div id="findBtn" title="Find">${icons.magnifier}</div>
			<div id="filterBtn" class="active" title="Filter">${icons.filter}</div>
			<div id="refreshBtn" title="Refresh">${icons.refresh}</div>
			<div id="mobileMoreBtn" title="More">${icons.more}</div>
		</div>
	</div>
	<div id="pinnedControls"><span class="pinnedRowLabel">📌</span>
		<span class="pinnedChip"><b>main</b><span class="pinnedChipRemove">✕</span></span>
		<span class="pinnedChip">a1b2c3d Fix login<span class="pinnedChipRemove">✕</span></span>
	</div></div>
	<div id="content"><div id="commitTable"><table>
		<thead id="tableColHeaders"><tr><th>Graph</th><th>Description</th></tr></thead>
		<tbody>
			${narrowCommitRow('current', 'feat: support themed status colours', mobileRef('head active', 'main', 0), 'neophack', '12:00', 'a1b2c3d', 0)}
			${narrowCommitRow('', 'fix: use theme variables for signature icons', mobileRef('tag', 'v1.0.21', 1) + mobileRef('pr', '#129', 2), 'neophack', 'Yesterday', '9f8e7d6', 1)}
			${narrowCommitRow('mute', 'chore: bump version to 1.0.21', mobileRef('remote', 'origin/main', 2), 'neophack', 'Mon', '7c6b5a4', 2)}
			${narrowCommitRow('commitDetailsOpen', 'docs: update readme badges', mobileRef('head', 'docs', 3), 'contributor', 'Oct 9', '5d4e3f2', 3)}
			${narrowCommitRow('', 'refactor: split the stylesheet by component', gitRef('stash', `${icons.stash}<span class="gitRefName">WIP</span>`), 'neophack', 'Oct 7', '3c2b1a0', 4)}
		</tbody>
	</table></div></div>
	<div id="footer"><div class="roundedBtn" id="loadMoreCommitsBtn">Load More Commits</div></div>
</div>

${section('Fast scroller (visible, dragging bubble)', `
<div style="position:relative;height:120px;margin:12px;border:1px dashed rgba(128,128,128,0.4)">
	<div id="fastScroller" class="visible dragging" style="position:absolute;right:8px;top:8px;opacity:1">
		<div id="fastScrollerThumb"></div>
	</div>
	<div id="fastScrollerBubble" style="right:64px;top:24px;opacity:1;position:absolute">
		<div class="fastScrollerDate">Oct 9</div>
		<div class="fastScrollerPos">4 218 / 12 904</div>
	</div>
</div>`)}

${section('Overflow sheet (⋯ menu with switches)', `
<ul class="contextMenu" style="position:relative;display:block;min-width:0;margin:0 12px">
	<li class="contextMenuItem"><span class="mobileMenuIcon">${icons.branch}</span><span class="mobileMenuLabel">Show Remote Branches</span><span class="mobileMenuSwitch on"></span></li>
	<li class="contextMenuItem"><span class="mobileMenuIcon">${icons.fetch}</span><span class="mobileMenuLabel">Fetch Avatars</span><span class="mobileMenuSwitch"></span></li>
	<li class="contextMenuDivider"></li>
	<li class="contextMenuItem"><span class="mobileMenuIcon">${icons.fetch}</span><span class="mobileMenuLabel">Fetch from origin</span></li>
	<li class="contextMenuItem"><span class="mobileMenuIcon">${icons.stats}</span><span class="mobileMenuLabel">Statistics</span></li>
	<li class="contextMenuItem"><span class="mobileMenuIcon">${icons.gear}</span><span class="mobileMenuLabel">Settings</span></li>
</ul>`)}

${section('Mobile find bar and dropdown card', `
<div class="findWidget active" style="position:relative;display:flex;visibility:visible;margin:12px">
	<input id="findInput" type="text" value="feature">
	<span id="findPosition">1 of 2</span>
	<button type="button" id="findPrev">${icons.chevronDown}</button>
	<button type="button" id="findNext">${icons.chevronDown}</button>
	<button type="button" id="findClose">${icons.close}</button>
</div>
<div class="dropdown loaded dropdownOpen" style="display:block;margin:12px">
	<div class="dropdownMenu" style="position:relative;display:block;left:0;right:0">
		<div class="dropdownFilter"><input class="dropdownFilterInput" value="feat"></div>
		<div class="dropdownOptions">
			<div class="dropdownOption selected">feature/pr-view</div>
			<div class="dropdownOption">feature/theme-audit</div>
			<div class="dropdownOption">main</div>
		</div>
	</div>
</div>`)}
`;

const mobileViewCss = `
#view{position:static !important;overflow:visible !important;bottom:auto !important}
.contextMenu{animation:none}
.dropdownMenu{animation:none}
.findWidget{animation:none}
#fastScroller{pointer-events:none}
`;

/** The mobile commit details sheet: title bar, mobile summary card, file rows, mobile dialog. */
const mobileDetailsBody = `
${section('Commit details sheet (mobile)', `
<div id="view" style="position:static;padding:0">
<div id="cdv" class="docked">
	<div id="cdvControls">
		<div id="cdvClose" class="cdvControlBtn">${icons.close}</div>
		<div id="cdvMobileTitle">a1b2c3d</div>
		<div class="cdvControlBtn" id="cdvExternalDiff" title="External diff">${icons.openChanges}</div>
		<div class="cdvControlBtn" id="cdvCodeReview" title="Code review">${icons.review}</div>
	</div>
	<div id="cdvContent">
		<div id="cdvSummary">
			<div class="cdvmTitle">feat: support themed status colours</div>
			<div class="cdvmByline">
				<span class="cdvmAvatar" style="--cdvm-avatar-hue:210">N</span>
				<span class="cdvmByText">
					<span class="cdvmAuthor">neophack</span>
					<span class="cdvmDate">Oct 9, 2026, 12:00</span>
				</span>
			</div>
			<div class="cdvmMessage"><span id="cdvMessageBody">Renders the full commit message with the mobile summary card layout.</span></div>
			<div class="cdvmFacts">
				<div class="cdvmFact"><span class="cdvmFactLabel">Commit</span><span class="cdvmFactValue"><span class="cdvmMono">a1b2c3d4e5f6789abcdef0123456789abcdef0123</span></span></div>
				<div class="cdvmFact"><span class="cdvmFactLabel">Parents</span><span class="cdvmFactValue"><span class="cdvmChip internalUrl">9f8e7d6</span></span></div>
				<div class="cdvmFact"><span class="cdvmFactLabel">Author</span><span class="cdvmFactValue">neophack<span class="cdvmEmail">neophack@example.com</span></span></div>
			</div>
			<div class="cdvmNote">Signed off with a verified signature (G).</div>
		</div>
		<div id="cdvFiles">
			<div id="cdvFilesHeader">
				<span class="cdvmFilesCount">4 FILES CHANGED</span>
				<span class="cdvmFilesStat"><span class="cdvmAdd">+242</span><span class="cdvmDel">-99</span></span>
				<span class="cdvmFileViewBtns">
					<div class="cdvControlBtn cdvFileViewTypeBtn" id="cdvFileViewTypeList">${icons.file}</div>
					<div class="cdvControlBtn cdvFileViewTypeBtn active" id="cdvFileViewTypeTree">${icons.folder}</div>
				</span>
			</div>
			<ul>
				<li class="fileTreeFolder"><span class="fileTreeFolderIcon">${icons.folder}</span><span class="gitFolderName">src</span></li>
				<li><ul class="fileTreeFolderContents">
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName M">gitGraphView.ts</span></span><span class="fileTreeFileAddDel">(<span class="fileTreeFileAdd">+32</span><span class="fileTreeFileDel">-4</span>)</span></li>
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName A">pullRequests.ts</span></span><span class="fileTreeFileAddDel">(<span class="fileTreeFileAdd">+210</span>)</span></li>
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName D">oldFile.ts</span></span><span class="fileTreeFileAddDel">(<span class="fileTreeFileDel">-95</span>)</span></li>
					<li class="fileTreeFileRecord"><span class="fileTreeFile"><span class="fileTreeFileIcon">${icons.file}</span><span class="gitFileName R">renamed.ts</span></span><span class="fileTreeFileAddDel countsPending">(+…|-…)</span></li>
				</ul></li>
			</ul>
		</div>
	</div>
</div>
</div>`)}

${section('Mobile dialog (delete branch)', `
<div class="dialog" style="position:relative;display:block;left:0;transform:none;margin:12px auto;max-height:none">
	<div class="dialogContent">
		<div class="messageContent">Are you sure you want to delete branch <b>feature/old</b>?</div>
		<span class="roundedBtn">Delete Branch</span>
		<span class="roundedBtn">Cancel</span>
	</div>
</div>`)}
`;

const mobileDetailsCss = `
#cdv{position:static !important;animation:none}
#cdvContent{position:static;width:auto;left:auto;right:auto;overflow:visible}
#cdvControls{position:relative;width:auto;order:0}
#cdvSummary, #cdvFiles{position:static;width:auto;left:auto;border-right:none;overflow:visible}
.dialog{animation:none}
`;

/** The tablet's squeezed Description column: the single-line commit table in a container too
 *  narrow for the refs and the subject at their natural sizes. Like the wide layout, the pill
 *  never yields: the icon, the name, the remote labels and the score chips all keep their
 *  natural size, and the subject beside them is what gives way, ellipsizing down to its 96px
 *  floor. The rows cover: a long remote ref squeezed by a long subject (the pill stays whole,
 *  the subject ellipsizes), a combined head-plus-origin pill beside a short subject (it fits,
 *  so nothing gives way at all), and a Gerrit badge whose name and score chip keep their size
 *  while the subject ellipsizes. */
const tabletSqueezedBody = `
<div id="view"><div id="content">
	<div id="commitTable" class="autoLayout" style="width:700px;margin:8px 12px"><table>
		<thead id="tableColHeaders"><tr><th>Graph</th><th>Description</th><th class="dateCol">Date</th><th class="authorCol">Author</th><th>Commit</th></tr></thead>
		<tbody>
			${wideCommitRow('current', 'docs: update the refactor plan', gitRef('remote', `${icons.branch}<span class="gitRefName">origin/task/m0-gates</span>`, ' style="--git-graph-color:var(--git-graph-color2)"'), 'neophack', '2026-09-10 12:00', 'a1b2c3d', 0)}
			${wideCommitRow('', 'docs: readme', gitRef('head', `${icons.branch}<span class="gitRefName">task/m0-gates</span><span class="gitRefHeadRemote">origin</span>`, ' style="--git-graph-color:var(--git-graph-color0)"'), 'neophack', '2026-09-09 18:30', '9f8e7d6', 1)}
			${wideCommitRow('', 'feat: review progress on the change badge', gitRef('gerrit', `${icons.review}<span class="gitRefName">#43955/1</span><span class="gg-label cr2">CR+2</span>`), 'neophack', '2026-09-08 09:15', '7c6b5a4', 2)}
		</tbody>
	</table></div>
</div></div>
`;

const tabletSqueezedCss = `
#view{position:static !important;overflow:visible !important}
`;

/** The mobile pages of the audit. */
export const mobilePages = [
	{ name: 'mobile-view', label: 'Mobile layout (app bar, commit list, sheets)', stylesheet: 'out', bodyClass: 'mobileMode', viewport: { width: 390, height: 844 }, body: mobileViewBody, harnessCss: mobileViewCss },
	{ name: 'mobile-details', label: 'Mobile layout (commit details sheet, dialog)', stylesheet: 'out', bodyClass: 'mobileMode', viewport: { width: 390, height: 844 }, body: mobileDetailsBody, harnessCss: mobileDetailsCss },
	{ name: 'tablet-squeezed', label: 'Tablet layout, squeezed Description column (ref pills stay whole, the subject gives way)', stylesheet: 'out', bodyClass: 'tabletMode', viewport: { width: 768, height: 600 }, body: tabletSqueezedBody, harnessCss: tabletSqueezedCss }
];
