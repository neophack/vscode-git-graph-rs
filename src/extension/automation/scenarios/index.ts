/**
 * The scenario registry: the catalog's actions grown into
 * scenarios, split by domain under ./ and assembled here in a fixed order. Like catalog.ts, the
 * assembly validates the invariants a split could silently break — unique ids, tags on every
 * scenario, a then.git assertion on every write scenario — and throws at import time: a broken
 * registry is broken for every consumer, not just the test that would have caught it.
 *
 * The registry does NOT extend the pinned CATALOG (its snapshot contract stays intact):
 * scenarios REFERENCE catalog actions by id (through byId, a load-time wiring check) or embed
 * inline request-only actions for the surfaces the catalog has not grown yet. The E2E entry
 * (test/e2e/) selects scenarios by tag, drives the when-path through the existing engine,
 * answers native dialogs through the ScriptedUiPort and judges then.* through
 * scenario.ts's evaluateThen + GitStateProbe.
 */

import { AutomationScenario, countGitAssertions, validateScenarios } from '../scenario';
import { BRANCH_SCENARIOS } from './branches';
import { REMOTE_BRANCH_SCENARIOS } from './remoteBranch';
import { COMMIT_SCENARIOS } from './commits';
import { MERGE_REBASE_SCENARIOS } from './mergeRebase';
import { STASH_SCENARIOS } from './stash';
import { TAG_SCENARIOS } from './tags';
import { REMOTES_CONFIG_SCENARIOS } from './remotesConfig';
import { WORKTREE_FILE_SCENARIOS } from './worktreeFiles';
import { SMOKE_SCENARIOS } from './smoke';

/** The assembled scenario registry, in domain order (branches through smoke). */
export const SCENARIOS: readonly AutomationScenario[] = [
	...BRANCH_SCENARIOS,
	...REMOTE_BRANCH_SCENARIOS,
	...COMMIT_SCENARIOS,
	...MERGE_REBASE_SCENARIOS,
	...STASH_SCENARIOS,
	...TAG_SCENARIOS,
	...REMOTES_CONFIG_SCENARIOS,
	...WORKTREE_FILE_SCENARIOS,
	...SMOKE_SCENARIOS
];

/** The then.git assertions across the registry — the count the acceptance gates hold at ≥ 82. */
export const GIT_ASSERTION_COUNT = countGitAssertions(SCENARIOS);

/**
 * Load-time invariant of the registry: every scenario tagged, every id unique, every write
 * scenario asserting then.git. (scenario() already rejected malformed ENTRIES at their
 * construction — this is the cross-entry half.)
 */
const loadProblems = validateScenarios(SCENARIOS);
if (loadProblems.length > 0) {
	throw new Error('Automation scenario registry: ' + loadProblems.join('; '));
}
