/**
 * Rebase / merge / cherry-pick / revert state detection: which operation is in progress
 * (read off the state files in the Git directory), a rebase's step counter, and the
 * still-unresolved files.
 *
 * The environment (`exists`, `readIntFile`, `runText`) is injected, so the exact sequence
 * — including the precedence of the state files and which failure resolves to "no operation in
 * progress" — is unit-testable without a repository. Every member is asynchronous: the detection
 * runs on the shared extension host, whose synchronous fs would stall every other extension in
 * the window.
 */

import * as fs from 'fs';
import * as path from 'path';

import { GitOperationState, GitOperationType } from '../../shared/model/git';

/** Runs a Git read in a repository, resolving its stdout; rejecting when it fails. */
export type RepoTextRunner = (argv: ReadonlyArray<string>, repo: string) => Promise<string>;

/** The environment the detection runs against; the real one is `fs` plus a Git text runner. */
export interface OperationStateEnv {
	/** Whether a path exists (`fs.promises.access`). */
	readonly exists: (file: string) => Promise<boolean>;
	/** Read a file holding one integer, or null when it is missing or not a plain integer. */
	readonly readIntFile: (file: string) => Promise<number | null>;
	/** Run a Git read, resolving its stdout; rejecting when it fails. */
	readonly runText: (argv: ReadonlyArray<string>) => Promise<string>;
}

/**
 * The production environment: the real filesystem for the state files, and the repository's Git
 * text runner bound to the repo. The assembly used to sit in the facade's `getOperationState`;
 * it lives here so everything `detectOperationState` needs to run is decided in one module,
 * and the facade only composes.
 */
export function fsOperationStateEnv(repo: string, runText: RepoTextRunner): OperationStateEnv {
	return {
		exists: (file) => fs.promises.access(file).then(() => true, () => false),
		readIntFile: async (file) => {
			try {
				const value = parseInt((await fs.promises.readFile(file)).toString().trim(), 10);
				return isNaN(value) ? null : value;
			} catch (_) {
				return null;
			}
		},
		runText: (argv) => runText(argv, repo)
	};
}

/** The argv of the Git-directory probe. */
export function gitDirArgv(): ReadonlyArray<string> {
	return ['rev-parse', '--git-dir'];
}

/** The argv of the unresolved-conflicts probe. */
export function conflictedFilesArgv(): ReadonlyArray<string> {
	return ['diff', '--name-only', '--diff-filter=U'];
}

/** Resolve the Git directory: an absolute path as-is, else repo-relative. */
export function resolveGitDir(repo: string, gitDirOutput: string): string {
	return path.isAbsolute(gitDirOutput) ? gitDirOutput : path.join(repo, gitDirOutput);
}

/**
 * Detect the in-progress operation of a repository. Never rejects: any failure resolves to "no
 * operation in progress", since a transient failure must not break the load this rides along with.
 */
export async function detectOperationState(repo: string, env: OperationStateEnv): Promise<GitOperationState> {
	const none: GitOperationState = { type: null, conflictedFiles: [], progress: null };
	try {
		const gitDirOutput = await env.runText(gitDirArgv());
		const gitDir = resolveGitDir(repo, gitDirOutput.trim());

		let type: GitOperationType | null = null;
		let progress: { step: number, total: number } | null = null;
		if (await env.exists(path.join(gitDir, 'rebase-merge'))) {
			type = GitOperationType.Rebase;
			progress = await readRebaseProgress(path.join(gitDir, 'rebase-merge', 'msgnum'), path.join(gitDir, 'rebase-merge', 'end'), env);
		} else if (await env.exists(path.join(gitDir, 'rebase-apply'))) {
			type = GitOperationType.Rebase;
			progress = await readRebaseProgress(path.join(gitDir, 'rebase-apply', 'next'), path.join(gitDir, 'rebase-apply', 'last'), env);
		} else if (await env.exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
			type = GitOperationType.CherryPick;
		} else if (await env.exists(path.join(gitDir, 'REVERT_HEAD'))) {
			type = GitOperationType.Revert;
		} else if (await env.exists(path.join(gitDir, 'MERGE_HEAD'))) {
			type = GitOperationType.Merge;
		}

		if (type === null) return none;

		const conflictedFiles = await env.runText(conflictedFilesArgv())
			.then((stdout) => stdout.split(/\r\n|\r|\n/).filter((line) => line !== ''))
			.catch(() => [] as string[]);

		return { type, conflictedFiles, progress };
	} catch (_) {
		return none;
	}
}

/**
 * Read a rebase's step counter out of two single-integer marker files in its state directory.
 */
export async function readRebaseProgress(stepFile: string, totalFile: string, env: Pick<OperationStateEnv, 'readIntFile'>): Promise<{ step: number, total: number } | null> {
	const [step, total] = await Promise.all([env.readIntFile(stepFile), env.readIntFile(totalFile)]);
	return step !== null && total !== null ? { step, total } : null;
}
