/**
 * The commit-details theme: one commit (or the uncommitted row, or a stash) in full — its
 * metadata, signature, and the files it changed, statuses only, layered with the working-tree
 * status where the comparison reaches the working tree.
 */

import { parseGitSignatureOutput } from '../signatures';
import {
	GitBackendError,
	GitCommitDetails,
	GitCommitStash,
	GitFileChange,
	GitFileStatus,
	GitSignature,
	UNCOMMITTED
} from '../types';
import { GitCli, SEPARATOR } from './process';
import { StatusFiles, parseStatusFiles, mergeStatusFiles } from './parse/status';

/** One commit in full, with the files it changed — their statuses only, without line counts. */
export async function getCommitDetails(cli: GitCli, repo: string, hash: string): Promise<GitCommitDetails> {
	const details = await getCommitDetailsBase(cli, repo, hash);
	const from = details.parents.length > 0 ? hash + '^' : await cli.getEmptyTree(repo);
	details.fileChanges = await getFileChanges(cli, repo, from, hash);
	return details;
}

/**
 * Verify one commit's signature with Git/GPG. The Rust engine does not implement the keyring
 * integration, so it declines this capability and lets the CLI fallback answer it.
 */
export async function getCommitSignature(cli: GitCli, repo: string, hash: string): Promise<GitSignature | null> {
	return parseGitSignatureOutput(await cli.runRaw(['verify-commit', '--raw', hash], repo));
}

/** The "Uncommitted Changes" row in full. */
export async function getUncommittedDetails(cli: GitCli, repo: string): Promise<GitCommitDetails> {
	// `git diff HEAD` sees neither untracked files nor files deleted from the working tree, so
	// the status scan is layered on top of it — as the original extension does. An unborn HEAD
	// (a fresh repository, or an orphan branch) has no commit to diff against: the working
	// tree is diffed against the empty tree instead, so the files already staged for the first
	// commit are listed as added - as `git status` lists them - rather than left out.
	const headExists = await cli.run(['rev-parse', '--verify', '--quiet', 'HEAD'], repo)
		.then((out) => out.trim() !== '', () => false);
	const base = headExists ? 'HEAD' : await cli.getEmptyTree(repo);
	const [changes, status] = await Promise.all([
		getFileChanges(cli, repo, base, ''),
		getStatusFiles(cli, repo)
	]);
	return {
		hash: UNCOMMITTED,
		parents: [],
		author: '',
		authorEmail: '',
		authorDate: 0,
		committer: '',
		committerEmail: '',
		committerDate: 0,
		signature: null,
		body: '',
		fileChanges: mergeStatusFiles(changes, status)
	};
}

/** A stash entry in full. */
export async function getStashDetails(
	cli: GitCli,
	repo: string,
	hash: string,
	stash: GitCommitStash
): Promise<GitCommitDetails> {
	const details = await getCommitDetailsBase(cli, repo, hash);
	details.fileChanges = await getFileChanges(cli, repo, stash.baseHash, hash);
	if (stash.untrackedFilesHash !== null) {
		const untracked = await getFileChanges(cli, repo, await cli.getEmptyTree(repo), stash.untrackedFilesHash);
		for (const change of untracked) {
			if (change.type === GitFileStatus.Added) {
				details.fileChanges.push({ ...change, type: GitFileStatus.Untracked });
			}
		}
	}
	return details;
}

/** The files that differ between two revisions; an empty `to` compares against the working tree. */
export async function compareCommits(cli: GitCli, repo: string, from: string, to: string): Promise<GitFileChange[]> {
	const againstWorktree = to === UNCOMMITTED || to === '';
	const changes = await getFileChanges(cli, repo, from, againstWorktree ? '' : to);
	// Comparing against the working tree means the untracked and deleted files count too.
	return againstWorktree ? mergeStatusFiles(changes, await getStatusFiles(cli, repo)) : changes;
}

/** The untracked and deleted files of the working tree (see {@link parseStatusFiles}). */
async function getStatusFiles(cli: GitCli, repo: string): Promise<StatusFiles> {
	const out = await cli.run(
		['status', '-s', '--untracked-files=all', '--porcelain', '-z'],
		repo
	);
	return parseStatusFiles(out);
}

async function getCommitDetailsBase(cli: GitCli, repo: string, hash: string) {
	const format = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join(SEPARATOR);
	const [out, signature] = await Promise.all([
		cli.run(['-c', 'log.showSignature=false', 'show', '--quiet', hash, `--format=${format}`], repo),
		getCommitSignature(cli, repo, hash)
	]);
	const fields = out.split(SEPARATOR);
	if (fields.length < 9) {
		throw new GitBackendError('NotFound', `Could not read the commit ${hash}`);
	}
	return {
		hash: fields[0],
		parents: fields[1] !== '' ? fields[1].split(' ') : [],
		author: fields[2],
		authorEmail: fields[3],
		authorDate: parseInt(fields[4], 10),
		committer: fields[5],
		committerEmail: fields[6],
		committerDate: parseInt(fields[7], 10),
		signature,
		body: fields.slice(8).join(SEPARATOR).trim(),
		fileChanges: [] as GitFileChange[]
	};
}

/**
 * The file list between two revisions — the statuses only, from `--name-status`.
 *
 * The line counts used to be merged in from a second `--numstat` run here; they are the
 * expensive half of a details load (every file costs two blob reads), so they are now answered
 * separately, for the paths the view asks about, by [`getLineCounts`].
 */
export async function getFileChanges(cli: GitCli, repo: string, from: string, to: string): Promise<GitFileChange[]> {
	const base = ['diff', '--name-status', '--find-renames', '--diff-filter=AMDR', '-z', from];
	if (to !== '') base.push(to);
	const nameStatus = await cli.run(base, repo);

	const changes: GitFileChange[] = [];

	const statusFields = nameStatus.split('\0');
	for (let i = 0; i < statusFields.length && statusFields[i] !== ''; ) {
		const type = statusFields[i][0] as GitFileStatus;
		if (type === GitFileStatus.Renamed) {
			changes.push({
				oldFilePath: statusFields[i + 1],
				newFilePath: statusFields[i + 2],
				type,
				additions: null,
				deletions: null
			});
			i += 3;
		} else if (
			type === GitFileStatus.Added ||
			type === GitFileStatus.Modified ||
			type === GitFileStatus.Deleted
		) {
			changes.push({
				oldFilePath: statusFields[i + 1],
				newFilePath: statusFields[i + 1],
				type,
				additions: null,
				deletions: null
			});
			i += 2;
		} else {
			break;
		}
	}

	return changes;
}
