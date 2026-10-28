/*---------------------------------------------------------------------------------------------
 *  This code is based on the askpass implementation in the Microsoft Visual Studio Code Git Extension
 *  https://github.com/microsoft/vscode/blob/473af338e1bd9ad4d9853933da1cd9d5d9e07dc9/extensions/git/src/askpass.ts,
 *  which has the following copyright notice & license:
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See ./licenses/LICENSE_MICROSOFT for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { UiPort } from '../../../platform/uiPort';
import { Disposable, toDisposable } from '../../../../shared/util/disposable';

export interface AskpassEnvironment {
	GIT_ASKPASS: string;
	ELECTRON_RUN_AS_NODE?: string;
	VSCODE_GIT_GRAPH_ASKPASS_NODE?: string;
	VSCODE_GIT_GRAPH_ASKPASS_MAIN?: string;
	VSCODE_GIT_GRAPH_ASKPASS_HANDLE?: string;
}

export interface AskpassRequest {
	host: string;
	request: string;
}

/** The response surface the askpass prompts write to (`http.ServerResponse` structurally). */
export interface AskpassResponder {
	writeHead(status: number): unknown;
	end(body?: string): void;
}

/**
 * The collaborators the askpass server needs from its host (the composition root wires them, so
 * this module carries no vscode or platform imports). The port TYPES come from the shared uiPort
 * (src/extension/platform/uiPort.ts); the production binding is injected — a lazy getter, so the
 * first prompt is the first time the native input surface is read.
 */
export interface AskpassManagerDeps {
	/** The random token the IPC handle path embeds (the platform nonce generator in production). */
	readonly nonce: () => string;
	/** The native input port a credential prompt goes through (the platform uiPort in production). */
	readonly input: () => Pick<UiPort, 'showInputBox'>;
}

/**
 * Prompt for one credential through the native input port and write the answer onto the askpass
 * HTTP response. A dismissed prompt answers '' (git treats that as no input given); a failed
 * prompt rejects with HTTP 500, so git surfaces the failure instead of hanging.
 * @param input The native input port (production: the injected uiPort getter's answer; tests: a fake).
 * @param request What git asks for (username, password, ...).
 * @param host The host the credential is for.
 * @param res The askpass HTTP response.
 */
export function promptForCredential(input: Pick<UiPort, 'showInputBox'>, request: string, host: string, res: AskpassResponder): void {
	input.showInputBox({ placeHolder: request, prompt: 'Git Graph RS: ' + host, password: /password/i.test(request), ignoreFocusOut: true }).then(result => {
		res.writeHead(200);
		res.end(JSON.stringify(result || ''));
	}, () => {
		res.writeHead(500);
		res.end();
	});
}

export class AskpassManager extends Disposable {
	private readonly deps: AskpassManagerDeps;
	private ipcHandlePath: string;
	private server: http.Server;
	private enabled = true;

	/**
	 * @param deps The host collaborators (see {@link AskpassManagerDeps}).
	 */
	constructor(deps: AskpassManagerDeps) {
		super();
		this.deps = deps;
		this.ipcHandlePath = getIPCHandlePath(deps.nonce());
		this.server = http.createServer((req, res) => this.onRequest(req, res));
		try {
			this.server.listen(this.ipcHandlePath);
			// `listen` fails asynchronously, so this handler (not the try/catch) is what sees a
			// bind failure — with `enabled` left true, git would be handed an askpass script that
			// cannot connect and every credential prompt would fail with git's raw error
			this.server.on('error', () => {
				this.enabled = false;
			});
		} catch (err) {
			this.enabled = false;
		}
		fs.chmod(path.join(__dirname, 'askpass.sh'), '755', () => { });
		fs.chmod(path.join(__dirname, 'askpass-empty.sh'), '755', () => { });

		this.registerDisposable(
			// Close the Askpass Server
			toDisposable(() => {
				try {
					this.server.close();
					if (process.platform !== 'win32') {
						fs.unlinkSync(this.ipcHandlePath);
					}
				} catch (e) { }
			})
		);
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		let reqData = '';
		req.setEncoding('utf8');
		req.on('data', (d) => reqData += d);
		req.on('end', () => {
			let data: AskpassRequest;
			try {
				data = JSON.parse(reqData) as AskpassRequest;
			} catch (e) {
				// Malformed request: respond with an error instead of crashing the server callback
				res.writeHead(400);
				res.end();
				return;
			}
			if (typeof data.request !== 'string' || typeof data.host !== 'string') {
				res.writeHead(400);
				res.end();
				return;
			}
			promptForCredential(this.deps.input(), data.request, data.host, res);
		});
	}

	public getEnv(): AskpassEnvironment {
		return this.enabled
			? {
				ELECTRON_RUN_AS_NODE: '1',
				GIT_ASKPASS: path.join(__dirname, 'askpass.sh'),
				VSCODE_GIT_GRAPH_ASKPASS_NODE: process.execPath,
				VSCODE_GIT_GRAPH_ASKPASS_MAIN: path.join(__dirname, 'askpassMain.js'),
				VSCODE_GIT_GRAPH_ASKPASS_HANDLE: this.ipcHandlePath
			}
			: {
				GIT_ASKPASS: path.join(__dirname, 'askpass-empty.sh')
			};
	}
}

function getIPCHandlePath(nonce: string): string {
	if (process.platform === 'win32') {
		return '\\\\.\\pipe\\git-graph-askpass-' + nonce + '-sock';
	} else if (process.env['XDG_RUNTIME_DIR']) {
		return path.join(process.env['XDG_RUNTIME_DIR'] as string, 'git-graph-askpass-' + nonce + '.sock');
	} else {
		return path.join(os.tmpdir(), 'git-graph-askpass-' + nonce + '.sock');
	}
}
