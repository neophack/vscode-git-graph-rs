/* The ref labels of a commit, grouped the way the commit row and the graph tooltip display them. */

import * as GG from '../../common/protocol';

export interface BranchLabels {
	/** The local branches, each with the remotes whose same-named branch is combined into its label. */
	readonly heads: ReadonlyArray<{ readonly name: string, readonly remotes: string[] }>;
	/** The remote-tracking branches that are not combined into a local branch label. */
	readonly remotes: ReadonlyArray<GG.GitCommitRemote>;
}

/**
 * Group the branches of a commit into labels. With `combineLocalAndRemote`, a remote-tracking
 * branch whose name matches a local branch on the same commit is shown inside that local branch's
 * label rather than as a label of its own.
 */
export function getBranchLabels(heads: ReadonlyArray<string>, remotes: ReadonlyArray<GG.GitCommitRemote>, combineLocalAndRemote: boolean): BranchLabels {
	const headLabels: { name: string, remotes: string[] }[] = [], headLookup: { [name: string]: number } = {};
	let remoteLabels: ReadonlyArray<GG.GitCommitRemote>;
	for (let i = 0; i < heads.length; i++) {
		headLabels.push({ name: heads[i], remotes: [] });
		headLookup[heads[i]] = i;
	}
	if (combineLocalAndRemote) {
		const remainingRemoteLabels = [];
		for (let i = 0; i < remotes.length; i++) {
			const remote = remotes[i].remote;
			if (remote !== null) { // If the remote of the remote branch ref is known
				const branchName = remotes[i].name.substring(remote.length + 1);
				if (typeof headLookup[branchName] === 'number') {
					headLabels[headLookup[branchName]].remotes.push(remote);
					continue;
				}
			}
			remainingRemoteLabels.push(remotes[i]);
		}
		remoteLabels = remainingRemoteLabels;
	} else {
		remoteLabels = remotes;
	}
	return { heads: headLabels, remotes: remoteLabels };
}

export interface TagLabel {
	readonly name: string;
	readonly remotes: string[];
	readonly annotated: boolean;
	local: boolean;
}

/**
 * Group the tags of a commit into labels: a tag fetched from a remote ("<remote>/<tag>", with
 * the trackRemoteTags setting) is shown inside the label of the tag of the same name. The labels
 * are in the key order of an object keyed by tag name (integer-like names first, then the order
 * of first appearance), as the commit row has always shown them.
 */
export function getTagLabels(tags: ReadonlyArray<GG.GitCommitTag>): TagLabel[] {
	const lookup: { [name: string]: TagLabel } = {};
	for (let i = 0; i < tags.length; i++) {
		const parts = tags[i].name.split('/');
		const name = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
		const remote = parts.length > 1 ? parts[0] : null;
		if (!lookup[name]) lookup[name] = { name: name, remotes: [], annotated: tags[i].annotated, local: false };
		if (remote) {
			lookup[name].remotes.push(remote);
		} else {
			lookup[name].local = true;
		}
	}
	return Object.keys(lookup).map((name) => lookup[name]);
}
