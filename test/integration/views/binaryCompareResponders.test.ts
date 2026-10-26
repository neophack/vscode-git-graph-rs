/**
 * The host-side plumbing around the hex comparison that both comparison pages share (task 6.1:
 * the frontend halves of these suites live in src/webview/binaryCompare/*.test.ts, importing
 * the extracted modules - the flattened section layout's consumers, the scripted-page grid
 * tests, the selection & copy surface and the right-click menu; this file keeps what the HOST
 * does, driving the responders against throwaway git repositories, like the hex tests).
 *
 * Ported from tests/binaryCompare.test.mjs to the new tree's module
 * (src/extension/views/binaryCompare/binaryCompare, REFACTOR-PLAN task 7.1); assertions are
 * unchanged.
 *
 * The responders are the protocol boundary the webview talks to, so what matters is the echo:
 * the row width the page measured is the one the layout — and the reply — must use, the scan
 * result must arrive as the flattened `hexMap` the page's renderer consumes, and the clipboard
 * write must answer with the outcome the page's status line shows. The clipboard runs through
 * the shared `vscode` alias stub, so its calls and scripted failures are recordable.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, vi } from 'vitest';
import { vscodeState } from '../../support/vscodeAlias';
import { createHexSession, flatSections, respondCopyToClipboard, respondHexInfo, respondHexRows, wireHexSession } from '../../../src/extension/views/binaryCompare/binaryCompare';
import { t } from '../../../src/extension/platform/i18n';
import { UNCOMMITTED } from '../../../src/extension/platform/git';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

/* ---------- The flattened section layout ---------- */

describe('the flattened section layout', () => {
	it('answers null for a layout that has not been scanned yet', () => {
		assert.equal(flatSections(null), null);
	});

	it('flattens each section to old/new start+length and the equal flag', () => {
		assert.deepEqual(flatSections([
			{ os: 0, ol: 10, ns: 0, nl: 10, eq: true },
			{ os: 10, ol: 5, ns: 10, nl: 9, eq: false }
		] as never), [0, 10, 0, 10, 1, 10, 5, 10, 9, 0]);
	});
});

/* ---------- The host-side hex responders ---------- */

const gitSpawner = {
	spawnGitStream(args: string[], repo: string) {
		return spawn('git', args, { cwd: repo });
	}
};

const fileChange = (type: string, oldFilePath: string, newFilePath: string) => ({ oldFilePath, newFilePath, type, additions: null, deletions: null }) as never;

function git(repo: string, args: string[]) {
	const result = spawnSync('git', args, { cwd: repo, encoding: 'buffer', maxBuffer: 1 << 28 });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.toString();
}

