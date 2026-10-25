/**
 * The file-contents theme: a file at one revision, one file's unified diff, the on-demand
 * message reads (bodies, subjects, summaries, history search), rename following into the
 * working tree, the submodule roots, and the repository-root lookup.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
	GitBackendError,
	GitCommitFile,
	GitCommitSummary,
	GitFileStatus,
	GitHistoryMatch
} from '../../../../backend/types';
import { GitCli, MAX_BUFFER } from './process';
import { diffSectionNewPath } from './parse/diffHeader';

/**
 * The contents of one file at one revision, via `git show --textconv` — the same command the
 * original extension used. A NUL byte in the first 8000 bytes marks the file as binary, and the
 * contents are then omitted.
 */
export async function getCommitFile(cli: GitCli, repo: string, hash: string, file: string): Promise<GitCommitFile> {
	const stdout = await new Promise<Buffer>((resolve, reject) => {
		execFile(
			cli.gitPath,
			['show', '--textconv', `${hash}:${file}`],
			{ cwd: repo, maxBuffer: MAX_BUFFER, encoding: 'buffer' },
			(error, stdout, stderr) => {
				if (error) {
					const text = (stderr || stdout || error.message).toString().trim();
					const kind = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Unsupported' : 'Git';
					reject(new GitBackendError(kind, text));
				} else {
					resolve(stdout);
				}
			}
		);
	});
	const binary = stdout.subarray(0, 8000).includes(0);
	return {
		contents: binary ? null : stdout.toString('utf8'),
		binary
	};
}

/**
 * The unified diff of one file in one commit (against its first parent).
 *
 * The diff of the whole commit is filtered down to the file, rather than passed as a pathspec,
 * so that a rename is shown as a rename (the way the engine reports it) instead of as a new
 * file with an unrelated deletion.
 */
export async function getCommitFileDiff(cli: GitCli, repo: string, hash: string, file: string): Promise<string> {
	// A root commit has no first parent: git diff would fail on `hash^`, so the empty tree —
	// resolved per repository, since its hash depends on the object format — stands in as the
	// base, exactly as `git show <root>` diffs against it. `core.quotepath=false` keeps non-ASCII paths raw in
	// the headers instead of C-quoted octal escapes (a pathspec could not be used instead: it
	// would exclude the old side of a rename and break its pairing), and the diff.*Prefix
	// settings pin the `a/` and `b/` header prefixes the sections are matched by, which a
	// repository's own configuration would otherwise be free to change.
	const parent = await cli.run(['rev-parse', '--verify', '--quiet', `${hash}^`], repo)
		.then((out) => out.trim())
		.catch(() => cli.getEmptyTree(repo));
	const out = await cli.run([
		'-c', 'core.quotepath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
		'-c', 'diff.srcPrefix=a/', '-c', 'diff.dstPrefix=b/',
		'diff', '--no-color', '--find-renames', parent, hash
	], repo);
	return out
		.split(/(?=^diff --git )/m)
		.filter((section) => diffSectionNewPath(section) === file)
		.join('')
		.replace(/\n$/m, '');
}

/**
 * The unified diff of one file between two revisions (the Commit Comparison view); an empty `to`
 * compares against the working tree, and `oldFilePath`/`newFilePath` differ when the file was
 * renamed between the two sides.
 */
export async function compareFileDiff(cli: GitCli, repo: string, from: string, to: string, oldFilePath: string, newFilePath: string): Promise<string> {
	const args = ['diff', '--no-color', '--find-renames', from];
	if (to !== '') args.push(to);
	args.push('--');
	if (oldFilePath !== newFilePath) args.push(oldFilePath);
	args.push(newFilePath);
	return cli.run(args, repo);
}

/** The full commit message of each of the given commits, keyed by hash. */
export async function getCommitBodies(cli: GitCli, repo: string, hashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }> {
	// With no hashes there is nothing to ask for — and `git log --no-walk` with no revisions
	// would silently default to HEAD, answering a question nobody asked.
	if (hashes.length === 0) return {};
	const out = await cli.run(
		['-c', 'log.showSignature=false', 'log', '--no-walk', '--format=%H%x1f%B%x1e', ...hashes],
		repo
	);
	const bodies: { [hash: string]: string } = {};
	for (let record of out.split('\x1e')) {
		record = record.replace(/^\n/, ''); // git terminates each formatted entry with a newline
		const sep = record.indexOf('\x1f');
		if (sep <= 0) continue;
		bodies[record.substring(0, sep)] = record.substring(sep + 1).replace(/\n$/, '');
	}
	return bodies;
}

/** The subject of one commit, whitespace-normalised as the extension has always shown it. */
export async function getCommitSubject(cli: GitCli, repo: string, hash: string): Promise<string> {
	const out = await cli.run(
		['-c', 'log.showSignature=false', 'log', '--format=%s', '-n', '1', hash, '--'],
		repo
	);
	return out.trim().replace(/\s+/g, ' ');
}

