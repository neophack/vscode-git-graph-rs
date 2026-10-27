/* The context menu of a tag. */

import { html } from '../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import { GraphContext } from '../context';
import { IndexedRefTarget } from '../state/types';
import { ContextMenuActions } from '../widgets/contextMenu';
import { deleteTagAction } from './dialogActions';

export function getTagContextMenuActions(ctx: GraphContext, isAnnotated: boolean, target: IndexedRefTarget): ContextMenuActions {
	const store = ctx.store, hash = target.hash, tagName = target.ref, visibility = store.config.contextMenuActionsVisibility.tag;

	return [[
		{
			title: strings.menuViewDetails,
			visible: visibility.viewDetails && isAnnotated,
			onClick: () => {
				ctx.actions.run({ command: 'tagDetails', repo: store.currentRepo, tagName: tagName, commitHash: hash }, strings.retrievingTagDetails);
			}
		}, {
			title: strings.menuDeleteTag + ELLIPSIS,
			visible: visibility.delete,
			onClick: () => {
				const message = formatStr(markup.deleteTagConfirm, tagName);
				if (store.gitRemotes.length > 1) {
					const options = [{ name: strings.dontDeleteOnRemote, value: '-1' }];
					store.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
					ctx.dialog.showSelect(html`${message}${markup.alsoDeleteTagOnRemote}`, '-1', options, strings.yesDelete, (remoteIndex) => {
						deleteTagAction(ctx, tagName, remoteIndex !== '-1' ? store.gitRemotes[parseInt(remoteIndex)] : null);
					}, target);
				} else if (store.gitRemotes.length === 1) {
					ctx.dialog.showCheckbox(message, strings.alsoDeleteOnRemoteCheckbox, false, strings.yesDelete, (deleteOnRemote) => {
						deleteTagAction(ctx, tagName, deleteOnRemote ? store.gitRemotes[0] : null);
					}, target);
				} else {
					ctx.dialog.showConfirmation(message, strings.yesDelete, () => {
						deleteTagAction(ctx, tagName, null);
					}, target);
				}
			}
		}, {
			title: strings.menuPushTag + ELLIPSIS,
			visible: visibility.push && store.gitRemotes.length > 0,
			onClick: () => {
				const runPushTagAction = (remotes: string[]) => {
					ctx.actions.run({
						command: 'pushTag',
						repo: store.currentRepo,
						tagName: tagName,
						remotes: remotes,
						commitHash: hash,
						skipRemoteCheck: store.globalViewState.pushTagSkipRemoteCheck
					}, strings.pushingTag);
				};

				if (store.gitRemotes.length === 1) {
					ctx.dialog.showConfirmation(formatStr(markup.pushTagToRemoteConfirm, tagName, store.gitRemotes[0]), strings.yesPush, () => {
						runPushTagAction([store.gitRemotes[0]]);
					}, target);
				} else if (store.gitRemotes.length > 1) {
					const defaults = [store.getPushRemote()];
					const options = store.gitRemotes.map((remote) => ({ name: remote, value: remote }));
					ctx.dialog.showMultiSelect(formatStr(markup.pushTagSelectRemotes, tagName), defaults, options, strings.yesPush, (remotes) => {
						runPushTagAction(remotes);
					}, target);
				}
			}
		}
	], [
		{
			title: strings.menuCreateArchive,
			visible: visibility.createArchive,
			onClick: () => {
				ctx.actions.run({ command: 'createArchive', repo: store.currentRepo, ref: tagName }, strings.creatingArchive);
			}
		},
		{
			title: strings.menuCopyTagName,
			visible: visibility.copyName,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: strings.copyTypeTagName, data: tagName });
			}
		}
	]];
}
