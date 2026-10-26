import { AutomationAction } from './catalog/types';
import { expandTemplate, validateCatalog } from './catalog';
import { GitAssertion, GitStateProbe } from './gitStateProbe';
import type { ScriptedAnswer } from './scriptedUiPort';

/**
 * The scenario layer (REFACTOR-PLAN §6.8.3, task 4.10): the catalog's actions grown into
 * scenarios. A scenario is an EXISTING catalog action (or an inline action with the same shape)
 * plus the four §6.8.3 dimensions the action form lacks:
 *
 *   given   — the fixture/setting/branch state the executor must establish first;
 *   when    — the action's own drive path (ui / request / vscodeCommand), unchanged;
 *   answers — the ScriptedUiPort's answers to the native dialogs the when-path raises;
 *   then    — the assertions: then.git (GitStateProbe over the REAL repository), then.dom,
 *             then.responses, then.refreshes and noErrors.
 *
 * scenario() is the single constructor: it validates at LOAD time (a scenario without tags does
 * not load at all) and the assembled registry (scenarios/index.ts) re-validates the invariants
 * that only hold across entries — unique ids, every write scenario carrying then.git, and the
 * write-operation coverage the 4.10 acceptance criteria gate on.
 */

/** The pre-state a scenario declares (§6.8.3 `given`); the executor establishes it before the run. */
export interface ScenarioGiven {
	/** The fixture to seed; only 'standard' (src/automation/fixture.ts's seeded clone) exists today. */
	readonly fixture?: 'standard';
	/** Settings to apply before the run (`git-graph-rs.*` keys, ConfigurationTarget.Global). */
	readonly settings?: Readonly<Record<string, unknown>>;
	/** The branch to check out before the run ('main' when omitted). */
	readonly branch?: string;
	/**
	 * With `branch`: create that branch at the repository's ROOT commit (rev-list
	 * --max-parents=0) and check it out — the state operations that can only fail on a
	 * parentless HEAD (undoLastCommit's `reset --soft HEAD^`) need.
	 */
	readonly at?: 'root';
	/**
	 * Repo-local git config to set (string) or unset (NULL) before the run — the precise
	 * pre-states the failure paths need (no committer identity, no branch upstream).
	 */
	readonly config?: Readonly<Record<string, string | null>>;
	/**
	 * A prepared repository state the plain settings cannot express (the executor's documented
	 * recipes; each leaves `main` checked out afterwards unless named):
	 * - 'merge-conflict': branches `automation-conflict-ours` (checked out) and
	 *   `automation-conflict-theirs` both edit the same line of the same tracked file, and a
	 *   `git merge automation-conflict-theirs` has been started and left CONFLICTED.
	 * - 'merge-conflict-resolved': the same, with the conflict resolved and staged — ready for
	 *   `git merge --continue` (the run env pins GIT_EDITOR so the continue commits headlessly).
	 */
	readonly state?: 'merge-conflict' | 'merge-conflict-resolved';
}

/** One DOM expectation of then.dom, judged in the live webview by the E2E runner's shim. */
export type DomExpectation =
	| { readonly present: string }
	| { readonly absent: string }
	| { readonly text: string; readonly contains: string | readonly string[] };

/** The assertions of a scenario (§6.8.3 `then`). */
export interface ScenarioThen {
	/** Response commands that must have arrived; defaults to the action's own expect.responses. */
	readonly responses?: readonly string[];
	/** GitStateProbe assertions against the repository's real state. */
	readonly git?: readonly GitAssertion[];
	/** DOM expectations judged in the webview after the run. */
	readonly dom?: readonly DomExpectation[];
	/** How many view refreshes (loadCommits responses) the run must have caused. */
	readonly refreshes?: number;
	/** TRUE => no error may sit in the host log or the webview console for the run. */
	readonly noErrors?: boolean;
}

