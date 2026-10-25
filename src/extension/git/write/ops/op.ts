/**
 * The write-operation record type: every write of the legacy `DataSource` (`src/dataSource.ts`)
 * expressed as pure data. An op function takes parameters (any value Git would otherwise have to
 * be consulted for is passed in by the caller), returns a `WriteOp`, and touches no process, no
 * configuration and no vscode API.
 */

import type { GitCapability } from '../../executable/capabilities';

/**
 * How a value handed to Git positionally must look, for the argument-injection check. The kinds
 * and their validators are the legacy `DataSource.checkUnsafeGitArgs` ones; `argSafety.ts` is the
 * single place that interprets them.
 */
export type ArgKind = 'hash' | 'ref' | 'stash' | 'url';

/** One `[argumentName, value, kind]` check, as the legacy `checkUnsafeGitArgs` received them. */
export type ArgCheck = readonly [name: string, value: string | null | undefined, kind: ArgKind];

/**
 * What an operation can change about the repository, for Phase 4's impact-based refresh
 * (REFACTOR-PLAN §3.8.3/§4.8). The single definition lives in the shared protocol (where the
 * per-command aggregate table `WRITE_EFFECTS` also lives); re-exported here so the op table's
 * `effects` fields speak the local vocabulary without a second union to keep in sync.
 */
import type { WriteEffect } from '../../../../shared/protocol/graphView';

export type { WriteEffect };

/**
 * One Git invocation within an operation. Steps run in order and stop at the first failure,
 * except where the step opts out:
 * - `bestEffort`: a failure is ignored and the sequence continues (the legacy `_spawnGit(...,
 *   ignoreExitCode = true)` cleanup spawns);
 * - `tolerance`: a failure whose stderr contains this substring does not abort the sequence
 *   (the legacy string sniffing, e.g. `remote ref does not exist` when deleting a remote tag).
 */
export interface WriteStep {
	readonly argv: ReadonlyArray<string>;
	readonly bestEffort?: boolean;
	readonly tolerance?: string;
}

/**
 * The refusal i18n keys: when `WriteOp.refusal` is one of these, the GitWriter localises it
 * through its injected `t`; any other refusal string is the final message already (the two
 * places the legacy code returned a hardcoded English string).
 */
export const REFUSAL_I18N_KEYS: ReadonlyArray<string> = ['pruneTagsRequiresPrune'];

/** A write operation, as data. */
export interface WriteOp {
	/** The Git invocations, in order (usually exactly one). */
	readonly steps: ReadonlyArray<WriteStep>;
	readonly effects: ReadonlyArray<WriteEffect>;
	/** Argument-injection checks, run once by the GitWriter before anything else. */
	readonly checks?: ReadonlyArray<ArgCheck>;
	/** The minimum Git capability; the GitWriter checks it before anything runs. */
	readonly requires?: GitCapability;
	/** The operation talks to a remote: the askpass environment is injected. */
	readonly network?: boolean;
	/**
	 * The operation refuses to run for a parameter reason (e.g. `--prune-tags` without
	 * `--prune`): an `REFUSAL_I18N_KEYS` key to localise, or the final message text.
	 */
	readonly refusal?: string;
}

/** Wrap a single Git invocation as the one step of an op. */
export function single(argv: ReadonlyArray<string>): ReadonlyArray<WriteStep> {
	return [{ argv }];
}
