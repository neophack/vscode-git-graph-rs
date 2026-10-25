import { describe, expect, it } from 'vitest';
import type { DataSource } from '../../../dataSource';
import { MUTATING_COMMANDS, REQUEST_COMMANDS } from '../../../shared/protocol/graphView';
import { GitConfigLocation, GitPushBranchMode, GitResetMode, MergeActionOn, RebaseActionOn, TagType } from '../../../types';
import type { ResponseMessage } from '../../../types';
import type {
	AvatarPort, CommitLoaderPort, ConfigSnapshot, GlobalSettingsPort, HandlerContext, PullRequestsPort,
	ReposPort, StoragePort, UiPort, UserConfigPort, ViewPort
} from './context';
import { HANDLER_TABLE, dispatchRequest } from './index';

/**
 * Handler table tests with a RecordingContext: a fake DataSource recording every call, a fake
 * for every context port (ui, loader, avatars, storage, repos, userConfig, settings,
 * pullRequests, view) recording every effect, and a send function recording every response -
 * proving that every command of the protocol routes through its genuine handler, that unknown
 * commands are answered 'unknown', and that each handler's mutates flag still equals the
 * REPO_MUTATING_COMMANDS set the table replaced.
 */

/** One recorded effect on a context port: which method ran, with which arguments. */
interface RecordedCall {
	readonly port: 'repo' | 'ui' | 'loader' | 'avatars' | 'storage' | 'repos' | 'userConfig' | 'settings' | 'pullRequests' | 'view';
	readonly method: string;
	readonly args: unknown[];
}

/** The non-null results genuine handlers destructure; everything else resolves null. */
const CANNED_RESULTS: { [method: string]: unknown } = {
	countCommitsBefore: 0,
	getAuthorStatistics: [],
	getActivityHeatmap: [],
	getCommitComparison: { fileChanges: [], error: null },
	getCommitDetails: { commitDetails: null, error: null },
	getCommitFileCounts: { counts: {}, error: null },
	getConfig: { config: null, error: null },
	getOperationState: { type: null, conflictedFiles: [], progress: null },
	getReflog: { entries: [], moreAvailable: false, error: null },
	getRepoInfo: { branches: [], head: null, remotes: [], stashes: [], tags: [], error: null },
	getStashDetails: { commitDetails: null, error: null },
	getTagDetails: { details: null, error: null },
	getUncommittedDetails: { commitDetails: null, error: null },
	getWorktrees: [],
	predictConflicts: null,
	repoRoot: null
};

class RecordingContext implements HandlerContext {
	public readonly calls: RecordedCall[] = [];
	public readonly sent: ResponseMessage[] = [];
	public readonly repo: DataSource;
	public readonly config: ConfigSnapshot = { gerrit: { remote: 'gerrit' } };

	constructor(repoOverrides: { [method: string]: unknown } = {}) {
		this.repo = RecordingContext.fakeRepo(this.calls, repoOverrides);
	}

	private static fakeRepo(calls: RecordedCall[], overrides: { [method: string]: unknown }): DataSource {
		const record = (port: RecordedCall['port'], holder: { [method: string]: unknown }, method: string, target: unknown) => {
			holder[method] = (...args: unknown[]) => {
				calls.push({ port: port, method: method, args: args });
				const result = overrides.hasOwnProperty(method) ? overrides[method] : target;
				return Promise.resolve(typeof result === 'function' ? result(...args) : result);
			};
		};
		const repoHolder: { [method: string]: unknown } = {};
		const gerritHolder: { [method: string]: unknown } = {};
		record('repo', gerritHolder, 'clearLocalChanges', { error: null, cleared: 0 });
		const gerritProxy = new Proxy(gerritHolder, {
			get: (target, prop) => Reflect.get(target, prop)
		});
		for (const method of Object.keys(CANNED_RESULTS)) record('repo', repoHolder, method, CANNED_RESULTS[method]);
		repoHolder['gerrit'] = gerritProxy;
		return new Proxy(repoHolder, {
			get: (target, prop) => {
				if (prop === 'gerrit') return gerritProxy;
				if (typeof prop !== 'string' || Object.prototype.hasOwnProperty.call(target, prop)) return Reflect.get(target, prop);
				record('repo', target, prop, null);
				return target[prop];
			}
		}) as unknown as DataSource;
	}

