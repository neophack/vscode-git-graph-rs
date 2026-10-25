/**
 * A configurable stand-in for the `vscode` module, shared by the migrated extension-host test
 * files (tests/vscodeStub.mjs ported for Vitest, REFACTOR-PLAN task 7.1).
 *
 * Where the legacy runner hooked CommonJS module loading for the compiled `out/*.js` tree,
 * Vitest resolves the same seam with `vi.mock('vscode', () => buildVscodeStub(state))` — the
 * hoisted mock serves every transitive import of the TypeScript sources. The stub records every
 * user-facing call (messages, quick picks, input boxes, executed commands, ...) in `state.calls`
 * so tests can assert on what the extension asked of the editor, and answers them from
 * `state.responses` (a queue per method, falling back to `undefined`).
 */

import * as path from 'path';

export function disposable(): { dispose(): void } { return { dispose() { /* nothing */ } }; }

export class StubUri {
	scheme: string;
	fsPath: string;
	path: string;
	query: string;
	fragment: string;
	authority: string;
	constructor(scheme: string, fsPath: string, extra: { path?: string, query?: string, fragment?: string, authority?: string } = {}) {
		this.scheme = scheme;
		this.fsPath = fsPath;
		this.path = extra.path !== undefined ? extra.path : String(fsPath).replace(/\\/g, '/');
		this.query = extra.query !== undefined ? extra.query : '';
		this.fragment = extra.fragment !== undefined ? extra.fragment : '';
		this.authority = extra.authority !== undefined ? extra.authority : '';
	}
	with(change: { scheme?: string, path?: string, query?: string, fragment?: string, authority?: string }): StubUri {
		return new StubUri(change.scheme ?? this.scheme, this.fsPath, {
			path: change.path ?? this.path,
			query: change.query ?? this.query,
			fragment: change.fragment ?? this.fragment,
			authority: change.authority ?? this.authority
		});
	}
	toString(): string {
		return this.scheme + '://' + this.authority + this.path + (this.query !== '' ? '?' + this.query : '') + (this.fragment !== '' ? '#' + this.fragment : '');
	}
	toJSON() { return { scheme: this.scheme, path: this.path, query: this.query, fragment: this.fragment }; }
	static file(p: string): StubUri { return new StubUri('file', p); }
	static parse(value: string): StubUri {
		const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(String(value));
		if (match === null) throw new Error('Invalid URI: ' + value);
		return new StubUri(match[1], match[3], { authority: match[2] ?? '', path: match[3], query: match[4] ?? '', fragment: match[5] ?? '' });
	}
	static joinPath(uri: StubUri, ...segments: string[]): StubUri { return StubUri.file(path.join(uri.fsPath, ...segments)); }
}

export class StubEventEmitter<T = unknown> {
	listeners: Array<(value: T) => void> = [];
	event = (listener: (value: T) => { dispose?: void }) => {
		this.listeners.push(listener as (value: T) => void);
		return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
	};
	fire(value: T) { for (const listener of this.listeners.slice()) listener(value); }
	dispose() { this.listeners = []; }
	hasSubscribers(): boolean { return this.listeners.length > 0; }
}

/** The mutable state the hoisted mock reads and the tests steer. */
export interface VscodeStubState {
	settings: Record<string, unknown>;
	calls: Array<{ name: string, args: unknown[] }>;
	responses: Record<string, unknown>;
	version: string;
	uriScheme: string;
	language: string;
	workspaceFolders: Array<{ uri: StubUri | { uri: null, name: string, index: number } | unknown, name: string, index: number }>;
	terminals: unknown[];
	statusBarItems: any[];
	outputChannels: any[];
	registeredCommands: Map<string, (...args: unknown[]) => unknown>;
	textDocumentContentProviders: Map<string, unknown>;
	window: { activeTextEditor?: unknown };
	emitters: {
		onDidChangeActiveTextEditor: StubEventEmitter;
		onDidChangeConfiguration: StubEventEmitter;
		onDidChangeWorkspaceFolders: StubEventEmitter;
		onDidCloseTextDocument: StubEventEmitter;
	};
	/** Invoke a command registered through `commands.registerCommand`. */
	runCommand(command: string, ...args: unknown[]): unknown;
	/** The recorded calls with the given name. */
	callsTo(name: string): Array<{ name: string, args: unknown[] }>;
	/** Drop every recorded call. */
	resetCalls(): void;
}

/**
 * @param options.settings Configuration values keyed by their dotted section under
 *   `git-graph-rs` (other configuration roots are keyed as `<root>.<key>`).
 * @param options.workspaceFolders The folders `vscode.workspace.workspaceFolders` reports.
 */
