/* Mouse interactions with the commit table: clicking commits, refs and badges, double clicking refs
   to check them out, the commit and ref context menus, and following the links of commit messages. */

import { handledEvent } from '../../common/dom';
import { strings } from '../../common/i18n/index';
import { checkoutBranchAction } from '../actions/dialogActions';
import { getBranchContextMenuActions, getCommitContextMenuActions, getRemoteBranchContextMenuActions, getStashContextMenuActions, getTagContextMenuActions, getUncommittedChangesContextMenuActions } from '../actions/contextMenuActions';
import { GraphContext } from '../context';
import { CLASS_REF_GERRIT, showGerritReviewInfo } from '../integrations/gerrit';
import { showPullRequestDetails } from '../integrations/pullRequests';
import { ContextMenuTarget, IndexedCommitTarget, IndexedRefTarget, TargetType } from '../state/types';
import { isExternalUrlElem, isInternalUrlElem, isUrlElem } from '../text/textFormatter';
import { ContextMenuActions } from '../widgets/contextMenu';
import { UNCOMMITTED } from '../../common/util';

const CLASS_REF_HEAD = 'head';
const CLASS_REF_REMOTE = 'remote';
const CLASS_REF_STASH = 'stash';
const CLASS_REF_TAG = 'tag';

/**
 * Links in the view: clicking a commit hash link opens that commit's details, and the context menu
 * of any link offers to open it (external URLs), copy it, or follow it (commit hashes).
 */
export function observeUrls(ctx: GraphContext) {
	const store = ctx.store;
	const followInternalLink = (e: MouseEvent) => {
		if (e.target !== null && isInternalUrlElem(<Element>e.target)) {
			const value = (<HTMLElement>e.target).dataset.value!;
			switch ((<HTMLElement>e.target).dataset.type!) {
				case 'commit':
					if (typeof store.commitLookup[value] === 'number' && (store.expandedCommit === null || store.expandedCommit.commitHash !== value || store.expandedCommit.compareWithHash !== null)) {
						const elem = ctx.table.findCommitElem(store.commitLookup[value]);
						if (elem !== null) ctx.details.load(elem);
					}
					break;
			}
		}
	};

	document.body.addEventListener('click', followInternalLink);

	document.body.addEventListener('contextmenu', (e: MouseEvent) => {
		if (e.target === null) return;
		const eventTarget = <Element>e.target;

		const isExternalUrl = isExternalUrlElem(eventTarget), isInternalUrl = isInternalUrlElem(eventTarget);
		if (isExternalUrl || isInternalUrl) {
			const viewElem: HTMLElement | null = eventTarget.closest('#view');
			let eventElem: HTMLElement | null;

			let target: ContextMenuTarget, isInDialog = false;
			if (store.expandedCommit !== null && eventTarget.closest('#cdv') !== null) {
				// URL is in the Commit Details View
				target = {
					type: TargetType.CommitDetailsView,
					hash: store.expandedCommit.commitHash,
					index: store.commitLookup[store.expandedCommit.commitHash],
					elem: <HTMLElement>eventTarget
				};
				ctx.details.closeContextMenuIfOpen(store.expandedCommit);
				store.expandedCommit.contextMenuOpen.summary = true;
			} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
				// URL is in the Commits
				const commit = store.getCommitOfElem(eventElem);
				if (commit === null) return;

				target = {
					type: TargetType.Commit,
					hash: commit.hash,
					index: parseInt(eventElem.dataset.id!),
					elem: <HTMLElement>eventTarget
				};
			} else {
				// URL is in a dialog
				target = {
					type: TargetType.Repo
				};
				isInDialog = true;
			}

			handledEvent(e);
			ctx.contextMenu.show([
				[
					{
						title: strings.menuOpenUrl,
						visible: isExternalUrl,
						onClick: () => {
							ctx.bridge.send({ command: 'openExternalUrl', url: (<HTMLAnchorElement>eventTarget).href });
						}
					},
					{
						title: strings.menuFollowInternalLink,
						visible: isInternalUrl,
						onClick: () => followInternalLink(e)
					},
					{
						title: strings.menuCopyUrl,
						visible: isExternalUrl,
						onClick: () => {
							ctx.bridge.send({ command: 'copyToClipboard', type: strings.copyTypeExternalUrl, data: (<HTMLAnchorElement>eventTarget).href });
						}
					}
				]
			], false, target, e, viewElem || document.body, () => {
				if (target.type === TargetType.CommitDetailsView && store.expandedCommit !== null) {
					store.expandedCommit.contextMenuOpen.summary = false;
				}
			}, isInDialog ? 'dialogContextMenu' : null);
		}
	});
}

