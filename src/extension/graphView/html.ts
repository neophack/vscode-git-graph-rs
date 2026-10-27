import * as fs from 'fs';
import * as path from 'path';
import type { Uri } from 'vscode';
import { describeCapabilities } from '../git/read/backendIndex';
import { hasEngineForPlatform } from '../git/read/addonLoader';
import { ConfigSnapshot, cookConfig } from '../platform/config';
import { t } from '../platform/i18n';
import type { GitGraphViewConfig, GitGraphViewGlobalState, GitGraphViewInitialState, GitGraphViewSnapshot, GitGraphViewWorkspaceState, LoadGitGraphViewTo } from '../../shared/model/webview';
import type { GitRepoSet } from '../../shared/model/repoState';
import { unableToFindGitMsg } from '../git/executable/findGit';
import { encodeJsonForInlineScript, getNonce } from '../platform/format';

/**
 * The webview HTML shell of the Git Graph main view (REFACTOR-PLAN task 4.4), extracted from
 * GitGraphView's `getHtmlForWebview` / `getWebviewConfig` / `getMediaUri` plumbing
 * (src/gitGraphView.ts): the CSP + nonce document, the initial state the page boots on, the
 * media URIs (with their cache-busting version) and the automation shim injection. The Panel
 * supplies every input; the side effects the old method performed (recording whether the view
 * loaded, consuming loadViewTo / the restored snapshot, the language last sent) stay with the
 * Panel.
 */

/**
 * Cache-busting version appended to the webview media URIs.
 * Must change whenever web/ sources change, so that already-open webviews
 * don't keep serving a stale cached out.min.js / out.min.css after an update.
 * Derived from the extension's own version (which every release bumps) plus the
 * package file's modification time: the local dev loop reinstalls builds without
 * bumping the version, and a version-only buster then serves the previous install's
 * webview bundle to the new extension host - exactly the stale-bundle disagreement
 * (a host and a webview disagreeing about a message field) that has produced
 * hard-to-reproduce webview errors before, so the buster must never be forgotten.
 */
let mediaCacheVersion: string | null = null;

/** The media cache-busting version of this install (see {@link mediaCacheVersion}). */
export function getMediaCacheVersion(extensionPath: string): string {
	const cached = mediaCacheVersion;
	if (cached !== null) return cached;
	let version: string;
	try {
		const packageJsonPath = path.join(extensionPath, 'package.json');
		// Every install rewrites package.json, so its mtime distinguishes same-version reinstalls
		version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version + '+' + fs.statSync(packageJsonPath).mtime.getTime();
	} catch (_) {
		version = String(Date.now()); // unreadable version: bust every session instead
	}
	mediaCacheVersion = version;
	return version;
}

/** The automation shim source cached per session (empty on read failure / the default build). */
let automationShimJs: string | null = null;

/**
 * The automation shim source, inlined into the page (with its CSP nonce) so it needs no change
 * to the Content-Security-Policy sources. Cached per session; empty on read failure. ENOENT is
 * the default (no-automation) build: the shim simply is not injected, and only other read
 * errors are logged.
 */
export function getAutomationShimScript(extensionPath: string, logger: { logError(message: string): void }): string {
	if (automationShimJs === null) {
		try {
			automationShimJs = fs.readFileSync(path.join(extensionPath, 'resources', 'automation', 'shim.js'), 'utf8');
		} catch (error) {
			automationShimJs = '';
			// ENOENT => the default (no-automation) build: the shim simply is not injected.
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.logError('Unable to read the automation shim: ' + (error instanceof Error ? error.message : String(error)));
			}
		}
	}
	return automationShimJs;
}

/**
 * The webview's runtime configuration: the subset of the Extension Settings that the page runs
 * on, cooked from one configuration snapshot. Embedded into the generated HTML at page load,
 * and sent to the already-loaded page with a `configChanged` message when a setting changes
 * (see the Panel's configuration listener).
 * @param config The configuration snapshot to derive from.
 * @param hostLanguage The language Visual Studio Code itself is displayed in (the "auto"
 * interface language resolves against it).
 * @param avatarStorageAvailable Whether avatar images can be stored (fetchAvatars degrades to off otherwise).
 */
