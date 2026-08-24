/**
 * The hex comparison model behind the Commit Comparison View's binary-file mode.
 *
 * These drive the compiled `out/hexDiff.js` against real throwaway git repositories (through a
 * stub spawner that spawns the real `git`), because what matters is the end-to-end behaviour:
 * chunked reads of blobs, the working-tree side read from disk, the coarse section scan and the
 * byte-level masks of the visible rows.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const { HexDiffSession } = await import('../out/hexDiff.js');

const CHUNK = 64 * 1024;

/** The spawner HexDiffSession needs: DataSource implements this over its own Git executable. */
const gitSpawner = {
	spawnGitStream(args, repo) {
		return spawn('git', args, { cwd: repo });
	}
};

const fileChange = (type, oldFilePath, newFilePath) => ({ oldFilePath, newFilePath, type, additions: null, deletions: null });

function git(repo, args) {
	const result = spawnSync('git', args, { cwd: repo, encoding: 'buffer', maxBuffer: 1 << 28 });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.toString();
}

function bytes(length, seed) {
	const buffer = Buffer.alloc(length);
	for (let i = 0; i < length; i++) buffer[i] = (i * 31 + seed) & 0xff;
	return buffer;
}

/** A fresh repository, with a callback-scoped teardown registered through the test's context. */
function withRepo(run) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hexdiff-'));
	git(repo, ['init', '-q']);
	git(repo, ['config', 'user.email', 'test@test']);
	git(repo, ['config', 'user.name', 'test']);
	// Windows releases the directory under EPERM or EBUSY a moment after a session's killed git
	// children exit, so the removal retries with real waits until the directory is actually gone.
	const cleanup = async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				fs.rmSync(repo, { recursive: true, force: true });
				return;
			} catch (err) {
				if (attempt >= 50 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	};
	return Promise.resolve().then(() => run(repo)).then(
		(value) => cleanup().then(() => value),
		(err) => cleanup().then(() => { throw err; })
	);
}

/** Two commits around one write (or deletion, when `second` is NULL) of `data.bin`. */
function commitPair(repo, first, second) {
	fs.writeFileSync(path.join(repo, 'data.bin'), first);
	git(repo, ['add', '.']);
	git(repo, ['commit', '-q', '-m', 'one']);
	const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
	if (second === null) {
		fs.unlinkSync(path.join(repo, 'data.bin'));
	} else {
		fs.writeFileSync(path.join(repo, 'data.bin'), second);
	}
	git(repo, ['add', '.']);
	git(repo, ['commit', '-q', '-m', 'two']);
	return [fromHash, git(repo, ['rev-parse', 'HEAD']).trim()];
}

function sessionFor(repo, fromHash, toHash, change) {
	return new HexDiffSession(gitSpawner, repo,
		false, change.oldFilePath !== '' ? change.oldFilePath : change.newFilePath, fromHash,
		false, change.newFilePath !== '' ? change.newFilePath : change.oldFilePath, toHash,
		change);
}

function sectionsOf(session) {
	if (session.sectionLayout !== null) return Promise.resolve(session.sectionLayout);
	return new Promise((resolve, reject) => {
		session.onSections = (sections, error) => error !== null ? reject(new Error(error)) : resolve(sections);
	});
}

