/**
 * A configurable stand-in for the `vscode` module, shared by the extension-host tests that
 * exercise code outside the webview (commands, the status bar item, the extension state, ...).
 *
 * `installVscodeStub()` hooks CommonJS module loading so every `require('vscode')` made by the
 * compiled extension (out/*.js) resolves to the stub; import the modules under test only AFTER
 * calling it. Each test file runs in its own process (see scripts/run-tests.mjs), so the hook
 * never leaks between files. Additional relative modules (e.g. './gitGraphView') can be replaced
 * through the `modules` option, keyed by the request string as the requiring module spells it.
 *
 * The stub records every user-facing call (messages, quick picks, input boxes, executed
 * commands, ...) in `stub.calls` so tests can assert on what the extension asked of the editor,
 * and answers them from `stub.responses` (a queue per method, falling back to `undefined`).
 */

import path from 'node:path';
import { Module } from 'node:module';

function disposable() { return { dispose() {} }; }

export class StubUri {
	constructor(scheme, fsPath, extra = {}) {
		this.scheme = scheme;
		this.fsPath = fsPath;
		this.path = extra.path !== undefined ? extra.path : String(fsPath).replace(/\\/g, '/');
		this.query = extra.query !== undefined ? extra.query : '';
		this.fragment = extra.fragment !== undefined ? extra.fragment : '';
		this.authority = extra.authority !== undefined ? extra.authority : '';
	}
	with(change) {
		return new StubUri(change.scheme ?? this.scheme, this.fsPath, {
			path: change.path ?? this.path,
			query: change.query ?? this.query,
			fragment: change.fragment ?? this.fragment,
			authority: change.authority ?? this.authority
		});
	}
	toString() {
		return this.scheme + '://' + this.authority + this.path + (this.query !== '' ? '?' + this.query : '') + (this.fragment !== '' ? '#' + this.fragment : '');
	}
	toJSON() { return { scheme: this.scheme, path: this.path, query: this.query, fragment: this.fragment }; }
	static file(p) { return new StubUri('file', p); }
	static parse(value) {
		const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(String(value));
		if (match === null) throw new Error('Invalid URI: ' + value);
		return new StubUri(match[1], match[3], { authority: match[2] ?? '', path: match[3], query: match[4] ?? '', fragment: match[5] ?? '' });
	}
	static joinPath(uri, ...segments) { return StubUri.file(path.join(uri.fsPath, ...segments)); }
}

export class StubEventEmitter {
	constructor() {
		this.listeners = [];
		this.event = (listener) => {
			this.listeners.push(listener);
			return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
		};
	}
	fire(value) { for (const listener of this.listeners.slice()) listener(value); }
	dispose() { this.listeners = []; }
}

/**
 * @param {object} [options]
 * @param {Record<string, any>} [options.settings] Configuration values keyed by their dotted
 *   section under `git-graph-rs` (other configuration roots are keyed as `<root>.<key>`).
 * @param {Array<{path: string, name?: string}>} [options.workspaceFolders]
 * @param {string} [options.language] The display language reported by `vscode.env.language`.
 * @param {string} [options.version] The editor version reported by `vscode.version`.
 */
