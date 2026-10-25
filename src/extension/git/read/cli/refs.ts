/**
 * The ref-reading theme: which branches, tags and remotes a repository has, which of them HEAD
 * points at, the stash reflog, and the small branch/remote lookups the view asks for by name.
 */

import {
	GitRef,
	GitRefData,
	GitRepoInfo,
	GitStash,
	GitTagRef,
	RefReadOptions
} from '../../../../backend/types';
import { EOL, GitCli, message, SEPARATOR } from './process';
import { parseStashReflog } from './parse/log';

/**
 * The branches, checked-out branch, tags, remotes and stashes the view opens with.
 */
export async function getRepoInfo(cli: GitCli, repo: string, options: RefReadOptions = {}): Promise<GitRepoInfo> {
	const opts = { showRemoteBranches: true, showStashes: true, ...options };
	try {
		const [refs, remotes, stashes] = await Promise.all([
			readRefs(cli, repo, opts),
			getRemotes(cli, repo),
			opts.showStashes ? getStashes(cli, repo) : Promise.resolve([] as GitStash[])
		]);
		return {
			branches: refs.branches,
			head: refs.branchHead,
			remotes,
			stashes,
			tags: refs.tagNames,
			error: null
		};
	} catch (error) {
		return {
			branches: [],
			head: null,
			remotes: [],
			stashes: [],
			tags: [],
			error: message(error)
		};
	}
}

/** The refs of a repository, without the commits. */
export async function getRefs(cli: GitCli, repo: string, options: RefReadOptions = {}): Promise<GitRefData> {
	const snapshot = await readRefs(cli, repo, { showRemoteBranches: true, ...options });
	return snapshot.refData;
}

/**
 * A signature of everything at ref level that can change the commit graph: the resolved hash of
 * HEAD, and the names AND hashes of every branch, tag, remote-tracking ref and stash. A change
 * poller comparing name-only lists cannot see a new commit landing on an existing branch; reading
 * the actual ref hashes is what makes it visible. Never rejects: a momentarily unreadable
 * repository answers NULL.
 */
export async function getRepoChangeSignature(cli: GitCli, repo: string): Promise<string | null> {
	try {
		const [refs, stashes] = await Promise.all([getRefs(cli, repo, { showRemoteBranches: true }), getStashes(cli, repo)]);
		return JSON.stringify([refs.head, refs.heads, refs.tags, refs.remotes, stashes]);
	} catch (_) {
		return null;
	}
}

/** The local Gerrit change refs of a remote (`refs/remotes/<remote>/changes/**`), as `[refname, hash]` pairs. */
export async function listChangeRefs(cli: GitCli, repo: string, remote: string): Promise<[string, string][]> {
	const out = await cli.run(['for-each-ref', 'refs/remotes/' + remote + '/changes/', '--format=%(refname)%00%(objectname)'], repo);
	const refs: [string, string][] = [];
	for (const line of out.split(EOL)) {
		const separator = line.indexOf('\0');
		if (separator === -1) continue;
		const ref = line.substring(0, separator);
		if (ref !== '') refs.push([ref, line.substring(separator + 1)]);
	}
	return refs;
}

/** The stashes of a repository, newest first. */
export async function getStashes(cli: GitCli, repo: string): Promise<GitStash[]> {
	const format = ['%H', '%P', '%gD', '%an', '%ae', '%ct', '%s'].join(SEPARATOR);
	const out = await cli.run(['reflog', `--format=${format}`, 'refs/stash', '--'], repo).catch(
		() => ''
	);
	return parseStashReflog(out);
}

/** The names of the repository's remotes. */
export async function getRemotes(cli: GitCli, repo: string): Promise<string[]> {
	const out = await cli.run(['remote'], repo);
	return out.split(EOL).filter((line) => line !== '');
}

