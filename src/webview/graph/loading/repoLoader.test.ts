import { describe, expect, it } from 'vitest';
import * as GG from '../../common/protocol';
import type { GraphContext } from '../context';
import { RenderScheduler } from '../render/scheduler';
import { RepoLoader } from './repoLoader';

/**
 * The open path of the webview (REFACTOR-PLAN task 4.7): the initial boot sends ZERO
 * loadRepoInfo/loadCommits requests — it only reports `ready` — and the pushed `loadView`
 * response applies the repo-info and commit-page halves through the same processing the
 * partial responses use. The repository's own settings matching the pushed defaults costs no
 * re-request; a repository that selects specific branches re-requests just the commits.
 */

interface SentMessage {
	readonly command: string;
	readonly [field: string]: unknown;
}

/** A GraphContext whose members are no-ops (or recording fakes where the test asserts on them). */
function fakeContext(options: { repos?: GG.GitRepoSet } = {}): { ctx: GraphContext; sent: SentMessage[]; store: Record<string, unknown> } {
	const sent: SentMessage[] = [];
	const repoState = {
		pinnedBranches: [], pinnedCommits: [], cdvDivider: 0, cdvHeight: 0, columnWidths: null,
		commitOrdering: GG.RepoCommitOrdering.Default, fileViewType: 0, gerritFetchRefs: false,
		gerritFetchLimit: null, gerritStatusFilter: { new: true, merged: true, abandoned: true, wip: true },
		hideRemotes: [], includeCommitsMentionedByReflogs: 0, issueLinkingConfig: null, lastImportAt: 0,
		name: null, onlyFollowFirstParent: 0, onRepoLoadShowCheckedOutBranch: 0, onRepoLoadShowSpecificBranches: null,
		pullRequestConfig: null, showRemoteBranches: true, showRemoteBranchesV2: 0, showStashes: 0, showTags: 0,
		workspaceFolderIndex: null
	};
	const store: Record<string, unknown> = {
		repos: options.repos !== undefined ? options.repos : { '/repo': { name: 'repo' } as unknown as GG.GitRepoState },
		currentRepo: null,
		currentRepoLoading: false,
		loadViewTo: null,
		maxCommits: 0,
		gitConfig: null,
		gitRemotes: [],
		gitStashes: [],
		gitTags: [],
		gitBranches: [],
		gitBranchHead: null,
		currentBranches: null,
		currentAuthors: null,
		commitPathFilter: null,
		compareSourceHash: null,
		pullRequestsByHead: {},
		expandedCommit: null,
		commits: [],
		commitLookup: {},
		commitHead: null,
		uncommittedCount: null,
		renderedGitBranchHead: null,
		gerritStates: {},
		gerritStatesDirty: false,
		moreCommitsAvailable: false,
		onlyFollowFirstParent: false,
		scrollTop: 0,
		repoState: repoState,
		hasCurrentRepo: () => false,
		invalidateRender: () => undefined,
		getBranchGlobPatterns: () => [] as string[],
		getBranchOptions: () => [] as unknown[],
		getAuthorOptions: () => [] as unknown[],
		getSelectedBranchesFilter: () => null,
		getSelectedAuthorsFilter: () => null,
		getCommitId: () => null,
		config: {
			repoDropdownOrder: 'alphabetical',
			initialLoadCommits: 100,
			commitOrdering: GG.CommitOrdering.Date,
			showRemoteBranches: true,
			showTags: true,
			showStashes: true,
			includeCommitsMentionedByReflogs: false,
			onlyFollowFirstParent: false,
			fetchAvatars: false,
			pullRequests: { enabled: false },
			onRepoLoad: { scrollToHead: false, showCheckedOutBranch: false, showSpecificBranches: [] }
		},
		refreshState: {
			inProgress: false, hard: false, configChanges: false, requestingRepoInfo: false,
			repoInfoChanges: false, requestingConfig: false,
			loadRepoInfoRefreshId: 0, loadCommitsRefreshId: 0, loadConfigRefreshId: 0
		}
	};
	const noop = () => undefined;
	const ctx = {
		store: store,
		renderScheduler: new RenderScheduler(noop),
		bridge: {
			send: (message: unknown) => { sent.push(message as SentMessage); }
		},
		persistence: { saveState: noop, saveRepoStateValue: noop },
		controls: {
			renderRepoDropdownOptions: noop, syncShowRemoteBranches: noop, renderFetchButton: noop,
			renderFilterButton: noop, renderRefreshButton: noop, renderToolbarText: noop,
			branchDropdown: { setOptions: noop }, authorDropdown: { setOptions: noop },
			repoDropdown: { setOptions: noop }
		},
		viewport: {
			pendingViewportAnchor: null, restoreScrollTop: null, renderedRange: null,
			captureViewportAnchor: () => null, capturePendingViewportAnchor: () => undefined,
			applyViewportAnchor: noop, updateVirtualWindow: noop,
			pendingScrollCommit: null
		},
		table: { showLoadingSkeleton: noop, setFooterLoading: noop, setFooter: noop, render: noop, clear: noop, renderGraph: noop, renderUncommittedChanges: noop },
		graph: { loadCommits: noop },
		details: { close: noop },
		widgets: {
			settings: { close: noop, refresh: noop }, reflog: { close: noop }, worktree: { close: noop },
			statistics: { close: noop }, conflictBanner: { update: noop }, find: { refresh: noop }
		},
		dialog: { closeActionRunning: noop, isTargetDynamicSource: () => false, showError: noop },
		contextMenu: { isTargetDynamicSource: () => false },
		closeDialogAndContextMenu: noop,
		commitBodies: { clear: noop },
		dom: {
			view: { focus: noop, scrollTop: 0, classList: { contains: () => false, add: noop, remove: noop } },
			controls: { classList: { contains: () => false, add: noop, remove: noop } },
			headerRow: { classList: { contains: () => false, add: noop, remove: noop } }
		}
	};
	return { ctx: ctx as unknown as GraphContext, sent: sent, store: store };
}

