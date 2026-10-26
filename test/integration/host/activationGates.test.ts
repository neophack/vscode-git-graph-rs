/**
 * The activation gates of OPTIMIZATION-PLAN V1/V2, booted against the real `activate()` (the
 * same shape extensionHost.test.ts uses):
 *
 * - V1: commands, the webview panel serializer and the text document content provider are
 *   registered BEFORE the Git resolution answers — `findGit` is stubbed to never resolve, and
 *   activation still completes with everything registered.
 * - V1: the "no engine for this platform" information shows ONCE PER EXTENSION VERSION
 *   (globalState flag keyed by version), not on every activation.
 * - V2: an untrusted workspace activates in Restricted Mode — the banner shows once, no `git`
 *   spawn happens at all, write commands are refused, and repository discovery (which the
 *   engine-less machine serves over the CLI when trusted) finds nothing because the backend is
 *   engine-only. The addon loader is forced unavailable so the backend choice is identical on
 *   every machine.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, it, vi } from 'vitest';
import { vscodeState } from '../../support/vscodeAlias';
import { vscodeMockOf } from '../../support/fakeVscode';
import { activate } from '../../../src/extension/main';
import { STRINGS_EN } from '../../../src/shared/i18n';
import type { GitExecutable } from '../../../src/extension/git/executable/findGit';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

/* The Git discovery is stubbed: never resolving unless a test says otherwise. */
const findStub = vi.hoisted(() => ({
	calls: 0,
	impl: (): Promise<GitExecutable> => new Promise(() => { /* never resolves */ })
}));
vi.mock('../../../src/extension/git/executable/findGit', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/extension/git/executable/findGit')>();
	return {
		...actual,
		findGit: () => {
			findStub.calls++;
			return findStub.impl();
		}
	};
});

/* The addon is forced unavailable: the backend choice under test is then machine-independent. */
vi.mock('../../../src/extension/git/read/addonLoader', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/extension/git/read/addonLoader')>();
	return {
		...actual,
		isAddonAvailable: () => false,
		hasEngineForPlatform: () => false
	};
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-activation-gates-'));
const repoDir = path.join(tmp, 'repo');
fs.mkdirSync(repoDir);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

const stub: any = vscodeMockOf(vscodeState);

afterAll(async () => {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== 'EPERM') return;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
});

/** The memento stand-in extensionHost.test.ts uses for the activation contexts. */
function createMemento(initial: Record<string, unknown> = {}) {
	const store = Object.assign({}, initial);
	return {
		store,
		get: (key: string, defaultValue: unknown) => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue,
		update: (key: string, value: unknown) => { store[key] = value; return Promise.resolve(); },
		keys: () => Object.keys(store)
	};
}

/**
 * An activation context in the tmp tree. `package.json` exists so the `version` command can read
 * it; `extension.packageJSON.version` is what keys the once-per-version flags.
 */
function contextOf(name: string, version: string, globalState = createMemento()) {
	const extensionPath = path.join(tmp, name);
	fs.mkdirSync(extensionPath, { recursive: true });
	fs.writeFileSync(path.join(extensionPath, 'package.json'), JSON.stringify({ name: 'git-graph-rs', version }));
	const context = {
		subscriptions: [] as Array<{ dispose(): void }>,
		extensionPath,
		globalStoragePath: path.join(extensionPath, 'global-storage'),
		globalState,
		workspaceState: createMemento(),
		extension: { packageJSON: { version } }
	};
	return {
		context,
		dispose: () => { for (const subscription of context.subscriptions) subscription.dispose(); }
	};
}

/** The repositories discovered into a context's workspace state (empty until one is found). */
function discoveredRepos(context: { workspaceState: { store: Record<string, unknown> } }): string[] {
	return Object.keys(((context.workspaceState.store.repoStates ?? {}) as { data?: Record<string, unknown> }).data ?? {});
}

/** No workspace folders: repository discovery and the status bar stay out of the way. */
function noWorkspaceFolders() {
	stub.workspace.workspaceFolders = [];
}

describe('activate() registers everything before the Git resolution answers (V1)', () => {
	it('registers the commands, the serializer target view and the content provider while findGit never resolves', async () => {
		findStub.calls = 0;
		findStub.impl = () => new Promise(() => { /* never resolves */ });
		noWorkspaceFolders();
		const { context, dispose } = contextOf('register-first', '1.0.0-register');
		vscodeState.resetCalls();
		vscodeState.textDocumentContentProviders.clear();

		await activate(context as never);

		// The background validation has started (and is still in flight) ...
		assert.equal(findStub.calls, 1);
		// ... yet every command is already registered, together with the content provider.
		assert.ok(vscodeState.registeredCommands.has('git-graph-rs.view'), 'the view command is registered');
		assert.ok(vscodeState.registeredCommands.has('git-graph-rs.amendLastCommit'), 'a write command is registered');
		assert.ok(vscodeState.registeredCommands.has('git-graph-rs.gerritPushRef.zhCn'), 'the zhCn variants are registered');
		assert.ok(vscodeState.textDocumentContentProviders.has('git-graph-rs'), 'the diff document content provider is registered');
		// Nothing failed yet — Git is merely not validated, which is not an error.
		assert.equal(vscodeState.callsTo('showErrorMessage').length, 0);
		assert.ok(!vscodeState.callsTo('showInformationMessage').some((call) => String(call.args[0]).includes('no Git executable was found')));

		dispose();
	});
});

