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
import * as vscode from 'vscode';
import { InputBoxOptionsLike, UiPort } from '../../../platform/uiPort';
import { getNonce } from '../../../platform/format';
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

// The native input port of the askpass responder (task 4.10, INVENTORY.md #21). This module
// cannot import the shared uiPort of src/utils/actions.ts: the DataSource (which constructs
// this manager) sits in that module graph, which would make an import cycle. So the window is
// captured on first use here (merely importing this module never touches the vscode module
// surface, keeping minimal test vscode mocks usable); when
// src/extension/platform/uiPort.ts ships its production implementation, this binding is
// replaced by the wiring-injected port and nothing else changes.
let askpassUi: Pick<UiPort, 'showInputBox'> | null = null;

function nativeInput(): Pick<UiPort, 'showInputBox'> {
	if (askpassUi === null) {
		// The captured window (call-time property lookups) is this port's single native seam,
		// the same binding style as the interim UiPort of src/utils/actions.ts.
		const window = vscode.window;
		askpassUi = {
			showInputBox(options?: InputBoxOptionsLike): Promise<string | undefined> {
				const showInputBox = window.showInputBox;
				return typeof showInputBox === 'function' ? Promise.resolve(showInputBox(options)) : Promise.resolve(undefined);
			}
		};
	}
	return askpassUi;
}

/**
 * Prompt for one credential through the native input port and write the answer onto the askpass
 * HTTP response. A dismissed prompt answers '' (git treats that as no input given); a failed
 * prompt rejects with HTTP 500, so git surfaces the failure instead of hanging (INVENTORY.md #21:
 * the answer feeds `res.end`, so this promise plumbing must not be broken up).
 * @param input The native input port (production: {@link askpassUi}; tests: a fake).
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
	private ipcHandlePath: string;
	private server: http.Server;
	private enabled = true;

	constructor() {
		super();
		this.ipcHandlePath = getIPCHandlePath(getNonce());
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
			promptForCredential(nativeInput(), data.request, data.host, res);
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
