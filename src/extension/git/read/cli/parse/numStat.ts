/**
 * The parser of `git diff --numstat -z` output: the `+N/-M` counts of a whole diff, keyed by
 * each file's new path.
 */

import { GitLineCounts } from '../../../../../backend/types';

export function parseNumStat(numStat: string): { [path: string]: GitLineCounts } {
	const counts: { [path: string]: GitLineCounts } = {};

	const fields = numStat.split('\0');
	for (let i = 0; i < fields.length && fields[i] !== ''; ) {
		const parts = fields[i].split('\t');
		if (parts.length !== 3) break;
		// A rename's numstat record has an empty path, followed by the two paths as separate
		// NUL-terminated fields; the new path (the last one) is what the counts are keyed by.
		const path = parts[2] !== '' ? parts[2] : fields[i + 2];
		const additions = parseInt(parts[0], 10);
		const deletions = parseInt(parts[1], 10);
		counts[path] = {
			// A binary file reports a dash, which parses to NaN and is reported as "unknown".
			additions: Number.isNaN(additions) ? null : additions,
			deletions: Number.isNaN(deletions) ? null : deletions
		};
		i += parts[2] !== '' ? 1 : 3;
	}

	return counts;
}