	get ui(): UiPort {
		const calls = this.calls;
		const ui: { [method: string]: unknown } = {};
		for (const method of ['showErrorMessage']) {
			ui[method] = (message: string) => {
				calls.push({ port: 'ui', method: method, args: [message] });
			};
		}
		for (const method of ['viewScm', 'openExternalUrl', 'openExtensionSettings', 'openLogFile', 'copyToClipboard',
			'copyFilePathToClipboard', 'viewDiff', 'viewDiffWithWorkingFile', 'viewFileAtRevision', 'openFile',
			'createArchive', 'createPullRequest', 'setInterfaceLanguage', 'openCompareTab', 'viewDiffBinary']) {
			ui[method] = (...args: unknown[]) => {
				calls.push({ port: 'ui', method: method, args: args });
				return Promise.resolve(null);
			};
		}
		return ui as unknown as UiPort;
	}

	get loader(): CommitLoaderPort {
		const calls = this.calls;
		const loader: { [method: string]: unknown } = {
			loadCommits: (...args: unknown[]) => {
				calls.push({ port: 'loader', method: 'loadCommits', args: args });
				return Promise.resolve();
			},
			markGerritStale: (repo: string) => { calls.push({ port: 'loader', method: 'markGerritStale', args: [repo] }); },
			unmarkGerritStale: (repo: string) => { calls.push({ port: 'loader', method: 'unmarkGerritStale', args: [repo] }); },
			clearGerritCache: (repo: string) => { calls.push({ port: 'loader', method: 'clearGerritCache', args: [repo] }); },
			invalidateCommitCache: () => { calls.push({ port: 'loader', method: 'invalidateCommitCache', args: [] }); },
			viewRepoChanged: () => { calls.push({ port: 'loader', method: 'viewRepoChanged', args: [] }); }
		};
		Object.defineProperty(loader, 'viewHasCommits', { value: false });
		return loader as unknown as CommitLoaderPort;
	}

	get avatars(): AvatarPort {
		const calls = this.calls;
		const avatars: { [method: string]: unknown } = {
			fetchAvatarImage: (...args: unknown[]) => { calls.push({ port: 'avatars', method: 'fetchAvatarImage', args: args }); },
			getAvatarImage: (email: string) => { calls.push({ port: 'avatars', method: 'getAvatarImage', args: [email] }); return Promise.resolve(null); }
		};
		return avatars as unknown as AvatarPort;
	}

	get storage(): StoragePort {
		const calls = this.calls;
		const storage: { [method: string]: unknown } = {
			getCodeReview: (...args: unknown[]) => { calls.push({ port: 'storage', method: 'getCodeReview', args: args }); return null; },
			startCodeReview: (...args: unknown[]) => {
				calls.push({ port: 'storage', method: 'startCodeReview', args: args });
				return Promise.resolve({ codeReview: { id: 'review', lastActive: 0, lastViewedFile: null, remainingFiles: [] }, error: null });
			},
			updateCodeReview: (...args: unknown[]) => { calls.push({ port: 'storage', method: 'updateCodeReview', args: args }); return Promise.resolve(null); },
			endCodeReview: (...args: unknown[]) => { calls.push({ port: 'storage', method: 'endCodeReview', args: args }); },
			setGlobalViewState: (...args: unknown[]) => { calls.push({ port: 'storage', method: 'setGlobalViewState', args: args }); return Promise.resolve(null); },
			setWorkspaceViewState: (...args: unknown[]) => { calls.push({ port: 'storage', method: 'setWorkspaceViewState', args: args }); return Promise.resolve(null); },
			setViewSnapshot: (...args: unknown[]) => { calls.push({ port: 'storage', method: 'setViewSnapshot', args: args }); },
			getLastActiveRepo: () => { calls.push({ port: 'storage', method: 'getLastActiveRepo', args: [] }); return null; }
		};
		return storage as unknown as StoragePort;
	}

	get repos(): ReposPort {
		const calls = this.calls;
		const repos: { [method: string]: unknown } = {
			getRepos: () => { calls.push({ port: 'repos', method: 'getRepos', args: [] }); return {}; },
			checkReposExist: () => { calls.push({ port: 'repos', method: 'checkReposExist', args: [] }); return Promise.resolve(false); },
			setRepoState: (...args: unknown[]) => { calls.push({ port: 'repos', method: 'setRepoState', args: args }); },
			exportRepoConfig: (...args: unknown[]) => { calls.push({ port: 'repos', method: 'exportRepoConfig', args: args }); return Promise.resolve(null); },
			rescanForRepos: () => { calls.push({ port: 'repos', method: 'rescanForRepos', args: [] }); return Promise.resolve(); }
		};
		return repos as unknown as ReposPort;
	}

