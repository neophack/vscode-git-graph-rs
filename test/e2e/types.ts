/**
 * The E2E harness's shared shapes (plan tasks 0.6/1.10, §6.8.1): the CLI options, the wire
 * mirrors of what crosses `executeCommand` into the bundled automation subsystem, and the
 * scenario/report records the entry produces.
 *
 * The wire mirrors are deliberate STRUCTURAL copies of src/extension/automation and
 * src/extension/commands/automation types, not imports: the entry runs in the same extension
 * host but its own module registry, and a type-only import would still couple this tsconfig to
 * the src tree's. The mirrors live here and are validated against the real shapes by the local
 * run (a mismatch surfaces as a failed scenario, never as a silent pass).
 */

/* ---------------- CLI options (launcher -> entry via E2E_RUN_OPTIONS) ---------------- */

export type Tier = 'smoke' | 'affected' | 'full';
export type Backend = 'engine' | 'cli' | 'nogit';
export type UiLanguage = 'en' | 'zh-cn';

export interface FixtureTuning {
	readonly commits: number;
	readonly branches: number;
	readonly tags: number;
	readonly authors: number;
	readonly mergeRate: number;
	readonly seed: number;
}

/** Everything `npm run test:e2e -- <flags>` accepts (§6.8.5/§6.8.7). */
export interface E2eOptions {
	readonly tier: Tier;
	/** Scenario id/tag substring filter (§6.8.7's --grep). */
	readonly grep: string | null;
	/** VS Code version: 'stable' | 'insiders' | a concrete version like '1.38.0'. */
	readonly vscodeVersion: string;
	readonly backend: Backend;
	readonly lang: UiLanguage;
	/** Show the editor window (the default on desktop OSes; CI runs under xvfb). */
	readonly headed: boolean;
	/** Keep the editor window open after a failing run (debugging; the exit code is then meaningless). */
	readonly keepOpen: boolean;
	/** The ref the affected tier diffs against (default: dev-refactor, or $GITHUB_BASE_REF). */
	readonly base: string;
	readonly actionTimeoutMs: number;
	readonly fixture: FixtureTuning;
}

export const DEFAULT_E2E_OPTIONS: E2eOptions = {
	tier: 'smoke',
	grep: null,
	vscodeVersion: 'stable',
	backend: 'engine',
	lang: 'en',
	headed: false,
	keepOpen: false,
	base: process.env.E2E_BASE_REF ?? process.env.GITHUB_BASE_REF ?? 'dev-refactor',
	actionTimeoutMs: 30000,
	fixture: { commits: 2000, branches: 50, tags: 40, authors: 20, mergeRate: 0.12, seed: 12345 }
};

/** The env var the launcher serializes {@link E2eOptions} into for the entry (extensionTestsEnv). */
export const E2E_OPTIONS_ENV = 'E2E_RUN_OPTIONS';
/** The env var carrying the absolute results directory (reports + evidence land there). */
export const E2E_RESULTS_DIR_ENV = 'E2E_RESULTS_DIR';
/** The env var carrying the absolute fixture workspace path (also VS Code's launch folder). */
export const E2E_WORKSPACE_ENV = 'E2E_WORKSPACE';
/** The env var carrying the affected selection ({"full":true} or {"tags":[...]}) for the entry. */
export const E2E_AFFECTED_ENV = 'E2E_AFFECTED';

/* ---------------- Wire mirrors of the in-host automation surface ---------------- */

/** Mirror of the suite runner's ActionRunRecord (src/extension/automation/suiteRunner.ts). */
export interface SuiteRunRecordWire {
	readonly id: string;
	readonly title: string;
	readonly group: string;
	readonly mode: 'ui' | 'request' | 'command';
	readonly ok: boolean;
	readonly skipped: boolean;
	readonly reason: string | null;
	readonly error: string | null;
	readonly totalMs: number | null;
	readonly responses: readonly { readonly command: string; readonly atMs: number }[];
	readonly notifications: readonly string[];
}

/** Mirror of the suite runner's SuiteReport. */
export interface SuiteReportWire {
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly repo: string;
	readonly fixture: boolean;
	readonly fixtureGenerated: boolean;
	readonly writeSuiteIncluded: boolean;
	readonly suites: readonly { readonly name: 'read' | 'write'; readonly runs: readonly SuiteRunRecordWire[] }[];
	readonly totals: { readonly actions: number; readonly passed: number; readonly failed: number; readonly skipped: number };
}

/** Mirror of src/extension/automation/e2eGate.ts's E2eProbe. */
export interface ProbeWire {
	readonly automation: true;
	readonly editorVersion: string;
	readonly view: { readonly viewLoaded: boolean; readonly currentRepo: string | null; readonly repos: readonly string[] };
	readonly logFile: string | null;
	readonly logTail: string | null;
}

/** Mirror of src/extension/commands/automation.ts's AutomationE2eSuiteRequest. */
export interface SuiteRequestWire {
	readonly e2eSuite: true;
	readonly repo?: string;
	readonly actionIds?: readonly string[];
	readonly includeTags?: readonly string[];
	readonly excludeTags?: readonly string[];
	readonly actionTimeoutMs?: number;
	readonly skipWriteSuite?: boolean;
	readonly fixtureOptions?: Readonly<Partial<FixtureTuning>>;
}

/** What the command answers a suite request with: the report, or the failure text. */
export type SuiteAnswerWire = SuiteReportWire | { readonly e2eError: string } | undefined;

/* ---------------- Scenario records and the run report ---------------- */

export type ScenarioStatus = 'pass' | 'fail' | 'skip';

/** One scenario's outcome, as the reports carry it. */
export interface ScenarioRecord {
	readonly id: string;
	readonly title: string;
	readonly tags: readonly string[];
	readonly status: ScenarioStatus;
	/** The skip reason, or the failure text (first line). */
	readonly detail: string | null;
	readonly durationMs: number | null;
	/** Evidence file paths, relative to the results dir. */
	readonly evidence: readonly string[];
	/** The underlying legacy action records, when this scenario ran through the compatibility adapter. */
	readonly legacyRuns?: readonly SuiteRunRecordWire[];
}

export interface E2eReport {
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly options: E2eOptions;
	/** Runtime facts observed inside the extension host (null when the probe never succeeded). */
	readonly runtime: { readonly editorVersion: string; readonly backend: Backend } | null;
	readonly totals: { readonly scenarios: number; readonly passed: number; readonly failed: number; readonly skipped: number };
	readonly scenarios: readonly ScenarioRecord[];
}
