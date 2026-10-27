/**
 * Git configuration write operations: pure `WriteOp` builders for the Settings widget.
 */

import { GitConfigLocation } from '../../../../shared/model/git';
import { WriteOp, single } from './op';

/**
 * The configuration keys the Settings widget can write. Defined locally (nothing under
 * `extension/git/**` may import vscode); a key is one of these fixed strings by
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
 * The write half of remote tag tracking: add the tag-tracking fetch refspec of a remote.
 * (The deduplication read — `--get-all remote.<name>.fetch`, adding the refspec only when it
 * is not already there — is the caller's preflight.)
 */
export function addRemoteTagsRefspec(params: AddRemoteTagsRefspecParams): WriteOp {
	return {
		steps: single(['config', '--add', 'remote.' + params.remote + '.fetch', '+refs/tags/*:refs/remotes/' + params.remote + '/tags/*']),
		effects: ['config'],
		checks: [['remote', params.remote, 'ref']]
	};
}