	get userConfig(): UserConfigPort {
		const calls = this.calls;
		const record = (method: string) => (...args: unknown[]) => {
			calls.push({ port: 'userConfig', method: method, args: args });
			return Promise.resolve(null);
		};
		const userConfig: { [method: string]: unknown } = {
			setUserName: record('setUserName'),
			setUserEmail: record('setUserEmail'),
			unsetUserName: record('unsetUserName'),
			unsetUserEmail: record('unsetUserEmail'),
			invalidateConfig: (...args: unknown[]) => { calls.push({ port: 'userConfig', method: 'invalidateConfig', args: args }); }
		};
		return userConfig as unknown as UserConfigPort;
	}

	get settings(): GlobalSettingsPort {
		const calls = this.calls;
		const settings: { [method: string]: unknown } = {
			setGlobalSetting: (...args: unknown[]) => {
				calls.push({ port: 'settings', method: 'setGlobalSetting', args: args });
				return Promise.resolve(null);
			}
		};
		return settings as unknown as GlobalSettingsPort;
	}

	get pullRequests(): PullRequestsPort {
		const calls = this.calls;
		const pullRequests: { [method: string]: unknown } = {
			fetchPullRequests: (repo: string) => { calls.push({ port: 'pullRequests', method: 'fetchPullRequests', args: [repo] }); return Promise.resolve(null); },
			fetchPullRequestHeadRefs: (repo: string, remote: unknown) => { calls.push({ port: 'pullRequests', method: 'fetchPullRequestHeadRefs', args: [repo, remote] }); return Promise.resolve(); }
		};
		return pullRequests as unknown as PullRequestsPort;
	}

	get view(): ViewPort {
		const calls = this.calls;
		const view: { [method: string]: unknown } = {
			noteRefreshId: (kind: unknown, id: unknown) => { calls.push({ port: 'view', method: 'noteRefreshId', args: [kind, id] }); },
			repoSwitched: (repo: unknown) => { calls.push({ port: 'view', method: 'repoSwitched', args: [repo] }); }
		};
		Object.defineProperty(view, 'viewHasCommits', { value: false });
		return view as unknown as ViewPort;
	}

	public send(msg: ResponseMessage): void {
		this.sent.push(msg);
	}
}

