import * as vscode from 'vscode';
import { Logger } from './logger';
import { getPathFromUri } from './utils';

const FILE_CHANGE_REGEX = /(^\.git\/(config|index|HEAD|refs\/stash|refs\/heads\/.*|refs\/remotes\/.*|refs\/tags\/.*)$)|(^(?!\.git).*$)|(^\.git[^\/]+$)/;

/**
 * Paths whose modification can change the commit graph itself (the checked-out branch, any ref, or
 * the config Git reads when walking it). Everything else matching `FILE_CHANGE_REGEX` - working
 * tree files, `.git/index`, top-level `.git*` files - only affects the "Uncommitted Changes"
 * count, which is computed per refresh outside the commit cache; clearing that cache for them
 * would force the staged reload whose intermediate response strips the remote refs (the pill
 * flicker / double shape change this classification exists to prevent).
 */
const COMMITS_AFFECTED_REGEX = /^\.git\/(config|HEAD|refs\/.*)$/;

/**
 * Watches a Git repository for file events.
 */
export class RepoFileWatcher {
	private readonly logger: Logger;
	private readonly repoChangeCallback: (commitsAffected: boolean) => void;
	private readonly repoConfigChangeCallback: (() => void) | null;
	private repo: string | null = null;
	private fsWatcher: vscode.FileSystemWatcher | null = null;
	private fsWatcherGit: vscode.FileSystemWatcher | null = null;
	private refreshTimeout: NodeJS.Timer | null = null;
	private pendingCommitsAffected: boolean = false;
	private muteCount: number = 0;
	private resumeAt: number = 0;

	/**
	 * Creates a RepoFileWatcher.
	 * @param logger The Git Graph Logger instance.
	 * @param repoChangeCallback A callback to be invoked when a file event occurs in the repository.
	 * The argument tells whether any event of the debounce window can have changed the commit graph
	 * (a ref, HEAD or the Git config), as opposed to only the working tree status.
	 * @param repoConfigChangeCallback An optional callback to be invoked when the repository's
	 * `.git/config` file is modified (even while muted, so caches are never left stale).
	 */
	constructor(logger: Logger, repoChangeCallback: (commitsAffected: boolean) => void, repoConfigChangeCallback: (() => void) | null = null) {
		this.logger = logger;
		this.repoChangeCallback = repoChangeCallback;
		this.repoConfigChangeCallback = repoConfigChangeCallback;
	}

	/**
	 * Start watching a repository for file events.
	 * @param repo The path of the repository to watch.
	 */
	public start(repo: string) {
		if (this.fsWatcher !== null) {
			// If there is an existing File System Watcher, stop it
			this.stop();
		}

		this.repo = repo;
		// Create a File System Watcher for all events within the specified repository
		this.fsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo, '**'));
		this.fsWatcher.onDidCreate(uri => this.refresh(uri));
		this.fsWatcher.onDidChange(uri => this.refresh(uri));
		this.fsWatcher.onDidDelete(uri => this.refresh(uri));

		this.fsWatcherGit = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repo, '.git/**'));
		this.fsWatcherGit.onDidCreate(uri => this.refresh(uri));
		this.fsWatcherGit.onDidChange(uri => this.refresh(uri));
		this.fsWatcherGit.onDidDelete(uri => this.refresh(uri));

		this.logger.log('Started watching repo: ' + repo);
	}

	/**
	 * Get the repository currently being watched.
	 * @returns The path of the repository, or NULL if no repository is being watched.
	 */
	public getRepo(): string | null {
		return this.repo;
	}

	/**
	 * Stop watching the repository for file events.
	 */
	public stop() {
		if (this.fsWatcher !== null) {
			// If there is an existing File System Watcher, stop it
			this.fsWatcher.dispose();
			this.fsWatcher = null;
		}
		if (this.fsWatcherGit !== null) {
			this.fsWatcherGit.dispose();
			this.fsWatcherGit = null;
		}
		if (this.refreshTimeout !== null) {
			// If a timeout is active, clear it
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		this.pendingCommitsAffected = false;
	}

	/**
	 * Mute file events - Used to prevent many file events from being triggered when a Git action is
	 * executed by the Git Graph View. Mute requests are counted, so that concurrent Git actions each
	 * need to be completed (via a call to `unmute`) before file events are resumed.
	 */
	public mute() {
		this.muteCount++;
	}

	/**
	 * Unmute file events - Used to resume normal watching after a Git action executed by the Git
	 * Graph View has completed. The mute count is clamped at zero to recover from any unbalanced
	 * unmute call.
	 */
	public unmute() {
		if (this.muteCount > 0) this.muteCount--;
		this.resumeAt = (new Date()).getTime() + 1500;
	}


	/**
	 * Handle a file event triggered by the File System Watcher.
	 * @param uri The URI of the file that the event occurred on.
	 */
	private refresh(uri: vscode.Uri) {
		if (this.repo === null) return;
		const relativePath = getPathFromUri(uri).replace(this.repo + '/', '');
		if (relativePath === '.git/config') {
			// Config modifications must invalidate caches even while muted (Git actions run by the
			// Git Graph View itself may change the config), otherwise stale data could be served
			if (this.repoConfigChangeCallback !== null) this.repoConfigChangeCallback();
		}
		if (this.muteCount > 0) return;
		if (!relativePath.match(FILE_CHANGE_REGEX)) return;

		// Accumulate the classification across the debounce window: a `git commit` writes the index
		// AND the branch ref as separate events, and the callback must fire once with the union.
		this.pendingCommitsAffected = this.pendingCommitsAffected || COMMITS_AFFECTED_REGEX.test(relativePath);

		// An event arriving inside the post-action suppression window is DEFERRED until after the
		// window, never dropped: whether the event was caused by one of this extension's own Git
		// actions or by the user committing at just the wrong moment cannot be told apart here, and
		// a dropped event means a repository change that nothing else will detect.
		const delay = Math.max(750, this.resumeAt - (new Date()).getTime());
		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			this.refreshTimeout = null;
			const commitsAffected = this.pendingCommitsAffected;
			this.pendingCommitsAffected = false;
			this.repoChangeCallback(commitsAffected);
		}, delay);
	}
}