/**
 * A catalog action grown into a scenario: the action's own fields (id, tags, drive paths,
 * expect, ...) unchanged, plus given / answers / then. Scenarios are NOT added to the pinned
 * CATALOG — they reference it — so the action snapshot contract stays intact while the
 * scenario registry grows independently.
 */
export interface AutomationScenario extends AutomationAction {
	readonly given?: ScenarioGiven;
	/** The ScriptedUiPort's answers to the native dialogs the when-path raises, in order. */
	readonly answers?: readonly ScriptedAnswer[];
	readonly then: ScenarioThen;
	/**
	 * The write-op factories (src/extension/git/write/ops/*.ts export names) this scenario
	 * exercises — the explicit op-coverage mapping the 4.10 acceptance counts then.git
	 * assertions against (the protocol command names alone cannot express it: worktreeAdd's op
	 * is addWorktree, the merge flow reaches commitSquashFromMerge only with squash set, ...).
	 */
	readonly ops?: readonly string[];
}

/** What scenario() adds over the action it wraps. */
export interface ScenarioExtras {
	readonly given?: ScenarioGiven;
	readonly answers?: readonly ScriptedAnswer[];
	readonly then: ScenarioThen;
	readonly ops?: readonly string[];
	/**
	 * Replacement tags (validated like the action's own: the group at minimum). Used to add
	 * cross-cutting tags a wrapped catalog action cannot carry — 'smoke' for the smoke tier's
	 * S1–S9 equivalents, 'failure' for the failure-path variants.
	 */
	readonly tags?: readonly string[];
	/**
	 * Replacement allowErrorOn (same semantics as the action field): the failure scenarios whose
	 * DESIGNED outcome is git's refusal list the response command here, so then.responses
	 * accepts the error payload as the expected outcome.
	 */
	readonly allowErrorOn?: readonly string[];
	/**
	 * Replacement id, for wrapping the SAME catalog action twice (e.g. once for the confirm
	 * branch and once for the cancel branch of the dialog it opens). Validated to keep the
	 * dotted `<group>/<name>` shape.
	 */
	readonly id?: string;
}

/**
 * The authoring shape of scenario()'s first argument: a catalog action (wrapped via
 * {@see byId}) or an inline action literal, which may additionally carry `given` and `answers`
 * inline — the natural position when the action literal is the scenario's own.
 */
export type ScenarioAction = AutomationAction & {
	readonly given?: ScenarioGiven;
	readonly answers?: readonly ScriptedAnswer[];
};

/**
 * Wrap a catalog action (or an inline action literal with the same shape) into a scenario.
 * Validates immediately — the constructor is the load gate: a malformed scenario (no tags, no
 * then, a write scenario without then.git, an unknown assertion kind) throws instead of
 * entering the registry.
 */
