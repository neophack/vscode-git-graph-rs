/**
 * The host-side picture responders of the binary comparison (task 6.1: the frontend difference
 * engine - computeImageDiff, the display modes and the statistics - lives in
 * src/webview/binaryCompare/imageView.test.ts, importing the extracted module; this file keeps
 * what the HOST does, driving the responders against throwaway git repositories, like the hex
 * tests).
 *
 * Ported from tests/imageDiff.test.mjs to the new tree's module (REFACTOR-PLAN task 7.1);
 * assertions are unchanged.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, vi } from 'vitest';
import { imageMimeOf, isImageChange, respondImageData } from '../../../src/extension/views/binaryCompare/binaryCompare';
import { t } from '../../../src/extension/platform/i18n';
import { HexDiffSession } from '../../../src/extension/views/binaryCompare/hexDiff';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

/* ---------- The host-side image responders ---------- */

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
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdiff-'));
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

/** A real 1x1 transparent PNG: the host only re-encodes bytes, but a decodable file keeps the fixture honest. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function sessionFor(repo: string, fromHash: string, toHash: string, change: any) {
	return new HexDiffSession(gitSpawner as never, repo,
		false, change.oldFilePath !== '' ? change.oldFilePath : change.newFilePath, fromHash,
		false, change.newFilePath !== '' ? change.newFilePath : change.oldFilePath, toHash,
		change);
}

async function imageReply(repo: string, fromHash: string, toHash: string, change: any) {
	const session = sessionFor(repo, fromHash, toHash, change);
	const replies: any[] = [];
	try {
		await respondImageData(session, 0, change, (message: unknown) => replies.push(message) as never);
	} finally {
		session.dispose();
	}
	assert.equal(replies.length, 1);
	return replies[0];
}

describe('the host-side image responders', () => {
	it('recognises picture paths of every supported kind', () => {
		assert.equal(imageMimeOf('a.PNG'), 'image/png');       // case-insensitive extension
		assert.equal(imageMimeOf('dir/b.jpeg'), 'image/jpeg');
		assert.equal(imageMimeOf('c.svg'), 'image/svg+xml');
		assert.equal(imageMimeOf('icon.ico'), 'image/x-icon');
		assert.equal(imageMimeOf('d.bin'), null);
		assert.equal(imageMimeOf('noext'), null);
		assert.equal(imageMimeOf('photo.png/bak'), null); // only the text after the last dot counts

		assert.equal(isImageChange(fileChange('M', 'a.png', 'a.png')), true);
		assert.equal(isImageChange(fileChange('A', '', 'added.webp')), true);
		assert.equal(isImageChange(fileChange('D', 'gone.bmp', '')), true);
		assert.equal(isImageChange(fileChange('R', 'a.png', 'renamed.avif')), true);
		assert.equal(isImageChange(fileChange('R', 'a.png', 'now.bin')), false); // the new side is not a picture
		assert.equal(isImageChange(fileChange('M', 'a.bin', 'a.bin')), false);
	});

	it('answers getImageData with both sides as data URLs', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'pixel.png'), PNG_1X1);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		const edited = Buffer.from(PNG_1X1);
		edited[edited.length - 1] ^= 0xff;
		fs.writeFileSync(path.join(repo, 'pixel.png'), edited);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'two']);
		const toHash = git(repo, ['rev-parse', 'HEAD']).trim();

		const reply = await imageReply(repo, fromHash, toHash, fileChange('M', 'pixel.png', 'pixel.png'));
		assert.equal(reply.error, null);
		assert.equal(reply.oldSize, PNG_1X1.length);
		assert.equal(reply.newSize, edited.length);
		assert.ok(reply.oldData.startsWith('data:image/png;base64,'), reply.oldData);
		assert.ok(Buffer.from(reply.oldData.substring(22), 'base64').equals(PNG_1X1));
		assert.ok(Buffer.from(reply.newData.substring(22), 'base64').equals(edited));
	}));

	it('answers null for the missing side of an added picture', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'keep.txt'), 'x');
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		fs.writeFileSync(path.join(repo, 'pixel.png'), PNG_1X1);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'two']);
		const toHash = git(repo, ['rev-parse', 'HEAD']).trim();

		const reply = await imageReply(repo, fromHash, toHash, fileChange('A', '', 'pixel.png'));
		assert.equal(reply.error, null);
		assert.equal(reply.oldData, null);
		assert.ok(Buffer.from(reply.newData.substring(22), 'base64').equals(PNG_1X1));
	}));

	it('refuses types the picture view cannot render', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'data.bin'), Buffer.from([1, 2, 3, 4]));
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		fs.writeFileSync(path.join(repo, 'data.bin'), Buffer.from([5, 6, 7, 8]));
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'two']);
		const toHash = git(repo, ['rev-parse', 'HEAD']).trim();

		const reply = await imageReply(repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		assert.equal(reply.error, t('compareImageUnsupportedType' as never));
		assert.equal(reply.oldData, null);
		assert.equal(reply.newData, null);
	}));
});