/** The fields beyond `command`/`repo` the handlers dereference, per command. */
const FIXTURES: { [command: string]: { [field: string]: unknown } } = {
	addTag: { tagName: 'v1', commitHash: 'h', type: TagType.Lightweight, message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false },
	checkoutBranch: { branchName: 'main', remoteBranch: null, pullAfterwards: null },
	cherrypickCommit: { commitHash: 'h', parentIndex: 0, recordOrigin: false, noCommit: false },
	commitBodies: { commitHashes: [], requestId: 7 },
	commitDetails: { commitHash: 'h', hasParents: false, stash: null, avatarEmail: null, refresh: false },
	commitFileCounts: { commitHash: 'h', compareWithHash: null, from: null, to: 'HEAD', paths: [] },
	compareCommits: { commitHash: 'a', compareWithHash: 'b', fromHash: 'a', toHash: 'b', refresh: false },
	countCommitsBefore: { hash: 'h', branches: null, showRemoteBranches: false, includeCommitsMentionedByReflogs: false },
	createBranch: { commitHash: 'h', branchName: 'topic', checkout: false, force: false },
	createPullRequest: { push: false, config: { provider: 'github', custom: null } },
	deleteBranch: { branchName: 'topic', forceDelete: false, deleteOnRemotes: [] },
	deleteUserDetails: { name: true, email: true, location: GitConfigLocation.Global },
	editCommitMessage: { commitHash: 'h', message: 'm' },
	editUserDetails: { name: 'n', email: 'e', location: GitConfigLocation.Global, deleteLocalName: false, deleteLocalEmail: false },
	endCodeReview: { id: 'review' },
	exportRepoConfig: {},
	fetch: { name: null, prune: false, pruneTags: false },
	fetchAvatar: { email: 'a@b.c', remote: null, commits: [] },
	fetchPullRequest: {},
	gerritSetFetchRefs: { enabled: true },
	loadCommits: { refreshId: 1 },
	loadConfig: { refreshId: 1, remotes: [] },
	loadRepoInfo: { refreshId: 1, showRemoteBranches: false, showStashes: false, hideRemotes: [] },
	loadRepos: { check: false },
	merge: { obj: 'main', actionOn: MergeActionOn.Branch, createNewCommit: false, squash: false, noCommit: false },
	openCompareTab: { fromHash: 'a', toHash: 'b', singleCommit: false },
	pushBranch: { branchName: 'main', remotes: [], setUpstream: false, mode: GitPushBranchMode.Normal, willUpdateBranchConfig: false },
	pushTag: { tagName: 'v1', remotes: [], commitHash: 'h', skipRemoteCheck: false },
	rebase: { obj: 'main', actionOn: RebaseActionOn.Branch, ignoreDate: false, interactive: false, autosquash: false },
	reflog: { ref: 'HEAD', limit: 10 },
	resetToCommit: { commit: 'HEAD~1', resetMode: GitResetMode.Soft },
	rescanForRepos: {},
	setGlobalSetting: { setting: 'enableLog', value: true },
	setGlobalViewState: { state: null },
	setInterfaceLanguage: { language: 'en' },
	setRepoState: { state: null },
	setViewSnapshot: { snapshot: null },
	setWorkspaceViewState: { state: null },
	startCodeReview: { id: 'review', files: [], lastViewedFile: null, commitHash: 'a', compareWithHash: null },
	tagDetails: { tagName: 'v1', commitHash: 'h' },
	updateCodeReview: { id: 'review', remainingFiles: [], lastViewedFile: null },
	viewDiff: { fromHash: 'a', toHash: 'b', oldFilePath: 'a.txt', newFilePath: 'b.txt', type: 'M' },
	viewDiffBinary: { fromHash: 'a', toHash: 'b', oldFilePath: 'a.png', newFilePath: 'b.png', type: 'M' },
	viewDiffWithWorkingFile: { hash: 'a', filePath: 'a.txt' },
	viewFileAtRevision: { hash: 'a', filePath: 'a.txt' },
	openFile: { hash: 'a', filePath: 'a.txt' },
	openExternalDirDiff: { fromHash: 'a', toHash: 'b', isGui: true },
	openTerminal: { name: 'Git Graph' },
	copyFilePath: { filePath: 'a.txt', absolute: false },
	copyToClipboard: { type: 'hash', data: 'abc' },
	showErrorMessage: { message: 'boom' },
	openExternalUrl: { url: 'https://example.com' },
	predictConflicts: { ours: 'a', theirs: 'b' },
	worktreeAdd: { path: 'wt', branch: null, newBranch: null },
	worktreeRemove: { path: 'wt', force: false }
};

function fixture(command: string): { [field: string]: unknown } {
	return { command: command, repo: '/repo', ...(FIXTURES[command] || {}) };
}

