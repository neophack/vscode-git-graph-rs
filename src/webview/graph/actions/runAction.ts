/**
 * Running write actions: every action the view asks the extension host to perform goes through
 * `ActionRunner.run`, which first assesses whether it can lose data, and if so requires the user
 * to accept the risk, then shows the "action running" dialog and sends the request.
 */

import { html, joinHtml, SafeHtml } from '../../common/html';
import { formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { formatCommaSeparatedList } from '../../common/util';
import { GraphContext } from '../context';

/**
 * Assess whether an action can cause the user to lose data, and if so describe the risk. Covers
 * every write operation performed via `ActionRunner.run`, so operations that bypass the
 * per-action confirmation dialogs are still guarded.
 * @param msg The request describing the action that is about to be performed.
 * @returns The markup describing the data loss risk, or NULL if the action cannot lose data.
 */
export function getDataLossRisk(msg: GG.RequestMessage): SafeHtml | null {
	switch (msg.command) {
		case 'resetToCommit':
			return msg.resetMode === GG.GitResetMode.Hard ? markup.riskResetHard : null;
		case 'cleanUntrackedFiles':
			return html`${msg.directories ? markup.riskCleanUntrackedDirectories : markup.riskCleanUntrackedFiles} ${strings.riskCleanUntrackedSuffix}`;
		case 'deleteBranch': {
			const risks: SafeHtml[] = [];
			if (msg.forceDelete) risks.push(formatStr(markup.riskDeleteBranchForce, msg.branchName));
			if (msg.deleteOnRemotes.length > 0) risks.push(html`${formatStr(strings.riskDeleteBranchRemote, formatCommaSeparatedList(msg.deleteOnRemotes.map((remote) => '"' + remote + '"')))}`);
			return risks.length > 0 ? joinHtml(risks, html`<br>`) : null;
		}
		case 'deleteRemoteBranch':
			return formatStr(markup.riskDeleteRemoteBranch, msg.remote + '/' + msg.branchName);
		case 'pushBranch': {
			const target = formatCommaSeparatedList(msg.remotes.map((remote) => remote + '/' + msg.branchName));
			return msg.mode === GG.GitPushBranchMode.Force
				? formatStr(markup.riskPushForce, target)
				: msg.mode === GG.GitPushBranchMode.ForceWithLease
					? formatStr(markup.riskPushForceWithLease, target)
					: null;
		}
		case 'fetchIntoLocalBranch':
			return msg.force ? formatStr(markup.riskFetchIntoLocalBranchForce, msg.localBranch) : null;
		case 'dropCommit':
			return html`${strings.riskDropCommit}`;
		case 'dropStash':
			return markup.riskDropStash;
		case 'resetFileToRevision':
			return formatStr(markup.riskResetFile, msg.filePath);
		default:
			return null;
	}
}

export class ActionRunner {
	constructor(private readonly ctx: () => GraphContext) { }

	/**
	 * Perform an action: confirm it first if it can lose data, show that it is running, and send it.
	 * @param msg The request.
	 * @param action A short name for the action, shown while it runs.
	 */
	public run(msg: GG.RequestMessage, action: string) {
		const ctx = this.ctx();
		const risk = getDataLossRisk(msg);
		if (risk !== null) {
			ctx.dialog.showDataLossWarning(risk, () => {
				ctx.dialog.showActionRunning(action);
				ctx.bridge.send(msg);
			});
			return;
		}
		ctx.dialog.showActionRunning(action);
		ctx.bridge.send(msg);
	}
}
