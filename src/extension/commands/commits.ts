import { GitGraphView } from '../../gitGraphView';
import { t } from '../../i18n';
import { showErrorMessage, showInformationMessage, uiPort } from '../../utils/actions';
import { UiPort } from '../../extension/platform/uiPort';
import { unableToFindGitMsg } from '../../utils/findGit';
import type { CommandHost } from './context';

/**
 * The commit-history commands outside the view: `searchCommits` finds a commit across the
 * known repositories and opens the view on it.
 */

/**
 * The method run when the `git-graph-rs.searchCommits` command is invoked.
 * @param host The services the command runs with.
 * @param ui The native-UI port the repo/query/commit pickers run through (task 4.10,
 * INVENTORY.md #15-#17); defaults to the production port, injectable for tests.
 */
export async function searchCommits(host: CommandHost, ui: UiPort = uiPort) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg());
		return;
	}
	const repos = host.repoManager.getRepos();
	const repoOptions = Object.keys(repos).sort();
	if (repoOptions.length === 0) return;

	let repo: string;
	if (repoOptions.length === 1) {
		repo = repoOptions[0];
	} else {
		const selectedRepo = await ui.showQuickPick(repoOptions, { placeHolder: t('selectRepoToSearch') });
		if (!selectedRepo) return;
		repo = selectedRepo;
	}

	const query = await ui.showInputBox({
		prompt: t('searchCommitsPrompt'),
		placeHolder: t('searchCommitsPlaceholder')
	});
	if (typeof query !== 'string' || query.trim() === '') return;

	try {
		const commits = await host.dataSource.searchHistory(repo, query.trim());
		if (commits.length === 0) {
			showInformationMessage(t('noCommitsFound'));
			return;
		}
		const items = commits.map(c => ({
			label: c.hash.substring(0, 8),
			description: c.message,
			detail: c.author + ' - ' + new Date(c.date * 1000).toLocaleString(),
			commitHash: c.hash
		}));
		const selected = await ui.showQuickPick(items, {
			placeHolder: t('selectCommitToView'),
			matchOnDescription: true,
			matchOnDetail: true
		});
		if (selected) {
			GitGraphView.createOrShow(host.context.extensionPath, host.repo, host.gitRunner, host.legacyViews, host.extensionState, host.avatarManager, host.repoManager, host.logger, { repo: repo, findCommitHash: selected.commitHash });
		}
	} catch (err) {
		showErrorMessage(t('searchCommitsError'));
	}
}
