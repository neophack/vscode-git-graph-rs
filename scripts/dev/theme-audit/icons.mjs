/* Shared building blocks for the theme-audit markup samples: the SVG icons the view renders
 * (small codicon-style stand-ins) and helpers that assemble ref chips and commit rows with the
 * same class names src/webview produces, so the audit exercises the real selectors. */

const svg = (viewBox, body, extra = '') =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${extra}>${body}</svg>`;

export const icons = {
	review: svg('0 0 24 24', '<path fill-rule="evenodd" d="m4,4.7 -4,7.3 4,7.3 2.5,0 -4,-7.3 4,-7.3zM11.5,6C9,5.5 6.6,7.1 6.1,9.6c-0.5,2.6 1.1,5 3.6,5.5 1,0.2 1.8,0.1 2.7,-0.3l2.5,3.3c0.1,0.1 0.3,0.2 0.5,0.3 0.2,0 0.4,0 0.6,-0.1 0.3,-0.2 0.4,-0.4 0.4,-0.6 0,-0.2 0,-0.4 -0.1,-0.6 0,-0.2 -2.4,-3.3 -2.4,-3.3 0.7,-0.6 1,-1.5 1.3,-2.4C15.7,8.9 14,6.5 11.5,6zm8.5,-1.3 -2.5,0 4,7.3 -4.2,7.3 2.5,0L24,12zm-8.8,3c1.6,0.3 2.6,1.8 2.3,3.4 -0.3,1.6 -1.8,2.6 -3.4,2.3C8.5,13 7.4,11.6 7.8,10 8,8.4 9.6,7.3 11.2,7.7z"/>', ' width="24" height="24"'),
	pullRequest: svg('0 0 16 16', '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>', ' width="12" height="12"'),
	linkExternal: svg('0 0 16 16', '<path fill-rule="evenodd" d="M4 3.5h3V2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V10h-1.5v3h-9v-9H4ZM8.5 2H14v5.5h-1.5V4.56l-4.72 4.72-.7-.7 4.22-4.22L11 7.5h.5V2h-3V2Z"/>', ' width="12" height="12"'),
	chevronDown: svg('0 0 14 14', '<path fill-rule="evenodd" d="M7,10.5L1.2,4.7l1.4,-1.4L7,7.7l4.4,-4.4l1.4,1.4z"/>', ' width="14" height="14"'),
	folder: svg('0 0 16 16', '<path fill-rule="evenodd" d="M7.71 3h6.79A1.5 1.5 0 0 1 16 4.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 12.5v-10A1.5 1.5 0 0 1 1.5 1h3.71l2.5 2z"/>', ' width="13" height="13"'),
	file: svg('0 0 16 16', '<path fill-rule="evenodd" d="M4 1h5l4 4v10H4V1zm4 1v4h4L8 2z"/>', ' width="13" height="13"'),
	openChanges: svg('0 0 16 16', '<path d="M13 12V4.414C13 4.014 12.844 3.637 12.561 3.353L9.64602.439C9.36302.156 8.98602 0 8.58502 0H3.99902C2.89602 0 1.99902.897 1.99902 2V12C1.99902 13.103 2.89602 14 3.99902 14H10.999C12.102 14 12.999 13.103 12.999 12H13Z"/>', ' width="16" height="16"'),
	loading: svg('0 0 12 16', '<circle cx="6" cy="8" r="5"/>', ' width="15" height="20"'),
	branch: svg('0 0 16 16', '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>', ' width="14" height="14"'),
	tag: svg('0 0 16 16', '<path fill-rule="evenodd" d="M11.6 10c-.5-.8-1-1.6-1.1-2.7-.1-1.1.2-2.2 1-3.4l1.2 1-.7-3.4-3.4.7 1.2 1.2c-1.2.8-2.4 1-3.5.9C4.2 4.2 3.4 3.7 2.6 3L1.4 4.2c1 .8 1.9 1.9 2.2 3.4.3 1.4-.1 2.9-1.1 4.4l1.6 1.1c.8-1.2 1.9-1.9 3.1-2.1 1.2-.2 2.4.1 3.6.8l-1 1.4 3.4.4.3-3.5-1.5 1.1c-.4-.3-.8-.6-1-1.2z"/>', ' width="14" height="14"'),
	stash: svg('0 0 16 16', '<path fill-rule="evenodd" d="M2 2v4.5A1.5 1.5 0 0 0 3.5 8h9l-2.5-2.5L13 3.5 16 6.5 13 9.5l-2.5-2.5h-7A3 3 0 0 1 .5 4V2H2z"/>', ' width="14" height="14"'),
	check: svg('0 0 16 16', '<path fill-rule="evenodd" d="M14.4 4.4l-8 8L1.6 7.6 3 6.2l3.4 3.4 6.6-6.6 1.4 1.4z"/>', ' width="16" height="16"'),
	close: svg('0 0 16 16', '<path fill-rule="evenodd" d="M8 8.7l4.6 4.6 1.4-1.4L9.4 7.3 14 2.7 12.6 1.3 8 5.9 3.4 1.3 2 2.7l4.6 4.6L2 11.9l1.4 1.4L8 8.7z"/>', ' width="16" height="16"'),
	alert: svg('0 0 16 16', '<path fill-rule="evenodd" d="M8 1l7 13H1L8 1zm-.5 5v4h1V6h-1zm0 5v1.5h1V11h-1z"/>', ' width="16" height="16"'),
	magnifier: svg('0 0 16 16', '<path fill-rule="evenodd" d="M6.5 1a5.5 5.5 0 1 1 0 11c-1.3 0-2.5-.45-3.45-1.2l-2.4 2.4-.7-.7 2.4-2.4A5.47 5.47 0 0 1 1 6.5 5.5 5.5 0 0 1 6.5 1zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>', ' width="18" height="18"'),
	refresh: svg('0 0 16 16', '<path fill-rule="evenodd" d="M13.45 2.55l-.65 3.1-3.1-.65.4-1.35a5 5 0 1 0 3.15 5.65l1.45.35A6.5 6.5 0 1 1 10.6 2.2l.4-1.35 2.45.7z"/>', ' width="16" height="16"'),
	filter: svg('0 0 16 16', '<path fill-rule="evenodd" d="M1 2h14l-5.5 6.5V14l-3-1.5V8.5L1 2z"/>', ' width="18" height="18"'),
	stats: svg('0 0 16 16', '<path fill-rule="evenodd" d="M2 13V8h2v5H2zm5 0V3h2v10H7zm5 0v-7h2v7h-2z"/>', ' width="18" height="18"'),
	terminal: svg('0 0 16 16', '<path fill-rule="evenodd" d="M1 2h14v12H1V2zm1.5 1.5v9h11v-9h-11zM4 6l1.8 2L4 10l.8.8L7.4 8 4.8 5.2 4 6zm4 4h4v1H8v-1z"/>', ' width="18" height="18"'),
	gear: svg('0 0 16 16', '<path fill-rule="evenodd" d="M9.1 1l.35 1.9c.42.15.8.37 1.15.64l1.8-.7.9 1.55-1.35 1.35c.03.25.05.5.05.76s-.02.51-.05.76l1.35 1.35-.9 1.55-1.8-.7c-.35.27-.73.49-1.15.64L9.1 12H7l-.35-1.9c-.42-.15-.8-.37-1.15-.64l-1.8.7-.9-1.55 1.35-1.35A5.6 5.6 0 0 1 4.1 6.5c0-.26.02-.51.05-.76L2.8 4.4l.9-1.55 1.8.7c.35-.27.73-.49 1.15-.64L7 1h2.1zM8 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>', ' width="18" height="18"'),
	fetch: svg('0 0 16 16', '<path fill-rule="evenodd" d="M8 1v3.5a4.5 4.5 0 1 1-4.47 5L5 9.85A3 3 0 1 0 8 6v3l4-4-4-4z"/>', ' width="18" height="18"'),
	more: svg('0 0 16 16', '<circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/>', ' width="20" height="20"'),
	info: svg('0 0 16 16', '<path fill-rule="evenodd" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm-.75 3v1.5h1.5V4h-1.5zm0 3v5h1.5V7h-1.5z"/>', ' width="14" height="14"'),
	current: svg('0 0 16 16', '<path fill-rule="evenodd" d="M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm0 1.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/>', ' width="18" height="18"'),
	upDown: svg('0 0 16 16', '<path fill-rule="evenodd" d="M4 5V1H2.5L5.5-2 8.5 1H7v4H4z" transform="translate(1 3)"/>', ' width="18" height="18"')
};

/** A one-pixel avatar as an inline SVG data URI (the avatar <img> the rows load from the host). */
export const avatarUri = 'data:image/svg+xml,' + encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect width="18" height="18" fill="#0e639c"/><text x="9" y="13" font-size="10" fill="#fff" text-anchor="middle" font-family="sans-serif">N</text></svg>'
);

/** A small test picture for the image-compare pane. */
export const imgUri = (fill) => 'data:image/svg+xml,' + encodeURIComponent(
	`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="${fill}"/><circle cx="32" cy="32" r="18" fill="rgba(255,255,255,0.7)"/><rect x="58" y="16" width="24" height="32" fill="rgba(0,0,0,0.45)"/></svg>`
);

/** One ref chip (span.gitRef), same shape as src/webview/graph/render/commitRow.ts builds. */
export function gitRef(kind, inner, extra) {
	return `<span class="gitRef ${kind}"${extra || ''}>${inner}</span>`;
}

/** The ref-chip gallery: heads (active/remote), tag, stash, gerrit and pull-request badges. */
export function refChips() {
	return gitRef('head active', `${icons.branch}<span class="gitRefName">main</span>`, ' style="--git-graph-color:var(--git-graph-color0)"') +
		gitRef('head', `${icons.branch}<span class="gitRefName">develop</span>`, ' style="--git-graph-color:var(--git-graph-color1)"') +
		gitRef('remote', `${icons.branch}<span class="gitRefName">origin/main</span><span class="gitRefHeadRemote">origin</span>`, ' style="--git-graph-color:var(--git-graph-color2)"') +
		gitRef('tag', `${icons.tag}<span class="gitRefName">v1.0.21</span>`) +
		gitRef('stash', `${icons.stash}<span class="gitRefName">WIP on main</span>`) +
		gitRef('gerrit', `${icons.review}<span class="gitRefName">#42501/3</span><span class="gg-label cr2">CR+2</span><span class="gg-label v1">V+1</span>`) +
		gitRef('gerrit', `${icons.review}<span class="gitRefName">#42502/1</span><span class="gg-label cr1">CR+1</span><span class="gg-label cr0">CR 0</span><span class="gg-label cr-1">CR-1</span><span class="gg-label cr-2">CR-2</span><span class="gg-status merged">MERGED</span>`) +
		gitRef('gerrit', `${icons.review}<span class="gitRefName">#42503/2</span><span class="gg-label cr0">CR 0</span><span class="gg-status abandoned">ABANDONED</span>`) +
		gitRef('gerrit', `${icons.review}<span class="gitRefName">#42504/1</span><span class="gg-label cr-1">CR-1</span><span class="gg-status wip">WIP</span>`) +
		gitRef('pr', `${icons.pullRequest}<span class="gitRefName">#128</span><span class="gg-status open">OPEN</span>`) +
		gitRef('pr', `${icons.pullRequest}<span class="gitRefName">#129</span><span class="gg-status merged">MERGED</span>`) +
		gitRef('pr', `${icons.pullRequest}<span class="gitRefName">#130</span><span class="gg-status abandoned">CLOSED</span>`) +
		gitRef('pr', `${icons.pullRequest}<span class="gitRefName">#131</span><span class="gg-status wip">DRAFT</span>`);
}

