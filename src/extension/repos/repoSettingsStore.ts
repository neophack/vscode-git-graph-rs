import * as path from 'path';
import { t } from '../platform/i18n';
import { ErrorInfo } from '../../shared/protocol/messages';
import { GitRepoState } from '../../shared/model/repoState';
import { getRepoName, getPathFromStr } from '../platform/paths';
import { showErrorMessage, showInformationMessage } from '../platform/actions';
import { BufferedQueue } from '../../shared/util/bufferedQueue';
import { Disposable } from '../../shared/util/disposable';
import {
	ExternalRepoConfig,
	applyExternalConfigFile,
	generateExternalConfigFile,
	pinsEqual,
	readExternalConfigFile,
	validateExternalConfigFile,
	writeExternalConfigFile
} from './repoConfigFile';

/**
 * The repository-settings half of the repository manager (OPTIMIZATION-PLAN A5): everything the
 * extension does with a repository's External Configuration File (`.vscode/git-graph-rs.json`)
 * beyond the file format itself (./repoConfigFile owns reading, writing, validating and
 * applying a file): importing detected file changes into the repository states (queued, so a
 * burst of file events is checked once), persisting pinned branches/commits back to the file,
 * and exporting a repository's configuration.
 *
 * The store has NO vscode import: the registry surface it reads and updates arrives as the
 * {@link RepoSettingsStoreHost} port (the RepoRegistry satisfies it structurally), and the one
 * native prompt the newer-configuration import asks with arrives as {@link InformationPrompt}
 * (the RepoManager passes `vscode.window.showInformationMessage`, which owns the file watcher,
 * through) — so the import/export policies are testable with plain fakes.
 */

/** The registry surface the settings store reads and updates. */
export interface RepoSettingsStoreHost {
	/** The paths of all known repositories. */
	repoPaths(): string[];
	/** The (live) state of a known repository, or UNDEFINED when the repository is unknown. */
	getRepoState(repo: string): GitRepoState | undefined;
	/** Whether the repository is currently known. */
	isKnownRepo(repo: string): boolean;
	/** The known repository containing the file, or NULL when none does. */
	getRepoContainingFile(path: string): string | null;
	/** Persist the repository states (the registry's save). */
	persist(): void;
	/** Announce the repository set (and its per-repository settings) to the subscribers. */
	sendRepos(): void;
}

/**
 * The information-message prompt the newer-configuration import asks with:
 * `vscode.window.showInformationMessage`, passed structurally (a dismissed message answers
 * UNDEFINED, the "no" answer, exactly as before). Both choices are plain strings, so the
 * prompt needs none of the API's genericity.
 */
export type InformationPrompt = (message: string, ...items: string[]) => Thenable<string | undefined>;

/**
 * Keeps the repository states and their External Configuration Files in sync: detected file
 * changes are imported (asking before an older file's full configuration is applied, and never
 * reverting pins while a write is in flight), pins are persisted back to the file, and a
 * repository's configuration can be exported.
 */
export class RepoSettingsStore extends Disposable {
	private readonly host: RepoSettingsStoreHost;
	private readonly prompt: InformationPrompt;

	private readonly pinsWriteInFlight: Set<string> = new Set(); // repos whose pinned branches/commits are currently being persisted to the External Configuration File

	private readonly checkRepoConfigQueue: BufferedQueue<string>;

	/**
	 * @param host The registry the store reads repository states through and persists to.
	 * @param prompt The Yes/No information-message prompt the newer-configuration import asks with.
	 */
	constructor(host: RepoSettingsStoreHost, prompt: InformationPrompt) {
		super();
		this.host = host;
		this.prompt = prompt;
		this.checkRepoConfigQueue = new BufferedQueue<string>(this.checkRepoForNewConfig.bind(this), this.host.sendRepos.bind(this.host));
		this.registerDisposable(this.checkRepoConfigQueue);
	}

	/* Configuration File Changes */

	/**
	 * Check the known repositories for new configuration files.
	 */
	public checkReposForNewConfig() {
		this.host.repoPaths().forEach((repo) => this.checkRepoConfigQueue.enqueue(repo));
	}

