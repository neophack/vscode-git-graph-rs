import { commandFailure } from '../git/write/gitWriter';
import type { GitProcess, RunResult } from '../git/process/gitProcess';
import type { GerritChangeState, ErrorInfo } from '../../types';

/**
 * The raw Git runner of the graph view: the spawn seam behind the few actions the read backend
 * and the pure write-op table cannot express (the interactive-rebase handoff, the external diff
 * tool, the batched `update-ref --stdin` of the Gerrit integration). Structurally the
 * `GitRunner` src/extension/integrations/gerrit/gerrit.ts builds its `GerritDataSource` over, so
 * the same instance backs both.
 *
 * Every member rejects with the legacy `getErrorMessage` shape (stderr + stdout, split on line
 * ends, the trailing empty element dropped) exactly as `DataSource._spawnGit` did.
 */
export interface GitRunnerPort {
	/** Spawn Git, resolving the value parsed out of its stdout; rejecting when it fails. */
	gitOutput<T>(args: ReadonlyArray<string>, repo: string, resolveValue: (stdout: string) => T): Promise<T>;
	/**
	 * Spawn Git, resolving the value parsed out of its combined stdout AND stderr; rejecting when
	 * it fails. `git push` writes its human-readable report — including a Gerrit change URL — to
	 * stderr, so callers that mine both streams need this form.
	 */
	gitOutputWithStderr<T>(args: ReadonlyArray<string>, repo: string, resolveValue: (stdout: string, stderr: string) => T): Promise<T>;
	/** Run a Git command, resolving the legacy `ErrorInfo` (NULL => success). */
	runGitCommand(args: ReadonlyArray<string>, repo: string): Promise<ErrorInfo>;
	/** Run a Git command fed a command stream on stdin (e.g. `update-ref --stdin`). */
	runGitCommandWithInput(args: ReadonlyArray<string>, repo: string, input: string): Promise<ErrorInfo>;
	/**
	 * Run Git and collect the raw result (exit code whatever it is), for flows that decide from
	 * the output or tolerate a failure — the editor-script rebase of `editCommitMessage`.
	 */
	collect(args: ReadonlyArray<string>, repo: string, options?: { readonly env?: { readonly [name: string]: string }; readonly input?: string }): Promise<RunResult>;
	/** Whether a Git executable is known (the read path may run on the engine without one). */
	hasGit(): boolean;
	/** The path of the Git executable, or NULL when none was found (the terminal/difftool handoffs). */
	gitPath(): string | null;
	/**
	 * The Rust-engine NoteDb meta parser (one in-process pass over the warm handle), or NULL when
	 * no engine is loaded — the Gerrit integration then runs its Git CLI fallback.
	 */
	parseGerritMetas: ((repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null) => Promise<ReadonlyArray<GerritChangeState | null>>) | null;
	/**
	 * The Rust-engine local change-ref scan (`refs/remotes/<remote>/changes/**`), or NULL when no
	 * engine is loaded — the integration then lists them with `git for-each-ref`.
	 */
	listChangeRefs: ((repo: string, remote: string) => Promise<ReadonlyArray<readonly [string, string]>>) | null;
}

/** The failure message of a runner spawn, mirroring the legacy `getErrorMessage`. */
function spawnFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The localizer the runner needs for the one no-Git case (injected, so this module stays vscode-free). */
export type RunnerLocalize = (key: 'unableToFindGit') => string;

/**
 * Build the view's runner over the composition root's `GitProcess` (which owns the askpass
 * environment and follows the current Git executable), plus the engine handle for the two Gerrit
 * fast paths (NULL on a machine without the engine binary — the integration's CLI fallbacks then
 * serve those reads, as they always have).
 */
export function createGitRunner(process: GitProcess, engine: GitRunnerParseMetas | null, t: RunnerLocalize): GitRunnerPort {
	return {
		gitOutput: <T>(args: ReadonlyArray<string>, repo: string, resolveValue: (stdout: string) => T) => process.run(args, { cwd: repo }).then(
			(result) => {
				if (result.code !== 0) throw commandFailure(result);
				return resolveValue(result.stdout.toString('utf8'));
			},
			(error) => { throw isNoGit(error) ? new Error(t('unableToFindGit')) : new Error(spawnFailure(error)); }
		),
		gitOutputWithStderr: <T>(args: ReadonlyArray<string>, repo: string, resolveValue: (stdout: string, stderr: string) => T) => process.run(args, { cwd: repo }).then(
			(result) => {
				if (result.code !== 0) throw commandFailure(result);
				return resolveValue(result.stdout.toString('utf8'), result.stderr);
			},
			(error) => { throw isNoGit(error) ? new Error(t('unableToFindGit')) : new Error(spawnFailure(error)); }
		),
		runGitCommand: (args, repo) => process.run(args, { cwd: repo }).then(
			(result) => result.code === 0 ? null : commandFailure(result),
			(error) => isNoGit(error) ? t('unableToFindGit') : spawnFailure(error)
		),
		runGitCommandWithInput: (args, repo, input) => process.run(args, { cwd: repo, input }).then(
			(result) => result.code === 0 ? null : commandFailure(result),
			(error) => isNoGit(error) ? t('unableToFindGit') : spawnFailure(error)
		),
		collect: (args, repo, options) => process.run(args, {
			cwd: repo,
			env: options?.env,
			input: options?.input
		}),
		hasGit: () => process.git !== null,
		gitPath: () => process.git !== null ? process.git.path : null,
		parseGerritMetas: engine === null ? null : (repo, remote, changes, urlBase) => engine.parseGerritMetas(repo, remote, changes, urlBase),
		listChangeRefs: engine === null ? null : (repo, remote) => engine.listChangeRefs(repo, remote)
	};
}

/** Whether an error is the runner's "no Git executable" rejection. */
function isNoGit(error: unknown): boolean {
	return error instanceof Error && error.message.indexOf('No Git executable was found') === 0;
}

/** The structural slice of `NativeBackend` the runner's engine fast paths need. */
export interface GitRunnerParseMetas {
	parseGerritMetas(repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null): Promise<ReadonlyArray<GerritChangeState | null>>;
	listChangeRefs(repo: string, remote: string): Promise<ReadonlyArray<readonly [string, string]>>;
}

/**
 * The two auxiliary webviews the view opens, which still hold a legacy `DataSource` (their
 * controllers move in Phase 6): the port is composed in extension.ts, where the instance lives,
 * so no graphView module imports `src/dataSource`.
 */
export interface LegacyViewPort {
	openCompareTab(extensionPath: string, repo: string, fromHash: string, toHash: string, singleCommit: boolean): void;
	openBinaryCompare(extensionPath: string, repo: string, fromHash: string, toHash: string, file: {
		readonly oldFilePath: string;
		readonly newFilePath: string;
		readonly type: import('../../types').GitFileStatus;
		readonly additions: number | null;
		readonly deletions: number | null;
	}): void;
}