/** A fresh repository, with a callback-scoped teardown registered through the test's context. */
function withRepo(run: (repo: string) => unknown) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bincompare-'));
	git(repo, ['init', '-q']);
	git(repo, ['config', 'user.email', 'test@test']);
	git(repo, ['config', 'user.name', 'test']);
	// A session's killed git children take a moment to release the repository on Windows, so the
	// removal retries with real waits until the directory is actually gone.
	const cleanup = async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				fs.rmSync(repo, { recursive: true, force: true });
				return;
			} catch (err) {
				// Windows releases the directory under either EPERM or EBUSY while the children exit.
				if (attempt >= 50 || ((err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EBUSY')) throw err;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	};
	return Promise.resolve().then(() => run(repo)).then(
		(value) => cleanup().then(() => value),
		(err) => cleanup().then(() => { throw err; })
	);
}

function bytes(length: number, seed: number) {
	const buffer = Buffer.alloc(length);
	for (let i = 0; i < length; i++) buffer[i] = (i * 31 + seed) & 0xff;
	return buffer;
}

/** A repository holding one modification of data.bin: a single byte changed at offset 10. */
function modifiedRepo(repo: string) {
	const original = bytes(100, 1);
	const modified = Buffer.from(original);
	modified[10] ^= 0xff;
	fs.writeFileSync(path.join(repo, 'data.bin'), original);
	git(repo, ['add', '.']);
	git(repo, ['commit', '-q', '-m', 'one']);
	const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
	fs.writeFileSync(path.join(repo, 'data.bin'), modified);
	git(repo, ['add', '.']);
	git(repo, ['commit', '-q', '-m', 'two']);
	return [fromHash, git(repo, ['rev-parse', 'HEAD']).trim()];
}

/** A wired-up session plus every message it posted, disposed when the callback returns. */
async function withSession(session: any, run: (posted: any[]) => unknown) {
	const posted: any[] = [];
	wireHexSession(session, 5, (message: unknown) => posted.push(message));
	try {
		return await run(posted);
	} finally {
		session.dispose();
	}
}

/** Wait until a message of the given command has been posted (the scan replies asynchronously). */
async function waitForMessage(posted: any[], command: string) {
	for (let attempt = 0; ; attempt++) {
		const message = posted.find((entry) => entry.command === command);
		if (message !== undefined || attempt >= 100) return message;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe('the host-side hex responders', () => {
	it('answer getHexInfo with the sizes, the applied row width, and the provisional layout', () => withRepo(async (repo) => {
		const [fromHash, toHash] = modifiedRepo(repo);
		const session = createHexSession(gitSpawner as never, repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		await withSession(session, async (posted) => {
			await respondHexInfo(session, 5, 8, (message: unknown) => posted.push(message));
			const reply = posted.find((message) => message.command === 'hexInfo');
			assert.ok(reply !== undefined, 'the hexInfo reply must be posted');
			assert.equal(reply.index, 5);
			assert.equal(reply.error, null);
			assert.equal(reply.oldSize, 100);
			assert.equal(reply.newSize, 100);
			assert.equal(reply.totalRows, 13); // 100 bytes at 8 per row
			// Regression: the reply used to echo the 16-byte constant whatever width the page had
			// measured, so a narrow window rendered rows the layout had not been built for.
			assert.equal(reply.bytesPerRow, 8);
			assert.equal(reply.rowHeight, 19);
			// The coarse scan only starts alongside init, so its layout is not there yet — the
			// reply leaves the sections null and the scan delivers them as a hexMap.
			assert.equal(reply.sections, null);
		});
	}));

	it('ignore a row width the webview does not offer, echoing the one in effect', () => withRepo(async (repo) => {
		const [fromHash, toHash] = modifiedRepo(repo);
		const session = createHexSession(gitSpawner as never, repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		await withSession(session, async (posted) => {
			await respondHexInfo(session, 5, 7, (message: unknown) => posted.push(message));
			const reply = posted.find((message) => message.command === 'hexInfo');
			assert.equal(reply.error, null);
			assert.equal(reply.bytesPerRow, 16);
			assert.equal(reply.totalRows, 7); // 100 bytes back at 16 per row
		});
	}));

	it('deliver the scan result as a flattened hexMap that agrees with the hexInfo', () => withRepo(async (repo) => {
		const [fromHash, toHash] = modifiedRepo(repo);
		const session = createHexSession(gitSpawner as never, repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		await withSession(session, async (posted) => {
			await respondHexInfo(session, 5, 8, (message: unknown) => posted.push(message));
			const hexMap = await waitForMessage(posted, 'hexMap');
			assert.ok(hexMap !== undefined, 'the background scan must post a hexMap');
			assert.equal(hexMap.index, 5);
			assert.equal(hexMap.error, null);
			assert.equal(hexMap.totalRows, 13);
			// 100 bytes is a single scan block holding one changed byte: one unequal section
			// spanning the whole file — [oldStart, oldLength, newStart, newLength, equal?].
			assert.deepEqual(hexMap.sections, [0, 100, 0, 100, 0]);
			const hexInfo = posted.find((message) => message.command === 'hexInfo');
			// The scan replaces the provisional layout with the real sections, bumping the
			// version so the page drops rows built for the provisional one.
			assert.ok(hexMap.layoutVersion > hexInfo.layoutVersion, 'the scanned layout must be a new layout version');
		});
	}));

	it('stream a window of rows on getHexRows', () => withRepo(async (repo) => {
		const [fromHash, toHash] = modifiedRepo(repo);
		const session = createHexSession(gitSpawner as never, repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		await withSession(session, async (posted) => {
			await respondHexInfo(session, 5, 8, (message: unknown) => posted.push(message));
			const hexMap = await waitForMessage(posted, 'hexMap'); // request rows for the final layout
			await respondHexRows(session, 5, 1, 2, (message: unknown) => posted.push(message));
			const reply = posted.filter((message) => message.command === 'hexRows').pop();
			assert.ok(reply !== undefined, 'the hexRows reply must be posted');
			assert.equal(reply.error, null);
			assert.equal(reply.start, 1);
			assert.equal(reply.rows.length, 2);
			// Row 1 holds bytes 8..15: the changed byte 10 lights up at position 2 of its mask.
			assert.equal(reply.rows[0].o, 8);
			assert.equal(Buffer.from(reply.rows[0].ob, 'base64').length, 8);
			assert.equal(reply.rows[0].om, '00100000');
			assert.equal(reply.layoutVersion, hexMap.layoutVersion, 'the rows must be built for the scanned layout');

			await respondHexRows(session, 5, 9999, 5, (message: unknown) => posted.push(message));
			const beyond = posted.filter((message) => message.command === 'hexRows').pop();
			assert.equal(beyond.error, null);
			assert.deepEqual(beyond.rows, []);
		});
	}));

	it('read the working tree through the UNCOMMITTED pseudo-hash', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'data.bin'), bytes(100, 3));
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		const edited = bytes(100, 3);
		edited[99] ^= 0xff;
		fs.writeFileSync(path.join(repo, 'data.bin'), edited);

		const session = createHexSession(gitSpawner as never, repo, fromHash, UNCOMMITTED, fileChange('M', 'data.bin', 'data.bin'));
		await withSession(session, async (posted) => {
			await respondHexInfo(session, 5, 16, (message: unknown) => posted.push(message));
			const reply = posted.find((message) => message.command === 'hexInfo');
			assert.equal(reply.error, null);
			assert.equal(reply.oldSize, 100);
			assert.equal(reply.newSize, 100); // the working-tree side comes from disk

			await respondHexRows(session, 5, 6, 1, (message: unknown) => posted.push(message));
			const rows = posted.filter((message) => message.command === 'hexRows').pop();
			assert.equal(Buffer.from(rows.rows[0].nb, 'base64').length, 4); // row 6 holds the last 4 bytes
			assert.equal(rows.rows[0].nm, '0001');
		});
	}));

	it('report a load failure through the localised error message', () => withRepo(async (repo) => {
		modifiedRepo(repo);
		const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
		const session = createHexSession(gitSpawner as never, repo, bogus, bogus, fileChange('M', 'data.bin', 'data.bin'));
		await withSession(session, async (posted) => {
			await respondHexInfo(session, 5, 16, (message: unknown) => posted.push(message));
			const reply = posted.find((message) => message.command === 'hexInfo');
			// git fails on the unknown revision; the responder surfaces that failure behind the
			// localised prefix, with the sizes and layout reset to their failure values.
			assert.ok(reply.error !== null && reply.error.startsWith(t('compareHexLoadError' as never, '')), reply.error);
			assert.ok(reply.error.includes(bogus), reply.error);
			assert.equal(reply.oldSize, -1);
			assert.equal(reply.newSize, -1);
			assert.equal(reply.totalRows, 0);
			assert.equal(reply.sections, null);
		});
	}));
});

describe('the clipboard responder', () => {
	it('writes the payload through the VS Code clipboard and echoes the outcome for the status line', async () => {
		// The alias stub's clipboard records every write and answers from the scripted responses.
		delete vscodeState.responses['clipboard.writeText'];
		vscodeState.resetCalls();
		const posted: any[] = [];
		await respondCopyToClipboard((message: unknown) => posted.push(message) as never, 'Hex Bytes', '48690AFF');
		assert.deepEqual(posted.slice(), [{ command: 'copyToClipboard', type: 'Hex Bytes', error: null }]);
		assert.equal(vscodeState.callsTo('clipboard.writeText')[0].args[0], '48690AFF');

		// A refused write surfaces the localised failure the page's status line shows instead.
		vscodeState.responses['clipboard.writeText'] = [new Error('clipboard unavailable')];
		await respondCopyToClipboard((message: unknown) => posted.push(message) as never, 'Address', '00000010-00000013');
		assert.equal(posted.length, 2);
		assert.equal(posted[1].type, 'Address');
		assert.equal(posted[1].error, t('clipboardWriteFailed' as never));
		delete vscodeState.responses['clipboard.writeText'];
	});
});
