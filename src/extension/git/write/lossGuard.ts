/**
 * Data-loss guards, ported from `DataSource` (`src/dataSource.ts`): the warning shown before
 * moving HEAD away from commits that would become unreachable, and the warning shown before a
 * hard reset discards uncommitted changes.
 *
 * The guards are pure functions over an injected text runner (`(argv) => Promise<string>`,
 * resolving Git's stdout, rejecting on failure), so the exact legacy sequence — including which
 * failure is swallowed and which aborts — is unit-testable without a repository.
 */

import type { LossWarning } from '../../../shared/protocol/messages';
import type { Localize } from './argSafety';

/** Runs a Git read and resolves its stdout (empty on no output), rejecting when it fails. */
export type GuardRunner = (argv: ReadonlyArray<string>) => Promise<string>;

/** The argv of the anchor probe: the current commit HEAD points at. */
export function revParseHeadArgv(): ReadonlyArray<string> {
	return ['rev-parse', 'HEAD'];
}

/** The argv of the stash-roots probe: every stash entry's hash, oldest anchors included. */
export function stashListArgv(): ReadonlyArray<string> {
	return ['stash', 'list', '--format=%H'];
}

/**
 * The argv of the unreachable-commit count: commits reachable from HEAD but from no branch, tag,
 * remote or stash root. Every stash entry counts as an anchor (`--all` cannot stand in for the
 * explicit roots: it includes HEAD itself, which would silence the guard entirely).
 */
export function countDetachedOnlyCommitsArgv(stashRoots: ReadonlyArray<string>): ReadonlyArray<string> {
	return ['rev-list', 'HEAD', '--not', '--branches', '--tags', '--remotes', ...stashRoots, '--count'];
}

/** The argv of the working-tree dirtiness probe. */
export function statusPorcelainArgv(): ReadonlyArray<string> {
	return ['status', '--porcelain'];
}

/**
 * Count the commits that moving HEAD away from its current position would leave behind.
 * Never rejects: a Git that cannot answer (or has nothing stashed) counts as zero.
 */
export async function countDetachedOnlyCommits(run: GuardRunner): Promise<number> {
	const stashRoots = await run(stashListArgv())
		.then((out) => out.split('\n').map((line) => line.trim()).filter((line) => line !== ''))
		.catch(() => [] as string[]);
	return run(countDetachedOnlyCommitsArgv(stashRoots))
		.then((out) => parseInt(out, 10))
		.catch(() => 0);
}

/**
 * The data-loss warning for moving HEAD away from detached commits that no ref or stash keeps
 * reachable, or null when nothing can be lost.
 * @param run The text runner the probes go through.
 * @param t The localiser (`leavingCommitsBehind`).
 * @param anchoredAt A revision that, when it is the current HEAD, anchors the detached commits
 *                   (a branch being created right at HEAD): nothing is stranded.
 */
export async function detachedCommitsLossWarning(run: GuardRunner, t: Localize, anchoredAt: string | null = null): Promise<LossWarning | null> {
	if (anchoredAt !== null) {
		const head = await run(revParseHeadArgv())
			.then((out) => out.trim())
			.catch(() => '');
		if (head !== '' && head === anchoredAt) return null;
	}
	const count = await countDetachedOnlyCommits(run);
	if (count <= 0) return null;
	return { message: t('leavingCommitsBehind', count) };
}

/**
 * The data-loss warning for a hard reset while the working tree has uncommitted changes (they
 * are discarded irrecoverably), or null when the tree is clean.
 */
export async function hardResetLossWarning(run: GuardRunner, t: Localize): Promise<LossWarning | null> {
	const dirty = await run(statusPorcelainArgv())
		.then((out) => (out.trim() === '' ? 0 : 1))
		.catch(() => 0);
	if (dirty === 0) return null;
	return { message: t('hardResetLosesChanges') };
}
