/* The context menu of the "Uncommitted Changes" row. */

import { ELLIPSIS, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import { IndexedCommitTarget } from '../state/types';
import { ContextMenuActions } from '../widgets/contextMenu';
import { DialogInputType } from '../widgets/dialog';

export function getUncommittedChangesContextMenuActions(ctx: GraphContext, target: IndexedCommitTarget): ContextMenuActions {
	const store = ctx.store, visibility = store.config.contextMenuActionsVisibility.uncommittedChanges;

	return [[
		{
			title: strings.menuStashUncommitted + ELLIPSIS,
			visible: visibility.stash,
			onClick: () => {
				ctx.dialog.showForm(markup.stashUncommittedConfirm, [
					{ type: DialogInputType.Text, name: strings.messageInput, default: '', placeholder: strings.optionalPlaceholder },
					{ type: DialogInputType.Checkbox, name: strings.includeUntrackedCheckbox, value: store.config.dialogDefaults.stashUncommittedChanges.includeUntracked, info: strings.includeUntrackedInfo }
				], strings.yesStash, (values) => {
					ctx.actions.run({ command: 'pushStash', repo: store.currentRepo, message: <string>values[0], includeUntracked: <boolean>values[1] }, strings.stashingUncommitted);
				}, target);
			}
		}
	], [
		{
			title: strings.menuResetUncommitted + ELLIPSIS,
			visible: visibility.reset,
			onClick: () => {
				ctx.dialog.showSelect(markup.resetUncommittedConfirm, store.config.dialogDefaults.resetUncommitted.mode, [
					{ name: strings.resetModeMixed, value: GG.GitResetMode.Mixed },
					{ name: strings.resetModeHard, value: GG.GitResetMode.Hard }
				], strings.yesReset, (mode) => {
					ctx.actions.run({ command: 'resetToCommit', repo: store.currentRepo, commit: 'HEAD', resetMode: <GG.GitResetMode>mode }, strings.resettingUncommitted);
				}, target);
			}
		}, {
			title: strings.menuCleanUntracked + ELLIPSIS,
			visible: visibility.clean,
			onClick: () => {
				ctx.dialog.showCheckbox(strings.cleanUntrackedConfirm, strings.cleanDirectoriesCheckbox, true, strings.yesClean, (directories) => {
					ctx.actions.run({ command: 'cleanUntrackedFiles', repo: store.currentRepo, directories: directories }, strings.cleaningUntracked);
				}, target);
			}
		}
	], [
		{
			title: strings.menuOpenSourceControlView,
			visible: visibility.openSourceControlView,
			onClick: () => {
				ctx.bridge.send({ command: 'viewScm' });
			}
		}
	]];
}
