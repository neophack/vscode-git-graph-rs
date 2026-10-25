/**
 * Parsers of the working-tree status: the untracked, deleted and unmerged files `git status -z`
 * reports, and the layering of that list onto a diff's file changes.
 */

import { GitFileChange, GitFileStatus } from '../../types';

/** The untracked, deleted and unmerged paths of the working tree. */
export interface StatusFiles {
	deleted: string[];
	untracked: string[];
	unmerged: string[];
}

/**
 * The untracked and deleted files of the working tree.
 *
 * `git status -z` terminates each entry with a NUL, and a rename spends two entries (the new
 * path then the old one), which is why the cursor advances by two for `R` and `C`.
 */
export function parseStatusFiles(out: string): StatusFiles {
	const entries = out.split('\u0000');
	const status: StatusFiles = { deleted: [], untracked: [], unmerged: [] };
	for (let i = 0; i < entries.length && entries[i] !== ''; ) {
		if (entries[i].length < 4) break;
		const path = entries[i].slice(3);
		const staged = entries[i][0];
		const unstaged = entries[i][1];
		// In an unmerged pair (`UD`, `DU`, `AU`, …) a `D` says which side of the merge deleted
		// the file, which is still in the working tree; only `DD` (both deleted) is gone.
		const unmerged = staged === 'U' || unstaged === 'U' || (staged === 'A' && unstaged === 'A') || (staged === 'D' && unstaged === 'D');

		if ((staged === 'D' || unstaged === 'D') && (!unmerged || staged === unstaged)) status.deleted.push(path);
		else if (unmerged) status.unmerged.push(path);
		else if (staged === '?' || unstaged === '?') status.untracked.push(path);

		i += staged === 'R' || unstaged === 'R' || staged === 'C' || unstaged === 'C' ? 2 : 1;
	}
	return status;
}

/**
 * Layer the untracked and deleted files of the working tree onto a diff.
 *
 * A file deleted in the working tree but still in the index shows as deleted rather than
 * unchanged, and untracked files are appended — neither is visible to `git diff`.
 */
export function mergeStatusFiles(changes: ReadonlyArray<GitFileChange>,
	status: { deleted: ReadonlyArray<string>; untracked: ReadonlyArray<string>; unmerged: ReadonlyArray<string> }
): GitFileChange[] {
	const merged = [...changes];
	// A conflicted file still in the working tree (`UD` when the other side deleted it) can be
	// identical to HEAD, so `git diff` leaves it out; it is listed as modified, as `git status`
	// counts it and the engine lists it, rather than vanishing mid-merge.
	for (const path of status.unmerged) {
		if (!merged.some((change) => change.newFilePath === path)) {
			merged.push({ oldFilePath: path, newFilePath: path, type: GitFileStatus.Modified, additions: null, deletions: null });
		}
	}
	for (const path of status.deleted) {
		// The source of a rename the diff already paired (`git status` lists it as deleted when
		// `status.renames` is off) is accounted for by that rename record.
		if (merged.some((change) => change.type === GitFileStatus.Renamed && change.oldFilePath === path)) continue;
		const index = merged.findIndex((change) => change.newFilePath === path);
		if (index !== -1) {
			merged[index] = { ...merged[index], type: GitFileStatus.Deleted };
		} else {
			merged.push({
				oldFilePath: path,
				newFilePath: path,
				type: GitFileStatus.Deleted,
				additions: null,
				deletions: null
			});
		}
	}
	for (const path of status.untracked) {
		merged.push({
			oldFilePath: path,
			newFilePath: path,
			type: GitFileStatus.Untracked,
			additions: null,
			deletions: null
		});
	}
	return merged;
}
