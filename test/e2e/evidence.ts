/**
 * Failure evidence (§6.8.6): on failure, save what explains it — the webview DOM (via the
 * in-page shim's eval of `outerHTML`), the host log tail (through the in-host probe), the git
 * state of the fixture repository at the moment of failure, and — best effort, when the
 * extension host exposes it — VS Code's own log directory. Everything lands under the run's
 * results directory and the report references the files by relative path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { evalInPage, git, probe } from './inhost';

/** A safe file-name fragment for a scenario id ('smoke/S1' -> 'smoke_S1'). */
export function evidenceSlug(scenarioId: string): string {
	return scenarioId.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/** Write one evidence file; returns its path relative to the results dir (null when unwritable). */
export function writeEvidence(resultsDir: string, slug: string, name: string, content: string): string | null {
	try {
		const dir = path.join(resultsDir, 'evidence', slug);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, name);
		fs.writeFileSync(file, content);
		return path.relative(resultsDir, file).replace(/\\/g, '/');
	} catch {
		return null;
	}
}

/** The repository's observable state: HEAD, branches, tags, stashes, status, recent history. */
export async function captureGitState(repo: string): Promise<string> {
	const sections: string[] = [];
	const run = async (label: string, args: readonly string[]): Promise<void> => {
		try {
			sections.push('== ' + label + ' ==\n' + (await git(args, repo)).trimEnd());
		} catch (error) {
			sections.push('== ' + label + ' == (failed: ' + (error instanceof Error ? error.message : String(error)) + ')');
		}
	};
	await run('HEAD', ['rev-parse', 'HEAD']);
	await run('symbolic-ref', ['symbolic-ref', '--short', 'HEAD']);
	await run('branches', ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
	await run('tags', ['tag', '-l']);
	await run('stash list', ['stash', 'list']);
	await run('status', ['status', '--porcelain']);
	await run('recent history', ['log', '--oneline', '--decorate', '-n', '25', '--all']);
	return sections.join('\n\n') + '\n';
}

/** The live webview's DOM (best effort — no view or no page means null). */
export async function captureDom(): Promise<string | null> {
	try {
		const dom = await evalInPage('document.documentElement.outerHTML');
		return typeof dom === 'string' ? dom : null;
	} catch {
		return null;
	}
}

/** The host log tail through the in-host probe (null when logging is off or the probe fails). */
export async function captureHostLogTail(): Promise<string | null> {
	try {
		return (await probe()).logTail;
	} catch {
		return null;
	}
}

/**
 * Copy VS Code's log directory for this session into the evidence tree (best effort: the env
 * variable is not contractual across versions, and live log files can be locked on Windows).
 */
export function copyVscodeLogs(resultsDir: string, slug: string): string | null {
	const logsDir = process.env.VSCODE_LOGS_DIR;
	if (logsDir === undefined || logsDir === '' || !fs.existsSync(logsDir)) return null;
	try {
		const target = path.join(resultsDir, 'evidence', slug, 'vscode-logs');
		fs.mkdirSync(target, { recursive: true });
		copyTree(logsDir, target, 0);
		return path.relative(resultsDir, target).replace(/\\/g, '/');
	} catch {
		return null;
	}
}

/** Recursive copy with a depth cap (a runaway logs tree must never fill the results dir). */
function copyTree(source: string, target: string, depth: number): void {
	if (depth > 4) return;
	for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(target, entry.name);
		if (entry.isDirectory()) {
			fs.mkdirSync(to, { recursive: true });
			copyTree(from, to, depth + 1);
		} else if (entry.isFile()) {
			try {
				fs.copyFileSync(from, to);
			} catch {
				// a locked live log: skipped, the rest still copies
			}
		}
	}
}

/**
 * Capture the full evidence set for one failed scenario. The git-state "diff" is the state at
 * failure plus — when available — the pre-scenario snapshot the entry kept, concatenated.
 */
export async function captureFailureEvidence(resultsDir: string, scenarioId: string, repo: string, gitStateBefore: string | null): Promise<string[]> {
	const slug = evidenceSlug(scenarioId);
	const written: string[] = [];
	const push = (relative: string | null): void => {
		if (relative !== null) written.push(relative);
	};
	push(writeEvidence(resultsDir, slug, 'git-state-at-failure.txt', gitStateBefore !== null
		? '== before the scenario ==\n' + gitStateBefore + '\n\n== at failure ==\n' + (await captureGitState(repo))
		: await captureGitState(repo)));
	const dom = await captureDom();
	if (dom !== null) push(writeEvidence(resultsDir, slug, 'webview-dom.html', dom));
	const logTail = await captureHostLogTail();
	if (logTail !== null && logTail !== '') push(writeEvidence(resultsDir, slug, 'host-log-tail.log', logTail));
	push(copyVscodeLogs(resultsDir, slug));
	return written;
}
