/**
 * The conflict-prediction theme: whether merging one tip into another would conflict, probed
 * ahead of the merge/rebase confirmation dialog with a single `git merge-tree --write-tree`
 * (no working-tree side effects).
 */

import { GitConflictPrediction } from '../types';
import { hasCapability } from '../../executable/capabilities';
import { EOL, GitCli } from './process';

/**
 * Predict whether merging `theirs` into `ours` would conflict. Requires Git 2.40+; on an older
 * Git — when the version is known — this resolves to "no prediction available"
 * (`null`) without spawning, since the prediction is advisory and a stale/incompatible Git must
 * not block the action. When the version is not known, the probe runs and an old Git's usage
 * error simply parses to no conflicted files — the same `null`.
 */
export async function predictConflicts(cli: GitCli, repo: string, ours: string, theirs: string, gitVersion?: string): Promise<GitConflictPrediction | null> {
	if (gitVersion !== undefined && !hasCapability(gitVersion, 'MergeTreeConflictPrediction')) {
		return null;
	}

	const result = await cli.runDetailed(['merge-tree', '--write-tree', ours, theirs], repo);
	if (result.code === 0) {
		// Exit code 0 means a clean merge: no conflicted paths.
		return { conflicted: false, files: [] };
	}

	// A real (non-transient) conflict exits non-zero with output made of several sections
	// (the merged tree OID, the conflicted file info, then free-text informational
	// messages), separated by blank lines whose exact position isn't worth depending on -
	// every line is instead matched against the fixed porcelain index-entry shape of a
	// conflicted file info line, `<mode> <oid> <stage>\t<path>` (stage 1/2/3 =
	// base/ours/theirs - the same path can appear up to three times, once per stage), which
	// a free-text informational message cannot accidentally match. Both streams are parsed
	// (the informational text and the entries arrive across them), matching on the combined
	// output.
	const files = new Set<string>();
	for (const line of (result.stderr + result.stdout).split(EOL)) {
		const match = line.match(/^[0-7]{6} [0-9a-f]+ [1-3]\t(.+)$/);
		if (match !== null) files.add(match[1]);
	}
	return files.size > 0 ? { conflicted: true, files: [...files] } : null;
}
