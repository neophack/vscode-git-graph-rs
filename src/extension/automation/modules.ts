/**
 * The automation subsystem's build-mode entry gate: whether the
 * automation modules load is decided AT BUILD TIME, not by which files happen to sit next to the
 * bundle. scripts/build/build.mjs passes esbuild `define: { __AUTOMATION__: 'true' | 'false' }`:
 *   - automation build (`--automation`): the flag is true, the requires below survive and the
 *     modules are BUNDLED into dist/automation/extension.js;
 *   - default build: the flag is false, esbuild constant-folds the typeof guard and
 *     dead-code-eliminates the whole branch — the requires disappear, so no automation module
 *     (catalog, server, suite runner) enters the bundle at all.
 * In the out/ (tsc) tree the global is simply absent: the typeof guard short-circuits TRUE and
 * the modules load exactly when the packaging variant put them in place — the v1.0 behavior,
 * which the out/-based VSIXs still rely on.
 */

declare global {
	const __AUTOMATION__: boolean | undefined;
}

/** The automation modules the Run Automation Test command needs (loaded only in an automation build). */
export interface AutomationModules {
	runAutomationSuite: typeof import('./suiteRunner').runAutomationSuite;
	showAutomationReport: typeof import('./reportView').showAutomationReport;
	e2eEvalPage: typeof import('./e2eGate').e2eEvalPage;
	e2eProbe: typeof import('./e2eGate').e2eProbe;
}

/**
 * Load the automation modules when this build carries them. NULL in the default dist build (the
 * gate is compiled out) and when the out/-tree files are absent (the default packaging variant).
 */
export function loadAutomationModules(): AutomationModules | null {
	if (typeof __AUTOMATION__ === 'undefined' || __AUTOMATION__) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const suiteRunner = require('./suiteRunner') as typeof import('./suiteRunner');
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const reportView = require('./reportView') as typeof import('./reportView');
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const e2eGate = require('./e2eGate') as typeof import('./e2eGate');
			return {
				runAutomationSuite: suiteRunner.runAutomationSuite,
				showAutomationReport: reportView.showAutomationReport,
				e2eEvalPage: e2eGate.e2eEvalPage,
				e2eProbe: e2eGate.e2eProbe
			};
		} catch (_) {
			// The automation modules are absent from this build: not an error.
			return null;
		}
	}
	return null;
}
