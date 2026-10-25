/**
 * The reflog theme: one page of the reflog of a reference (the reflog panel's data), with the
 * dangling (unreachable-from-any-ref) commits flagged.
 */

import { GitBackendError, GitReflogPage } from '../types';
import { isSafeRefName } from '../../write/argSafety';
import { EOL, GitCli, message } from './process';

/**
 * A page of the reflog of a reference (defaulting to `HEAD`), newest first, with the dangling
 * commits flagged. The read rejects with the failure — the view message's `error` field is the
 * caller's composition, as it was on the legacy `DataSource`.
 */
export async function getReflog(cli: GitCli, repo: string, ref: string, limit: number): Promise<GitReflogPage> {
	// The ref arrives from the webview and is passed to git as a bare argument, so drop one that
	// could be misinterpreted as a git option (argument injection) — the legacy read validated
	// inside the method, and the check must survive the move to the backend.
	if (!isSafeRefName(ref)) {
		throw new GitBackendError('InvalidArgument', `The reference name "${ref}" cannot be used`);
	}

	// %gd is the reflog selector, but under --date=unix it switches from the index form
	// (ref@{N}) to the date form (ref@{<unix time>}) - the index is instead rebuilt below
	// from each entry's position in this (newest-first) page, and the unix time is read out
	// of the same field instead of needing a second, separately-formatted column for it.
	const stdout = await cli.run(
		['reflog', 'show', ref, '--format=%H\x1f%h\x1f%gd\x1f%gs', '--date=unix', '-n', String(limit + 1)],
		repo
	).catch((error: unknown) => {
		throw error instanceof GitBackendError ? error : new GitBackendError('Git', message(error));
	});

	let lines = stdout.split(EOL).filter((line) => line !== '');
	const moreAvailable = lines.length > limit;
	if (moreAvailable) lines = lines.slice(0, limit);

	const parsed = parseReflogLines(lines);
	const dangling = await findDanglingHashes(cli, repo, parsed.map((entry) => entry.hash));

	return {
		entries: parsed.map((entry, index) => ({
			hash: entry.hash,
			abbrevHash: entry.abbrevHash,
			selector: ref + '@{' + index + '}',
			date: entry.date,
			message: entry.message,
			dangling: dangling.has(entry.hash)
		})),
		moreAvailable: moreAvailable
	};
}

/** One parsed reflog line, before the page's selector index and dangling flag are attached. */
export interface RawReflogEntry {
	hash: string;
	abbrevHash: string;
	date: number;
	message: string;
}

/** Split one `--format=%H\x1f%h\x1f%gd\x1f%gs` page into its entries, dropping malformed lines. */
export function parseReflogLines(lines: ReadonlyArray<string>): RawReflogEntry[] {
	const parsed: RawReflogEntry[] = [];
	for (const line of lines) {
		const parts = line.split('\x1f');
		const dateMatch = parts.length === 4 ? parts[2].match(/\{(\d+)\}/) : null;
		if (parts.length === 4 && dateMatch !== null) {
			parsed.push({ hash: parts[0], abbrevHash: parts[1], date: parseInt(dateMatch[1], 10), message: parts[3] });
		}
	}
	return parsed;
}

/**
 * Which of the page's hashes are missing from the object database, in one
 * `git cat-file --batch-check` process. A best-effort annotation: a failure here leaves every
 * entry non-dangling rather than failing the whole reflog.
 */
async function findDanglingHashes(cli: GitCli, repo: string, hashes: ReadonlyArray<string>): Promise<Set<string>> {
	const uniqueHashes = [...new Set(hashes)];
	if (uniqueHashes.length === 0) return new Set<string>();
	try {
		const output = await cli.runWithInput(['cat-file', '--batch-check'], repo, uniqueHashes.join('\n') + '\n');
		const dangling = new Set<string>();
		for (const line of output.split(EOL)) {
			const match = line.match(/^([0-9a-f]+)\s+missing\b/);
			if (match !== null) dangling.add(match[1]);
		}
		return dangling;
	} catch (_) {
		return new Set<string>();
	}
}