/** The summary of each of the given commits, keyed by hash. */
export async function getCommitSummaries(
	cli: GitCli,
	repo: string,
	hashes: ReadonlyArray<string>
): Promise<{ [hash: string]: GitCommitSummary }> {
	const out = await cli.run(
		['show', '--quiet', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B%x1e', ...hashes],
		repo
	);
	const summaries: { [hash: string]: GitCommitSummary } = {};
	for (const record of out.replace(/\x1e\s*$/, '').split('\x1e')) {
		const text = record.trim();
		// The message is the last field and may itself contain the unit separator, so the
		// first four separators are located by index instead of splitting on every occurrence
		// (as getCommitBodies does).
		const sep1 = text.indexOf('\x1f');
		const sep2 = sep1 > 0 ? text.indexOf('\x1f', sep1 + 1) : -1;
		const sep3 = sep2 > 0 ? text.indexOf('\x1f', sep2 + 1) : -1;
		const sep4 = sep3 > 0 ? text.indexOf('\x1f', sep3 + 1) : -1;
		if (sep4 > 0) {
			const hash = text.substring(0, sep1);
			summaries[hash] = {
				hash: hash,
				author: text.substring(sep1 + 1, sep2),
				email: text.substring(sep2 + 1, sep3),
				date: parseInt(text.substring(sep3 + 1, sep4), 10),
				message: text.substring(sep4 + 1).trim()
			};
		}
	}
	return summaries;
}

/** The commits whose message matches a pattern, newest first. */
export async function searchHistory(cli: GitCli, repo: string, query: string): Promise<GitHistoryMatch[]> {
	// The unit separator (\x1f) is used instead of `|` so that hashes, author names and
	// subjects containing `|` don't shift the fields.
	const out = await cli.run(
		['log', '--all', '-E', '-i', `--grep=${query}`, '--format=%H%x1f%an%x1f%at%x1f%s', '--max-count=100'],
		repo
	);
	const text = out.replace(/\n$/, '');
	if (text === '') return [];
	return text.split('\n').map((line) => {
		const parts = line.split('\x1f');
		return {
			hash: parts[0],
			author: parts[1],
			date: parseInt(parts[2], 10),
			message: parts.slice(3).join('|')
		};
	});
}

/** Where a file was renamed to between a commit and the working tree, or NULL. */
export async function getNewPathOfRenamedFile(
	cli: GitCli,
	repo: string,
	commitHash: string,
	oldFilePath: string
): Promise<string | null> {
	const out = await cli.run(
		['diff', '--name-status', '--find-renames', '--diff-filter=R', '-z', commitHash],
		repo
	);
	const fields = out.split('\0');
	for (let i = 0; i < fields.length && fields[i] !== ''; ) {
		const type = fields[i][0];
		if (type === GitFileStatus.Renamed) {
			if (fields[i + 1] === oldFilePath) return fields[i + 2];
			i += 3;
		} else if (
			type === GitFileStatus.Added ||
			type === GitFileStatus.Modified ||
			type === GitFileStatus.Deleted
		) {
			i += 2;
		} else {
			break;
		}
	}
	return null;
}

/** The roots of the repository's initialised submodules. */
export function getSubmodules(cli: GitCli, repo: string): Promise<string[]> {
	return new Promise<string[]>((resolve) => {
		fs.readFile(path.join(repo, '.gitmodules'), { encoding: 'utf8' }, async (err, data) => {
			const submodules: string[] = [];
			if (!err) {
				const lines = data.split(/\r\n|\r|\n/);
				let inSubmoduleSection = false;
				const section = /^\s*\[.*\]\s*$/,
					submodule = /^\s*\[submodule "([^"]+)"\]\s*$/,
					pathProp = /^\s*path\s+=\s+(.*)$/;

				for (const line of lines) {
					if (line.match(section) !== null) {
						inSubmoduleSection = line.match(submodule) !== null;
						continue;
					}
					const match = inSubmoduleSection ? line.match(pathProp) : null;
					if (match === null) continue;

					// A submodule that was never initialised has no repository below its path;
					// resolving the path's root drops it, as `rev-parse` fails there.
					try {
						const root = await cli.run(
							['rev-parse', '--show-toplevel'],
							path.join(repo, match[1].trim())
						);
						const normalised = path.normalize(root.trim());
						if (!submodules.includes(normalised)) submodules.push(normalised);
					} catch {
						/* not initialised (or no longer present): nothing to list */
					}
				}
			}
			resolve(submodules);
		});
	});
}

/** The root of the repository containing a path. */
export async function repoRoot(cli: GitCli, path: string): Promise<string> {
	const out = await cli.run(['rev-parse', '--show-toplevel'], path);
	return out.trim();
}
