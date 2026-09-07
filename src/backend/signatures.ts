import { GitSignature, GitSignatureStatus } from './types';

interface GpgStatusCodeParsingDetails {
	readonly status: GitSignatureStatus;
	readonly uid: boolean;
}

const GPG_STATUS_CODE_PARSING_DETAILS: Readonly<Record<string, GpgStatusCodeParsingDetails>> = {
	GOODSIG: { status: GitSignatureStatus.GoodAndValid, uid: true },
	BADSIG: { status: GitSignatureStatus.Bad, uid: true },
	ERRSIG: { status: GitSignatureStatus.CannotBeChecked, uid: false },
	EXPSIG: { status: GitSignatureStatus.GoodButExpired, uid: true },
	EXPKEYSIG: { status: GitSignatureStatus.GoodButMadeByExpiredKey, uid: true },
	REVKEYSIG: { status: GitSignatureStatus.GoodButMadeByRevokedKey, uid: true }
};

const GPG_STATUS_PREFIX = '[GNUPG:] ';

/**
 * Parse the machine-readable output of `git verify-commit --raw` or `git verify-tag --raw`.
 *
 * Git sends GnuPG status records to stderr and uses a non-zero exit code for invalid or
 * unverifiable signatures, so callers must parse both streams and must not treat the exit code
 * alone as the result.
 */
export function parseGitSignatureOutput(output: string): GitSignature | null {
	let signature: GitSignature | null = null;
	let trustLevel: string | null = null;

	for (const line of output.split(/\r\n|\r|\n/)) {
		if (!line.startsWith(GPG_STATUS_PREFIX)) continue;
		const fields = line.slice(GPG_STATUS_PREFIX.length).split(/\s+/);
		const statusCode = fields.shift();
		if (statusCode === undefined) continue;

		const parsingDetails = GPG_STATUS_CODE_PARSING_DETAILS[statusCode];
		if (parsingDetails !== undefined) {
			// Git currently exposes one signature per commit/tag. Keep the first record if a
			// future Git/GPG combination emits more than one, rather than hiding the details.
			if (signature !== null) continue;
			const key = fields.shift() ?? '';
			signature = {
				status: parsingDetails.status,
				key,
				signer: parsingDetails.uid ? fields.join(' ') : ''
			};
		} else if (statusCode.startsWith('TRUST_')) {
			trustLevel = statusCode;
		}
	}

	if (
		signature !== null &&
		signature.status === GitSignatureStatus.GoodAndValid &&
		(trustLevel === 'TRUST_UNDEFINED' || trustLevel === 'TRUST_NEVER')
	) {
		return { ...signature, status: GitSignatureStatus.GoodWithUnknownValidity };
	}
	return signature;
}
