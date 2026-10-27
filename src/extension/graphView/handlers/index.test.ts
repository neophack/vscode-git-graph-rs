import { describe, expect, it } from 'vitest';
import { MUTATING_COMMANDS, REQUEST_COMMANDS } from '../../../shared/protocol/graphView';
import { GitConfigLocation, GitPushBranchMode, GitResetMode } from '../../../shared/model/git';
import { MergeActionOn, RebaseActionOn } from '../../../shared/protocol/operations';
import { SquashMessageFormat, TagType } from '../../../shared/model/webview';
import type { ResponseMessage } from '../../../shared/protocol/messages';
import type {
	AvatarPort, CommitLoaderPort, ConfigSnapshot, GerritWritesPort, GlobalSettingsPort, HandlerContext, PullRequestsPort,
	ReposPort, StoragePort, UiPort, UserConfigPort, ViewPort
} from './context';
import type { GitRunnerPort } from '../gitRunner';
import type { ProductionGitRepository } from '../../git/gitRepository';
import { HANDLER_TABLE, dispatchRequest } from './index';

/**
 * Handler table tests with a RecordingContext: a fake GitRepository facade (reads on `.read`,
 * writes recorded through the GitWriter's `run` with the pure op they carry), a fake runner, and
 * a fake for every context port (git, repoConfig, gerrit, ui, loader, avatars, storage, repos,
 * userConfig, settings, pullRequests, view) recording every effect, and a send function recording
 * every response - proving that every command of the protocol routes through its genuine handler,
 * that unknown commands are answered 'unknown', and that each handler's mutates flag still equals
 * the protocol's MUTATING_COMMANDS entry.
 */

/** One recorded effect on a context port: which method ran, with which arguments. */
interface RecordedCall {
	readonly port: 'repo' | 'git' | 'repoConfig' | 'gerrit' | 'ui' | 'loader' | 'avatars' | 'storage' | 'repos' | 'userConfig' | 'settings' | 'pullRequests' | 'view';
	readonly method: string;
	readonly args: unknown[];
}

/** The read results genuine handlers destructure; a write op's run resolves NULL (success). */
const CANNED_READS: { [method: string]: unknown } = {
	countCommitsBefore: 0,
	getAuthorStatistics: [],
	getActivityHeatmap: [],
	compareCommits: [],
	getCommitDetails: { hash: 'h', parents: [], author: 'A', authorEmail: 'a@x', authorDate: 1, committer: 'A', committerEmail: 'a@x', committerDate: 1, signature: null, fileChanges: [] },
	getLineCounts: {},
	getReflog: { entries: [], moreAvailable: false },
	getRepoInfo: { branches: [], head: null, remotes: [], stashes: [], tags: [], error: null },
	getStashDetails: { hash: 'h', parents: [], author: 'A', authorEmail: 'a@x', authorDate: 1, committer: 'A', committerEmail: 'a@x', committerDate: 1, signature: null, fileChanges: [] },
	getTagDetails: { hash: 'h', name: 'v1', tagger: 'A', message: '', signed: false },
	getUncommittedDetails: { hash: '*', parents: [], author: 'A', authorEmail: 'a@x', authorDate: 1, committer: 'A', committerEmail: 'a@x', committerDate: 1, signature: null, fileChanges: [] },
	getWorktrees: [],
	predictConflicts: null,
	repoRoot: '/repo',
	getRemotes: [],
	currentBranchName: null,
	getAuthors: [],
	getConfigList: {},
	getConfig: { diffTool: null, guiDiffTool: null, pushDefault: null, remotes: [] },
	getCommitBodies: {},
	getCommitSummaries: {},
	getStashes: [],
	getRefs: { head: null, heads: [], tags: [], remotes: [] }
};

class RecordingContext implements HandlerContext {
	public readonly calls: RecordedCall[] = [];
	public readonly sent: ResponseMessage[] = [];
	public readonly repo: ProductionGitRepository;
	public readonly git: GitRunnerPort;
	public readonly repoConfig: { load: (repo: string, remotes: ReadonlyArray<string>) => Promise<{ config: null; error: null }>; invalidate: (repo: string | null) => void };
	public readonly gerrit: GerritWritesPort;
	public readonly config: ConfigSnapshot = {
		gerrit: { remote: 'gerrit' },
		showRemoteHeads: false,
		squashPullMessageFormat: SquashMessageFormat.Default,
		squashMergeMessageFormat: SquashMessageFormat.Default
	};
	public readonly t = (key: string, ...params: Array<string | number>): string => JSON.stringify([key, ...params]);

