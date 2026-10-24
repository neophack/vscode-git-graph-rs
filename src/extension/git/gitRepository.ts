/**
 * The `GitRepository` facade: what the rest of the host will hold instead of the legacy
 * `DataSource` (REFACTOR-PLAN task 3.6). It composes the three faces of a repository —
 * reads, writes and in-progress-operation state — without owning any of them:
 *
 * - `read` is the structural `GitReaderLike` (the future engine/CLI reader satisfies it; this
 *   tree must not depend on `src/backend`, so the reader arrives as an interface);
 * - `write` is the `GitWriter`;
 * - `getOperationState` is the ported detection over an injected text runner.
 *
 * Phase 4 wires the real reader in and migrates the `DataSource` call sites; this skeleton is
 * the composition point they will land on.
 */

import * as fs from 'fs';

import { GitOperationState } from '../../types/git';
import { detectOperationState, OperationStateEnv } from './operationState';
import { GitWriter } from './write/gitWriter';

/**
 * The read face of a repository, as the facade consumes it: a structural subset of the future
 * reader (`read/gitReader.ts`), so no dependency on `src/backend` is created here.
 */
export interface GitReaderLike {
	openRepository(repo: string): Promise<void>;
	closeRepository(repo: string): void;
	/** The remotes of the repository, in configuration order. */
	getRemotes(repo: string): Promise<string[]>;
	/** The checked-out branch's short name, or null when HEAD is detached. */
	currentBranchName(repo: string): Promise<string | null>;
}

/** Runs a Git read in a repository, resolving its stdout; rejecting when it fails. */
export type RepoTextRunner = (argv: ReadonlyArray<string>, repo: string) => Promise<string>;

export class GitRepository {
	constructor(
		public readonly read: GitReaderLike,
		public readonly write: GitWriter,
		private readonly runText: RepoTextRunner
	) {}

	/**
	 * Detect the in-progress merge / rebase / cherry-pick / revert (and the unresolved files,
	 * and a rebase's step counter). Never rejects: a failure reads as "no operation in progress".
	 */
	getOperationState(repo: string): Promise<GitOperationState> {
		const env: OperationStateEnv = {
			exists: (file) => fs.existsSync(file),
			readIntFile: (file) => {
				try {
					const value = parseInt(fs.readFileSync(file).toString().trim(), 10);
					return isNaN(value) ? null : value;
				} catch (_) {
					return null;
				}
			},
			runText: (argv) => this.runText(argv, repo)
		};
		return detectOperationState(repo, env);
	}
}
