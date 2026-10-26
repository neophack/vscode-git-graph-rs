import * as fs from 'fs';
import * as vscode from 'vscode';
import { Logger } from '../extension/platform/logger';
import { HostBridge } from './hostBridge';
import { AutomationServer } from './server';

/**
 * The E2E entry's in-host eyes and hands (plan tasks 0.6/1.10, §6.8.1). The entry
 * (test/e2e/entry.ts) runs in the same extension host as the bundled extension, but in its own
 * module registry: it cannot import these modules directly without creating a SECOND copy of the
 * automation subsystem — a copy whose GraphViewPort no view ever publishes to, so every view
 * observation would report "no view". Everything the entry needs therefore crosses the boundary
 * as plain data through the `git-graph-rs.runAutomationTest` command (commands/automation.ts),
 * which forwards to the functions below — always against the ONE live module instance.
 */

/** How many bytes of the host log {@see e2eProbe} includes (the tail is what a failure explains). */
const LOG_TAIL_BYTES = 65536;

/** Result shape of {@see e2eEvalPage} — JSON-cloneable, the page expression's value or an error. */
export interface E2eEvalResult {
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: string;
}

/**
 * Evaluate one expression in the live Git Graph webview page (the in-page shim executes it; the
 * result must be JSON-cloneable). Fails cleanly when no view is open — the caller decides
 * whether that is a failure or a skip.
 */
export async function e2eEvalPage(logger: Logger, expr: string): Promise<E2eEvalResult> {
	const bridge = new HostBridge();
	const server = new AutomationServer({ logger, bridge, version: 'e2e' });
	server.start();
	try {
		return await server.eval({ expr });
	} finally {
		server.stop();
	}
}

/** The runtime snapshot {@see e2eProbe} returns: the live view, the host log and the editor. */
export interface E2eProbe {
	readonly automation: true;
	readonly editorVersion: string;
	readonly view: { readonly viewLoaded: boolean; readonly currentRepo: string | null; readonly repos: readonly string[] };
	/** The host log file (null when logging is off); the tail is embedded in {@see logTail}. */
	readonly logFile: string | null;
	readonly logTail: string | null;
}

/**
 * Snapshot the live editor for the E2E entry: the view/repository state (through the same
 * GraphViewPort the engine reads), the extension's log file tail (failure evidence §6.8.6), and
 * the editor version. Purely observational — never drives anything.
 */
export function e2eProbe(logger: Logger): E2eProbe {
	const logFile = logger.getLogFile();
	let logTail: string | null = null;
	if (logFile !== null) {
		try {
			const contents = fs.readFileSync(logFile, 'utf8');
			logTail = contents.length > LOG_TAIL_BYTES ? contents.slice(contents.length - LOG_TAIL_BYTES) : contents;
		} catch {
			// unreadable/unwritable log location: the Output Channel still works
		}
	}
	return {
		automation: true,
		editorVersion: vscode.version,
		view: new HostBridge().viewState(),
		logFile,
		logTail
	};
}
