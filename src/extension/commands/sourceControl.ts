import { t } from '../platform/i18n';
import { showErrorMessage, showInformationMessage, uiPort } from '../platform/actions';
import { UiPort } from '../platform/uiPort';
import { getRepoName } from '../platform/paths';
import { unableToFindGitMsg } from '../git/executable/findGit';
import { amendLastCommit as amendLastCommitOp, resetCurrentBranchToRemote as resetCurrentBranchToRemoteOp } from '../git/write/ops/commits';
import { resolveRepoFromCommandArg, type CommandHost } from './context';

/**
 * The commands the Visual Studio Code Source Control view offers (package.json
 * `contributes.menus["scm/title"]`): amending the last commit and resetting the current branch
 * to its remote. Each ships under an English and a Simplified-Chinese-titled `.zhCn` variant
 * (registered by the CommandManager to the same handlers).
 */

/**
 * The method run when the `git-graph-rs.amendLastCommit` command is invoked.
 * Amends the last commit with the currently staged changes, keeping the existing commit message.
 * @param host The services the command runs with.
 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Source Control View).
 */
export async function amendLastCommit(host: CommandHost, arg: unknown) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg(t));
		return;
	}

	const repo = await resolveRepoFromCommandArg(host, arg);
	if (repo === null) return;

	const errorInfo = await host.repo.write.run(repo, amendLastCommitOp({ sign: host.repo.write.policies.signCommits }));
	if (errorInfo !== null) {
		showErrorMessage(t('unableToAmendLastCommit', errorInfo));
	} else {
		showInformationMessage(t('amendedLastCommit', host.repoManager.getRepos()[repo].name || getRepoName(repo)));
	}
}

/**
 * The method run when the `git-graph-rs.resetCurrentBranchToRemote` command is invoked.
 * Soft resets the current branch to its upstream (remote tracking) branch, keeping all changes staged.
 * @param host The services the command runs with.
 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Source Control View).
 * @param ui The native-UI port the destructive confirm runs through;
 * defaults to the production port, injectable for tests.
 */
export async function resetCurrentBranchToRemote(host: CommandHost, arg: unknown, ui: UiPort = uiPort) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg(t));
		return;
	}

	const repo = await resolveRepoFromCommandArg(host, arg);
	if (repo === null) return;

	const upstream = await host.repo.read.getCurrentBranchUpstream(repo).catch(() => null);
	if (upstream === null) {
		showErrorMessage(t('noUpstreamBranch'));
		return;
	}

	const confirmed = await ui.showWarningMessage(
		t('resetToRemoteConfirm', upstream),
		{ modal: true },
		t('resetToRemoteButton')
	);
	if (confirmed !== t('resetToRemoteButton')) return;

	const errorInfo = await host.repo.write.run(repo, resetCurrentBranchToRemoteOp());
	if (errorInfo !== null) {
		showErrorMessage(t('unableToResetToRemote', errorInfo));
	} else {
		showInformationMessage(t('resetToRemoteDone', upstream));
	}
}
