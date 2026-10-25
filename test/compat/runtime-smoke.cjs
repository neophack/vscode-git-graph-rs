/**
 * The old-Node runtime smoke (C2, REFACTOR-PLAN task 1.8): the built extension bundle must
 * BOOT and serve a real repository read and write on the oldest Node the extension's floor
 * allows - VS Code 1.38's extension host is Node 10.11 - and on the current LTS.
 *
 * Plain CommonJS on purpose: the CI matrix (.github/workflows/native-build.yml) runs this file
 * directly under Node 10.11.0 and 12.4.0, which cannot parse ES modules, and this script must
 * require nothing but Node builtins and the built dist/extension.js - no devDependency tooling
 * runs on the old Nodes. test/compat/runtime-smoke.mjs is a thin forwarder so modern invocations
 * (`node test/compat/runtime-smoke.mjs`) reach the same smoke.
 *
 * What it exercises, in order:
 *   1. require(dist/extension.js) - the bundle parses and loads on this Node.
 *   2. activate(context) against a throwaway workspace holding a real small git repository
 *      (git init + three commits via child_process). No native addon is required: when no
 *      engine binary is present the extension falls back to the `git` CLI backend.
 *   3. The read path: the `git-graph-rs.view` command, invoked the way the Source Control view
 *      invokes it (a rootUri argument), opens the view on a stubbed webview panel; a
 *      `loadRepos` request returns the canonical repository path, and a real `loadCommits`
 *      request is answered through panel.postMessage with the fixture's commits. (The
 *      compiled reader is not reachable as a module - the dist bundle is a single CJS file -
 *      so the read is driven exactly the way the real webview drives it, through the handler
 *      table.)
 *   4. The write path: a `createBranch` request over the same protocol. The handler runs the
 *      repository write (GitWriter under the CLI backend); the smoke then verifies with git
 *      that the branch exists and points at the requested commit.
 *   5. deactivate() and disposal of every context subscription.
 *
 * Asserted throughout: no unhandled promise rejection (process listener), the read returned
 * commits, the branch exists. Process exit code 0 is the pass signal.
 *
 *   node test/compat/runtime-smoke.cjs
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const distEntry = path.join(root, 'dist', 'extension.js');

function fail(message) {
	console.error('RUNTIME SMOKE FAILED: ' + message);
	process.exit(1);
}

function sleep(ms) {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Poll until `condition` returns a truthy value; null after ~10 seconds. */
async function waitFor(condition) {
	for (let i = 0; i < 400; i++) {
		const value = condition();
		if (value) return value;
		await sleep(25);
	}
	return null;
}

if (!fs.existsSync(distEntry)) {
	fail('dist/extension.js is missing: run npm run build:dist first');
}

/* ---------- a real small git repository in a throwaway workspace ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-runtime-smoke-'));
const repoDir = path.join(tmp, 'repo');
fs.mkdirSync(repoDir);
const git = (args, cwd) => execFileSync('git', ['-c', 'core.autocrlf=false'].concat(args), { cwd: cwd || repoDir, encoding: 'utf8' });
git(['init', '-q']);
git(['checkout', '-q', '-b', 'main']);
git(['config', 'user.email', 'smoke@example.com']);
git(['config', 'user.name', 'Runtime Smoke']);
for (let i = 1; i <= 3; i++) {
	fs.writeFileSync(path.join(repoDir, 'file' + i + '.txt'), 'commit ' + i + '\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'commit ' + i]);
}

/* ---------- the vscode module stub (Module._load hook, per tests/vscodeStub.mjs) ---------- */

function createMemento() {
	const store = {};
	return {
		store,
		get(key, defaultValue) {
			return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue;
		},
		update(key, value) {
			store[key] = value;
			return Promise.resolve();
		},
		keys() {
			return Object.keys(store);
		}
	};
}

function disposable() {
	return { dispose() {} };
}

function createEventEmitter() {
	const listeners = [];
	const event = (listener) => {
		listeners.push(listener);
		return { dispose() { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } };
	};
	return {
		event,
		fire(value) { for (const listener of listeners.slice()) listener(value); },
		dispose() { listeners.length = 0; }
	};
}