export function createVscodeState(options: { settings?: Record<string, unknown>, workspaceFolders?: Array<{ path: string, name?: string }>, language?: string, version?: string, uriScheme?: string } = {}): VscodeStubState {
	const settings = Object.assign({}, options.settings);
	const calls: Array<{ name: string, args: unknown[] }> = [];
	const responses: Record<string, unknown> = {};
	const record = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
	const respond = (name: string, args: unknown[]) => {
		const queue = responses[name];
		if (Array.isArray(queue) && queue.length > 0) {
			const next = (queue as unknown[]).shift();
			return typeof next === 'function' ? (next as (...a: unknown[]) => unknown)(...args) : next;
		}
		return typeof queue === 'function' ? (queue as (...a: unknown[]) => unknown)(...args) : undefined;
	};
	const isThenable = (value: unknown): value is { then: (...a: unknown[]) => unknown } => value !== null && typeof value === 'object' && typeof (value as any).then === 'function';
	const answer = (name: string) => (...args: unknown[]) => {
		// `showQuickPick` accepts a promise of items: resolve it first, so the recorded call (and the
		// responder) see the items themselves
		const settle = (resolvedArgs: unknown[]) => {
			record(name, ...resolvedArgs);
			const value = respond(name, resolvedArgs);
			return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
		};
		return args.some(isThenable) ? Promise.all(args as unknown[]).then(settle) : settle(args);
	};

	const fullKey = (section: string, key: string) => section === 'git-graph-rs' ? key : section + '.' + key;
	const makeConfiguration = (section: string) => ({
		get: (key: string, defaultValue: unknown) => Object.prototype.hasOwnProperty.call(settings, fullKey(section, key)) ? settings[fullKey(section, key)] : defaultValue,
		has: (key: string) => Object.prototype.hasOwnProperty.call(settings, fullKey(section, key)),
		// VS Code's inspect always answers an object; an explicitly set value rides as globalValue
		inspect: (key: string) => ({ key: fullKey(section, key), globalValue: Object.prototype.hasOwnProperty.call(settings, fullKey(section, key)) ? settings[fullKey(section, key)] : undefined }),
		update: (key: string, value: unknown) => { record('configuration.update', section, key, value); settings[fullKey(section, key)] = value; return Promise.resolve(); }
	});

	const workspaceFolders = (options.workspaceFolders ?? []).map((folder, index) => ({ uri: StubUri.file(folder.path), name: folder.name ?? path.basename(folder.path), index }));
	const onDidChangeActiveTextEditor = new StubEventEmitter();
	const onDidChangeConfiguration = new StubEventEmitter();
	const onDidChangeWorkspaceFolders = new StubEventEmitter();
	const onDidCloseTextDocument = new StubEventEmitter();

	const terminals: unknown[] = [];
	const statusBarItems: any[] = [];
	const outputChannels: any[] = [];
	const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
	const textDocumentContentProviders = new Map<string, unknown>();

	const state: VscodeStubState = {
		version: options.version ?? '1.90.0',
		uriScheme: options.uriScheme ?? 'vscode',
		language: options.language ?? 'en',
		calls, responses, settings, workspaceFolders, terminals, statusBarItems, outputChannels, registeredCommands, textDocumentContentProviders,
		window: { activeTextEditor: undefined },
		emitters: { onDidChangeActiveTextEditor, onDidChangeConfiguration, onDidChangeWorkspaceFolders, onDidCloseTextDocument },
		runCommand(command, ...args) {
			const callback = registeredCommands.get(command);
			if (callback === undefined) throw new Error('Command not registered: ' + command);
			return callback(...args);
		},
		callsTo(name) { return calls.filter((call) => call.name === name); },
		resetCalls() { calls.length = 0; }
	};

	const stubBuilt: any = {
		version: state.version,
		Uri: StubUri,
		EventEmitter: StubEventEmitter,
		RelativePattern: class RelativePattern { constructor(base: unknown, pattern: string) { (this as any).base = base; (this as any).pattern = pattern; } },
		ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		StatusBarAlignment: { Left: 1, Right: 2 },
		ProgressLocation: { Notification: 15, Window: 10 },
		env: {
			appName: 'Visual Studio Code', language: state.language, uriScheme: state.uriScheme,
			clipboard: { writeText: answer('clipboard.writeText') },
			openExternal: answer('env.openExternal')
		},
		window: {
			get activeTextEditor() { return state.window.activeTextEditor; },
			set activeTextEditor(value) { state.window.activeTextEditor = value; },
			onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
			showInformationMessage: answer('showInformationMessage'),
			showWarningMessage: answer('showWarningMessage'),
			showErrorMessage: answer('showErrorMessage'),
			showQuickPick: answer('showQuickPick'),
			showInputBox: answer('showInputBox'),
			showOpenDialog: answer('showOpenDialog'),
			showSaveDialog: answer('showSaveDialog'),
			showTextDocument: answer('showTextDocument'),
			withProgress: (_options: unknown, task: (p: { report(): void }) => unknown) => task({ report() { /* nothing */ } }),
			createTerminal: (terminalOptions: unknown) => {
				const terminal = { options: terminalOptions, sent: [] as string[], shown: 0, sendText(text: string) { this.sent.push(text); }, show() { this.shown++; }, dispose() { /* nothing */ } };
				terminals.push(terminal);
				record('createTerminal', terminalOptions);
				return terminal;
			},
			createStatusBarItem: (alignment: unknown, priority: unknown) => {
				const item = { alignment, priority, text: '', tooltip: '', command: '', visible: false, shows: 0, hides: 0, disposed: false, show() { this.visible = true; this.shows++; }, hide() { this.visible = false; this.hides++; }, dispose() { this.disposed = true; } };
				statusBarItems.push(item);
				return item;
			},
			createOutputChannel: (name: string) => {
				const channel = { name, lines: [] as string[], shown: 0, disposed: false, appendLine(line: string) { this.lines.push(line); }, show() { this.shown++; }, dispose() { this.disposed = true; } };
				outputChannels.push(channel);
				return channel;
			},
			createWebviewPanel: (...args: unknown[]) => { record('createWebviewPanel', ...args); return respond('createWebviewPanel', args); },
			registerWebviewPanelSerializer: () => disposable()
		},
		workspace: {
			get workspaceFolders() { return workspaceFolders.length > 0 ? workspaceFolders : undefined; },
			set workspaceFolders(value) { workspaceFolders.length = 0; workspaceFolders.push(...(value as unknown[])); },
			getConfiguration: (section?: string) => makeConfiguration(section ?? 'git-graph-rs'),
			onDidChangeConfiguration: onDidChangeConfiguration.event,
			onDidChangeWorkspaceFolders: onDidChangeWorkspaceFolders.event,
			onDidCloseTextDocument: onDidCloseTextDocument.event,
			createFileSystemWatcher: () => ({ onDidChange: () => disposable(), onDidCreate: () => disposable(), onDidDelete: () => disposable(), dispose() { /* nothing */ } }),
			registerTextDocumentContentProvider: (scheme: string, provider: unknown) => { textDocumentContentProviders.set(scheme, provider); return disposable(); },
			openTextDocument: answer('openTextDocument'),
			fs: { stat: async () => { throw new Error('not available'); }, readFile: async () => { throw new Error('not available'); } }
		},
		commands: {
			registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => { registeredCommands.set(command, callback); return { dispose() { registeredCommands.delete(command); } }; },
			registerTextEditorCommand: (command: string, callback: (...args: unknown[]) => unknown) => { registeredCommands.set(command, callback); return disposable(); },
			executeCommand: (command: string, ...args: unknown[]) => {
				record('executeCommand', command, ...args);
				const specific = responses['executeCommand:' + command];
				if (Array.isArray(specific) && specific.length > 0) {
					const next = (specific as unknown[]).shift();
					return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
				}
				const value = respond('executeCommand', [command, ...args]);
				return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
			}
		},
		extensions: { getExtension: () => undefined }
	};
	// The steering surface, by reference: tests drive the stub object directly (settings,
	// responses, calls, the registered commands, the emitters' firers).
	stubBuilt.calls = calls;
	stubBuilt.settings = settings;
	stubBuilt.responses = responses;
	stubBuilt.terminals = terminals;
	stubBuilt.statusBarItems = statusBarItems;
	stubBuilt.outputChannels = outputChannels;
	stubBuilt.registeredCommands = registeredCommands;
	stubBuilt.textDocumentContentProviders = textDocumentContentProviders;
	stubBuilt.workspaceFoldersRef = workspaceFolders;
	stubBuilt.emitters = state.emitters;
	stubBuilt.runCommand = state.runCommand;
	stubBuilt.callsTo = state.callsTo;
	stubBuilt.resetCalls = state.resetCalls;
	(state as any).stub = stubBuilt;
	return state;
}

/** Convenience: the hoisted mock factory body for `vi.mock('vscode', ...)`. */
export function vscodeMockOf(state: VscodeStubState) {
	return (state as any).stub;
}

/** A silent Logger stand-in that records what was logged. */
export function createLoggerStub() {
	const lines: Array<{ level: string, message: string }> = [];
	return {
		lines,
		log(message: string) { lines.push({ level: 'log', message }); },
		logCmd(command: string, args?: ReadonlyArray<string>) { lines.push({ level: 'cmd', message: command + ' ' + (args ?? []).join(' ') }); },
		logError(message: string) { lines.push({ level: 'error', message }); },
		dispose() { /* nothing */ }
	};
}