export function getWebviewConfig(config: ConfigSnapshot, hostLanguage: string, avatarStorageAvailable: boolean): GitGraphViewConfig {
	const cooked = cookConfig(config, hostLanguage);
	return {
		commitAuthors: cooked.commitAuthors,
		commitDetailsView: cooked.commitDetailsView,
		commitOrdering: cooked.commitOrder,
		contextMenuActionsVisibility: cooked.contextMenuActionsVisibility,
		customBranchGlobPatterns: cooked.customBranchGlobPatterns,
		customEmojiShortcodeMappings: cooked.customEmojiShortcodeMappings,
		customPullRequestProviders: cooked.customPullRequestProviders,
		dateFormat: cooked.dateFormat,
		dateType: cooked.dateType,
		defaultColumnVisibility: cooked.defaultColumnVisibility,
		dialogDefaults: cooked.dialogDefaults,
		enableLog: config.enableLog,
		stickyHeader: config.stickyHeader,
		enhancedAccessibility: config.enhancedAccessibility,
		fetchAndPrune: config.repositoryFetchAndPrune,
		fetchAndPruneTags: config.repositoryFetchAndPruneTags,
		fetchAvatars: config.repositoryCommitsFetchAvatars && avatarStorageAvailable,
		gerrit: cooked.gerrit,
		graph: cooked.graph,
		interfaceLanguage: cooked.interfaceLanguage,
		interfaceLanguageSetting: cooked.interfaceLanguageSetting,
		includeCommitsMentionedByReflogs: config.repositoryIncludeCommitsMentionedByReflogs,
		initialLoadCommits: config.repositoryCommitsInitialLoad,
		keybindings: cooked.keybindings,
		loadMoreCommits: config.repositoryCommitsLoadMore,
		loadMoreCommitsAutomatically: config.repositoryCommitsLoadMoreAutomatically,
		markdown: config.markdown,
		mobileAdaptation: config.mobileAdaptation,
		mute: cooked.muteCommits,
		showBodyInline: config.repositoryCommitsShowBodyInline,

		onlyFollowFirstParent: config.repositoryOnlyFollowFirstParent,
		onRepoLoad: cooked.onRepoLoad,
		pullRequests: { enabled: config.pullRequestsEnabled },
		referenceLabels: cooked.referenceLabels,
		repoDropdownOrder: cooked.repoDropdownOrder,
		showCommitBodyInline: config.repositoryCommitsShowBodyInline,
		showRemoteBranches: config.repositoryShowRemoteBranches,
		showRemoteHeads: config.repositoryShowRemoteHeads,
		showStashes: config.repositoryShowStashes,
		showTags: config.repositoryShowTags,
		showUncommittedChanges: config.repositoryShowUncommittedChanges,
		showUntrackedFiles: config.repositoryShowUntrackedFiles,
		snapshotFirstPaint: config.snapshotFirstPaint,
		trackRemoteTags: config.repositoryTrackRemoteTags
	};
}

/**
 * Whether the view can load at all: it needs the engine or Git - either one is enough (the
 * engine serves every read in-process; Git serves everything through the CLI backend). The
 * "unable to load" page appears only when neither is present. The Settings widget's backend
 * section shows which is in use.
 */
export function canLoadGraphView(gitCliAvailable: boolean, extensionPath: string): boolean {
	return gitCliAvailable || hasEngineForPlatform(extensionPath);
}