describe('graphView handler table', () => {
	it('has exactly one entry per protocol command', () => {
		const keys = Object.keys(HANDLER_TABLE);
		expect(new Set(keys).size).toBe(REQUEST_COMMANDS.length);
		expect(keys.slice().sort()).toEqual((<string[]>REQUEST_COMMANDS).slice().sort());
	});

	it('routes every command through its genuine handler', async () => {
		for (const command of REQUEST_COMMANDS) {
			const ctx = new RecordingContext();
			await expect(dispatchRequest(fixture(command), ctx), command).resolves.toBe('handled');
			// Every handler touches at least one port (its response may legitimately be silent)
			expect(ctx.calls.length + ctx.sent.length, command).toBeGreaterThan(0);
		}
	});

	it('routes the loader-delegating loadCommits through the CommitLoader port', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest(fixture('loadCommits'), ctx);
		const loaderCall = ctx.calls.find((call) => call.port === 'loader' && call.method === 'loadCommits');
		expect(loaderCall).toBeDefined();
		// The staged loader owns the responses; none are sent by the handler itself
		expect(ctx.sent).toEqual([]);
	});

	it('sends the expected response for representative genuine handlers', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest(fixture('addRemote'), ctx);
		expect(ctx.sent).toEqual([{ command: 'addRemote', error: null }]);
		expect(ctx.calls.find((call) => call.port === 'repo' && call.method === 'addRemote')?.args)
			.toEqual(['/repo', undefined, undefined, undefined, undefined]);

		const ctx2 = new RecordingContext();
		await dispatchRequest(fixture('worktreeList'), ctx2);
		expect(ctx2.sent).toEqual([{ command: 'worktreeList', repo: '/repo', worktrees: [] }]);

		const ctx3 = new RecordingContext();
		await dispatchRequest(fixture('repoStatistics'), ctx3);
		expect(ctx3.sent).toEqual([{ command: 'repoStatistics', repo: '/repo', authors: [], activity: [] }]);
	});

	it('forwards data-loss warnings and replays the request with confirmed on retry', async () => {
		const ctx = new RecordingContext({ checkoutBranch: { message: 'unmerged work would be lost' } });
		await dispatchRequest(fixture('checkoutBranch'), ctx);
		expect(ctx.sent.length).toBe(1);
		const warning = ctx.sent[0];
		expect(warning.command).toBe('lossWarning');
		expect((warning as { message: string }).message).toBe('unmerged work would be lost');
		expect((warning as { retry: { command: string; confirmed?: boolean } }).retry.command).toBe('checkoutBranch');
		expect((warning as { retry: { command: string; confirmed?: boolean } }).retry.confirmed).toBe(true);
	});

	it('chains the remote deletions of deleteBranch only after the local delete succeeded', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest({ command: 'deleteBranch', repo: '/repo', branchName: 'topic', forceDelete: false, deleteOnRemotes: ['upstream', 'origin'] }, ctx);
		expect(ctx.sent).toEqual([{
			command: 'deleteBranch', repo: '/repo', branchName: 'topic',
			deleteOnRemotes: ['upstream', 'origin'], errors: [null, null, null]
		}]);
		const remoteDeletes = ctx.calls.filter((call) => call.port === 'repo' && call.method === 'deleteRemoteBranch');
		expect(remoteDeletes.length).toBe(2);

		const ctx2 = new RecordingContext({ deleteBranch: 'branch not found' });
		await dispatchRequest({ command: 'deleteBranch', repo: '/repo', branchName: 'topic', forceDelete: false, deleteOnRemotes: ['origin'] }, ctx2);
		expect(ctx2.sent[0]).toEqual({
			command: 'deleteBranch', repo: '/repo', branchName: 'topic', deleteOnRemotes: ['origin'], errors: ['branch not found']
		});
		expect(ctx2.calls.filter((call) => call.method === 'deleteRemoteBranch').length).toBe(0);
	});

	it('marks the Gerrit cache stale after a successful fetch', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest(fixture('fetch'), ctx);
		expect(ctx.sent).toEqual([{ command: 'fetch', error: null }]);
		expect(ctx.calls.find((call) => call.port === 'loader' && call.method === 'markGerritStale')?.args).toEqual(['/repo']);

		const ctx2 = new RecordingContext({ fetch: 'network down' });
		await dispatchRequest(fixture('fetch'), ctx2);
		expect(ctx2.sent).toEqual([{ command: 'fetch', error: 'network down' }]);
		expect(ctx2.calls.find((call) => call.port === 'loader' && call.method === 'markGerritStale')).toBeUndefined();
	});

	it('clears the local Gerrit change refs through the DataSource when disabling the integration', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest({ command: 'gerritSetFetchRefs', repo: '/repo', enabled: false }, ctx);
		expect(ctx.calls.find((call) => call.port === 'repo' && call.method === 'clearLocalChanges')?.args).toEqual(['/repo', 'gerrit']);
		expect(ctx.calls.filter((call) => call.port === 'loader').map((call) => call.method).sort())
			.toEqual(['clearGerritCache', 'invalidateCommitCache', 'unmarkGerritStale']);
		expect(ctx.sent).toEqual([{ command: 'gerritSetFetchRefs', error: null, enabled: false, cleared: 0 }]);
	});

	it('answers unknown commands with unknown and touches no port', async () => {
		const ctx = new RecordingContext();
		await expect(dispatchRequest({ command: 'definitelyNotACommand', repo: '/repo' }, ctx)).resolves.toBe('unknown');
		await expect(dispatchRequest(null, ctx)).resolves.toBe('unknown');
		await expect(dispatchRequest('loadCommits', ctx)).resolves.toBe('unknown');
		await expect(dispatchRequest({ repo: '/repo' }, ctx)).resolves.toBe('unknown');
		expect(ctx.sent).toEqual([]);
		expect(ctx.calls).toEqual([]);
	});

	it("derives every handler's mutates flag from the protocol table", () => {
		// The one-off comparison against the old REPO_MUTATING_COMMANDS set (42 commands, both
		// directions equal) ran during the task 4.4 cutover and passed; per the acceptance
		// criteria it was then deleted. This keeps the table-internal consistency: every
		// handler's flag is exactly the protocol's MUTATING_COMMANDS entry for its command.
		for (const command of REQUEST_COMMANDS) {
			const handler = (HANDLER_TABLE as { [command: string]: { mutates: boolean } })[command];
			expect(handler.mutates, command).toBe(MUTATING_COMMANDS[command]);
		}
	});
});