/** The upstream of the checked-out branch, or NULL when there is none. */
export async function getCurrentBranchUpstream(cli: GitCli, repo: string): Promise<string | null> {
	try {
		const out = await cli.run(
			['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
			repo
		);
		return out.trim() || null;
	} catch {
		return null;
	}
}

/** The checked-out branch's short name, or NULL when HEAD is detached. */
export async function currentBranchName(cli: GitCli, repo: string): Promise<string | null> {
	try {
		const out = await cli.run(['symbolic-ref', '--short', 'HEAD'], repo);
		return out.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Read every ref the view needs.
 *
 * The calls are split the way the original extension split them, and for the same reason:
 * `show-ref -d` peels, which costs an object lookup per ref and is only affordable over the
 * local branches and tags; `for-each-ref` over `refs/remotes/` does not peel, which is what
 * makes the one unavoidably broad scan cheap. A remote tag (fetched by "track remote tags")
 * is rare enough that it gets its own narrow peel: without it, an annotated remote tag's
 * `%(objectname)` is the tag object's hash rather than the commit it points to, so it would
 * never attach to any commit in the graph.
 */
export async function readRefs(
	cli: GitCli,
	repo: string,
	options: {
		showRemoteBranches?: boolean;
		showRemoteHeads?: boolean;
		hideRemotes?: ReadonlyArray<string>;
		showChangeRefs?: boolean;
	}
) {
	const [local, remote, remoteTagPeels, branchHead] = await Promise.all([
		cli.run(['show-ref', '--heads', '--tags', '-d', '--head'], repo).catch(() => ''),
		options.showRemoteBranches ?? true
			? cli.run(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/'], repo).catch(
					() => ''
				)
			: Promise.resolve(''),
		options.showRemoteBranches ?? true
			? cli.run(
					['for-each-ref', '--format=%(objectname) %(*objectname) %(refname)', 'refs/remotes/**/tags/*'],
					repo
				).catch(() => '')
			: Promise.resolve(''),
		cli.run(['symbolic-ref', '-q', '--short', 'HEAD'], repo)
			.then((out) => out.trim() || null)
			.catch(() => null)
	]);

	// refname -> the commit hash an annotated remote tag peels to; absent for lightweight tags.
	const remoteAnnotatedTags = new Map<string, string>();
	for (const line of remoteTagPeels.split(EOL)) {
		const firstSpace = line.indexOf(' ');
		if (firstSpace === -1) continue;
		const rest = line.slice(firstSpace + 1);
		const secondSpace = rest.indexOf(' ');
		if (secondSpace === -1) continue;
		const peeled = rest.slice(0, secondSpace);
		if (peeled !== '') remoteAnnotatedTags.set(rest.slice(secondSpace + 1), peeled);
	}

	const refData: { head: string | null; heads: GitRef[]; tags: GitTagRef[]; remotes: GitRef[] } = {
		head: null,
		heads: [],
		tags: [],
		remotes: []
	};
	const branches: string[] = [];
	const tagNames: string[] = [];

	for (const line of local.split(EOL)) {
		const separator = line.indexOf(' ');
		if (separator === -1) continue;
		const hash = line.slice(0, separator);
		const ref = line.slice(separator + 1);

		if (ref.startsWith('refs/heads/')) {
			const name = ref.slice(11);
			refData.heads.push({ hash, name });
			branches.push(name);
		} else if (ref.startsWith('refs/tags/')) {
			const annotated = ref.endsWith('^{}');
			const name = annotated ? ref.slice(10, -3) : ref.slice(10);
			refData.tags.push({ hash, name, annotated });
			if (!annotated) tagNames.push(name);
		} else if (ref === 'HEAD') {
			refData.head = hash;
		}
	}

	const hidden = (options.hideRemotes ?? []).map((name) => `refs/remotes/${name}/`);
	for (const line of remote.split(EOL)) {
		const separator = line.indexOf(' ');
		if (separator === -1) continue;
		const hash = line.slice(0, separator);
		const ref = line.slice(separator + 1);
		if (!ref.startsWith('refs/remotes/')) continue;
		if (hidden.some((prefix) => ref.startsWith(prefix))) continue;
		if (!options.showRemoteHeads && ref.endsWith('/HEAD')) continue;

		const name = ref.slice(13);
		// Only `tags/` directly below the remote's name marks a tag (see refs.rs): a branch
		// pushed as `feature/tags/cleanup` also carries a `/tags/` further down.
		const slash = name.indexOf('/');
		const tagsIndex = slash > -1 && name.startsWith('tags/', slash + 1) ? slash : -1;
		if (tagsIndex > -1) {
			const peeledHash = remoteAnnotatedTags.get(ref);
			refData.tags.push({
				hash: peeledHash ?? hash,
				name: name.slice(0, tagsIndex) + '/' + name.slice(tagsIndex + 6),
				annotated: peeledHash !== undefined
			});
		} else if (name.includes('/changes/')) {
			// Never offered as branches, however they are displayed.
			if (options.showChangeRefs && !name.endsWith('/meta')) refData.remotes.push({ hash, name });
		} else {
			refData.remotes.push({ hash, name });
			branches.push('remotes/' + name);
		}
	}

	/* The checked-out branch is listed first, as `git branch` lists it */
	if (branchHead !== null) {
		const index = branches.indexOf(branchHead);
		if (index > 0) branches.splice(index, 1);
		if (index !== 0) branches.unshift(branchHead);
	}

	return { refData, branches, branchHead, tagNames: tagNames.sort() };
}