	constructor(repoOverrides: { [method: string]: unknown } = {}) {
		const calls = this.calls;
		const record = (port: RecordedCall['port'], holder: { [method: string]: unknown }, method: string, target: unknown) => {
			holder[method] = (...args: unknown[]) => {
				calls.push({ port: port, method: method, args: args });
				const result = repoOverrides.hasOwnProperty(method) ? repoOverrides[method] : target;
				return Promise.resolve(typeof result === 'function' ? result(...args) : result);
			};
		};

		/* The repository facade: reads on `.read`, writes through the GitWriter's `run`. */
		const readHolder: { [method: string]: unknown } = {};
		for (const method of Object.keys(CANNED_READS)) record('repo', readHolder, method, CANNED_READS[method]);
		const read = new Proxy(readHolder, {
			get: (target, prop) => {
				if (typeof prop !== 'string' || Object.prototype.hasOwnProperty.call(target, prop)) return Reflect.get(target, prop);
				record('repo', target, prop, null);
				return target[prop];
			}
		});
		const writeHolder: { [method: string]: unknown } = {};
		writeHolder['run'] = (repo: string, op: { readonly steps: ReadonlyArray<{ readonly argv: ReadonlyArray<string> }> }) => {
			calls.push({ port: 'repo', method: 'write.run', args: [repo, op] });
			const result = repoOverrides.hasOwnProperty('write') ? repoOverrides['write'] : null;
			return Promise.resolve(typeof result === 'function' ? result(repo, op) : result);
		};
		// The arg-injection gate the handlers reach the write layer through (A3): the fake
		// accepts every value unless the test scripts a rejection message.
		writeHolder['checkArgs'] = (...checks: unknown[]) => {
			calls.push({ port: 'repo', method: 'write.checkArgs', args: checks });
			const result = repoOverrides.hasOwnProperty('checkArgs') ? repoOverrides['checkArgs'] : null;
			return result;
		};
		writeHolder['policies'] = { signCommits: false, signTags: false };
		const repoHolder: { [method: string]: unknown } = {
			read: read,
			write: writeHolder,
			getOperationState: () => {
				calls.push({ port: 'repo', method: 'getOperationState', args: [] });
				return Promise.resolve({ type: null, conflictedFiles: [], progress: null });
			}
		};
		this.repo = new Proxy(repoHolder, {
			get: (target, prop) => {
				if (typeof prop !== 'string' || Object.prototype.hasOwnProperty.call(target, prop)) return Reflect.get(target, prop);
				record('repo', target, prop, null);
				return target[prop];
			}
		}) as unknown as ProductionGitRepository;

		/* The raw runner: the loss-guard probes and the few non-op flows read empty output. */
		const gitHolder: { [method: string]: unknown } = {};
		gitHolder['gitOutput'] = (args: unknown, repo: unknown, resolveValue: (stdout: string) => unknown) => {
			calls.push({ port: 'git', method: 'gitOutput', args: [args, repo] });
			return Promise.resolve((resolveValue as (stdout: string) => unknown)(''));
		};
		gitHolder['runGitCommand'] = (args: unknown, repo: unknown) => {
			calls.push({ port: 'git', method: 'runGitCommand', args: [args, repo] });
			return Promise.resolve(null);
		};
		gitHolder['runGitCommandWithInput'] = (args: unknown, repo: unknown, input: unknown) => {
			calls.push({ port: 'git', method: 'runGitCommandWithInput', args: [args, repo, input] });
			return Promise.resolve(null);
		};
		gitHolder['collect'] = (args: unknown, repo: unknown) => {
			calls.push({ port: 'git', method: 'collect', args: [args, repo] });
			return Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: '' });
		};
		gitHolder['hasGit'] = () => {
			calls.push({ port: 'git', method: 'hasGit', args: [] });
			return true;
		};
		gitHolder['gitPath'] = () => null;
		gitHolder['parseGerritMetas'] = null;
		gitHolder['listChangeRefs'] = null;
		this.git = gitHolder as unknown as GitRunnerPort;

		const repoConfigHolder: { [method: string]: unknown } = {};
		repoConfigHolder['load'] = (repo: unknown, remotes: unknown) => {
			calls.push({ port: 'repoConfig', method: 'load', args: [repo, remotes] });
			return Promise.resolve({ config: null, error: null });
		};
		repoConfigHolder['invalidate'] = (repo: unknown) => { calls.push({ port: 'repoConfig', method: 'invalidate', args: [repo] }); };
		this.repoConfig = repoConfigHolder as unknown as RecordingContext['repoConfig'];

		const gerritHolder: { [method: string]: unknown } = {};
		gerritHolder['clearLocalChanges'] = (repo: unknown, remote: unknown) => {
			calls.push({ port: 'gerrit', method: 'clearLocalChanges', args: [repo, remote] });
			return Promise.resolve({ error: null, cleared: 0 });
		};
		this.gerrit = gerritHolder as unknown as GerritWritesPort;
	}

	get ui(): UiPort {
		const calls = this.calls;
		const ui: { [method: string]: unknown } = {};
		for (const method of ['showErrorMessage', 'quoteForTerminal']) {
			ui[method] = (message: string) => {
				calls.push({ port: 'ui', method: method, args: [message] });
				return method === 'quoteForTerminal' ? message : undefined;
			};
		}
		for (const method of ['viewScm', 'openExternalUrl', 'openExtensionSettings', 'openLogFile', 'copyToClipboard',
			'copyFilePathToClipboard', 'viewDiff', 'viewDiffWithWorkingFile', 'viewFileAtRevision', 'openFile',
			'createArchive', 'createPullRequest', 'setInterfaceLanguage', 'openGitTerminal', 'openExternalDirDiff']) {
			ui[method] = (...args: unknown[]) => {
				calls.push({ port: 'ui', method: method, args: args });
				return Promise.resolve(null);
			};
		}
		for (const method of ['openCompareTab', 'viewDiffBinary']) {
			ui[method] = (...args: unknown[]) => {
				calls.push({ port: 'ui', method: method, args: args });
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
			loadView: (...args: unknown[]) => {
				calls.push({ port: 'loader', method: 'loadView', args: args });
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
			repoSwitched: (repo: unknown) => { calls.push({ port: 'view', method: 'repoSwitched', args: [repo] }); },
			viewReady: () => { calls.push({ port: 'view', method: 'viewReady', args: [] }); }
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
	addRemote: { name: 'newRemote', url: 'https://example.com/repo', pushUrl: null, fetch: true },
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
	loadView: { refreshId: 1, hard: false, branches: null, authors: null, maxCommits: 1, showTags: true, showRemoteBranches: false, includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date', remotes: [], hideRemotes: [], stashes: [] },
	loadRepos: { check: false },
	merge: { obj: 'main', actionOn: MergeActionOn.Branch, createNewCommit: false, squash: false, noCommit: false },
	openCompareTab: { fromHash: 'a', toHash: 'b', singleCommit: false },
	pushBranch: { branchName: 'main', remotes: [], setUpstream: false, mode: GitPushBranchMode.Normal, willUpdateBranchConfig: false },
	pushTag: { tagName: 'v1', remotes: [], commitHash: 'h', skipRemoteCheck: false },
	ready: {},
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

	it('routes loadView through the loader and ready through the view port (the open-path handshake)', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest(fixture('loadView'), ctx);
		expect(ctx.calls.find((call) => call.port === 'loader' && call.method === 'loadView')).toBeDefined();

		const readyCtx = new RecordingContext();
		await dispatchRequest({ command: 'ready' }, readyCtx);
		expect(readyCtx.calls.find((call) => call.port === 'view' && call.method === 'viewReady')).toBeDefined();
		expect(readyCtx.sent).toEqual([]); // the push, not a direct reply, is the answer
	});

	it('sends the expected response for representative genuine handlers', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest(fixture('addRemote'), ctx);
		expect(ctx.sent).toEqual([{ command: 'addRemote', error: null }]);
		// The write reached the GitWriter as the pure `remote add` op (then fetched the new remote)
		const runs = ctx.calls.filter((call) => call.port === 'repo' && call.method === 'write.run');
		const argvs = runs.map((call) => ((call.args[1] as { steps: ReadonlyArray<{ argv: ReadonlyArray<string> }> }).steps[0].argv.join(' ')));
		expect(argvs).toEqual(['remote add newRemote https://example.com/repo', 'fetch newRemote']);

		const ctx2 = new RecordingContext();
		await dispatchRequest(fixture('worktreeList'), ctx2);
		expect(ctx2.sent).toEqual([{ command: 'worktreeList', repo: '/repo', worktrees: [] }]);

		const ctx3 = new RecordingContext();
		await dispatchRequest(fixture('repoStatistics'), ctx3);
		expect(ctx3.sent).toEqual([{ command: 'repoStatistics', repo: '/repo', authors: [], activity: [] }]);
	});

	it('forwards data-loss warnings and replays the request with confirmed on retry', async () => {
		// The warning comes from the flow's detached-commits guard (the runner probe counts commits)
		const ctx = new RecordingContext({
			gitOutput: () => '3' // the stash list, then the rev-list --count: 3 unreachable commits
		});
		await dispatchRequest(fixture('checkoutBranch'), ctx);
		expect(ctx.sent.length).toBe(1);
		const warning = ctx.sent[0];
		expect(warning.command).toBe('lossWarning');
		expect((warning as { message: string }).message).toContain('leavingCommitsBehind');
		expect((warning as { retry: { command: string; confirmed?: boolean } }).retry.command).toBe('checkoutBranch');
		expect((warning as { retry: { command: string; confirmed?: boolean } }).retry.confirmed).toBe(true);
		// Nothing ran: the guard fired before any write
		expect(ctx.calls.filter((call) => call.method === 'write.run')).toEqual([]);
	});

	it('chains the remote deletions of deleteBranch only after the local delete succeeded', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest({ command: 'deleteBranch', repo: '/repo', branchName: 'topic', forceDelete: false, deleteOnRemotes: ['upstream', 'origin'] }, ctx);
		expect(ctx.sent).toEqual([{
			command: 'deleteBranch', repo: '/repo', branchName: 'topic',
			deleteOnRemotes: ['upstream', 'origin'], errors: [null, null, null]
		}]);
		const argvs = ctx.calls.filter((call) => call.method === 'write.run')
			.map((call) => ((call.args[1] as { steps: ReadonlyArray<{ argv: ReadonlyArray<string> }> }).steps[0].argv.join(' ')));
		expect(argvs).toEqual(['branch -d topic', 'push upstream --delete topic', 'push origin --delete topic']);

		const ctx2 = new RecordingContext({ write: 'branch not found' });
		await dispatchRequest({ command: 'deleteBranch', repo: '/repo', branchName: 'topic', forceDelete: false, deleteOnRemotes: ['origin'] }, ctx2);
		expect(ctx2.sent[0]).toEqual({
			command: 'deleteBranch', repo: '/repo', branchName: 'topic', deleteOnRemotes: ['origin'], errors: ['branch not found']
		});
		expect(ctx2.calls.filter((call) => call.method === 'write.run').length).toBe(1);
	});

	it('marks the Gerrit cache stale after a successful fetch', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest(fixture('fetch'), ctx);
		expect(ctx.sent).toEqual([{ command: 'fetch', error: null }]);
		expect(ctx.calls.find((call) => call.port === 'loader' && call.method === 'markGerritStale')?.args).toEqual(['/repo']);

		const ctx2 = new RecordingContext({ write: 'network down' });
		await dispatchRequest(fixture('fetch'), ctx2);
		expect(ctx2.sent).toEqual([{ command: 'fetch', error: 'network down' }]);
		expect(ctx2.calls.find((call) => call.port === 'loader' && call.method === 'markGerritStale')).toBeUndefined();
	});

	it('validates the external dir-diff hashes through the write layer (A3), not in the handler', async () => {
		// The write layer's gate rejects: the response carries its message and the ui port is
		// never reached (no terminal, no diff tool launch).
		const ctx = new RecordingContext({ checkArgs: 'the refusal message' });
		await dispatchRequest(fixture('openExternalDirDiff'), ctx);
		expect(ctx.sent).toEqual([{ command: 'openExternalDirDiff', error: 'the refusal message' }]);
		expect(ctx.calls.find((call) => call.method === 'write.checkArgs')).toBeDefined();
		expect(ctx.calls.find((call) => call.port === 'ui' && call.method === 'openExternalDirDiff')).toBeUndefined();

		// The gate accepts: the request passes through to the ui port.
		const happy = new RecordingContext();
		await dispatchRequest(fixture('openExternalDirDiff'), happy);
		expect(happy.sent).toEqual([{ command: 'openExternalDirDiff', error: null }]);
		expect(happy.calls.find((call) => call.port === 'ui' && call.method === 'openExternalDirDiff')).toBeDefined();
	});

	it('clears the local Gerrit change refs through the gerrit port when disabling the integration', async () => {
		const ctx = new RecordingContext();
		await dispatchRequest({ command: 'gerritSetFetchRefs', repo: '/repo', enabled: false }, ctx);
		expect(ctx.calls.find((call) => call.port === 'gerrit' && call.method === 'clearLocalChanges')?.args).toEqual(['/repo', 'gerrit']);
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