function createWebviewPanelStub() {
	const sent = [];
	const receivers = [];
	const disposeListeners = [];
	return {
		webview: {
			options: {},
			cspSource: 'vscode-webview://stub',
			html: '',
			asWebviewUri(uri) { return uri; },
			postMessage(message) { sent.push(message); return Promise.resolve(true); },
			onDidReceiveMessage(listener) {
				receivers.push(listener);
				return { dispose() { const index = receivers.indexOf(listener); if (index >= 0) receivers.splice(index, 1); } };
			}
		},
		sent,
		visible: true,
		viewColumn: 1,
		title: 'Git Graph RS',
		iconPath: undefined,
		onDidDispose(listener) {
			disposeListeners.push(listener);
			return { dispose() { const index = disposeListeners.indexOf(listener); if (index >= 0) disposeListeners.splice(index, 1); } };
		},
		onDidChangeViewState() { return disposable(); },
		reveal() {},
		/** VS Code fires the panel's onDidDispose listeners when the panel closes. */
		dispose() {
			for (let i = 0; i < disposeListeners.length; i++) disposeListeners[i]();
		},
		/** Deliver a message as the webview would (the extension's request entry point). */
		receive(message) {
			for (const receiver of receivers.slice()) receiver(message);
		}
	};
}

const registeredCommands = new Map();
const panels = [];
const outputChannels = [];
const statusBarItems = [];
const userMessages = [];

const vscodeStub = {
	version: '1.38.0',
	env: {
		appName: 'Visual Studio Code',
		language: 'en',
		uriScheme: 'vscode',
		clipboard: { writeText() { return Promise.resolve(); } },
		openExternal() { return Promise.resolve(true); }
	},
	Uri: {
		file(p) { return { scheme: 'file', fsPath: p, path: String(p).replace(/\\/g, '/'), query: '', fragment: '', authority: '', with(change) { const next = Object.create(this); Object.assign(next, this, change); return next; } }; },
		parse(value) { return vscodeStub.Uri.file(value); },
		joinPath(uri) { const parts = Array.prototype.slice.call(arguments, 1); return vscodeStub.Uri.file(path.join(uri.fsPath, ...parts)); }
	},
	EventEmitter: createEventEmitter,
	RelativePattern: function RelativePattern(base, pattern) { this.base = base; this.pattern = pattern; },
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ProgressLocation: { Notification: 15, Window: 10 },
	window: {
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: createEventEmitter().event,
		showInformationMessage() { userMessages.push(Array.prototype.slice.call(arguments)); return Promise.resolve(undefined); },
		showWarningMessage() { userMessages.push(Array.prototype.slice.call(arguments)); return Promise.resolve(undefined); },
		showErrorMessage() { userMessages.push(Array.prototype.slice.call(arguments)); return Promise.resolve(undefined); },
		showQuickPick() { return Promise.resolve(undefined); },
		showInputBox() { return Promise.resolve(undefined); },
		showOpenDialog() { return Promise.resolve(undefined); },
		showSaveDialog() { return Promise.resolve(undefined); },
		showTextDocument() { return Promise.resolve(undefined); },
		withProgress(options, task) { return task({ report() {} }); },
		createTerminal() {
			return { sendText() {}, show() {}, hide() {}, dispose() {} };
		},
		createStatusBarItem(alignment, priority) {
			const item = { alignment, priority, text: '', tooltip: '', command: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
			statusBarItems.push(item);
			return item;
		},
		createOutputChannel(name) {
			const channel = { name, lines: [], appendLine(line) { this.lines.push(line); }, show() {}, dispose() {} };
			outputChannels.push(channel);
			return channel;
		},
		createWebviewPanel(viewType, title, showOptions, options) {
			const panel = createWebviewPanelStub();
			panel.viewType = viewType;
			panels.push(panel);
			return panel;
		},
		registerWebviewPanelSerializer() { return disposable(); }
	},
	workspace: {
		workspaceFolders: [{ uri: vscodeStubUriFile(repoDir), name: 'repo', index: 0 }],
		getConfiguration(section) {
			return {
				get(key, defaultValue) { return defaultValue; },
				has() { return false; },
				inspect() { return undefined; },
				update() { return Promise.resolve(); }
			};
		},
		onDidChangeConfiguration: createEventEmitter().event,
		onDidChangeWorkspaceFolders: createEventEmitter().event,
		onDidCloseTextDocument: createEventEmitter().event,
		createFileSystemWatcher() {
			const never = () => ({ dispose() {} });
			return { onDidChange: never, onDidCreate: never, onDidDelete: never, dispose() {} };
		},
		registerTextDocumentContentProvider() { return disposable(); },
		openTextDocument() { return Promise.resolve(undefined); }
	},
	commands: {
		registerCommand(command, callback) {
			registeredCommands.set(command, callback);
			return { dispose() { registeredCommands.delete(command); } };
		},
		registerTextEditorCommand(command, callback) {
			registeredCommands.set(command, callback);
			return disposable();
		},
		executeCommand() { return Promise.resolve(undefined); }
	},
	extensions: { getExtension() { return undefined; } }
};

function vscodeStubUriFile(p) {
	return { scheme: 'file', fsPath: p, path: String(p).replace(/\\/g, '/'), query: '', fragment: '', authority: '', with(change) { return Object.assign({}, this, change); } };
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

/* ---------- the unhandled-rejection tripwire ---------- */

const unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
	unhandledRejections.push(String(reason && reason.stack ? reason.stack : reason));
});

