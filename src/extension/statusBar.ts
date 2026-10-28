import type * as vscode from 'vscode';
import { t } from './platform/i18n';
import type { ConfigProvider } from './platform/config';
import { Logger } from './platform/logger';
import { RepoChangeEvent } from './repos/repoManager';
import { createStatusBarItem } from './platform/statusBar';
import { Disposable } from '../shared/util/disposable';
import { GgEvent } from '../shared/util/event';

/**
 * Manages the Git Graph Status Bar Item, which allows users to open the Git Graph View from the Visual Studio Code Status Bar.
 * The item itself is created through the platform adapter (the single vscode seam); this class
 * drives it structurally.
 */
export class StatusBarItem extends Disposable {
	private readonly logger: Logger;
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly config: ConfigProvider;
	private isVisible: boolean = false;
	private numRepos: number = 0;

	/**
	 * Creates the Git Graph Status Bar Item.
	 * @param initialNumRepos The number of repositories known at construction.
	 * @param onDidChangeRepos The repository-set change event.
	 * @param onDidChangeConfiguration The configuration-change event of the extension's settings.
	 * @param config The configuration service (the latest settings snapshot).
	 * @param logger The Git Graph Logger instance.
	 */
	constructor(initialNumRepos: number, onDidChangeRepos: GgEvent<RepoChangeEvent>, onDidChangeConfiguration: GgEvent<vscode.ConfigurationChangeEvent>, config: ConfigProvider, logger: Logger) {
		super();
		this.logger = logger;
		this.config = config;

		const statusBarItem = createStatusBarItem();
		statusBarItem.text = 'Git Graph RS';
		statusBarItem.tooltip = t('viewGitGraphRs');
		statusBarItem.command = 'git-graph-rs.view';
		this.statusBarItem = statusBarItem;

		this.registerDisposables(
			onDidChangeRepos((event) => {
				this.setNumRepos(event.numRepos);
			}),
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-graph-rs.showStatusBarItem')) {
					this.refresh();
				}
			}),
			statusBarItem
		);

		this.setNumRepos(initialNumRepos);
	}

	/**
	 * Sets the number of repositories known to Git Graph, before refreshing the Status Bar Item.
	 * @param numRepos The number of repositories known to Git Graph.
	 */
	private setNumRepos(numRepos: number) {
		this.numRepos = numRepos;
		this.refresh();
	}

	/**
	 * Show or hide the Status Bar Item according to the configured value of `git-graph-rs.showStatusBarItem`, and the number of repositories known to Git Graph.
	 */
	private refresh() {
		const shouldBeVisible = this.config.current.showStatusBarItem && this.numRepos > 0;
		if (this.isVisible !== shouldBeVisible) {
			if (shouldBeVisible) {
				this.statusBarItem.show();
				this.logger.log('Showing "Git Graph" Status Bar Item');
			} else {
				this.statusBarItem.hide();
				this.logger.log('Hiding "Git Graph" Status Bar Item');
			}
			this.isVisible = shouldBeVisible;
		}
	}
}