describe('the hex diff session', () => {
	it('byte-compares the rows of equal-size blobs', () => withRepo(async (repo) => {
		const original = bytes(200, 1);
		const modified = Buffer.from(original);
		modified[10] ^= 0xff; // row 0, byte 10
		const [fromHash, toHash] = commitPair(repo, original, modified);

		const session = sessionFor(repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		try {
			await session.init();
			assert.equal(session.oldSize, 200);
			assert.equal(session.totalRows, Math.ceil(200 / 16));

			// Before the scan even starts, the provisional layout answers with real masks.
			const rows = await session.getRows(0, session.totalRows);
			assert.equal(rows[0].o, 0);
			assert.equal(Buffer.from(rows[0].ob, 'base64').length, 16);
			assert.equal(rows[0].om, '0000000000100000');

			// 200 bytes is a single scan block: one changed section, byte-compared because it is aligned.
			const sections = await sectionsOf(session);
			assert.equal(sections.length, 1);
			assert.equal(sections[0].eq, false);
			const rowsAfter = await session.getRows(0, session.totalRows);
			assert.equal(rowsAfter[0].om, '0000000000100000');
		} finally {
			session.dispose();
		}
	}));

	it('aligns different-size blobs on an exact prefix and suffix', () => withRepo(async (repo) => {
		const prefix = bytes(CHUNK * 2, 3);
		const suffix = bytes(CHUNK + 1000, 7); // spans a partial block, defeating block-granular suffix matching
		const [fromHash, toHash] = commitPair(repo,
			Buffer.concat([prefix, bytes(300, 5), suffix]),
			Buffer.concat([prefix, bytes(990, 11), suffix]));

		const session = sessionFor(repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		try {
			await session.init();
			const sections = await sectionsOf(session);
			assert.equal(sections.length, 3);
			const [head, middle, tail] = sections;
			assert.ok(head.eq && head.ol === prefix.length && head.os === 0);
			assert.ok(!middle.eq);
			assert.equal(middle.os, prefix.length);
			assert.equal(middle.ol, 300);
			assert.equal(middle.ns, prefix.length);
			assert.equal(middle.nl, 990);
			assert.ok(tail.eq && tail.ol === suffix.length);

			// A row inside the unaligned middle: both sides present, every byte marked changed.
			const rows = await session.getRows(Math.floor(prefix.length / 16), 3);
			assert.ok(rows.every((row) => row.om.indexOf('0') === -1 && row.nm.indexOf('0') === -1));

			// Regression: rows inside the matched suffix hold identical bytes, so despite the
			// sides' offsets differing nothing may be highlighted there (the suffix used to be
			// shown as one wholly-changed block, lighting up everything after an insertion).
			const suffixRow = Math.floor(prefix.length / 16) + Math.ceil(990 / 16);
			const tailRows = await session.getRows(suffixRow, 2);
			assert.ok(tailRows.length === 2 && tailRows[0].o === prefix.length + 300 && tailRows[0].n === prefix.length + 990);
			assert.ok(tailRows.every((row) => row.om.indexOf('1') === -1 && row.nm.indexOf('1') === -1), JSON.stringify(tailRows));
		} finally {
			session.dispose();
		}
	}));

	it('reads the working-tree side from disk', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'data.bin'), bytes(1000, 13));
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		const next = bytes(1000, 13);
		next[999] ^= 0xff;
		fs.writeFileSync(path.join(repo, 'data.bin'), next);

		const session = new HexDiffSession(gitSpawner, repo,
			false, 'data.bin', fromHash,
			true, 'data.bin', '',
			fileChange('M', 'data.bin', 'data.bin'));
		try {
			await session.init();
			assert.equal(session.newSize, 1000);
			const rows = await session.getRows(62, 1); // row 62 holds the final 8 bytes
			assert.equal(Buffer.from(rows[0].ob, 'base64').length, 8);
			assert.equal(rows[0].om, '00000001');
		} finally {
			session.dispose();
		}
	}));

	it('shows one-sided rows for an added file', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'keep.txt'), 'x');
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		fs.writeFileSync(path.join(repo, 'data.bin'), bytes(40, 17));
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'two']);
		const toHash = git(repo, ['rev-parse', 'HEAD']).trim();

		const session = sessionFor(repo, fromHash, toHash, fileChange('A', '', 'data.bin'));
		try {
			await session.init();
			assert.equal(session.oldSize, -1);
			assert.equal(session.totalRows, 3);
			const rows = await session.getRows(0, 3);
			assert.ok(rows.every((row) => row.o === -1 && row.ob === '' && row.n >= 0));
			assert.equal(Buffer.from(rows[2].nb, 'base64').length, 8); // the final row is short
		} finally {
			session.dispose();
		}
	}));

	it('shows one-sided rows for a deleted file', () => withRepo(async (repo) => {
		const [fromHash, toHash] = commitPair(repo, bytes(32, 19), null);

		const session = sessionFor(repo, fromHash, toHash, fileChange('D', 'data.bin', 'data.bin'));
		try {
			await session.init();
			assert.equal(session.newSize, -1);
			const rows = await session.getRows(0, 2);
			assert.ok(rows.every((row) => row.n === -1 && row.nb === '' && row.o >= 0));
		} finally {
			session.dispose();
		}
	}));

	it('coalesces adjacent differing blocks of an equal-size pair', () => withRepo(async (repo) => {
		const original = bytes(CHUNK * 3 + 12345, 23);
		const modified = Buffer.from(original);
		modified[CHUNK + 2] ^= 0xff;      // block 1
		modified[CHUNK * 2 + 7] ^= 0xff;  // block 2 (adjacent to block 1)
		const [fromHash, toHash] = commitPair(repo, original, modified);

		const session = sessionFor(repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		try {
			await session.init();
			const sections = await sectionsOf(session);
			assert.equal(sections.length, 3);
			assert.deepEqual(sections.map((section) => section.eq), [true, false, true]);
			assert.equal(sections[1].os, CHUNK);
			assert.equal(sections[1].ol, 2 * CHUNK);
			const row = Math.floor((CHUNK + 2) / 16);
			const rows = await session.getRows(row, 1);
			assert.equal(rows[0].om.indexOf('1'), 2);
		} finally {
			session.dispose();
		}
	}));

	it('reads a whole side in one piece for the image view', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'keep.txt'), 'x');
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		const image = bytes(5000, 29);
		fs.writeFileSync(path.join(repo, 'pixel.png'), image);
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'two']);
		const toHash = git(repo, ['rev-parse', 'HEAD']).trim();

		const session = sessionFor(repo, fromHash, toHash, fileChange('A', '', 'pixel.png'));
		try {
			await session.init();
			assert.equal(await session.readSide('old'), null); // the added file has no old side
			assert.ok((await session.readSide('new')).equals(image));
		} finally {
			session.dispose();
		}
	}));

	it('reads the working-tree side in one piece for the image view', () => withRepo(async (repo) => {
		fs.writeFileSync(path.join(repo, 'pixel.png'), bytes(700, 31));
		git(repo, ['add', '.']);
		git(repo, ['commit', '-q', '-m', 'one']);
		const fromHash = git(repo, ['rev-parse', 'HEAD']).trim();
		const edited = bytes(700, 31);
		edited[699] ^= 0xff;
		fs.writeFileSync(path.join(repo, 'pixel.png'), edited);

		const session = new HexDiffSession(gitSpawner, repo,
			false, 'pixel.png', fromHash,
			true, 'pixel.png', '',
			fileChange('M', 'pixel.png', 'pixel.png'));
		try {
			await session.init();
			assert.ok((await session.readSide('new')).equals(edited));
		} finally {
			session.dispose();
		}
	}));

	it('re-lays out when the row width changes', () => withRepo(async (repo) => {
		const original = bytes(64, 37);
		const modified = Buffer.from(original);
		modified[63] ^= 0xff;
		const [fromHash, toHash] = commitPair(repo, original, modified);

		const session = sessionFor(repo, fromHash, toHash, fileChange('M', 'data.bin', 'data.bin'));
		try {
			await session.init();
			assert.equal(session.totalRows, 4); // 64 bytes at 16 per row
			const version = session.layoutVersion;
			let rows = await session.getRows(0, 1);
			assert.equal(Buffer.from(rows[0].ob, 'base64').length, 16);

			session.setBytesPerRow(8); // the webview narrowed
			assert.equal(session.totalRows, 8);
			assert.ok(session.layoutVersion > version, 'a relayout must bump the layout version');
			rows = await session.getRows(7, 1);
			assert.equal(rows[0].o, 56);
			assert.equal(Buffer.from(rows[0].ob, 'base64').length, 8);

			session.setBytesPerRow(7); // not one of the supported widths: ignored
			assert.equal(session.totalRows, 8);
		} finally {
			session.dispose();
		}
	}));
});
