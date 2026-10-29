/**
 * The host side of the Commit Comparison View's boot seam (task 6.1's controller): the `init`
 * message the panel posts once the frontend's `ready` handshake and the comparison data are both
 * in — in particular the `mobileAdaptation` flag the page's layout decision consumes, which is
 * the one setting the page receives and the only line connecting the ConfigProvider to the
 * frontend. The frontend half of the suite lives in comparisonWebview.test.ts.
 *
 * The panel is a hand-rolled double over the recording `vscode` stub (`createWebviewPanel` is
 * answered per test), so what is asserted is the message traffic, not the rendering.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

/* The hoisted mock state: the recording `vscode` stub, whose responses the tests steer. */
const vs = vi.hoisted(() => ({
	stateHolder: {} as { state: { responses: Record<string, unknown> } }
}));

vi.mock('vscode', async () => {
	const { createVscodeState, vscodeMockOf } = await import('../../support/fakeVscode');
	const state = createVscodeState({ workspaceFolders: [{ path: '/ws' }] });
	vs.stateHolder.state = vscodeMockOf(state) as never;
	return vscodeMockOf(state);
});

import { CommitComparisonView } from '../../../src/extension/views/comparison/viewController';
import type { GitBackend } from '../../../src/extension/git/read/gitReader';
import type { ConfigProvider } from '../../../src/extension/platform/config';

const vscode = () => vs.stateHolder.state;

/** A webview panel double: captures the posted messages and the page's request handler. */
function makePanel() {
	const posted: any[] = [];
	let messageHandler: ((message: any) => void) | null = null;
	const panel: any = {
		webview: {
			html: '',
			cspSource: 'vscode-webview-test:',
			asWebviewUri: (uri: unknown) => uri,
			onDidReceiveMessage: (handler: (message: any) => void) => {
				messageHandler = handler;
				return { dispose() { /* nothing */ } };
			},
			postMessage: (message: unknown) => {
				posted.push(JSON.parse(JSON.stringify(message)));
				return Promise.resolve(true);
			}
		},
		onDidDispose: () => ({ dispose() { /* nothing */ } }),
		reveal: () => { /* nothing */ },
		dispose: () => { /* nothing */ }
	};
	return {
		panel: panel,
		posted: posted,
		receive: (message: unknown) => {
			assert.ok(messageHandler !== null, 'the page must have registered its message handler');
			messageHandler!(message);
		}
	};
}

/** A read backend answering one modified file (or the scripted comparison failure). */
function readDouble(options: { comparisonError?: Error } = {}) {
	return {
		compareCommits: (_repo: string, _from: string, _to: string) => options.comparisonError !== undefined
			? Promise.reject(options.comparisonError)
			: Promise.resolve([{ oldFilePath: 'a.txt', newFilePath: 'a.txt', type: 'M', additions: null, deletions: null }]),
		getCommitSummaries: (_repo: string, _hashes: ReadonlyArray<string>) => Promise.resolve({}),
		countCommitsBefore: (_repo: string, _refs: ReadonlyArray<string>, _hash: string) => Promise.resolve(1)
	} as unknown as GitBackend;
}

const configOf = (mobileAdaptation: boolean) => ({ current: { mobileAdaptation } }) as unknown as ConfigProvider;

/** Open a view and let its boot data resolve; the awaited value is the panel double. */
async function openView(fromHash: string, toHash: string, config: ConfigProvider, read: GitBackend) {
	const harness = makePanel();
	vscode().responses['createWebviewPanel'] = () => harness.panel;
	CommitComparisonView.open('/ext', read, { } as never, config, '/repo', fromHash, toHash, false);
	await new Promise((resolve) => setTimeout(resolve, 20)); // the boot comparison resolves
	return harness;
}

describe('the Commit Comparison View host', () => {
	it('posts the init message with the mobileAdaptation flag of the config, once the page is ready', async () => {
		const page = await openView('b000000000000000000000000000000000000000', 'cccccccccccccccccccccccccccccccccccccccc', configOf(true), readDouble());
		assert.equal(page.posted.length, 0, 'nothing is posted before the ready handshake');

		page.receive({ command: 'ready' });
		assert.equal(page.posted.length, 1);
		const init = page.posted[0];
		assert.equal(init.command, 'init');
		assert.equal(init.mobileAdaptation, true, 'the page receives the setting at open time');
		assert.deepEqual(init.changes, [{ oldFilePath: 'a.txt', newFilePath: 'a.txt', type: 'M', additions: null, deletions: null }]);
	});

	it('carries the flag on the failed comparison\'s init too (the setting reaches the page either way)', async () => {
		const page = await openView('e000000000000000000000000000000000000000', 'ffffffffffffffffffffffffffffffffffffffff', configOf(false), readDouble({ comparisonError: new Error('git failed') }));
		page.receive({ command: 'ready' });
		const init = page.posted[0];
		assert.equal(init.command, 'init');
		assert.equal(init.error, 'git failed');
		assert.equal(init.mobileAdaptation, false);
		assert.deepEqual(init.changes, []);
	});
});