/** The pushed merged response the host sends once the page reported `ready`. */
function pushedLoadView(refreshId: number): GG.ResponseLoadView {
	return {
		command: 'loadView',
		repo: '/repo',
		refreshId: refreshId,
		repoInfo: {
			branches: ['main'], head: 'main', remotes: ['origin'], stashes: [], isRepo: true,
			operationState: { type: null, conflictedFiles: [], progress: null }, error: null
		},
		commits: {
			commits: [commit('c1')].map((entry) => entry as unknown as GG.GitCommit),
			head: 'c1', tags: [], moreCommitsAvailable: true, onlyFollowFirstParent: false,
			gerritStates: null, uncommittedPending: true, branches: ['main'], error: null
		}
	} as unknown as GG.ResponseLoadView;
}

function commit(hash: string) {
	return { hash: hash, parents: [], author: 'A', email: 'a@x', date: 1, message: 'm', heads: [], tags: [], remotes: [], stash: null };
}

describe('RepoLoader open path (task 4.7)', () => {
	it('the initial boot sends ZERO loadRepoInfo/loadCommits requests (main.ts reports `ready` next)', () => {
		const { ctx, sent } = fakeContext();
		const loader = new RepoLoader(() => ctx);
		loader.start(null, '/repo', null);
		// The boot itself sends nothing: main.ts sends the single `ready` handshake once the
		// response router is installed, and the data arrives as the host's pushed loadView.
		expect(sent).toEqual([]);
		// The repository switch of the boot happened (the pushed response applies to it) ...
		expect((ctx.store as unknown as { currentRepo: string }).currentRepo).toBe('/repo');
		// ... and the loading skeleton shows until the push arrives.
		expect((ctx.store as unknown as { currentRepoLoading: boolean }).currentRepoLoading).toBe(true);
	});

	it('the pushed loadView applies both halves and triggers no re-request when the settings match the defaults', () => {
		const { ctx, sent, store } = fakeContext();
		const loader = new RepoLoader(() => ctx);
		loader.start(null, '/repo', null);
		expect(sent).toEqual([]);

		loader.processLoadView(pushedLoadView(7));
		// The refresh ids adopted the pushed one, so the staged follow-ups (same id) are accepted
		const refreshState = store.refreshState as { loadRepoInfoRefreshId: number; loadCommitsRefreshId: number };
		expect(refreshState.loadRepoInfoRefreshId).toBe(7);
		expect(refreshState.loadCommitsRefreshId).toBe(7);
		// The repo-info half applied ...
		expect(store.gitBranches).toEqual(['main']);
		expect(store.gitBranchHead).toBe('main');
		// ... and the commit-page half rendered the pushed page.
		expect(store.commits).toHaveLength(1);
		expect((store.commits as { hash: string }[])[0].hash).toBe('c1');
		// A repository whose settings match the pushed defaults re-requests nothing: the config
		// load the boot always issues is the only request the open path costs.
		expect(sent.map((message) => message.command)).toEqual(['loadConfig']);
	});

	it('a repository whose settings differ from the pushed defaults re-requests just the commits', () => {
		const { ctx, sent } = fakeContext();
		const loader = new RepoLoader(() => ctx);
		// This repository pins a non-default ordering: the pushed default page does not match it.
		(ctx.store as unknown as { repoState: { commitOrdering: GG.RepoCommitOrdering } }).repoState.commitOrdering = GG.RepoCommitOrdering.Topological;
		loader.start(null, '/repo', null);
		loader.processLoadView(pushedLoadView(7));
		const commands = sent.map((message) => message.command);
		expect(commands).toContain('loadCommits'); // one partial refresh, under the repository's own options
		expect(commands).not.toContain('loadRepoInfo');
	});
});