export function scenario(action: ScenarioAction, extras: ScenarioExtras): AutomationScenario {
	for (const problem of validateCatalog([action])) {
		throw new Error('Scenario ' + action.id + ': ' + problem);
	}
	if (extras.tags !== undefined) {
		const tagged = { ...action, tags: extras.tags };
		for (const problem of validateCatalog([tagged])) {
			throw new Error('Scenario ' + action.id + ' (scenario tags): ' + problem);
		}
	}
	if (extras.allowErrorOn !== undefined) {
		for (const command of extras.allowErrorOn) {
			if (!action.expect.responses.includes(command)) {
				throw new Error('Scenario ' + action.id + ': allowErrorOn lists "' + command + '", which is not an expected response');
			}
		}
	}
	if (extras.id !== undefined) {
		const dotted = extras.id.split('/');
		// The replacement keeps the dotted <group>/<name> shape, with the group either the
		// action's own or one the scenario's tags carry (the smoke tier re-ids wrapped actions
		// as smoke/S1…S9 per §6.6 while keeping their original group in the tags).
		const allowedGroups = extras.tags ?? [action.group];
		if (dotted.length !== 2 || dotted[1].trim() === '' || !allowedGroups.includes(dotted[0])) {
			throw new Error('Scenario ' + action.id + ': replacement id "' + extras.id + '" must keep the <group>/<name> shape (group one of ' + allowedGroups.join(', ') + ')');
		}
	}
	if (extras.then === undefined || extras.then === null) {
		throw new Error('Scenario ' + action.id + ': missing then (a scenario without assertions is a bare action)');
	}
	const then = extras.then;
	const assertionCount = (then.git?.length ?? 0) + (then.dom?.length ?? 0) + (then.responses?.length ?? 0)
		+ (then.refreshes !== undefined ? 1 : 0) + (then.noErrors === true ? 1 : 0);
	if (assertionCount === 0 && action.expect.responses.length === 0) {
		throw new Error('Scenario ' + action.id + ': then declares no assertions');
	}
	if (action.mutable && (then.git?.length ?? 0) === 0) {
		throw new Error('Scenario ' + action.id + ': every write scenario must assert then.git (the repository\'s real state)');
	}
	if (then.git !== undefined) {
		for (const [index, assertion] of then.git.entries()) {
			if (!GIT_ASSERTION_KINDS.has(assertion.kind)) {
				throw new Error('Scenario ' + action.id + ': unknown then.git assertion kind "' + assertion.kind + '" (entry ' + index + ')');
			}
		}
	}
	if (then.dom !== undefined) {
		for (const [index, expectation] of then.dom.entries()) {
			const keys = Object.keys(expectation);
			const ok = (keys.length === 1 && (keys[0] === 'present' || keys[0] === 'absent'))
				|| (keys.length === 2 && keys.includes('text') && keys.includes('contains'));
			if (!ok || (keys.length === 1 && typeof (expectation as { present?: unknown }).present !== 'string'
				&& typeof (expectation as { absent?: unknown }).absent !== 'string')) {
				throw new Error('Scenario ' + action.id + ': malformed then.dom entry ' + index + ' (present | absent | text+contains)');
			}
		}
	}
	return {
		...action,
		id: extras.id ?? action.id,
		tags: extras.tags ?? action.tags,
		allowErrorOn: extras.allowErrorOn ?? action.allowErrorOn,
		given: extras.given ?? action.given,
		answers: extras.answers ?? action.answers,
		then,
		ops: extras.ops
	};
}

/** The then.git assertion kinds (kept in lockstep with GitAssertion by the probe's type test). */
const GIT_ASSERTION_KINDS: ReadonlySet<string> = new Set([
	'refPresent', 'refAbsent', 'upstreamIs', 'headIs', 'commitCount', 'commitMessages',
	'worktreeStatus', 'stashCount', 'configValue', 'remotePresent', 'remoteAbsent'
]);

/**
 * Find a catalog action by id for scenario wiring. Throws at LOAD time when the action is
 * missing — a renamed or removed catalog action must fail the registry's import, not silently
 * drop its scenarios.
 */
export function byId(actions: readonly AutomationAction[], id: string): AutomationAction {
	const found = actions.find((action) => action.id === id);
	if (found === undefined) throw new Error('Scenario wiring: catalog action "' + id + '" not found');
	return found;
}

/**
 * Validate a whole scenario registry (the invariants that hold only across entries). Returns
 * the problems found — the assembled registry THROWS on any (the load gate the tests pin).
 */
export function validateScenarios(scenarios: readonly AutomationScenario[]): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	for (const entry of scenarios) {
		const where = 'scenario "' + entry.id + '"';
		if (ids.has(entry.id)) problems.push(where + ': duplicate id');
		ids.add(entry.id);
		if (!Array.isArray(entry.tags) || entry.tags.length === 0) {
			problems.push(where + ': missing tags (a scenario without tags must not load)');
		} else if (!entry.tags.includes(entry.group)) {
			problems.push(where + ': tags must include the scenario\'s own group "' + entry.group + '"');
		}
		if (entry.mutable && (entry.then.git?.length ?? 0) === 0) {
			problems.push(where + ': a write scenario must carry at least one then.git assertion');
		}
	}
	return problems;
}