	/**
	 * Handle a file system create or change event for a configuration file.
	 * @param path The path of the configuration file.
	 */
	public onConfigWatcherCreateOrChange(path: string) {
		const repo = this.host.getRepoContainingFile(path);
		if (repo !== null) {
			this.checkRepoConfigQueue.enqueue(repo);
		}
	}

	/**
	 * Check to see if the repository has a new configuration file.
	 * @param repo The repository to check.
	 * @param isRepoNew Is the repository new (was it just added)
	 */
	public async checkRepoForNewConfig(repo: string, isRepoNew: boolean = false) {
		let changes = false;
		try {
			const file = await readExternalConfigFile(repo);
			const state = this.host.getRepoState(repo);
			if (state && file !== null && !this.pinsWriteInFlight.has(repo)) {
				// Skip importing pins while a write is in flight: the watcher event that triggered
				// this check may be our own write, and importing the file's (older) pins would
				// silently revert the user's pins in memory before they are written back
				const pinnedBranches = Array.isArray(file.pinnedBranches) ? file.pinnedBranches : [];
				const pinnedCommits = Array.isArray(file.pinnedCommits) ? file.pinnedCommits : [];
				if (!pinsEqual(state, { pinnedBranches, pinnedCommits })) {
					state.pinnedBranches = pinnedBranches;
					state.pinnedCommits = pinnedCommits;
					this.host.persist();
					changes = true;
				}
			}
			if (state && file !== null && typeof file.exportedAt === 'number' && file.exportedAt > state.lastImportAt) {
				const validationError = validateExternalConfigFile(file);
				if (validationError === null) {
					const yes = t('yesButton');
					const action = isRepoNew ? yes : await this.prompt(t('newerRepoConfigDetected', state.name || getRepoName(repo)), yes, t('noButton'));
					if (this.host.isKnownRepo(repo) && action) {
						const state = this.host.getRepoState(repo)!;
						if (action === yes) {
							applyExternalConfigFile(file, state);
						}
						state.lastImportAt = file.exportedAt;
						this.host.persist();
						if (!isRepoNew && action === yes) {
							void showInformationMessage(t('repoConfigImported', state.name || getRepoName(repo)));
						}
						changes = true;
					}
				} else {
					void showErrorMessage(t('repoConfigInvalidValue', validationError, getPathFromStr(path.join(repo, '.vscode', 'git-graph-rs.json'))));
				}
			}
		} catch (_) { }
		return changes;
	}

	/**
	 * Persist the pinned commits and branches of a repository to its External Configuration File (`.vscode/git-graph-rs.json`).
	 * @param repo The path of the repository.
	 */
	public writeRepoPins(repo: string) {
		const state = this.host.getRepoState(repo);
		if (state === undefined) {
			return;
		}
		this.pinsWriteInFlight.add(repo);
		void readExternalConfigFile(repo).then((file) => {
			if (!this.host.isKnownRepo(repo) || this.host.getRepoState(repo) !== state) {
				this.pinsWriteInFlight.delete(repo);
				return;
			}
			const contents: ExternalRepoConfig.File = file !== null ? Object.assign({}, file) : {};
			contents.pinnedBranches = state.pinnedBranches;
			contents.pinnedCommits = state.pinnedCommits;
			void writeExternalConfigFile(repo, contents).catch(showErrorMessage).then(() => this.pinsWriteInFlight.delete(repo));
		});
	}

	/**
	 * Export a repositories configuration.
	 * @param repo The path of the repository to export.
	 * @returns The ErrorInfo produced when performing this action.
	 */
	public exportRepoConfig(repo: string): Promise<ErrorInfo> {
		const file = generateExternalConfigFile(this.host.getRepoState(repo)!);
		return writeExternalConfigFile(repo, file).then((message) => {
			void showInformationMessage(message);
			if (this.host.isKnownRepo(repo)) {
				this.host.getRepoState(repo)!.lastImportAt = file.exportedAt!;
				this.host.persist();
			}
			return null;
		}, (error) => error);
	}
}
