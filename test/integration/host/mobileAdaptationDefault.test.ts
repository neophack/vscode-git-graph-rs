/**
 * The `mobileAdaptation` default is host-aware: Git Graph Studio (uriScheme 'ggs') enables the
 * narrow-window phone layout out of the box — the studio's remote phone sessions are the
 * layout's audience — while VS Code keeps the marketplace default (off). An explicitly set value
 * always wins on every host, and the studio default is SEEDED into the settings store once at
 * activation (so the studio's own Settings dialog, which reads the store, agrees with the
 * runtime default) — never overwriting a value the user set or reset.
 *
 * Ported from tests/mobileAdaptationDefault.test.mjs (REFACTOR-PLAN task 7.1); assertions are
 * unchanged. The activation seeding is exercised against the real activate() booted on a
 * throwaway repository, the same shape extensionHost.test.ts uses.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it, vi } from 'vitest';
import { vscodeState } from '../../support/vscodeAlias';
import { vscodeMockOf } from '../../support/fakeVscode';
import { getConfig } from '../../../src/extension/platform/config';
import { activate } from '../../../src/extension';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-mobile-default-'));
const repoDir = path.join(tmp, 'repo');
fs.mkdirSync(repoDir);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
fs.writeFileSync(path.join(repoDir, 'a.txt'), 'first\n');
execFileSync('git', ['add', 'a.txt'], { cwd: repoDir });
execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: repoDir });

// Windows keeps transient handles on freshly-written temp trees (AV scans, indexer); the
// cleanup is best-effort - a stuck temp dir must not fail behaviour tests that already passed.
afterAll(() => {
	try {
		fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}	catch { /* best-effort: the OS reclaims its temp root */ }
});

/* Point the shared alias stub at the throwaway workspace under the studio host. */
const stub: any = vscodeMockOf(vscodeState);
stub.workspace.workspaceFolders = [{ uri: stub.Uri.file(repoDir), name: 'repo', index: 0 }];
stub.env.uriScheme = 'ggs';
afterAll(() => { stub.env.uriScheme = 'vscode'; });

describe('the mobileAdaptation host-aware default (config.ts)', () => {
	it('is ON under Git Graph Studio while unset, and OFF under VS Code', () => {
		delete vscodeState.settings.mobileAdaptation;

		assert.equal(getConfig().mobileAdaptation, true, 'the studio host defaults the phone layout on');

		stub.env.uriScheme = 'vscode';
		assert.equal(getConfig().mobileAdaptation, false, 'VS Code keeps the marketplace default (off)');
		stub.env.uriScheme = 'ggs';
	});

	it('lets an explicitly set value win on every host', () => {
		vscodeState.settings.mobileAdaptation = false;
		assert.equal(getConfig().mobileAdaptation, false, 'an explicit OFF stays off under the studio host');

		stub.env.uriScheme = 'vscode';
		vscodeState.settings.mobileAdaptation = true;
		assert.equal(getConfig().mobileAdaptation, true, 'an explicit ON is on under VS Code');

		delete vscodeState.settings.mobileAdaptation;
		stub.env.uriScheme = 'ggs';
	});
});

describe('the activation seeds the studio default once (extension.ts)', () => {
	const activationContext = (name: string) => ({
		subscriptions: [] as Array<{ dispose(): void }>,
		extensionPath: root,
		globalStoragePath: path.join(tmp, name),
		globalState: createMemento(),
		workspaceState: createMemento()
	});
	const seedCalls = () => vscodeState.callsTo('configuration.update').filter((call) => call.args[1] === 'mobileAdaptation');
	// extensionHost.test.ts's exit shape: disposing the subscriptions releases the watchers the
	// activation leaves behind, or the test worker never settles
	const run = async (name: string) => {
		const context = activationContext(name);
		await activate(context as never);
		return () => { for (const subscription of context.subscriptions) subscription.dispose(); };
	};

	it('writes true into the global settings when the studio host has no value set', async () => {
		vscodeState.resetCalls();
		delete vscodeState.settings.mobileAdaptation;

		const dispose = await run('global-storage-1');

		const seeds = seedCalls();
		assert.equal(seeds.length, 1, 'exactly one seed write happened');
		assert.equal(seeds[0].args[2], true, 'it seeds the phone layout ON');
		assert.equal(vscodeState.settings.mobileAdaptation, true, 'the store now carries the default');
		dispose();
	});

	it('never touches a value the user set (an explicit OFF after a reset stays off)', async () => {
		vscodeState.resetCalls();
		vscodeState.settings.mobileAdaptation = false;

		const dispose = await run('global-storage-2');

		assert.equal(seedCalls().length, 0, 'no seed write for an explicitly set value');
		assert.equal(vscodeState.settings.mobileAdaptation, false, 'the explicit OFF is untouched');
		dispose();
	});

	it('does not seed under VS Code', async () => {
		// the modules read the stub object at call time, so the scheme is flipped on it
		stub.env.uriScheme = 'vscode';
		vscodeState.resetCalls();
		delete vscodeState.settings.mobileAdaptation;

		const dispose = await run('global-storage-3');

		assert.equal(seedCalls().length, 0, 'VS Code activates without any seed write');
		assert.equal(vscodeState.settings.mobileAdaptation, undefined, 'the store is left alone');
		dispose();
		stub.env.uriScheme = 'ggs';
	});
});
