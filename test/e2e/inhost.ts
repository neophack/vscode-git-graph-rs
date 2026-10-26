/**
 * The entry's in-host driver: every interaction with the extension and the workspace happens
 * through `vscode.commands` (which lands in the BUNDLED automation subsystem — the one module
 * instance whose GraphViewPort the live view publishes to) plus the git CLI for repository
 * state. Also home of the condition waits: §6.8.6 forbids fixed-duration sleeps, so every wait
 * here polls a declared condition against a declared timeout.
 */

import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { ProbeWire, SuiteAnswerWire, SuiteReportWire, SuiteRequestWire } from './types';

/** The automation command the E2E hooks ride on (registered only in automation builds). */
const AUTOMATION_COMMAND = 'git-graph-rs.runAutomationTest';

/** Error thrown when a condition wait times out (§6.8.6: waits are on conditions, never sleeps). */
export class ConditionTimeout extends Error {
	public constructor(what: string, timeoutMs: number, last: string) {
		super('timed out after ' + timeoutMs + ' ms waiting for ' + what + (last === '' ? '' : ' (last observation: ' + last + ')'));
	}
}

/**
 * Wait until `condition` returns a string description of success (resolved with it) — polling
 * every `intervalMs` — or throw {@see ConditionTimeout} after `timeoutMs`.
 */
export async function waitFor(what: string, timeoutMs: number, condition: () => Promise<string | null> | string | null, intervalMs = 100): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const observed = await condition();
		if (observed !== null) return observed;
		if (Date.now() >= deadline) throw new ConditionTimeout(what, timeoutMs, '');
		await delay(intervalMs);
	}
}

/** The one deliberate sleep in the harness: the poll interval of a condition wait. */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one git command in `cwd`, returning stdout; the error's stderr text propagates. */
export function git(args: readonly string[], cwd: string, timeoutMs = 60000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			if (error !== null && error !== undefined) {
				reject(new Error('git ' + args.join(' ') + ' failed: ' + (stderr !== '' ? stderr : error.message)));
			} else {
				resolve(stdout);
			}
		});
	});
}

/** The machine probe (src/extension/automation/e2eGate.ts): view state, host log tail, editor version. */
export async function probe(): Promise<ProbeWire> {
	const answer = await vscode.commands.executeCommand(AUTOMATION_COMMAND, { e2eProbe: true }) as ProbeWire | undefined;
	if (answer === undefined || answer.automation !== true) {
		throw new Error('the automation build is not active (the probe command answered nothing)');
	}
	return answer;
}

/** Wait for the extension to activate by polling the probe (the command registers at activation). */
export async function waitForActivation(timeoutMs: number): Promise<ProbeWire> {
	let seen: ProbeWire | null = null;
	await waitFor('the automation build to activate', timeoutMs, async () => {
		try {
			seen = await probe();
			return 'VS Code ' + seen.editorVersion;
		} catch {
			return null;
		}
	}, 250);
	if (seen === null) throw new ConditionTimeout('the automation build to activate', timeoutMs, '');
	return seen;
}

/** Evaluate one expression in the live webview page (the entry's DOM observation). */
export async function evalInPage(expr: string, timeoutMs = 15000): Promise<unknown> {
	const answer = await vscode.commands.executeCommand(AUTOMATION_COMMAND, { e2eEval: expr, timeoutMs }) as { ok: boolean; value?: unknown; error?: string } | undefined;
	if (answer === undefined) throw new Error('the page eval answered nothing (no automation build?)');
	if (!answer.ok) throw new Error('page eval failed: ' + (answer.error ?? 'unknown'));
	return answer.value;
}

/** Run a machine suite request; throws with the in-host error when the run could not start. */
export async function runSuite(request: SuiteRequestWire): Promise<SuiteReportWire> {
	const answer = await vscode.commands.executeCommand(AUTOMATION_COMMAND, request) as SuiteAnswerWire;
	if (answer === undefined) throw new Error('the suite request answered nothing (no automation build?)');
	if ('e2eError' in answer) throw new Error('the automation suite failed to start: ' + answer.e2eError);
	return answer;
}

/** Open (or reveal) the Git Graph view on `repo` — the same command the SCM title menu runs. */
export async function openView(repo: string): Promise<void> {
	await vscode.commands.executeCommand('git-graph-rs.view', { rootUri: vscode.Uri.file(repo) });
}

/** Wait until the view reports `repo` loaded (paths compare normalized, like the runner does). */
export async function waitForViewRepo(repo: string, timeoutMs: number): Promise<void> {
	const same = (a: string | null, b: string): boolean => a !== null && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
	await waitFor('the view to load ' + repo, timeoutMs, async () => {
		const state = (await probe()).view;
		if (state.viewLoaded && same(state.currentRepo, repo)) return 'loaded';
		return null;
	}, 200);
}
