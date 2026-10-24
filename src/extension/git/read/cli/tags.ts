/**
 * The tag theme: one tag in full — its tagger, message and signature — read from the ref as
 * `for-each-ref` reports it, and verified through `git verify-tag --raw`.
 */

import { parseGitSignatureOutput } from '../../../../backend/signatures';
import { GitBackendError, GitSignature, GitSignatureStatus, GitTagDetails } from '../../../../backend/types';
import { EOL, GitCli, SEPARATOR } from './process';

/** A tag in full, read from the ref as `for-each-ref` reports it. */
export async function getTagDetails(cli: GitCli, repo: string, tagName: string): Promise<GitTagDetails> {
	const ref = `refs/tags/${tagName}`;
	const format = [
		'%(objectname)',
		'%(taggername)',
		'%(taggeremail)',
		'%(taggerdate:unix)',
		'%(contents:signature)',
		'%(contents)'
	].join(SEPARATOR);
	const out = await cli.run(['for-each-ref', ref, `--format=${format}`], repo);
	const data = out.split(SEPARATOR);
	if (data.length < 6 || data[0] === '') {
		throw new GitBackendError('NotFound', `Could not find the tag ${tagName}`);
	}
	const signed = data[4] !== '';
	const taggerDate = parseInt(data[3], 10);
	const signature = signed
		? (await getTagSignature(cli, repo, tagName)) ?? {
			key: '',
			signer: '',
			status: GitSignatureStatus.CannotBeChecked
		}
		: null;
	return {
		hash: data[0],
		taggerName: data[1],
		taggerEmail: data[2].substring(data[2].startsWith('<') ? 1 : 0, data[2].length - (data[2].endsWith('>') ? 1 : 0)),
		// A lightweight tag has no tagger date to parse; the epoch stands in where the
		// original's parse produced nothing.
		taggerDate: Number.isNaN(taggerDate) ? 0 : taggerDate,
		message: removeTrailingBlankLines(
			data
				.slice(5)
				.join(SEPARATOR)
				.replace(data[4], '')
				.split(EOL)
		).join('\n'),
		signature
	};
}

/** Verify one annotated tag's signature with Git/GPG. */
export async function getTagSignature(cli: GitCli, repo: string, tagName: string): Promise<GitSignature | null> {
	return parseGitSignatureOutput(
		await cli.runRaw(['verify-tag', '--raw', `refs/tags/${tagName}`], repo)
	);
}

/** Remove the trailing blank lines of a message before showing it, as the original did. */
function removeTrailingBlankLines(lines: string[]): string[] {
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}
