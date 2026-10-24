/* Display names of Git concepts (file change types, signature statuses). */

import { helpTooltipAttrs, html, SafeHtml } from './html';
import { strings } from './i18n/index';
import { SVG_ICONS } from './icons';
import * as GG from './protocol';

/**
 * The localised display name of a Git file change type (A/M/D/R/U), as shown in file tooltips.
 */
export function getGitFileChangeTypeName(type: string): string {
	switch (type) {
		case 'A': return strings.changeTypeAdded;
		case 'M': return strings.changeTypeModified;
		case 'D': return strings.changeTypeDeleted;
		case 'R': return strings.changeTypeRenamed;
		case 'U': return strings.changeTypeUntracked;
		default: return type;
	}
}

/**
 * The localised description of a commit signature status (G/U/X/Y/R/E/B), as shown in signature tooltips.
 */
export function getGitSignatureStatusDescription(status: string): string {
	switch (status) {
		case 'G': return strings.signatureStatusValid;
		case 'U': return strings.signatureStatusUnknownValidity;
		case 'X': return strings.signatureStatusExpired;
		case 'Y': return strings.signatureStatusExpiredKey;
		case 'R': return strings.signatureStatusRevokedKey;
		case 'E': return strings.signatureStatusCouldNotBeChecked;
		case 'B': return strings.signatureStatusBad;
		default: return status;
	}
}

/** The signature indicator of a signed commit or tag: a status icon with the signature details as its tooltip. */
export function generateSignatureHtml(signature: GG.GitSignature): SafeHtml {
	const status: GG.GitSignatureStatus = signature.status;
	const tooltip = getGitSignatureStatusDescription(status) + strings.signatureDescColon
		+ strings.signatureSignedBy + (signature.signer !== '' ? signature.signer : strings.signatureUnknown)
		+ strings.signatureGpgKeyIdPrefix + (signature.key !== '' ? signature.key : strings.signatureUnknown) + strings.signatureGpgKeyIdSuffix;
	return html`<span ${helpTooltipAttrs(tooltip, 'signatureInfo ' + status)}>${status === GG.GitSignatureStatus.GoodAndValid
		? SVG_ICONS.passed
		: status === GG.GitSignatureStatus.Bad
			? SVG_ICONS.failed
			: SVG_ICONS.inconclusive}</span>`;
}
