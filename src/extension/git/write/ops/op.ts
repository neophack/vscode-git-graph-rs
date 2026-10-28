/**
 * The write-operation record type: every repository write
 * expressed as pure data. An op function takes parameters (any value Git would otherwise have to
 * be consulted for is passed in by the caller), returns a `WriteOp`, and touches no process, no
 * configuration and no vscode API.
 */

import type { GitCapability } from '../../executable/capabilities';

/**
 * How a value handed to Git positionally must look, for the argument-injection check;
 * `argSafety.ts` is the single place that interprets the kinds and validates the values.
 */
export type ArgKind = 'hash' | 'ref' | 'stash' | 'url';

/** One `[argumentName, value, kind]` check, as `checkUnsafeGitArgs` receives them. */
export type ArgCheck = readonly [name: string, value: string | null | undefined, kind: ArgKind];

/**
 * What an operation can change about the repository, for the impact-based refresh.
 * The single definition lives in the shared protocol (where the
 * per-command aggregate table `WRITE_EFFECTS` also lives); re-exported here so the op table's
 * `effects` fields speak the local vocabulary without a second union to keep in sync.
 */
import type { WriteEffect } from '../../../../shared/protocol/graphView';

export type { WriteEffect };

/**
 * One Git invocation within an operation. Steps run in order and stop at the first failure,
 * except where the step opts out:
 * - `bestEffort`: a failure is ignored and the sequence continues (the cleanup spawns);
 * - `tolerance`: a failure whose stderr contains this substring does not abort the sequence
 *   (e.g. `remote ref does not exist` when deleting a remote tag).
 */
export interface WriteStep {
	readonly argv: ReadonlyArray<string>;
	/**
	 * Environment variables layered over the inherited process environment for this one
	 * invocation (they win, after the askpass variables): for neutralising an inherited setting
	 * that outranks the argv's own `-c` configuration — e.g. `GIT_EDITOR` outranks
	 * `core.editor`, so the headless-editor no-op needs both spellings.
	 */
	readonly env?: { readonly [name: string]: string };
	readonly bestEffort?: boolean;
	readonly tolerance?: string;
}

/**
 * The refusal i18n keys: when `WriteOp.refusal` is one of these, the GitWriter localises it
 * through its injected `t`; any other refusal string is the final message already (the few
 * refusals without an i18n key are fixed English strings).
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
