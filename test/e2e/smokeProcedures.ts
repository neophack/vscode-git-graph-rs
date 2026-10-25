/**
 * The S-checklist's custom procedures (§6's S1, S6, S7, S8, S9 — the items the legacy catalog
 * does not model as actions). Each procedure drives the real editor through commands and the
 * in-host hooks, asserts via condition waits (never fixed sleeps, §6.8.6), and returns a
 * plain outcome; the entry records it. Honest limitations are documented in the procedure's
 * outcome detail rather than papered over (S6, S7).
 */

import * as vscode from 'vscode';
import { E2eOptions } from './types';
import { evalInPage, git, openView, probe, waitFor, waitForViewRepo } from './inhost';

/** What a procedure reports back. */
export interface ProcedureOutcome {
	readonly status: 'pass' | 'fail' | 'skip';
	readonly detail: string | null;
	readonly durationMs: number;
}

/** Everything a procedure may use. */
export interface ProcedureContext {
	readonly repo: string;
	readonly options: E2eOptions;
}

/** The zh-cn/en refresh button titles (src/shared/i18n/{zh-cn,en}.ts, refreshTitle). */
const REFRESH_TITLE_ZH = '刷新';
const REFRESH_TITLE_EN = 'Refresh';

/** The rendered commit rows the graph must show (any loaded repository has hundreds). */
async function commitRowCount(): Promise<number> {
	const count = await evalInPage('document.querySelectorAll("tr.commit").length');
	return typeof count === 'number' ? count : -1;
}

/** Is an in-page dialog open (error dialogs render through the same .dialog widget)? */
async function dialogOpen(): Promise<boolean> {
	const open = await evalInPage('document.querySelector(".dialog") !== null');
	return open === true;
}

/** Wait until the graph shows rows and no dialog is up — the "loads without error" condition. */
async function waitForGraphLoaded(timeoutMs: number): Promise<string> {
	return waitFor('the graph to render commit rows with no dialog open', timeoutMs, async () => {
		if (await dialogOpen()) return null;
		const rows = await commitRowCount();
		return rows > 0 ? rows + ' rows' : null;
	}, 200);
}

/** S1: open the Git Graph view; the commit graph loads without error notifications/dialogs. */
export async function openViewLoad(ctx: ProcedureContext): Promise<ProcedureOutcome> {
	const started = Date.now();
	await openView(ctx.repo);
	await waitForViewRepo(ctx.repo, 60000);
	const rows = await waitForGraphLoaded(60000);
	return { status: 'pass', detail: rows + ' commit rows rendered, no dialog open', durationMs: Date.now() - started };
}

/**
 * S6: push to an HTTPS remote that needs credentials. There is no deterministic way to give the
 * run a real HTTPS remote with credentials, and the credential prompt itself (the extension's
 * askpass input box) cannot be answered from the test entry — answering it needs the
 * ScriptedUiPort (task 4.10, §6.8.2). Reported as a documented skip instead of a fake local
 * approximation that would verify git's transport but never the extension's askpass path.
 * Tracked for the ScriptedUiPort landing; see docs/e2e-baseline.md.
 */
export async function credentialPrompt(_ctx: ProcedureContext): Promise<ProcedureOutcome> {
	return {
		status: 'skip',
		detail: 'needs a real credential-demanding HTTPS remote and an answerable askpass prompt (ScriptedUiPort, task 4.10); no honest local approximation exists yet',
		durationMs: 0
	};
}

/**
 * S7: "Developer: Restart Extension Host" — the panel recovers with its state. Restarting the
 * extension host from inside the test entry would kill the test runner itself, so this
 * procedure drives the recoverable part that CAN be self-driven: the panel is closed (the view
 * disposes, its port state drops) and reopened, and the repository must come back loaded with
 * the graph rendered. A true restart flow needs the Playwright-driven tier (§6.8.2, stable
 * only); noted in docs/e2e-baseline.md.
 */
export async function panelCloseReopen(ctx: ProcedureContext): Promise<ProcedureOutcome> {
	const started = Date.now();
	await openView(ctx.repo);
	await waitForViewRepo(ctx.repo, 60000);
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	await waitFor('the view to dispose', 30000, async () => ((await probe()).view.viewLoaded ? null : 'disposed'), 200);
	await openView(ctx.repo);
	await waitForViewRepo(ctx.repo, 60000);
	const rows = await waitForGraphLoaded(60000);
	return {
		status: 'pass',
		detail: 'panel closed and reopened on the same repository, ' + rows + ' rows (extension-host restart itself needs the Playwright tier)',
		durationMs: Date.now() - started
	};
}

/**
 * S8: switch the UI language to zh-cn and verify the rendered controls follow (the refresh
 * button's title is the shared string table's refreshTitle — '刷新' in zh-cn). The setting is
 * workspace-scoped (the launcher's isolated workspace) and restored to the run's language.
 */
export async function languageZhCn(ctx: ProcedureContext): Promise<ProcedureOutcome> {
	const started = Date.now();
	const config = vscode.workspace.getConfiguration('git-graph-rs');
	const restore = ctx.options.lang;
	const refreshTitle = async (): Promise<string> => {
		const title = await evalInPage('(document.getElementById("refreshBtn")||{title:""}).title');
		return typeof title === 'string' ? title : '';
	};
	await config.update('interfaceLanguage', 'zh-cn', vscode.ConfigurationTarget.Workspace);
	try {
		await waitFor('the refresh button to render the zh-cn title', 30000, async () => {
			const title = await refreshTitle();
			return title.indexOf(REFRESH_TITLE_ZH) !== -1 ? '"' + title + '"' : null;
		}, 200);
	} finally {
		await config.update('interfaceLanguage', restore, vscode.ConfigurationTarget.Workspace);
	}
	await waitFor('the refresh button to render the restored title', 30000, async () => {
		const title = await refreshTitle();
		return title.indexOf(restore === 'zh-cn' ? REFRESH_TITLE_ZH : REFRESH_TITLE_EN) !== -1 ? '"' + title + '"' : null;
	}, 200);
	return { status: 'pass', detail: 'controls re-rendered in zh-cn and back to ' + restore, durationMs: Date.now() - started };
}

/**
 * S9: engine binaries deleted and restarted — S1–S4 still work over the git CLI. The launcher
 * implements this tier as the --backend cli run (the staged extension ships without the
 * native binaries, which is exactly "the binaries are gone" from the extension's point of
 * view). The procedure therefore only re-asserts the S1 condition under the CLI backend and
 * names the coverage: every scenario of this run executed over the git CLI.
 */
export async function engineMissing(ctx: ProcedureContext): Promise<ProcedureOutcome> {
	const started = Date.now();
	const head = (await git(['rev-parse', '--short', 'HEAD'], ctx.repo)).trim();
	const rows = await waitForGraphLoaded(60000);
	return {
		status: 'pass',
		detail: 'running over the git CLI backend (no engine binaries staged); HEAD ' + head + ', ' + rows + ' rows — this run\'s scenarios are the S1–S4 evidence',
		durationMs: Date.now() - started
	};
}

/** The procedure table the entry dispatches `when.procedure` names against. */
export const PROCEDURES: Readonly<Record<string, (ctx: ProcedureContext) => Promise<ProcedureOutcome>>> = {
	'open-view-load': openViewLoad,
	'credential-prompt': credentialPrompt,
	'panel-close-reopen': panelCloseReopen,
	'language-zh-cn': languageZhCn,
	'engine-missing': engineMissing
};