export function createVscodeStub(options = {}) {
	const settings = Object.assign({}, options.settings);
	const calls = [];
	const responses = {};
	const record = (name, ...args) => { calls.push({ name, args }); };
	const respond = (name, args) => {
		const queue = responses[name];
		if (Array.isArray(queue) && queue.length > 0) {
			const next = queue.shift();
			return typeof next === 'function' ? next(...args) : next;
		}
		return typeof queue === 'function' ? queue(...args) : undefined;
	};
	const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';
	const answer = (name) => (...args) => {
		// `showQuickPick` accepts a promise of items: resolve it first, so the recorded call (and the
		// responder) see the items themselves
		const settle = (resolvedArgs) => {
			record(name, ...resolvedArgs);
			const value = respond(name, resolvedArgs);
			return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
		};
		return args.some(isThenable) ? Promise.all(args).then(settle) : settle(args);
	};

	const fullKey = (section, key) => section === 'git-graph-rs' ? key : section + '.' + key;
	const makeConfiguration = (section) => ({
		get: (key, defaultValue) => Object.prototype.hasOwnProperty.call(settings, fullKey(section, key)) ? settings[fullKey(section, key)] : defaultValue,
		has: (key) => Object.prototype.hasOwnProperty.call(settings, fullKey(section, key)),
		inspect: () => undefined,
		update: (key, value) => { record('configuration.update', section, key, value); settings[fullKey(section, key)] = value; return Promise.resolve(); }
	});

	const workspaceFolders = (options.workspaceFolders ?? []).map((folder, index) => ({ uri: StubUri.file(folder.path), name: folder.name ?? path.basename(folder.path), index }));
	const onDidChangeActiveTextEditor = new StubEventEmitter();
	const onDidChangeConfiguration = new StubEventEmitter();
	const onDidChangeWorkspaceFolders = new StubEventEmitter();
	const onDidCloseTextDocument = new StubEventEmitter();

	const terminals = [];
	const statusBarItems = [];
	const outputChannels = [];
	const registeredCommands = new Map();
	const textDocumentContentProviders = new Map();

	const stub = {
		version: options.version ?? '1.90.0',
		calls, responses, settings, workspaceFolders, terminals, statusBarItems, outputChannels, registeredCommands, textDocumentContentProviders,
		Uri: StubUri,
		EventEmitter: StubEventEmitter,
		RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		StatusBarAlignment: { Left: 1, Right: 2 },
		ProgressLocation: { Notification: 15, Window: 10 },
		env: {
			appName: 'Visual Studio Code', language: options.language ?? 'en',
			clipboard: { writeText: answer('clipboard.writeText') },
			openExternal: answer('env.openExternal')
		},
		window: {
			activeTextEditor: undefined,
			onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
			showInformationMessage: answer('showInformationMessage'),
			showWarningMessage: answer('showWarningMessage'),
			showErrorMessage: answer('showErrorMessage'),
			showQuickPick: answer('showQuickPick'),
			showInputBox: answer('showInputBox'),
			showOpenDialog: answer('showOpenDialog'),
			showSaveDialog: answer('showSaveDialog'),
			showTextDocument: answer('showTextDocument'),
			withProgress: (_options, task) => task({ report() {} }),
			createTerminal: (terminalOptions) => {
				const terminal = { options: terminalOptions, sent: [], shown: 0, sendText(text) { this.sent.push(text); }, show() { this.shown++; }, dispose() {} };
				terminals.push(terminal);
				record('createTerminal', terminalOptions);
				return terminal;
			},
			createStatusBarItem: (alignment, priority) => {
				const item = { alignment, priority, text: '', tooltip: '', command: '', visible: false, shows: 0, hides: 0, disposed: false, show() { this.visible = true; this.shows++; }, hide() { this.visible = false; this.hides++; }, dispose() { this.disposed = true; } };
				statusBarItems.push(item);
				return item;
			},
			createOutputChannel: (name) => {
				const channel = { name, lines: [], shown: 0, disposed: false, appendLine(line) { this.lines.push(line); }, show() { this.shown++; }, dispose() { this.disposed = true; } };
				outputChannels.push(channel);
				return channel;
			},
			createWebviewPanel: (...args) => { record('createWebviewPanel', ...args); return respond('createWebviewPanel', args); },
			registerWebviewPanelSerializer: () => disposable()
		},
		workspace: {
			workspaceFolders: workspaceFolders.length > 0 ? workspaceFolders : undefined,
			getConfiguration: (section) => makeConfiguration(section ?? 'git-graph-rs'),
			onDidChangeConfiguration: onDidChangeConfiguration.event,
			onDidChangeWorkspaceFolders: onDidChangeWorkspaceFolders.event,
			onDidCloseTextDocument: onDidCloseTextDocument.event,
			createFileSystemWatcher: () => ({ onDidChange: () => disposable(), onDidCreate: () => disposable(), onDidDelete: () => disposable(), dispose() {} }),
			registerTextDocumentContentProvider: (scheme, provider) => { textDocumentContentProviders.set(scheme, provider); return disposable(); },
			openTextDocument: answer('openTextDocument'),
			fs: { stat: async () => { throw new Error('not available'); }, readFile: async () => { throw new Error('not available'); } }
		},
		commands: {
			registerCommand: (command, callback) => { registeredCommands.set(command, callback); return { dispose() { registeredCommands.delete(command); } }; },
			registerTextEditorCommand: (command, callback) => { registeredCommands.set(command, callback); return disposable(); },
			executeCommand: (command, ...args) => {
				record('executeCommand', command, ...args);
				const specific = responses['executeCommand:' + command];
				if (Array.isArray(specific) && specific.length > 0) {
					const next = specific.shift();
					return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
				}
				const value = respond('executeCommand', [command, ...args]);
				return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
			}
		},
		extensions: { getExtension: () => undefined },
		emitters: { onDidChangeActiveTextEditor, onDidChangeConfiguration, onDidChangeWorkspaceFolders, onDidCloseTextDocument },
		/** Invoke a command registered through `commands.registerCommand`. */
		runCommand(command, ...args) {
			const callback = registeredCommands.get(command);
			if (callback === undefined) throw new Error('Command not registered: ' + command);
			return callback(...args);
		},
		/** The recorded calls with the given name. */
		callsTo(name) { return calls.filter((call) => call.name === name); },
		/** Drop every recorded call. */
		resetCalls() { calls.length = 0; }
	};
	return stub;
}

/**
 * Route `require('vscode')` (and any other listed request strings) to the given replacements.
 * @param {object} stub The `vscode` stub.
 * @param {Record<string, any>} [modules] Extra replacements keyed by the request string.
 * @returns A function restoring the original loader.
 */
export function installVscodeStub(stub, modules = {}) {
	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === 'vscode') return stub;
		if (Object.prototype.hasOwnProperty.call(modules, request)) return modules[request];
		return originalLoad.apply(this, arguments);
	};
	return () => { Module._load = originalLoad; };
}

/** A silent Logger stand-in that records what was logged. */
export function createLoggerStub() {
	const lines = [];
	return {
		lines,
		log(message) { lines.push({ level: 'log', message }); },
		logCmd(command, args) { lines.push({ level: 'cmd', message: command + ' ' + (args ?? []).join(' ') }); },
		logError(message) { lines.push({ level: 'error', message }); },
		dispose() {}
	};
}
