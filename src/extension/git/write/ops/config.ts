/**
 * Git configuration write operations, ported from `DataSource`'s
 * "Git Action Methods - Config" (`src/dataSource.ts`).
 */

import { GitConfigLocation } from '../../../../types/git';
import { WriteOp, single } from './op';

/**
 * The configuration keys the Settings widget can write. Ported from the legacy `GitConfigKey`
 * (`src/dataSource.ts`): redefined here because the legacy enum lives in a module that imports
 * vscode, which this tree must not depend on. A key is one of these fixed strings by
 * construction, so no argument-injection check is needed for it.
 */
export const enum GitConfigKey {
	DiffGuiTool = 'diff.guitool',
	DiffTool = 'diff.tool',
	RemotePushDefault = 'remote.pushdefault',
	UseConfigOnly = 'user.useConfigOnly',
	UserEmail = 'user.email',
	UserName = 'user.name'
}

export interface SetConfigValueParams {
	readonly key: GitConfigKey;
	readonly value: string;
	readonly location: GitConfigLocation;
}

export function setConfigValue(params: SetConfigValueParams): WriteOp {
	return {
		steps: single(['config', '--' + params.location, params.key, params.value]),
		effects: ['config']
	};
}

export interface UnsetConfigValueParams {
	readonly key: GitConfigKey;
	readonly location: GitConfigLocation;
}

export function unsetConfigValue(params: UnsetConfigValueParams): WriteOp {
	return {
		steps: single(['config', '--' + params.location, '--unset-all', params.key]),
		effects: ['config']
	};
}

export interface AddRemoteTagsRefspecParams {
	readonly remote: string;
}

/**
 * The write half of the legacy `trackRemoteTags`: add the tag-tracking fetch refspec of a remote.
 * (The legacy method first reads `--get-all remote.<name>.fetch` and adds the refspec only when it
 * is not already there — that read is the caller's preflight.)
 */
export function addRemoteTagsRefspec(params: AddRemoteTagsRefspecParams): WriteOp {
	return {
		steps: single(['config', '--add', 'remote.' + params.remote + '.fetch', '+refs/tags/*:refs/remotes/' + params.remote + '/tags/*']),
		effects: ['config'],
		checks: [['remote', params.remote, 'ref']]
	};
}