/* ---------- the smoke ---------- */

async function main() {
	const started = Date.now();
	const extension = require(distEntry);
	if (typeof extension.activate !== 'function' || typeof extension.deactivate !== 'function') {
		fail('dist/extension.js does not export activate/deactivate');
	}

	const context = {
		subscriptions: [],
		extensionPath: root,
		globalStoragePath: path.join(tmp, 'global-storage'),
		globalState: createMemento(),
		workspaceState: createMemento()
	};
	await extension.activate(context);

	// The view command, invoked the way the Source Control view invokes it (a rootUri
	// argument): it resolves (or registers) the repository itself, so the smoke does not
	// depend on the timing or shape of the workspace scan's internal bookkeeping.
	const viewCommand = registeredCommands.get('git-graph-rs.view');
	if (viewCommand === undefined) fail('git-graph-rs.view is not registered after activate()');
	await viewCommand({ rootUri: vscodeStub.Uri.file(repoDir) });
	if (panels.length !== 1) fail('expected exactly one webview panel, got ' + panels.length);
	const rendered = await waitFor(() => panels[0].webview.html !== '' ? true : null);
	if (rendered === null) {
		// The extension log (enabled through the stub) is the fastest route to the cause.
		for (let c = 0; c < outputChannels.length; c++) {
			const lines = outputChannels[c].lines;
			for (let i = Math.max(0, lines.length - 15); i < lines.length; i++) console.error('log: ' + lines[i]);
		}
		fail('the view command did not render the webview HTML; dialogs: ' + JSON.stringify(userMessages.slice(0, 3)));
	}

	// Ask for the known repositories in the view protocol itself: the response's keys are the
	// canonical repository paths the rest of the protocol speaks.
	panels[0].receive({ command: 'loadRepos', check: false });
	const reposResponse = await waitFor(() => {
		for (let i = 0; i < panels[0].sent.length; i++) {
			const message = panels[0].sent[i];
			if (message && message.command === 'loadRepos' && message.repos) return message;
		}
		return null;
	});
	if (reposResponse === null) fail('no loadRepos response reached the webview');
	const repoPaths = Object.keys(reposResponse.repos).filter((repo) => repo.replace(/\\/g, '/').endsWith('/repo'));
	if (repoPaths.length !== 1) {
		fail('expected exactly the workspace repository to be known, got: ' + JSON.stringify(Object.keys(reposResponse.repos)));
	}
	const repoPath = repoPaths[0];
	console.log('repo discovered: ' + repoPath);

	// The read path: one real loadCommits request, answered through the panel protocol.
	panels[0].receive({
		command: 'loadCommits',
		repo: repoPath,
		refreshId: 1,
		hard: true,
		branches: null,
		authors: null,
		maxCommits: 300,
		showTags: true,
		showRemoteBranches: false,
		includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: false,
		commitOrdering: 'date',
		remotes: [],
		hideRemotes: [],
		stashes: [],
		gerritFetchRefs: false,
		gerritFetchLimit: null,
		gerritStatusFilter: { new: false, merged: false, abandoned: false, wip: false },
		filterPath: null
	});
	const commitsResponse = await waitFor(() => {
		for (let i = 0; i < panels[0].sent.length; i++) {
			const message = panels[0].sent[i];
			if (message && message.command === 'loadCommits' && Array.isArray(message.commits)) return message;
		}
		return null;
	});
	if (commitsResponse === null) {
		fail('no loadCommits response reached the webview; user messages seen: ' + JSON.stringify(userMessages.slice(0, 3)));
	}
	if (commitsResponse.error !== null && commitsResponse.error !== undefined) {
		fail('loadCommits returned an error: ' + JSON.stringify(commitsResponse.error));
	}
	const realCommits = commitsResponse.commits.filter((commit) => commit.hash !== '*');
	if (realCommits.length < 3) {
		fail('expected the 3 fixture commits, got ' + realCommits.length + ': ' + JSON.stringify(commitsResponse.commits).slice(0, 400));
	}
	console.log('read path: loadCommits returned ' + realCommits.length + ' commits');

	// The write path: one createBranch through the same protocol (GitWriter under the CLI
	// backend; the native addon is not required).
	const commitHash = realCommits[0].hash;
	panels[0].receive({
		command: 'createBranch',
		repo: repoPath,
		commitHash,
		branchName: 'smoke-created-branch',
		checkout: false,
		force: false
	});
	const branchResponse = await waitFor(() => {
		for (let i = 0; i < panels[0].sent.length; i++) {
			const message = panels[0].sent[i];
			if (message && message.command === 'createBranch') return message;
		}
		return null;
	});
	if (branchResponse === null) fail('no createBranch response reached the webview');
	const branchErrors = branchResponse.errors || [branchResponse.error];
	for (let i = 0; i < branchErrors.length; i++) {
		if (branchErrors[i] !== null && branchErrors[i] !== undefined) {
			fail('createBranch reported an error: ' + JSON.stringify(branchErrors[i]));
		}
	}

	// The branch must exist and point at the requested commit. (assert.match postdates Node
	// 10, so the hex check stays manual.)
	const branchRef = git(['rev-parse', '--verify', 'refs/heads/smoke-created-branch']).trim();
	if (!/^[0-9a-f]{40}$/.test(branchRef)) fail('git rev-parse did not return a full object name: ' + branchRef);
	if (branchRef.toLowerCase() !== String(commitHash).toLowerCase()) {
		fail('the branch points at ' + branchRef + ', expected the requested commit ' + commitHash);
	}
	console.log('write path: createBranch created refs/heads/smoke-created-branch at ' + branchRef.slice(0, 12));

	// Tear everything down the way VS Code would: dispose the open panel (firing the view's
	// teardown), deactivate, then dispose every context subscription.
	panels[0].dispose();
	extension.deactivate();
	for (let i = 0; i < context.subscriptions.length; i++) {
		try {
			context.subscriptions[i].dispose();
		} catch (error) {
			fail('disposing a context subscription threw: ' + error);
		}
	}
	await sleep(250); // let straggling promises settle before judging the tripwire

	if (unhandledRejections.length > 0) {
		fail(unhandledRejections.length + ' unhandled rejection(s):\n' + unhandledRejections.join('\n---\n'));
	}

	console.log('deactivate() + disposal clean; no unhandled rejections');
	console.log('RUNTIME SMOKE PASSED on ' + process.version + ' in ' + (Date.now() - started) + ' ms');
}

main().then(() => {
	cleanup();
	// Exit explicitly: activated subsystems (e.g. the prewarming idle-close timers, task 4.9)
	// legitimately keep the event loop alive for minutes after deactivate, which a bare
	// `node script` run must not wait out.
	process.exit(0);
}, (error) => {
	console.error('RUNTIME SMOKE FAILED: ' + (error && error.stack ? error.stack : error));
	cleanup();
	process.exit(1);
});

/** Best-effort temp cleanup: fs.rmSync is Node 14.14+, so older Nodes keep the temp dir. */
function cleanup() {
	if (typeof fs.rmSync === 'function') {
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch (_) {
			// The OS temp directory is disposable; a failed cleanup is not a smoke failure.
		}
	}
}