/** Everything the HTML shell needs, supplied by the Panel. */
export interface GraphViewHtmlInputs {
	readonly extensionPath: string;
	/** The panel webview's cspSource. */
	readonly cspSource: string;
	/** Map a file name under media/ to the webview URI serving it. */
	mediaUri(file: string): Uri;
	/** The webview's runtime configuration (see {@link getWebviewConfig}). */
	readonly config: GitGraphViewConfig;
	readonly lastActiveRepo: string | null;
	/** What to load the view to (consumed by this render; NULL => open plain). */
	readonly loadViewTo: LoadGitGraphViewTo;
	readonly repos: GitRepoSet;
	/** The latest refresh ids of the staged requests (the page must not apply responses older than these). */
	readonly refreshIds: { readonly loadRepoInfo: number, readonly loadCommits: number, readonly loadConfig: number };
	/** The view state the page should reopen on (consumed by this render; NULL => none). */
	readonly restoredSnapshot: GitGraphViewSnapshot | null;
	readonly globalState: GitGraphViewGlobalState;
	readonly workspaceState: GitGraphViewWorkspaceState;
	/** Whether a Git executable is known (the engine may serve the reads without one). */
	readonly gitCliAvailable: boolean;
	readonly logger: { logError(message: string): void };
}

/**
 * The HTML document to load in the webview panel: the CSP + nonce head, the theme colour
 * variables derived from the configuration, the initial state script, and one of the three
 * bodies - the view itself, the "unable to load" page (no engine and no Git), or the
 * "no repositories found" page with its rescan button.
 *
 * The view's script loads as an ES MODULE (task 5.9): the first-paint bundle media/out.min.js
 * imports its on-demand chunks (media/chunks/*.js) with relative dynamic import(), which the
 * nonce cannot cover - a dynamically imported module carries no nonce - so the CSP's script-src
 * allows the webview's own resource origin next to the nonce. The Markdown renderer is no
 * longer preloaded here at all: it is one of those on-demand chunks.
 * @returns The HTML.
 */