/**
 * Count the then.git assertions across a registry — the number the 4.10 acceptance gates at
 * ≥ 82 (all write operations with success AND failure scenarios).
 */
export function countGitAssertions(scenarios: readonly AutomationScenario[]): number {
	let total = 0;
	for (const entry of scenarios) total += entry.then.git?.length ?? 0;
	return total;
}

/* ---------------- Then-evaluation (the piece every executor calls) ---------------- */

/** What one executed scenario leaves behind, gathered by the runner while the when-path ran. */
export interface ScenarioArtifacts {
	/** TRUE when the drive itself completed without error. */
	readonly runOk: boolean;
	/** The drive's error text, when runOk is false. */
	readonly runError: string | null;
	/** Every host response that arrived while the scenario ran, with its error payload. */
	readonly seenResponses: readonly { readonly command: string; readonly error: string | null }[];
	/** How many loadCommits refreshes the run caused (the then.refreshes judgment). */
	readonly refreshCount: number;
	/** Error lines the host logged while the scenario ran (the noErrors judgment). */
	readonly hostErrors: readonly string[];
}

/** How the executor judges a DOM expectation: resolves NULL when it holds, a failure otherwise. */
export type DomChecker = (expectation: DomExpectation) => Promise<string | null>;

/**
 * Evaluate a scenario's then-block against the artifacts of its run. Pure logic plus the two
 * injected judges (the GitStateProbe and the DOM checker), so the vitest suite exercises every
 * judgment without a live editor. Resolves the failures found, in then-field order — empty
 * means the scenario passed.
 */
export async function evaluateThen(
	entry: AutomationScenario,
	artifacts: ScenarioArtifacts,
	probe: GitStateProbe,
	dom: DomChecker,
	context: Record<string, string> = {}
): Promise<readonly string[]> {
	const failures: string[] = [];
	// responses: the commands that must have arrived (defaults to the action's own expectation).
	const expectedResponses = entry.then.responses ?? entry.expect.responses;
	for (const command of expectedResponses) {
		const seen = artifacts.seenResponses.find((response) => response.command === command);
		if (seen === undefined) failures.push('responses: expected a "' + command + '" response, none arrived');
		else if (seen.error !== null && !(entry.allowErrorOn ?? []).includes(command)) {
			failures.push('responses: "' + command + '" arrived with an error: ' + seen.error);
		}
	}
	// git: every assertion, placeholders expanded against the run context.
	if (entry.then.git !== undefined && entry.then.git.length > 0) {
		const expanded = expandTemplate(entry.then.git as unknown[], context) as unknown as readonly GitAssertion[];
		const failure = await probe.assertAll(expanded);
		if (failure !== null) failures.push(failure);
	}
	// dom: delegated to the executor's checker.
	for (const expectation of entry.then.dom ?? []) {
		const failure = await dom(expandTemplate(expectation as unknown as DomExpectation, context));
		if (failure !== null) failures.push('dom: ' + failure);
	}
	// refreshes: exactly the declared count of loadCommits responses.
	if (entry.then.refreshes !== undefined && artifacts.refreshCount !== entry.then.refreshes) {
		failures.push('refreshes: expected ' + entry.then.refreshes + ', observed ' + artifacts.refreshCount);
	}
	// noErrors: nothing in the host error log and no failed drive.
	if (entry.then.noErrors === true) {
		if (!artifacts.runOk) failures.push('noErrors: the run itself failed: ' + (artifacts.runError ?? 'unknown'));
		if (artifacts.hostErrors.length > 0) failures.push('noErrors: host logged ' + artifacts.hostErrors.length + ' error(s): ' + artifacts.hostErrors.join(' | ').slice(0, 400));
	}
	return failures;
}
