/* The context menu of a stash. */

import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import { GraphContext } from '../context';
import { IndexedRefTarget } from '../state/types';
import { ContextMenuActions } from '../widgets/contextMenu';
import { DialogInputType } from '../widgets/dialog';

export function getStashContextMenuActions(ctx: GraphContext, target: IndexedRefTarget): ContextMenuActions {
	const store = ctx.store, hash = target.hash, selector = target.ref, visibility = store.config.contextMenuActionsVisibility.stash;
	const stashName = selector.substring(5);

	return [[
		{
			title: strings.menuApplyStash + ELLIPSIS,
			visible: visibility.apply,
			onClick: () => {
				ctx.dialog.showForm(formatStr(markup.applyStashConfirm, stashName), [{
					type: DialogInputType.Checkbox,
					name: strings.reinstateIndexCheckbox,
					value: store.config.dialogDefaults.applyStash.reinstateIndex,
					info: strings.reinstateIndexInfo
				}], strings.yesApplyStash, (values) => {
					ctx.actions.run({ command: 'applyStash', repo: store.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, strings.applyingStash);
				}, target);
			}
		}, {
			title: strings.menuCreateBranchFromStash + ELLIPSIS,
			visible: visibility.createBranch,
			onClick: () => {
				ctx.dialog.showRefInput(formatStr(markup.branchFromStashPrompt, stashName), '', strings.actionCreateBranch, (branchName) => {
					ctx.actions.run({ command: 'branchFromStash', repo: store.currentRepo, selector: selector, branchName: branchName }, strings.creatingBranch);
				}, target);
			}
		}, {
			title: strings.menuPopStash + ELLIPSIS,
			visible: visibility.pop,
			onClick: () => {
				ctx.dialog.showForm(formatStr(markup.popStashConfirm, stashName), [{
					type: DialogInputType.Checkbox,
					name: strings.reinstateIndexCheckbox,
					value: store.config.dialogDefaults.popStash.reinstateIndex,
					info: strings.reinstateIndexInfo
				}], strings.yesPopStash, (values) => {
					ctx.actions.run({ command: 'popStash', repo: store.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, strings.poppingStash);
				}, target);
			}
		}, {
			title: strings.menuDropStash + ELLIPSIS,
			visible: visibility.drop,
			onClick: () => {
				ctx.dialog.showConfirmation(formatStr(markup.dropStashConfirm, stashName), strings.yesDrop, () => {
					ctx.actions.run({ command: 'dropStash', repo: store.currentRepo, selector: selector }, strings.droppingStash);
				}, target);
			}
		}
	], [
		{
			title: strings.menuCopyStashName,
			visible: visibility.copyName,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: strings.copyTypeStashName, data: selector });
			}
		}, {
			title: strings.menuCopyStashHash,
			visible: visibility.copyHash,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: strings.copyTypeStashHash, data: hash });
			}
		}
	]];
}
