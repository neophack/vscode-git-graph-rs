/**
 * Parsers of the record-oriented `git log` / `git reflog` output: the separator-joined fields of
 * one commit record, and the stash reflog the view splices into the graph.
 */

import { GitStash } from '../../types';
import { EOL, SEPARATOR } from '../process';

/** One commit of the `git log` output, before the refs, stashes and the working tree are attached. */
export interface LogRecord {
	hash: string;
	parents: string[];
	author: string;
	email: string;
	date: number;
	message: string;
}

/**
 * One separator-joined `git log` record, or NULL where the output carries none (the trailing
 * record separator, or a short record that is not a commit).
 */
export function parseLogRecord(record: string): LogRecord | null {
	const fields = record.split(SEPARATOR);
	if (fields.length < 6) return null;
	return {
		hash: fields[0],
		parents: fields[1] ? fields[1].split(' ') : [],
		author: fields[2],
		email: fields[3],
		date: parseInt(fields[4], 10),
		message: fields.slice(5).join(SEPARATOR)
	};
}

/** The stashes of one `git reflog refs/stash` output, oldest line first. */
export function parseStashReflog(out: string): GitStash[] {
	const stashes: GitStash[] = [];
	for (const line of out.split(EOL)) {
		const fields = line.split(SEPARATOR);
		if (fields.length !== 7 || fields[1] === '') continue;
		const parents = fields[1].split(' ');
		stashes.push({
			hash: fields[0],
			baseHash: parents[0],
			untrackedFilesHash: parents.length === 3 ? parents[2] : null,
			selector: fields[2],
			author: fields[3],
			email: fields[4],
			date: parseInt(fields[5], 10),
			message: fields[6]
		});
	}
	return stashes;
}
