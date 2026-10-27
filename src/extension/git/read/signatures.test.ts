/**
 * Git signature status parsing: the GnuPG status records of `git verify-commit --raw` /
 * `git verify-tag --raw`, and one real unsigned commit read back through the CLI reader.
 *
 * Migrated from legacy/tests/signatures.test.mjs, asserting the same cases
 * against the module in its new home.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { CliBackend } from './cli';
import { parseGitSignatureOutput } from './signatures';

describe('Git signature status parsing', () => {
	it('parses a valid signature and signer', () => {
		const signature = parseGitSignatureOutput([
			'gpg: Signature made ...',
			'[GNUPG:] GOODSIG 0123456789ABCDEF Alice Example <alice@example.com>',
			'[GNUPG:] TRUST_FULLY 0 pgp'
		].join('\n'));

		expect(signature).toEqual({
			key: '0123456789ABCDEF',
			signer: 'Alice Example <alice@example.com>',
			status: 'G'
		});
	});

	it('downgrades a valid signature with unknown trust', () => {
		const signature = parseGitSignatureOutput([
			'[GNUPG:] GOODSIG 0123456789ABCDEF Alice Example <alice@example.com>',
			'[GNUPG:] TRUST_UNDEFINED 0 pgp'
		].join('\n'));

		expect(signature).toEqual({
			key: '0123456789ABCDEF',
			signer: 'Alice Example <alice@example.com>',
			status: 'U'
		});
	});

	it('keeps the key id when the signature cannot be checked', () => {
		const signature = parseGitSignatureOutput([
			'[GNUPG:] ERRSIG 0123456789ABCDEF 1 10 00 0 9',
			'[GNUPG:] NO_PUBKEY 0123456789ABCDEF'
		].join('\n'));

		expect(signature).toEqual({
			key: '0123456789ABCDEF',
			signer: '',
			status: 'E'
		});
	});

	it('returns null when Git reports no signature', () => {
		expect(parseGitSignatureOutput('commit has no signature\n')).toBe(null);
	});

	it('handles Git returning a non-zero status for an unsigned commit', async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-signature-'));
		try {
			const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repo };
			const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
			git(['init', '--quiet', '--initial-branch=main']);
			git(['config', 'user.name', 'Test User']);
			git(['config', 'user.email', 'test@example.com']);
			fs.writeFileSync(path.join(repo, 'file.txt'), 'content\n');
			git(['add', 'file.txt']);
			git(['commit', '--quiet', '-m', 'unsigned commit']);
			const hash = git(['rev-parse', 'HEAD']).trim();

			const backend = new CliBackend('git');
			expect(await backend.getCommitSignature(repo, hash)).toBe(null);
			expect((await backend.getCommitDetails(repo, hash)).signature).toBe(null);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