describe('the no-engine information shows once per extension version (V1)', () => {
	const noEngineMessages = () => vscodeState.callsTo('showInformationMessage')
		.filter((call) => String(call.args[0]).includes('no native engine is available'));

	it('shows on the first activation of a version, not again on the next, and again after an update', async () => {
		findStub.impl = () => new Promise(() => { /* never resolves */ });
		noWorkspaceFolders();
		const shared = createMemento();

		const first = contextOf('once-v1', '2.0.0-once', shared);
		vscodeState.resetCalls();
		await activate(first.context as never);
		assert.equal(noEngineMessages().length, 1, 'the first activation of a version shows the notice');
		first.dispose();

		const second = contextOf('once-v2', '2.0.0-once', shared);
		vscodeState.resetCalls();
		await activate(second.context as never);
		assert.equal(noEngineMessages().length, 0, 'a plain reload of the same version shows nothing');
		second.dispose();

		const updated = contextOf('once-v3', '2.0.1-once', shared);
		vscodeState.resetCalls();
		await activate(updated.context as never);
		assert.equal(noEngineMessages().length, 1, 'an updated version shows the notice again');
		updated.dispose();
	});
});

describe('an untrusted workspace activates in Restricted Mode (V2)', () => {
	/** Install a Workspace Trust surface (VS Code 1.56+) at the given level. */
	function trustSurface(trusted: boolean) {
		const listeners: Array<() => void> = [];
		(stub.workspace as Record<string, unknown>).isTrusted = trusted;
		(stub.workspace as Record<string, unknown>).onDidChangeWorkspaceTrust = (listener: () => void) => {
			listeners.push(listener);
			return { dispose() { /* nothing */ } };
		};
		return {
			setTrusted(value: boolean) {
				(stub.workspace as { isTrusted: boolean }).isTrusted = value;
				for (const listener of [...listeners]) listener();
			}
		};
	}

	it('shows the banner once, never spawns Git, refuses the write commands and still serves the view commands', async () => {
		const surface = trustSurface(false);
		findStub.calls = 0;
		findStub.impl = () => new Promise(() => { /* never resolves */ });
		noWorkspaceFolders();
		const { context, dispose } = contextOf('restricted', '1.0.0-restricted');
		vscodeState.resetCalls();

		await activate(context as never);

		// The one-time Restricted Mode banner
		assert.equal(vscodeState.callsTo('showInformationMessage').filter((call) => call.args[0] === STRINGS_EN.restrictedModeNotice).length, 1);
		// No git spawn at all — the resolution is deferred while untrusted
		assert.equal(findStub.calls, 0);

		// A write command is refused with the notice — not with a "no Git" error
		vscodeState.resetCalls();
		await vscodeState.runCommand('git-graph-rs.amendLastCommit', { rootUri: stub.Uri.file(repoDir) });
		assert.ok(vscodeState.callsTo('showInformationMessage').some((call) => call.args[0] === STRINGS_EN.restrictedModeNotice), 'the refusal carries the Restricted Mode notice');
		assert.equal(vscodeState.callsTo('showErrorMessage').length, 0, 'the refusal is not the misleading "unable to find Git" error');

		// A read-side command still runs: version answers, with Git shown as "(none)" — the
		// executable cell is empty in Restricted Mode whatever the cache says.
		vscodeState.resetCalls();
		await vscodeState.runCommand('git-graph-rs.version');
		assert.ok(vscodeState.callsTo('showInformationMessage').some((call) => String(call.args[0]).includes('(none)')), 'the version dialog answers with no Git executable');

		// Granting trust starts the deferred resolution and re-enables the write commands. The
		// stub now answers (no spawn), so the awaited resolution settles and the command runs.
		findStub.impl = () => Promise.resolve({ path: 'git', version: '2.99.0-test' });
		vscodeState.resetCalls();
		surface.setTrusted(true);
		assert.equal(findStub.calls, 1, 'the deferred Git validation starts when trust is granted');
		await vscodeState.runCommand('git-graph-rs.amendLastCommit', { rootUri: stub.Uri.file(repoDir) });
		assert.ok(!vscodeState.callsTo('showInformationMessage').some((call) => call.args[0] === STRINGS_EN.restrictedModeNotice), 'the command is no longer refused');

		dispose();
	});

	it('serves discovery from the engine only: a trusted activation finds the workspace repository, a restricted one does not', async () => {
		findStub.impl = () => new Promise(() => { /* never resolves */ });
		stub.workspace.workspaceFolders = [{ uri: stub.Uri.file(repoDir), name: 'repo', index: 0 }];

		// Trusted: no engine binary, so the CLI backend serves discovery — the repository is found
		trustSurface(true);
		const trusted = contextOf('discovery-trusted', '1.0.0-discovery');
		await activate(trusted.context as never);
		await vi.waitFor(() => {
			assert.ok(discoveredRepos(trusted.context).length > 0, 'the workspace repository is discovered over the CLI');
		});
		trusted.dispose();

		// Restricted: the backend is engine-only and (with no engine binary) unavailable — the
		// same workspace yields no repository, because no `git` CLI may run
		trustSurface(false);
		const restricted = contextOf('discovery-restricted', '1.0.0-discovery');
		await activate(restricted.context as never);
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(discoveredRepos(restricted.context).length, 0, 'no repository is discovered without the CLI');
		restricted.dispose();
	});
});
