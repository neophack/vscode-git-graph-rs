/* The "View Issue" action shared by the branch and remote branch menus. */

import { ELLIPSIS, strings } from '../../common/i18n/index';
import { GraphContext } from '../context';
import { findIssueLinks, parseIssueLinkingConfig } from '../text/issueLinking';
import { IndexedRefTarget } from '../state/types';
import { ContextMenuAction } from '../widgets/contextMenu';

/** The "View Issue" action of a branch: it links to the issues named in the branch name. */
export function getViewIssueAction(ctx: GraphContext, refName: string, visible: boolean, target: IndexedRefTarget): ContextMenuAction {
	const store = ctx.store;
	let issueLinks: Array<{ url: string, displayText: string }> = [];
	const issueLinking = visible ? parseIssueLinkingConfig(store.repoState.issueLinkingConfig) : null;
	if (issueLinking !== null) issueLinks = findIssueLinks(refName, issueLinking);

	return {
		title: strings.menuViewIssue + (issueLinks.length > 1 ? ELLIPSIS : ''),
		visible: issueLinks.length > 0,
		onClick: () => {
			if (issueLinks.length > 1) {
				ctx.dialog.showSelect(strings.selectIssueToView, '0', issueLinks.map((issueLink, i) => ({ name: issueLink.displayText, value: i.toString() })), strings.menuViewIssue, (value) => {
					ctx.bridge.send({ command: 'openExternalUrl', url: issueLinks[parseInt(value)].url });
				}, target);
			} else if (issueLinks.length === 1) {
				ctx.bridge.send({ command: 'openExternalUrl', url: issueLinks[0].url });
			}
		}
	};
}
