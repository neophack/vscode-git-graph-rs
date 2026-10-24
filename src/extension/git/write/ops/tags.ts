/**
 * Tag write operations, ported from `DataSource`'s "Git Action Methods - Tags"
 * (`src/dataSource.ts`).
 */

import { TagType } from '../../../../types/webview';
import { ArgCheck, WriteOp, WriteStep } from './op';

export interface AddTagParams {
	readonly tagName: string;
	readonly commitHash: string;
	readonly type: TagType;
	readonly message: string;
	readonly force: boolean;
	/** The `repository.sign.tags` policy (`-s` instead of `-a`). */
	readonly signTags: boolean;
}

export function addTag(params: AddTagParams): WriteOp {
	const argv = ['tag'];
	if (params.force) argv.push('-f');
	if (params.type === TagType.Lightweight) {
		argv.push(params.tagName);
	} else {
		argv.push(params.signTags ? '-s' : '-a', params.tagName, '-m', params.message);
	}
	argv.push(params.commitHash);
	return {
		steps: [{ argv }],
		effects: ['refs'],
		checks: [['tagName', params.tagName, 'ref'], ['commitHash', params.commitHash, 'hash']]
	};
}

export interface DeleteTagParams {
	readonly tagName: string;
	/** The remote to delete the tag on, or null to only delete it locally. */
	readonly deleteOnRemote: string | null;
	/** Every other remote of the repository (a preflight read), whose remote-tracking tag refs
	 * the legacy deletion also cleans up. */
	readonly otherRemotes: ReadonlyArray<string>;
}

export function deleteTag(params: DeleteTagParams): WriteOp {
	const steps: WriteStep[] = [];
	if (params.deleteOnRemote !== null) {
		// A push failing with "remote ref does not exist" is tolerated (the tag is already gone
		// there); any other failure aborts, which the `tolerance` marker expresses.
		steps.push({
			argv: ['push', params.deleteOnRemote, '--delete', params.tagName],
			tolerance: 'remote ref does not exist'
		});
		steps.push({
			argv: ['update-ref', '-d', 'refs/remotes/' + params.deleteOnRemote + '/tags/' + params.tagName],
			bestEffort: true
		});
	}
	steps.push({ argv: ['tag', '-d', params.tagName], tolerance: 'not found' });
	for (const remote of params.otherRemotes) {
		steps.push({
			argv: ['update-ref', '-d', 'refs/remotes/' + remote + '/tags/' + params.tagName],
			bestEffort: true
		});
	}
	return {
		steps,
		effects: ['refs'],
		network: params.deleteOnRemote !== null,
		checks: [['tagName', params.tagName, 'ref'], ['deleteOnRemote', params.deleteOnRemote, 'ref']]
	};
}

export interface PushTagParams {
	readonly tagName: string;
	readonly remotes: ReadonlyArray<string>;
	readonly commitHash: string;
}

/**
 * Push a tag to one or more remotes. The steps stop at the first failure, like the legacy loop.
 * The legacy `pushTag` preflight — checking the commit is on each remote before pushing
 * (`getRemotesContainingCommit`) — is a read the caller performs; the pure op is only the pushes.
 */
export function pushTag(params: PushTagParams): WriteOp {
	// The legacy code validated every remote itself and answered one fixed message for a bad one;
	// here each remote is an ordinary ref check (the arg-safety message names it instead).
	const checks: ReadonlyArray<ArgCheck> = [
		['tagName', params.tagName, 'ref'],
		['commitHash', params.commitHash, 'hash'],
		...params.remotes.map((remote) => ['remotes', remote, 'ref'] as ArgCheck)
	];
	return {
		steps: params.remotes.map((remote) => ({ argv: ['push', remote, params.tagName] })),
		effects: [],
		network: true,
		checks,
		refusal: params.remotes.length === 0
			? 'No remote(s) were specified to push the tag ' + params.tagName + ' to.'
			: undefined
	};
}
