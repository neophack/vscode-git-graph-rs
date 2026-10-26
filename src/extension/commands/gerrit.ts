import { t } from '../../i18n';
import { extractChangeId, generateChangeId } from '../integrations/gerrit/gerritProtocol';
import { getConfig } from '../platform/config';
import { showErrorMessage, showInformationMessage, openExternalUrl, uiPort } from '../../utils/actions';
import { UiPort } from '../../extension/platform/uiPort';
import { isSafeRefName } from '../../utils/git';
import { unableToFindGitMsg } from '../../utils/findGit';
import { ErrorInfo } from '../../types';
import { resolveRepoFromCommandArg, type CommandHost } from './context';

/**
 * The Gerrit review commands: pushing HEAD to `refs/for/<branch>` for review, and installing
 * the server's commit-msg hook so new commits carry a Change-Id.
 */

/**
 * The method run when the `git-graph-rs.gerritPushRef` command is invoked.
 * Pushes HEAD to `refs/for/<current branch>` on the configured Gerrit remote for review,
 * amending a Change-Id onto HEAD first if it has none (after asking).
 * @param host The services the command runs with.
 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Source Control View).
 * @param ui The native-UI port (task 4.10); defaults to the production port, injectable for tests.
 */
export async function gerritPushRef(host: CommandHost, arg: unknown, ui: UiPort = uiPort) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg());
		return;
	}

	const repo = await resolveRepoFromCommandArg(host, arg);
	if (repo === null) return;

	const branch = await host.gitRunner.gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], repo, (stdout) => stdout.trim()).catch(() => null);
	if (branch === null || branch === '') {
		showErrorMessage(t('gerritNoCommits'));
		return;
	}
	if (branch === 'HEAD') {
		showErrorMessage(t('gerritDetachedHead'));
		return;
	}
	if (!isSafeRefName(branch)) {
		showErrorMessage(t('gerritInvalidBranch', branch));
		return;
	}

	const amend = await ensureHeadChangeId(host, repo, true, ui);
	if (amend.error !== null) {
		showErrorMessage(amend.error);
		return;
	}

	const remote = getConfig().gerrit.remote;
	try {
		// git push writes its report (with the change URL) to STDERR, not stdout — resolve
		// from both streams, so the "Open Change" action is actually offered.
		const url = await host.gitRunner.gitOutputWithStderr(['push', remote, 'HEAD:refs/for/' + branch], repo, (stdout, stderr) => {
			const match = /(https?:\/\/\S*\/c\/\S*\/\+?\/?\d+)/.exec((stdout + '\n' + stderr).replace(/\r?\n/g, ' '));
			return match !== null ? match[1] : null;
		});
		if (url !== null) {
			ui.showInformationMessage(t('gerritPushedWithUrl', url), t('gerritOpenChange')).then((action) => {
				if (action === t('gerritOpenChange')) openExternalUrl(url);
			}, () => { });
		} else {
			showInformationMessage(t('gerritPushed', branch, remote));
		}
	} catch (errorMessage) {
		showErrorMessage(t('gerritPushFailed', String(errorMessage)));
	}
}

/**
 * The method run when the `git-graph-rs.gerritFetchCommitMsgHook` command is invoked.
 * Downloads the commit-msg hook from the Gerrit server of the configured remote and installs
 * it into the repository's hooks directory (so new commits get a Change-Id automatically).
 * @param host The services the command runs with.
 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Source Control View).
 */
export async function gerritFetchCommitMsgHook(host: CommandHost, arg: unknown) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg());
		return;
	}

	const repo = await resolveRepoFromCommandArg(host, arg);
	if (repo === null) return;

	const result = await host.gerrit.installHook(repo, getConfig().gerrit.remote, 'commit-msg');
	if (result.error !== null) {
		showErrorMessage(t('gerritHookFailed', result.error));
	} else if (result.installed) {
		showInformationMessage(t('gerritHookInstalled'));
	} else {
		showInformationMessage(t('gerritHookUpToDate'));
	}
}

/**
 * Ensure that HEAD has a Gerrit Change-Id footer, amending the commit if (and only if) it is
 * safe to do so: HEAD must have no Change-Id yet, and must not have been pushed to any remote
 * (amending an already-published commit would rewrite its history).
 * @param host The services the command runs with.
 * @param repo The path of the repository.
 * @param confirm Ask the user to confirm the amend before performing it (used by the push flow,
 * where amending is a side effect of another action, rather than the action itself).
 * @param ui The native-UI port the confirm dialog runs through (task 4.10, INVENTORY.md #2).
 * @returns The error of the operation (NULL => HEAD already had a Change-Id, or one was amended),
 *          the Change-Id of HEAD, and whether it was newly amended.
 */
async function ensureHeadChangeId(host: CommandHost, repo: string, confirm: boolean, ui: UiPort): Promise<{ error: ErrorInfo, changeId: string | null, amended: boolean }> {
	try {
		const message = await host.gitRunner.gitOutput(['log', '-1', '--format=%B', 'HEAD', '--'], repo, (stdout) => stdout);
		const existing = extractChangeId(message);
		if (existing !== null) return { error: null, changeId: existing, amended: false }; // nothing to amend

		const remotes = await host.gitRunner.gitOutput(['branch', '-r', '--no-color', '--contains=HEAD'], repo, (stdout) =>
			stdout.split(/\r?\n/).map((line) => line.trim())
				// A symbolic line ("origin/HEAD -> origin/main") names the same remote branch as
				// its target, which the listing carries as its own line: resolve it and deduplicate.
				.map((line) => (line.indexOf(' -> ') !== -1 ? line.split(' -> ').pop()! : line))
				.filter((line, index, lines) => line !== '' && lines.indexOf(line) === index)
		);
		if (remotes.length > 0) return { error: t('gerritChangeIdPushedError', remotes[0]), changeId: null, amended: false };

		// Generate the Change-Id Gerrit would assign to HEAD (same construction as the commit-msg hook)
		const changeId = await host.gitRunner.gitOutput(['show', '-s', '--format=%T%n%P%n%an <%ae> %at%n%cn <%ce> %ct%n%B', 'HEAD'], repo, (stdout) => {
			const lines = stdout.split(/\r?\n/);
			return generateChangeId(lines[0], lines[1], lines[2], lines[3], lines.slice(4).join('\n'));
		});

		if (confirm) {
			const action = await ui.showInformationMessage(
				t('gerritAmendConfirm', changeId.substring(0, 12)),
				t('gerritAmendAndPushButton'),
				t('gerritCancel')
			);
			if (action !== t('gerritAmendAndPushButton')) return { error: t('gerritAmendAborted'), changeId: null, amended: false };
		}

		const args = ['commit', '--amend', '-m', message.replace(/\s+$/, '') + '\n\nChange-Id: ' + changeId];
		if (getConfig().signCommits) args.push('-S');
		const error = await host.gitRunner.runGitCommand(args, repo);
		return { error: error, changeId: changeId, amended: error === null };
	} catch (errorMessage) {
		return { error: String(errorMessage), changeId: null, amended: false };
	}
}
