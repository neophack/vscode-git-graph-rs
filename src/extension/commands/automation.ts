import * as vscode from 'vscode';
import { t } from '../../i18n';
import { showErrorMessage } from '../../utils/actions';
import type { AutomationAction } from '../../automation/catalog';
import type { AutomationModules } from '../../automation/modules';
import type { CommandHost } from './context';

/* The automation-testing capability is a compile-time build variant (task 6.2): the dist build
 * defines __AUTOMATION__ through the gate in src/automation/modules.ts, which either bundles
 * the modules in (the automation build) or dead-code-eliminates the requires entirely (the
 * default build — no automation code in the bundle). The out/ (tsc) tree keeps the v1.0
 * load-when-present behavior: the default packaging variant removes out/automation/ WHOLE,
 * so the gate module's own require sits in a try/catch — its absence IS the "not an automation
 * build" signal. */
let automation: AutomationModules | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { loadAutomationModules } = require('../../automation/modules') as typeof import('../../automation/modules');
	automation = loadAutomationModules();
} catch { /* the automation modules are absent from this build: not an error */ }

/**
 * The automation build's `git-graph-rs.runAutomationTest` command. The CommandManager only
 * registers it when {@link automationAvailable} reports the automation modules as loaded.
 *
 * Two callers share it:
 *  - the editor-title button calls it with NO argument: the full catalog runs against the view's
 *    current repository and the report opens in a webview;
 *  - the E2E entry (test/e2e/entry.ts) calls it with a machine request (below): a subset run, a
 *    page eval or a state probe, answered with JSON-cloneable data instead of UI. The request
 *    crosses `executeCommand`, so it is validated defensively — it is data from another module,
 *    not a trusted in-process call.
 */

/** Machine-driven suite request: run a selected subset of the catalog and return the report. */
export interface AutomationE2eSuiteRequest {
	readonly e2eSuite: true;
	/** Repository to run against (defaults to the view's current repository). */
	readonly repo?: string;
	/** Restrict the run to these action ids (a hard restriction — see {@see buildFilter}). */
	readonly actionIds?: readonly string[];
	/** Additionally require one of these tags (the affected tier's domain selection). */
	readonly includeTags?: readonly string[];
	/** Drop actions carrying any of these tags. */
	readonly excludeTags?: readonly string[];
	readonly actionTimeoutMs?: number;
	readonly skipWriteSuite?: boolean;
	readonly fixtureOptions?: { commits?: number; branches?: number; tags?: number; authors?: number; mergeRate?: number; seed?: number };
}

/** Machine-driven page eval: evaluate one expression in the live webview page. */
export interface AutomationE2eEvalRequest {
	readonly e2eEval: string;
}

/** Machine-driven state probe: snapshot the live view, host log and editor version. */
export interface AutomationE2eProbeRequest {
	readonly e2eProbe: true;
}

export type AutomationTestRequest = AutomationE2eSuiteRequest | AutomationE2eEvalRequest | AutomationE2eProbeRequest;

/**
 * Whether the automation modules are present in this build (only the automation build's
 * packaging keeps them).
 */
export function automationAvailable(): boolean {
	return automation !== null;
}

/** Structural guard: a plain, non-null object (what JSON-shaped command arguments arrive as). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The suite-selection predicate for a machine request: `actionIds` (when given) is a hard
 * restriction, `includeTags`/`excludeTags` refine within it. Undefined when the request
 * selects nothing — the whole catalog runs.
 */
function buildFilter(request: Record<string, unknown> | undefined): ((action: AutomationAction) => boolean) | undefined {
	const ids = request?.actionIds;
	const include = request?.includeTags;
	const exclude = request?.excludeTags;
	if (ids === undefined && include === undefined && exclude === undefined) return undefined;
	const idList = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : undefined;
	const includeList = Array.isArray(include) ? include.filter((tag): tag is string => typeof tag === 'string') : undefined;
	const excludeList = Array.isArray(exclude) ? exclude.filter((tag): tag is string => typeof tag === 'string') : undefined;
	return (action) => {
		if (idList !== undefined && !idList.includes(action.id)) return false;
		if (includeList !== undefined && !action.tags.some((tag) => includeList.includes(tag))) return false;
		if (excludeList !== undefined && action.tags.some((tag) => excludeList.includes(tag))) return false;
		return true;
	};
}

/**
 * The numeric fixture-generation knobs a machine request may override (fixture.ts's
 * FixtureOptions, restricted to the JSON-safe subset the entry sends). Non-numeric entries are
 * dropped — the suite's own defaults apply.
 */
function numericFixtureOptions(source: unknown): Record<string, number> | undefined {
	if (!isPlainObject(source)) return undefined;
	const out: Record<string, number> = {};
	for (const key of ['commits', 'branches', 'tags', 'authors', 'mergeRate', 'seed'] as const) {
		const value = source[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Run the automation test suite against the Git Graph view (in-process; no external driver).
 * The write suite runs when the active repository is safe to mutate — a fixture clone (rebuilt
 * from its bare remote first) or a repository with no commits at all (the fixture history is
 * generated into it first).
 * @param host The services the command runs with.
 * @param request A machine-driven request (the E2E entry), or undefined for the button's full run.
 * @returns The suite report for machine requests; `undefined` for the button's run (its outcome
 *          is the report webview / the error notification).
 */
export async function runAutomationTest(host: CommandHost, request?: unknown): Promise<unknown> {
	const modules = automation;
	if (modules === null) return undefined;
	const machine = isPlainObject(request) ? request : undefined;

	// The observational machine modes (§6.8.1's entry needs eyes, not a second module copy).
	if (machine !== undefined && typeof machine.e2eEval === 'string') return modules.e2eEvalPage(host.logger, machine.e2eEval);
	if (machine !== undefined && machine.e2eProbe === true) return modules.e2eProbe(host.logger);

	try {
		const report = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: t('automationTestRunning'),
			cancellable: false
		}, () => modules.runAutomationSuite({
			logger: host.logger,
			repo: typeof machine?.repo === 'string' && machine.repo !== '' ? machine.repo : undefined,
			actionTimeoutMs: typeof machine?.actionTimeoutMs === 'number' ? machine.actionTimeoutMs : undefined,
			skipWriteSuite: machine?.skipWriteSuite === true ? true : undefined,
			fixtureOptions: numericFixtureOptions(machine?.fixtureOptions),
			filter: buildFilter(machine),
			// The fixture's submodule becomes a known repository the moment it is seeded: a
			// repository materialised mid-session is never discovered on its own (both the
			// workspace scan and the submodule scan skip paths inside a known repository).
			registerRepo: async (repo) => {
				if (!host.repoManager.isKnownRepo(repo)) await host.repoManager.registerRepo(repo, false);
			}
		}));
		if (machine !== undefined) return report;
		modules.showAutomationReport(report);
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (machine !== undefined) return { e2eError: message };
		showErrorMessage(t('automationTestFailedToStart', message));
		return undefined;
	}
}