/** Clicks, double clicks and context menus on the commit table. */
export function observeTableEvents(ctx: GraphContext) {
	const store = ctx.store, details = ctx.details, tableElem = ctx.dom.table;

	// Register Click Event Handler
	tableElem.addEventListener('click', (e: MouseEvent) => {
		if (e.target === null) return;
		const eventTarget = <Element>e.target;
		if (isUrlElem(eventTarget)) return;
		let eventElem: HTMLElement | null;

		if ((eventElem = eventTarget.closest('.openChangesBtn')) !== null) {
			// The "Open Changes" button at the end of the description was clicked: open the commit's
			// changes (diffed against its first parent) in a Commit Comparison View tab
			e.stopPropagation();
			if (ctx.contextMenu.isOpen()) {
				ctx.contextMenu.close();
			}
			const commitElem = <HTMLElement | null>eventTarget.closest('.commit');
			const commit = commitElem !== null ? store.getCommitOfElem(commitElem) : null;
			if (commit !== null && commit.parents.length > 0) {
				details.openCompareTab(commit.hash, commit.parents[0], true);
			}
			return;
		} else if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
			// .gitRef was clicked
			e.stopPropagation();
			if (ctx.contextMenu.isOpen()) {
				ctx.contextMenu.close();
			}
			if (eventElem.classList.contains(CLASS_REF_GERRIT)) {
				// The Gerrit change badge was clicked: show the review information of the change
				showGerritReviewInfo(ctx.dialog, store.gerritStates, eventElem.dataset.hash!, store.config.dateFormat);
				return;
			}
			if (eventElem.classList.contains('pr')) {
				// The pull request badge was clicked: show the details of the request
				showPullRequestDetails(ctx.dialog, store.pullRequestsByHead, eventElem.dataset.hash!);
				return;
			}
		} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
			// .commit was clicked
			if (store.expandedCommit !== null) {
				const commit = store.getCommitOfElem(eventElem);
				if (commit === null) return;

				if (store.expandedCommit.commitHash === commit.hash) {
					details.close(true);
				} else if ((<MouseEvent>e).ctrlKey || (<MouseEvent>e).metaKey) {
					if (store.expandedCommit.compareWithHash === commit.hash) {
						details.closeComparison(true);
					} else {
						details.openCompareTab(store.expandedCommit.commitHash, commit.hash);
					}
				} else {
					details.load(eventElem);
				}
			} else {
				details.load(eventElem);
			}
		}
	});

	// Register Double Click Event Handler
	tableElem.addEventListener('dblclick', (e: MouseEvent) => {
		if (e.target === null) return;
		const eventTarget = <Element>e.target;
		if (isUrlElem(eventTarget)) return;
		let eventElem: HTMLElement | null;

		if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
			// .gitRef was double clicked
			e.stopPropagation();
			ctx.closeDialogAndContextMenu();
			const commitElem = <HTMLElement>eventElem.closest('.commit')!;
			const commit = store.getCommitOfElem(commitElem);
			if (commit === null) return;
			if (eventElem.classList.contains(CLASS_REF_GERRIT)) return; // the Gerrit badge has no double click action
			if (eventElem.classList.contains('pr')) return; // the pull request badge has no double click action

			if (eventElem.classList.contains(CLASS_REF_HEAD) || eventElem.classList.contains(CLASS_REF_REMOTE)) {
				let sourceElem = <HTMLElement>eventElem.children[1];
				let refName = eventElem.dataset.name!, isHead = eventElem.classList.contains(CLASS_REF_HEAD);
				const isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');
				if (isHead && isRemoteCombinedWithHead) {
					refName = (<HTMLElement>eventTarget).dataset.fullref!;
					sourceElem = <HTMLElement>eventTarget;
					isHead = false;
				}

				const target: IndexedRefTarget = {
					type: TargetType.Ref,
					hash: commit.hash,
					index: parseInt(commitElem.dataset.id!),
					ref: refName,
					elem: sourceElem
				};

				checkoutBranchAction(ctx, refName, isHead ? null : (isRemoteCombinedWithHead ? <HTMLElement>eventTarget : eventElem).dataset.remote!, null, target);
			}
		}
	});

	// Register ContextMenu Event Handler
	tableElem.addEventListener('contextmenu', (e: Event) => {
		if (e.target === null) return;
		const eventTarget = <Element>e.target;
		if (isUrlElem(eventTarget)) return;
		let eventElem: HTMLElement | null;

		if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
			// .gitRef was right clicked
			handledEvent(e);
			const commitElem = <HTMLElement>eventElem.closest('.commit')!;
			const commit = store.getCommitOfElem(commitElem);
			if (commit === null) return;
			if (eventElem.classList.contains(CLASS_REF_GERRIT)) return; // the Gerrit badge has no context menu
			// The pull request badge has no context menu either (it is not a ref: without this
			// guard it would fall through to the remote branch actions below, which would act on
			// the badge's label as if it were a remote-tracking branch name)
			if (eventElem.classList.contains('pr')) return;

			const target: IndexedRefTarget = {
				type: TargetType.Ref,
				hash: commit.hash,
				index: parseInt(commitElem.dataset.id!),
				ref: eventElem.dataset.name!,
				elem: <HTMLElement>eventElem.children[1]
			};

			let actions: ContextMenuActions;
			if (eventElem.classList.contains(CLASS_REF_STASH)) {
				actions = getStashContextMenuActions(ctx, target);
			} else if (eventElem.classList.contains(CLASS_REF_TAG)) {
				actions = getTagContextMenuActions(ctx, eventElem.dataset.tagtype === 'annotated', target);
			} else {
				let isHead = eventElem.classList.contains(CLASS_REF_HEAD);
				const isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');
				if (isHead && isRemoteCombinedWithHead) {
					target.ref = (<HTMLElement>eventTarget).dataset.fullref!;
					target.elem = <HTMLElement>eventTarget;
					isHead = false;
				}

				if (isHead) {
					actions = getBranchContextMenuActions(ctx, target);
				} else {
					const remote = (isRemoteCombinedWithHead ? <HTMLElement>eventTarget : eventElem).dataset.remote!;
					actions = getRemoteBranchContextMenuActions(ctx, remote, target);
				}
			}

			ctx.contextMenu.show(actions, false, target, <MouseEvent>e, ctx.dom.view);
		} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
			// .commit was right clicked
			handledEvent(e);
			const commit = store.getCommitOfElem(eventElem);
			if (commit === null) return;

			const target: IndexedCommitTarget & { ref?: string } = {
				type: TargetType.Commit,
				hash: commit.hash,
				index: parseInt(eventElem.dataset.id!),
				elem: eventElem
			};

			let actions: ContextMenuActions;
			if (commit.hash === UNCOMMITTED) {
				actions = getUncommittedChangesContextMenuActions(ctx, target);
			} else if (commit.stash !== null) {
				target.ref = commit.stash.selector;
				actions = getStashContextMenuActions(ctx, <IndexedRefTarget>target);
			} else {
				actions = getCommitContextMenuActions(ctx, target);
			}

			ctx.contextMenu.show(actions, false, target, <MouseEvent>e, ctx.dom.view);
		}
	});
}
