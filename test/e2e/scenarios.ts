/**
 * The scenario layer (§6.8.3): the smoke checklist S1–S9 (plan §6 baseline, executed
 * automatically from task 1.10 on) plus the smoke tier's per-domain catalog picks, expressed in
 * the scenario schema the catalog is being converted into — `id` / `tags` / `given` / `when` /
 * `answers` / `then`. While the catalog conversion is in flight, `when.legacy` scenarios run
 * through the compatibility adapter (legacyAdapter.ts); `when.procedure` scenarios are named
 * procedures the entry implements against the in-host hooks.
 */

import { E2eOptions, Tier } from './types';
import { AffectedTarget } from './affected';

/** §6.8.3's given block (the fixture is 'standard' for every scenario at this stage). */
export interface ScenarioGiven {
	readonly fixture?: 'standard';
	readonly settings?: Readonly<Record<string, unknown>>;
	readonly branch?: string;
}

/**
 * §6.8.3's when block. `legacy` names catalog actions the compatibility adapter runs through
 * the existing suite runner (with all of its state mechanics); `procedure` names an entry-side
 * procedure (the S-items the catalog does not model yet).
 */
export type ScenarioWhen =
	| { readonly legacy: { readonly actionIds: readonly string[] } }
	| { readonly procedure: string };

/** §6.8.3's answers block — ScriptedUiPort answers, which land with task 4.10. Kept empty. */
export type ScenarioAnswers = readonly unknown[];

/** §6.8.3's then block (assertions are the engine's expect/verify for legacy runs). */
export interface ScenarioThen {
	readonly responses?: readonly string[];
	readonly git?: readonly { readonly kind: string; readonly name?: string }[];
	readonly dom?: readonly { readonly selector: string }[];
	readonly noErrors?: boolean;
}

/** One scenario (§6.8.3 schema, compat-adapter dialect). */
export interface Scenario {
	readonly id: string;
	readonly title: string;
	readonly tags: readonly string[];
	readonly given?: ScenarioGiven;
	readonly when: ScenarioWhen;
	readonly then?: ScenarioThen;
	readonly answers?: ScenarioAnswers;
	/**
	 * NULL when the scenario can run under `options`; otherwise the documented skip reason
	 * (e.g. S9's engine-missing check only meaningfully runs under --backend cli).
	 */
	readonly availability?: (options: E2eOptions) => string | null;
}

/** The smoke checklist S1–S9 as scenarios (REFACTOR-PLAN §6, lines 645–657). */
export const SMOKE_CHECKLIST: readonly Scenario[] = [
	{
		id: 'smoke/S1', title: 'Open the Git Graph view — the commit graph loads without error dialogs', tags: ['smoke', 'view'],
		given: { fixture: 'standard' },
		when: { procedure: 'open-view-load' },
		then: { dom: [{ selector: 'tr.commit' }], noErrors: true }
	},
	{
		id: 'smoke/S2', title: 'Scroll/load more in a 1000+ commit repository — rows continue seamlessly', tags: ['smoke', 'control-bar'],
		given: { fixture: 'standard' },
		when: { legacy: { actionIds: ['control-bar/load-more-commits'] } },
		then: { responses: ['loadCommits'] }
	},
	{
		id: 'smoke/S3', title: 'Expand a commit\'s details and open one file\'s diff', tags: ['smoke', 'cdv'],
		given: { fixture: 'standard' },
		when: { legacy: { actionIds: ['row/select-commit-row', 'cdv/file-view-tree', 'cdv/file-view-diff'] } },
		then: { responses: ['commitDetails', 'getCommitFileContent'] }
	},
	{
		id: 'smoke/S4', title: 'Context-click a branch and check it out — the HEAD marker moves', tags: ['smoke', 'menu-branch'],
		given: { fixture: 'standard', branch: 'local-ahead' },
		when: { legacy: { actionIds: ['menu-branch/checkout'] } },
		then: { git: [{ kind: 'headIs', name: 'local-ahead' }] }
	},
	{
		id: 'smoke/S5', title: 'Create a tag, then delete it — both show up in the graph', tags: ['smoke', 'menu-commit', 'menu-tag'],
		given: { fixture: 'standard' },
		when: { legacy: { actionIds: ['menu-commit/add-tag', 'menu-tag/delete'] } },
		then: { git: [{ kind: 'tagAbsent', name: 'v-e2e-smoke' }] }
	},
	{
		id: 'smoke/S6', title: 'Push to an HTTPS remote that needs credentials (askpass path)', tags: ['smoke', 'askpass', 'menu-branch'],
		given: { fixture: 'standard' },
		when: { procedure: 'credential-prompt' }
	},
	{
		id: 'smoke/S7', title: 'The panel recovers with its repository after being closed (restart approximation)', tags: ['smoke', 'view'],
		given: { fixture: 'standard' },
		when: { procedure: 'panel-close-reopen' }
	},
	{
		id: 'smoke/S8', title: 'Switch the UI language to zh-cn — controls render Chinese', tags: ['smoke', 'i18n'],
		given: { fixture: 'standard' },
		when: { procedure: 'language-zh-cn' },
		then: { dom: [{ selector: '#refreshBtn[title$="刷新"]' }] }
	},
	{
		id: 'smoke/S9', title: 'Engine binaries absent — the extension still loads over the git CLI', tags: ['smoke', 'backend'],
		given: { fixture: 'standard' },
		when: { procedure: 'engine-missing' },
		availability: (options) => options.backend === 'cli' ? null
			: 'only meaningfully verifiable in a --backend cli run (the engine binaries are present in this run); the CLI run covers S1–S4 by construction'
	}
];

