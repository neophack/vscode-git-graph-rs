/* Issue Linking: turning issue numbers in commit messages and branch names into links. */

import * as GG from '../../common/protocol';

export interface IssueLinking {
	readonly regexp: RegExp;
	readonly url: string;
}

const ISSUE_LINKING_ARGUMENT_REGEXP = /\$([1-9][0-9]*)/g;

/**
 * Parse the Issue Linking configuration of a repository, ready for detecting issues and
 * generating links.
 * @returns The parsed Issue Linking, or NULL if it isn't available (or its regex is invalid).
 */
export function parseIssueLinkingConfig(issueLinkingConfig: GG.IssueLinkingConfig | null): IssueLinking | null {
	if (issueLinkingConfig !== null) {
		try {
			return {
				regexp: new RegExp(issueLinkingConfig.issue, 'gu'),
				url: issueLinkingConfig.url
			};
		} catch (_) { }
	}
	return null;
}

/**
 * Generate the URL of an issue link, substituting the groups of a match.
 * @param match The match produced by `IssueLinking.regexp`.
 * @param issueLinking The Issue Linking.
 */
export function generateIssueLinkFromMatch(match: RegExpExecArray, issueLinking: IssueLinking) {
	return match.length > 1
		? issueLinking.url.replace(ISSUE_LINKING_ARGUMENT_REGEXP, (placeholder, index) => {
			const i = parseInt(index);
			return i < match.length ? match[i] : placeholder;
		})
		: issueLinking.url;
}

/** The issue links found in a text (e.g. a branch name). */
export function findIssueLinks(text: string, issueLinking: IssueLinking) {
	const issueLinks: { url: string, displayText: string }[] = [];
	let match: RegExpExecArray | null;
	issueLinking.regexp.lastIndex = 0;
	while ((match = issueLinking.regexp.exec(text)) !== null) {
		if (match[0].length === 0) break;
		issueLinks.push({
			url: generateIssueLinkFromMatch(match, issueLinking),
			displayText: match[0]
		});
	}
	return issueLinks;
}
