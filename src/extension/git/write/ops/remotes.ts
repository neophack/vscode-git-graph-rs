/**
 * Remote and remote-sync write operations, ported from `DataSource`'s
 * "Git Action Methods - Remotes" and "Git Action Methods - Remote Sync" (`src/dataSource.ts`).
 */

import { GitPushBranchMode } from '../../../../types/git';
import { ArgCheck, WriteOp, WriteStep, single } from './op';
import { pushBranchArgv } from './branches';

export interface AddRemoteParams {
	readonly name: string;
	readonly url: string;
	readonly pushUrl: string | null;
	/** Fetch the remote right after adding it (the legacy `addRemote` ran `fetch <name>`). */
	readonly fetchAfter: boolean;
}

export function addRemote(params: AddRemoteParams): WriteOp {
	const steps: WriteStep[] = [{ argv: ['remote', 'add', params.name, params.url] }];
	if (params.pushUrl !== null) steps.push({ argv: ['remote', 'set-url', params.name, '--push', params.pushUrl] });
	if (params.fetchAfter) steps.push({ argv: ['fetch', params.name] });
	return {
		steps,
		effects: ['config', 'refs'],
		network: params.fetchAfter,
		checks: [['name', params.name, 'ref'], ['url', params.url, 'url'], ['pushUrl', params.pushUrl, 'url']]
	};
}

export interface DeleteRemoteParams {
	readonly name: string;
}

export function deleteRemote(params: DeleteRemoteParams): WriteOp {
	return {
		steps: single(['remote', 'remove', params.name]),
		effects: ['config', 'refs'],
		checks: [['name', params.name, 'ref']]
	};
}

export interface EditRemoteParams {
	readonly nameOld: string;
	readonly nameNew: string;
	readonly urlOld: string | null;
	readonly urlNew: string | null;
	readonly pushUrlOld: string | null;
	readonly pushUrlNew: string | null;
}

export function editRemote(params: EditRemoteParams): WriteOp {
	const steps: WriteStep[] = [];
	if (params.nameOld !== params.nameNew) {
		steps.push({ argv: ['remote', 'rename', params.nameOld, params.nameNew] });
	}
	if (params.urlOld !== params.urlNew) {
		steps.push({ argv: setUrlArgv(params.nameNew, params.urlOld, params.urlNew, false) });
	}
	if (params.pushUrlOld !== params.pushUrlNew) {
		steps.push({ argv: setUrlArgv(params.nameNew, params.pushUrlOld, params.pushUrlNew, true) });
	}
	return {
		steps,
		effects: ['config', 'refs'],
		checks: [
			['nameOld', params.nameOld, 'ref'], ['nameNew', params.nameNew, 'ref'],
			['urlOld', params.urlOld, 'url'], ['urlNew', params.urlNew, 'url'],
			['pushUrlOld', params.pushUrlOld, 'url'], ['pushUrlNew', params.pushUrlNew, 'url']
		]
	};
}

/**
 * The legacy `remote set-url` argument order, kept verbatim: the new URL (or `--delete`/`--add`
 * with the respective one) comes first and the old URL last — `set-url <name> <new> <old>`.
 */
function setUrlArgv(name: string, oldUrl: string | null, newUrl: string | null, push: boolean): string[] {
	const argv = push ? ['remote', 'set-url', '--push', name] : ['remote', 'set-url', name];
	if (newUrl === null) argv.push('--delete', oldUrl as string);
	else if (oldUrl === null) argv.push('--add', newUrl);
	else argv.push(newUrl, oldUrl);
	return argv;
}

export interface PruneRemoteParams {
	readonly name: string;
}

export function pruneRemote(params: PruneRemoteParams): WriteOp {
	return {
		steps: single(['remote', 'prune', params.name]),
		effects: ['refs'],
		network: true,
		checks: [['name', params.name, 'ref']]
	};
}

export interface FetchParams {
	/** The remote to fetch, or null to fetch all remotes. */
	readonly remote: string | null;
	readonly prune: boolean;
	readonly pruneTags: boolean;
}

export function fetch(params: FetchParams): WriteOp {
	if (params.pruneTags && !params.prune) {
		return { steps: [], effects: [], refusal: 'pruneTagsRequiresPrune' };
	}
	const argv = ['fetch', params.remote === null ? '--all' : params.remote];
	if (params.prune) argv.push('--prune');
	if (params.pruneTags) argv.push('--prune-tags');
	return {
		steps: single(argv),
		effects: ['refs', 'commits'],
		network: true,
		requires: params.pruneTags ? 'FetchAndPruneTags' : undefined,
		checks: [['remote', params.remote, 'ref']]
	};
}

export interface PushBranchParams {
	readonly branchName: string;
	readonly remote: string;
	readonly setUpstream: boolean;
	readonly mode: GitPushBranchMode;
}

export function pushBranch(params: PushBranchParams): WriteOp {
	return {
		steps: single(pushBranchArgv(params.branchName, params.remote, params.setUpstream, params.mode)),
		effects: [],
		network: true,
		checks: [['branchName', params.branchName, 'ref'], ['remote', params.remote, 'ref']]
	};
}

export interface PushBranchToMultipleRemotesParams {
	readonly branchName: string;
	readonly remotes: ReadonlyArray<string>;
	readonly setUpstream: boolean;
	readonly mode: GitPushBranchMode;
}

export function pushBranchToMultipleRemotes(params: PushBranchToMultipleRemotesParams): WriteOp {
	const checks: ReadonlyArray<ArgCheck> = [
		['branchName', params.branchName, 'ref'],
		...params.remotes.map((remote) => ['remotes', remote, 'ref'] as ArgCheck)
	];
	return {
		// One push per remote, stopping at the first failure (the legacy loop breaks on it).
		steps: params.remotes.map((remote) => ({ argv: pushBranchArgv(params.branchName, remote, params.setUpstream, params.mode) })),
		effects: [],
		network: true,
		checks,
		refusal: params.remotes.length === 0
			? 'No remote(s) were specified to push the branch ' + params.branchName + ' to.'
			: undefined
	};
}