/**
 * One wide-layout commit row (the non-narrow branch of getCommitRowHtml): graph cell with the
 * head dot, description cell with refs / subject / open-changes button, then the date, author
 * and abbreviated-hash columns.
 */
export function wideCommitRow(state, msg, refs, author, date, hash, colour) {
	const lane = colour === undefined ? 0 : colour;
	const cls = 'commit' + (state ? ' ' + state : '');
	return `<tr class="${cls}" data-color="${lane}" style="--git-graph-color:var(--git-graph-color${lane})">` +
		`<td><span class="commitHeadDot"></span></td>` +
		`<td><span class="description">${refs}<span class="text">${msg}</span>` +
		(state === 'current' ? '<span class="pinnedBadge">📌</span>' : '') +
		`<span class="openChangesBtn" title="${msg}">${icons.openChanges}</span></span></td>` +
		`<td class="dateCol text" title="${date}">${date}</td>` +
		`<td class="authorCol text" title="${author} &lt;n@example.com&gt;"><span class="avatar"><img class="avatarImg" decoding="sync" src="${avatarUri}"></span>${author}</td>` +
		`<td class="text" title="0000000000000000000000000000000000000000">${hash}</td></tr>`;
}

/**
 * One narrow (mobile) commit row: subject with the compact date, then refs / author / hash on
 * the second line — the shape the mobile layout's CSS is written against.
 */
export function narrowCommitRow(state, msg, refs, author, date, hash, colour) {
	const lane = colour === undefined ? 0 : colour;
	const cls = 'commit' + (state ? ' ' + state : '');
	return `<tr class="${cls}" data-color="${lane}" style="--git-graph-color:var(--git-graph-color${lane})">` +
		`<td></td>` +
		`<td><span class="description"><span class="commitHeadDot"></span><span class="text">${msg}</span><span class="mobileMetaDate" title="${date}">${date}</span></span>` +
		`<span class="mobileMeta"><span class="mobileRefs">${refs}</span><span class="mobileMetaAuthor">${author}</span><span class="mobileMetaHash">${hash}</span></span></td></tr>`;
}