/**
 * The smoke tier's per-domain catalog picks beyond S1–S9 (§6.8.5: "the most critical scenario
 * per domain"). Kept to one or two reads and one write per domain to fit the ≤ 8-minute budget;
 * 'control-bar/refresh' doubles as the bootstrap action (its suite run generates the fixture
 * into the empty workspace first — see the entry).
 */
export const SMOKE_PICKS: readonly { readonly actionId: string; readonly domain: string }[] = [
	{ actionId: 'control-bar/refresh', domain: 'control-bar' },
	{ actionId: 'control-bar/fetch-btn', domain: 'control-bar' },
	{ actionId: 'row/compare-rows', domain: 'row' },
	{ actionId: 'settings/show-tags', domain: 'settings' },
	{ actionId: 'find/type-query', domain: 'find' },
	{ actionId: 'keyboard/key-find', domain: 'keyboard' },
	{ actionId: 'reflog/open', domain: 'reflog' },
	{ actionId: 'control-bar/statistics', domain: 'statistics' },
	{ actionId: 'host/open-log-file', domain: 'host' },
	{ actionId: 'menu-vscode/scm-view-button', domain: 'menu-vscode' },
	{ actionId: 'external/commit-appears', domain: 'external' },
	{ actionId: 'menu-branch/push', domain: 'menu-branch' },
	{ actionId: 'menu-stash/apply', domain: 'menu-stash' },
	{ actionId: 'menu-uncommitted/stash', domain: 'menu-uncommitted' },
	{ actionId: 'menu-remote-branch/fetch-into', domain: 'menu-remote-branch' },
	{ actionId: 'settings/open-worktree-dialog', domain: 'worktree' }
];

/** Does `scenario` match a --grep substring (id or tag containment)? */
export function matchesGrep(scenario: Scenario, grep: string | null): boolean {
	if (grep === null || grep === '') return true;
	return scenario.id.indexOf(grep) !== -1 || scenario.tags.some((tag) => tag.indexOf(grep) !== -1);
}

/**
 * The measurement tier's scenarios (OPTIMIZATION-PLAN §7 P2 / D-2): the hidden → visible
 * restore measurement the retainContextWhenHidden default decision needs, with the setting in
 * BOTH positions. Runs under `--tier perf` only — never in the blocking tiers, whose budgets
 * and semantics stay as the plan wrote them. The numbers land in the scenario's detail and in
 * the run's traces.json (each panel re-creation records its boot/session trace).
 */
export const PERF_SCENARIOS: readonly Scenario[] = [
	{
		id: 'perf/D2-restore',
		title: 'D-2: hidden -> visible restore latency, retained vs re-created webview context',
		tags: ['perf'],
		when: { procedure: 'panel-hide-restore' }
	}
];

/** The smoke tier's scenario list (the checklist + the picks), grep-filtered. */
export function smokeScenarios(grep: string | null): readonly Scenario[] {
	const picks = SMOKE_PICKS.map((pick) => ({
		id: pick.actionId,
		title: 'Smoke pick: ' + pick.actionId,
		tags: ['smoke', pick.domain],
		when: { legacy: { actionIds: [pick.actionId] } }
	} as Scenario));
	return [...SMOKE_CHECKLIST, ...picks].filter((scenario) => matchesGrep(scenario, grep));
}

/**
 * The custom (procedure) scenarios a non-smoke tier includes: the checklist items whose tags
 * intersect the affected selection (the full tier takes them all).
 */
export function customsForTier(tier: Tier, target: AffectedTarget | null, grep: string | null): readonly Scenario[] {
	if (tier === 'smoke') return [];
	return SMOKE_CHECKLIST.filter((scenario) => {
		if (!matchesGrep(scenario, grep)) return false;
		if (tier === 'full' || target === null) return true;
		if ('full' in target) return true;
		return scenario.tags.some((tag) => tag !== 'smoke' && target.tags.includes(tag));
	});
}

/** The suite request tags a non-smoke tier hands the runner (null = no tag restriction). */
export function suiteTagsForTarget(target: AffectedTarget | null): readonly string[] | null {
	if (target === null) return null;
	if ('full' in target) return null;
	return target.tags;
}
