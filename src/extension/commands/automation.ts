import * as vscode from 'vscode';
import { t } from '../../i18n';
import { showErrorMessage } from '../../utils/actions';
import type { CommandHost } from './context';

/* The automation-testing capability ships only in the automation build (the default build's
 * packaging moves out/automation aside), so these modules load conditionally. */
type AutomationModules = {
	runAutomationSuite: typeof import('../../automation/suiteRunner').runAutomationSuite;
	showAutomationReport: typeof import('../../automation/reportView').showAutomationReport;
};
let automation: AutomationModules | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const suiteRunner = require('../../automation/suiteRunner') as typeof import('../../automation/suiteRunner');
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const reportView = require('../../automation/reportView') as typeof import('../../automation/reportView');
	automation = { runAutomationSuite: suiteRunner.runAutomationSuite, showAutomationReport: reportView.showAutomationReport };
} catch (_) { /* the automation modules are absent from this build: not an error */ }

/**
 * The automation build's `git-graph-rs.runAutomationTest` command. The CommandManager only
 * registers it when {@link automationAvailable} reports the automation modules as loaded.
 */

/**
 * Whether the automation modules are present in this build (only the automation build's
 * packaging keeps them).
 */
export function automationAvailable(): boolean {
	return automation !== null;
}

/**
 * Run the automation test suite against the Git Graph view (in-process; no external driver)
 * and open the report page when it finishes. The write suite runs when the active repository is
 * safe to mutate — a fixture clone (rebuilt from its bare remote first) or a repository with no
 * commits at all (the fixture history is generated into it first).
 * @param host The services the command runs with.
 */
export async function runAutomationTest(host: CommandHost): Promise<void> {
	const modules = automation;
	if (modules === null) return;
	try {
		const report = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: t('automationTestRunning'),
			cancellable: false
		}, (progress) => modules.runAutomationSuite({
			logger: host.logger,
			onProgress: (p) => progress.report({ message: p.phase + ' ' + p.index + '/' + p.total + ' — ' + p.actionId }),
			// The fixture's submodule becomes a known repository the moment it is seeded: a
			// repository materialised mid-session is never discovered on its own (both the
			// workspace scan and the submodule scan skip paths inside a known repository).
			registerRepo: async (repo) => {
				if (!host.repoManager.isKnownRepo(repo)) await host.repoManager.registerRepo(repo, false);
			}
		}));
		modules.showAutomationReport(report);
	} catch (error) {
		showErrorMessage(t('automationTestFailedToStart', error instanceof Error ? error.message : String(error)));
	}
}