export function renderGraphViewHtml(inputs: GraphViewHtmlInputs): string {
	const nonce = getNonce();
	// The automation shim's `eval` steps compile expressions at runtime, which the default
	// CSP forbids — so the automation packaging variant (the only build whose webview carries
	// the shim) also opts that page into 'unsafe-eval'. The default build stays strict.
	const automationShimJs = getAutomationShimScript(inputs.extensionPath, inputs.logger);
	const initialState: GitGraphViewInitialState = {
		config: inputs.config,
		lastActiveRepo: inputs.lastActiveRepo,
		loadViewTo: inputs.loadViewTo,
		repos: inputs.repos,
		loadRepoInfoRefreshId: inputs.refreshIds.loadRepoInfo,
		loadCommitsRefreshId: inputs.refreshIds.loadCommits,
		loadConfigRefreshId: inputs.refreshIds.loadConfig,
		backend: describeCapabilities({ gitCliAvailable: inputs.gitCliAvailable }),
		restoredSnapshot: inputs.restoredSnapshot
	};

	let body;
	const numRepos = Object.keys(initialState.repos).length;

	if (!canLoadGraphView(inputs.gitCliAvailable, inputs.extensionPath)) {
		body = `<body class="unableToLoad">
		<h2>${t('unableToLoadGitGraph')}</h2>
		<p class="unableToLoadMessage">${unableToFindGitMsg()}</p>
		</body>`;
	} else if (numRepos > 0) {
		const stickyClassAttr = initialState.config.stickyHeader ? ' class="sticky"' : '';
		body = `<body>
		<div id="view" tabindex="-1">
			<div id="headerRow"${stickyClassAttr}>
				<div id="controls">
					<span id="repoControl"><span id="repoControlLabel" class="unselectable"></span><div id="repoDropdown" class="dropdown"></div></span>
					<span id="branchControl"><span id="branchControlLabel" class="unselectable"></span><div id="branchDropdown" class="dropdown"></div></span>
					<span id="authorControl"><span id="authorControlLabel" class="unselectable"></span><div id="authorDropdown" class="dropdown"></div></span>

				<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span><span id="showRemoteBranchesLabel"></span></label>
				<span id="controlBtns">
					<div id="currentBtn"></div>
					<div id="findBtn"></div>
					<div id="filterBtn"></div>
					<div id="statisticsBtn"></div>
					<div id="terminalBtn"></div>
					<div id="settingsBtn"></div>
					<div id="fetchBtn"></div>
					<div id="refreshBtn"></div>
				</span>
				</div>
				<div id="pinnedControls" style="display:none">
					<span id="pinnedRowLabel" class="unselectable pinnedRowLabel"></span>
				</div>
			</div>
			<div id="conflictBanner" style="display:none"></div>
			<div id="content">
				<div id="commitGraph"></div>
				<div id="commitTable"></div>
			</div>
			<div id="footer"></div>
		</div>
		<script nonce="${nonce}">var initialState = ${encodeJsonForInlineScript(JSON.stringify(initialState))}, globalState = ${encodeJsonForInlineScript(JSON.stringify(inputs.globalState))}, workspaceState = ${encodeJsonForInlineScript(JSON.stringify(inputs.workspaceState))};</script>
		<script nonce="${nonce}">${automationShimJs}</script>
		<script nonce="${nonce}" type="module" src="${inputs.mediaUri('out.min.js')}?v=${getMediaCacheVersion(inputs.extensionPath)}"></script>
		</body>`;
	} else {
		body = `<body class="unableToLoad">
		<h2>${t('unableToLoadGitGraph')}</h2>
		<p class="unableToLoadMessage">${t('noReposWhenLastScanned')}</p>
		<p>${t('noReposHint', 'https://github.com/mhutchie/vscode-git-graph/wiki/Extension-Settings#max-depth-of-repo-search')}</p>
		<p><div id="rescanForReposBtn" class="roundedBtn" role="button" tabindex="0">${t('rescanForReposButton')}</div></p>
		<script nonce="${nonce}">(function(){
			var api = acquireVsCodeApi(), btn = document.getElementById('rescanForReposBtn');
			var rescan = function(){ api.postMessage({command: 'rescanForRepos'}); };
			btn.addEventListener('click', rescan);
			btn.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rescan(); } });
		})();</script>
		</body>`;
	}

	const graphColours = themeColourVars(initialState.config.graph.colours);
	return `<!DOCTYPE html>
	<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${standardiseCspSource(inputs.cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}' ${standardiseCspSource(inputs.cspSource)}${automationShimJs !== '' ? " 'unsafe-eval'" : ''}; img-src data: https:;">
			<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
			<link rel="stylesheet" type="text/css" href="${inputs.mediaUri('out.min.css')}?v=${getMediaCacheVersion(inputs.extensionPath)}">
			<title>Git Graph</title>
			<style>body{${graphColours.vars}} ${graphColours.params}</style>
		</head>
		${body}
	</html>`;
}

/** The per-colour CSS variables of the graph theme: `--git-graph-colorN` plus the selector params. */
function themeColourVars(colours: ReadonlyArray<string>): { vars: string, params: string } {
	let vars = '', params = '';
	for (let i = 0; i < colours.length; i++) {
		vars += '--git-graph-color' + i + ':' + colours[i] + '; ';
		params += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ');} ';
	}
	return { vars: vars, params: params };
}

/**
 * Standardise the CSP Source provided by Visual Studio Code for use with the Webview. It is idempotent unless called with http/https URI's, in which case it keeps only the authority portion of the http/https URI. This is necessary to be compatible with some web browser environments.
 * @param cspSource The value provide by Visual Studio Code.
 * @returns The standardised CSP Source.
 */
export function standardiseCspSource(cspSource: string) {
	if (cspSource.startsWith('http://') || cspSource.startsWith('https://')) {
		const pathIndex = cspSource.indexOf('/', 8), queryIndex = cspSource.indexOf('?', 8), fragmentIndex = cspSource.indexOf('#', 8);
		let endOfAuthorityIndex = pathIndex;
		if (queryIndex > -1 && (queryIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = queryIndex;
		if (fragmentIndex > -1 && (fragmentIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = fragmentIndex;
		return endOfAuthorityIndex > -1 ? cspSource.substring(0, endOfAuthorityIndex) : cspSource;
	} else {
		return cspSource;
	}
}
