/**
 * The `GitRepository` facade: the repository object the rest of the host holds. It composes
 * the three faces of a repository — reads, writes and in-progress-operation state — without
 * owning any of them:
 *
 * - `read` is the structural `GitReaderLike` (the engine/CLI reader satisfies it; this tree must
 *   not depend on `src/backend`, so the reader arrives as an interface);
 * - `write` is the `GitWriter`;
 * - `getOperationState` is the in-progress-operation detection over an injected text runner.
 *
 * Production types the facade as `ProductionGitRepository`, with the full backend wired in as
 * the read face — this is the composition point the call sites land on.
 */

import type { GitBackend } from './read/gitReader';
import type { GitProcess } from './process/gitProcess';

import { GitOperationState } from '../../shared/model/git';
import { detectOperationState, fsOperationStateEnv, RepoTextRunner } from './operationState';
import { GitWriter } from './write/gitWriter';

/**
 * The read face of a repository, as the facade consumes it: a structural subset of the
 * reader (`read/gitReader.ts`), so no dependency on `src/backend` is created here.
 */
export interface GitReaderLike {
	openRepository(repo: string): Promise<string | void>;
	closeRepository(repo: string): void;
	/** The remotes of the repository, in configuration order. */
	getRemotes(repo: string): Promise<ReadonlyArray<string>>;
	/** The checked-out branch's short name, or null when HEAD is detached. */
	currentBranchName(repo: string): Promise<string | null>;
}

/** Runs a Git read in a repository, resolving its stdout; rejecting when it fails. */
export type { RepoTextRunner } from './operationState';

/**
 * The facade as production composes it: the full backend (the engine with the CLI fallback) as
 * the read face. Handlers and commands type their context against this alias, while tests keep
 * substituting a narrow `GitReaderLike` fake.
 */
export type ProductionGitRepository = GitRepository<GitBackend>;

/**
 * The facade's text runner over the composition root's `GitProcess` (main.ts passes it at
 * construction): one Git read resolving its stdout, rejecting with the combined
 * stderr+stdout message when it fails.
 */
export function repoTextRunnerOf(process: GitProcess): RepoTextRunner {
	return (argv, repo) => process.run(argv, { cwd: repo }).then((result) => {
		if (result.code !== 0) {
			const lines = (result.stderr + result.stdout.toString('utf8')).split(/\r\n|\r|\n/);
			lines.pop();
			throw lines.join('\n');
		}
		return result.stdout.toString('utf8');
	});
}

export class GitRepository<R extends GitReaderLike = GitReaderLike> {
	constructor(
		public readonly read: R,
		public readonly write: GitWriter,
		private readonly runText: RepoTextRunner
	) {}

	/**
	 * Detect the in-progress merge / rebase / cherry-pick / revert (and the unresolved files,
	 * and a rebase's step counter). Never rejects: a failure reads as "no operation in progress".
	 */
	getOperationState(repo: string): Promise<GitOperationState> {
		return detectOperationState(repo, fsOperationStateEnv(repo, this.runText));
	}
}
