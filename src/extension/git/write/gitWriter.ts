/**
 * The GitWriter: the only place a repository is changed. Every write goes through the same steps
 * — argument-injection validation (the single `checkUnsafeGitArgs` call site), the refusal and
 * Git-version gates, the op's argv through the one `GitProcess`, the legacy error mapping, and
 * the repository-changed event — so no write path can skip one of them
 * (REFACTOR-PLAN tasks 3.3/3.8).
 *
 * The writer takes its policies as a structural `WriterConfig` (the subset of the future
 * `ConfigSnapshot` the write path consults), so nothing under `extension/git/**` imports vscode.
 */

import { CAPABILITIES, CapabilityInfo, hasCapability } from '../executable/capabilities';
import type { AbortLike } from '../process/gitProcess';
import { GitProcess, RunResult } from '../process/gitProcess';
import { toGitError } from '../process/errors';
import { checkUnsafeGitArgs, Localize } from './argSafety';
import { ArgCheck, REFUSAL_I18N_KEYS, WriteEffect, WriteOp } from './ops/op';

/**
 * The write-path policies, a structural subset of the future `ConfigSnapshot`: a plain object
 * with these fields satisfies it, whatever its actual type is.
 */
export interface WriterConfig {
	readonly signCommits: boolean;
	readonly signTags: boolean;
}

/** What the writer tells the world after a run: the repository at `repo` may have changed. */
export type RepositoryChangedListener = (repo: string, effects: ReadonlyArray<WriteEffect>) => void;

const EOL_REGEX = /\r\n|\r|\n/g;

export class GitWriter {
	private readonly listeners: RepositoryChangedListener[] = [];

	constructor(
		private readonly process: GitProcess,
		/** The policies in effect (a ConfigSnapshot-shaped value; re-read per run when it changes). */
		private readonly config: () => WriterConfig,
		private readonly t: Localize
	) {}

	/** The write-path policies (the ops read the sign flags from them through their callers). */
	get policies(): WriterConfig {
		return this.config();
	}

	/**
	 * Register a listener fired after every run that reached its commands (succeeded or failed:
	 * a failed merge still changes things) — the hook Phase 4's impact-based refresh uses.
	 */
	onRepositoryChanged(listener: RepositoryChangedListener): { dispose(): void } {
		this.listeners.push(listener);
		return { dispose: () => { this.listeners.splice(this.listeners.indexOf(listener), 1); } };
	}

	/**
	 * Argument-injection validation for values the view must check OUTSIDE a full write op —
	 * the external dir-diff's hashes are interpolated into the integrated terminal's command
	 * line, so they must pass the same gate the ops pass in {@link run} (OPTIMIZATION-PLAN A3:
	 * the handler layer asks the git layer here instead of importing `argSafety` itself).
	 * @returns The localised error message when a value is unsafe, otherwise NULL.
	 */
	checkArgs(...checks: ReadonlyArray<ArgCheck>): string | null {
		return checkUnsafeGitArgs(this.t, ...checks);
	}

	/**
	 * Run a write operation.
	 * @returns The legacy `ErrorInfo`: null on success, the user-facing error message otherwise.
	 */
	async run(repo: string, op: WriteOp, signal?: AbortLike): Promise<string | null> {
		if (op.refusal !== undefined) {
			return REFUSAL_I18N_KEYS.includes(op.refusal) ? this.t(op.refusal) : op.refusal;
		}
		// The single argument-injection gate: every op's values pass through here or nowhere.
		const unsafe = checkUnsafeGitArgs(this.t, ...(op.checks !== undefined ? op.checks : []));
		if (unsafe !== null) return unsafe;

		const git = this.process.git;
		if (git === null) return this.t('unableToFindGit');
		if (op.requires !== undefined && !hasCapability(git.version, op.requires)) {
			const capability: CapabilityInfo = CAPABILITIES[op.requires];
			const feature = capability.featureKey !== undefined ? this.t(capability.featureKey) : this.t('thisFeature');
			return this.t('incompatibleGitVersion', capability.version, feature, git.version);
		}

		let error: string | null = null;
		try {
			for (const step of op.steps) {
				const result = await this.process.run(step.argv, { cwd: repo, signal });
				if (result.code !== 0) {
					const output = result.stderr + result.stdout.toString('utf8');
					const tolerated = step.tolerance !== undefined && output.includes(step.tolerance);
					if (tolerated || step.bestEffort === true) continue;
					error = commandFailure(result);
					break;
				}
			}
		} catch (thrown) {
			const gitError = toGitError(thrown);
			error = gitError.kind === 'noGit' ? this.t('unableToFindGit') : gitError.message;
		}

		for (const listener of this.listeners.slice()) listener(repo, op.effects);
		return error;
	}
}

/**
 * The error message of a Git command that ran and failed: the legacy `getErrorMessage`
 * (`src/dataSource.ts`) verbatim — stderr and stdout concatenated, split on line ends, the last
 * (empty, post-newline) element dropped, the rest joined with `\n`.
 */
export function commandFailure(result: RunResult): string {
	let lines: string[];
	if (result.stdout.length > 0 || result.stderr !== '') {
		lines = (result.stderr + result.stdout.toString('utf8')).split(EOL_REGEX);
		lines.pop();
	} else {
		lines = [];
	}
	return lines.join('\n');
}
