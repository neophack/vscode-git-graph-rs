/**
 * The `mobileAdaptation` default is host-aware: Git Graph Studio (uriScheme 'ggs') enables the
 * narrow-window phone layout out of the box — the studio's remote phone sessions are the
 * layout's audience — while VS Code keeps the marketplace default (off). An explicitly set value
 * always wins on every host, and the studio default is SEEDED into the settings store once at
 * activation (so the studio's own Settings dialog, which reads the store, agrees with the
 * runtime default) — never overwriting a value the user set or reset.
 *
 * The activation seeding is exercised against the real activate() booted on a throwaway
 * repository, the same shape extensionHost.test.mjs uses.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createVscodeStub, installVscodeStub } from './vscodeStub.mjs';

/** The memento stand-in extensionHost.test.mjs uses for the activation contexts. */
function createMemento(initial = {}) {
	const store = Object.assign({}, initial);
	return {
		store,
		get: (key, defaultValue) => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue,
		update: (key, value) => { store[key] = value; return Promise.resolve(); },
		keys: () => Object.keys(store)
	};
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-mobile-default-'));
const repoDir = path.join(tmp, 'repo');
fs.mkdirSync(repoDir);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
fs.writeFileSync(path.join(repoDir, 'a.txt'), 'first\n');
execFileSync('git', ['add', 'a.txt'], { cwd: repoDir });
execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: repoDir });

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const vscode = createVscodeStub({ uriScheme: 'ggs', workspaceFolders: [{ path: repoDir }] });
const restore = installVscodeStub(vscode);
after(() => restore());

describe('the mobileAdaptation host-aware default (config.ts)', () => {
	it('is ON under Git Graph Studio while unset, and OFF under VS Code', async () => {
		const { getConfig } = await import('../out/config.js');

		assert.equal(getConfig().mobileAdaptation, true, 'the studio host defaults the phone layout on');

		vscode.env.uriScheme = 'vscode';
		assert.equal(getConfig().mobileAdaptation, false, 'VS Code keeps the marketplace default (off)');
		vscode.env.uriScheme = 'ggs';
	});

	it('lets an explicitly set value win on every host', async () => {
		const { getConfig } = await import('../out/config.js');

		vscode.settings.mobileAdaptation = false;
		assert.equal(getConfig().mobileAdaptation, false, 'an explicit OFF stays off under the studio host');

		vscode.env.uriScheme = 'vscode';
		vscode.settings.mobileAdaptation = true;
		assert.equal(getConfig().mobileAdaptation, true, 'an explicit ON is on under VS Code');

		delete vscode.settings.mobileAdaptation;
		vscode.env.uriScheme = 'ggs';
	});
});

describe('the activation seeds the studio default once (extension.ts)', () => {
	const activationContext = (name) => ({
		subscriptions: [],
		extensionPath: root,
		globalStoragePath: path.join(tmp, name),
		globalState: createMemento(),
		workspaceState: createMemento()
	});
	const seedCalls = () => vscode.calls.filter((call) => call.name === 'configuration.update' && call.args[1] === 'mobileAdaptation');
	// extensionHost.test.mjs's exit shape: disposing the subscriptions releases the watchers the
	// activation leaves behind, or the test process never exits
	const run = async (name) => {
		const { activate } = await import('../out/extension.js');
		const context = activationContext(name);
		await activate(context);
		return () => { for (const subscription of context.subscriptions) subscription.dispose(); };
	};

	it('writes true into the global settings when the studio host has no value set', async () => {
		vscode.calls.length = 0;
		delete vscode.settings.mobileAdaptation;

		const dispose = await run('global-storage-1');

		const seeds = seedCalls();
		assert.equal(seeds.length, 1, 'exactly one seed write happened');
		assert.equal(seeds[0].args[2], true, 'it seeds the phone layout ON');
		assert.equal(vscode.settings.mobileAdaptation, true, 'the store now carries the default');
		dispose();
	});

	it('never touches a value the user set (an explicit OFF after a reset stays off)', async () => {
		vscode.calls.length = 0;
		vscode.settings.mobileAdaptation = false;

		const dispose = await run('global-storage-2');

		assert.equal(seedCalls().length, 0, 'no seed write for an explicitly set value');
		assert.equal(vscode.settings.mobileAdaptation, false, 'the explicit OFF is untouched');
		dispose();
	});

	it('does not seed under VS Code', async () => {
		// extension.js captured the stub object at import time, so the scheme is flipped on it
		vscode.env.uriScheme = 'vscode';
		vscode.calls.length = 0;
		delete vscode.settings.mobileAdaptation;

		const dispose = await run('global-storage-3');

		assert.equal(seedCalls().length, 0, 'VS Code activates without any seed write');
		assert.equal(vscode.settings.mobileAdaptation, undefined, 'the store is left alone');
		dispose();
		vscode.env.uriScheme = 'ggs';
	});
});
