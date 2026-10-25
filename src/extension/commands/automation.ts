import * as vscode from 'vscode';
import { t } from '../../i18n';
import { showErrorMessage } from '../../utils/actions';
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
