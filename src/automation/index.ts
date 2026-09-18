import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import { HostBridge } from './hostBridge';
import { AutomationServer } from './server';

/**
 * Lifecycle owner of the automation server. The server is off by default; setting
 * `git-graph-rs.automationPort` to a TCP port (1–65535) starts it on 127.0.0.1, and changing
 * the setting restarts it. See the "Remote automation & debugging" README section.
 */

function readExtensionVersion(): string {
	try {
		// out/automation/index.js -> the extension's package.json two levels up.
		return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version as string;
	} catch (_) {
		return 'unknown';
	}
}

export class AutomationService {
	private readonly logger: Logger;
	private readonly bridge = new HostBridge();
	private server: AutomationServer | null = null;
	private starting = false;

	constructor(logger: Logger) {
		this.logger = logger;
		this.refresh();
	}

	/** (Re)start or stop the server to match the `git-graph-rs.automationPort` setting. */
	public refresh(): void {
		const port = readAutomationPort();
		if (this.starting) return; // a refresh mid-start resolves to a no-op; the next config change retries
		if (port <= 0) {
			if (this.server !== null) {
				this.logger.log('Automation server stopped (git-graph-rs.automationPort disabled)');
				this.server.stop();
				this.server = null;
			}
			return;
		}
		if (this.server !== null && this.server.port === port) return;
		if (this.server !== null) {
			this.server.stop();
			this.server = null;
		}
		this.starting = true;
		const server = new AutomationServer({ logger: this.logger, bridge: this.bridge, version: readExtensionVersion() });
		server.start(port).then(() => {
			this.starting = false;
			this.server = server;
			this.logger.log('Automation server listening on 127.0.0.1:' + server.port + ' (test driver protocol v1)');
		}, (error) => {
			this.starting = false;
			this.logger.logError('Failed to start the automation server on port ' + port + ': ' + (error instanceof Error ? error.message : String(error)));
		});
	}

	public dispose(): void {
		if (this.server !== null) {
			this.server.stop();
			this.server = null;
		}
	}
}

/** Read and sanitise the `automationPort` setting (0 => disabled). */
export function readAutomationPort(): number {
	const value = vscode.workspace.getConfiguration('git-graph-rs').get('automationPort', 0);
	if (typeof value !== 'number' || !isFinite(value)) return 0;
	return Math.min(65535, Math.max(0, Math.floor(value)));
}
