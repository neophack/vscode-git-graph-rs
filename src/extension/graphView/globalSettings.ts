import * as vscode from 'vscode';
import type { ProductionGitRepository } from '../git/gitRepository';
import { GitConfigKey } from '../git/write/ops/config';
import { setConfigValue, unsetConfigValue } from '../git/write/ops/config';
import { GitConfigLocation } from '../../shared/model/git';
import type { CommitAuthor } from '../../shared/model/webview';
import type { ErrorInfo } from '../../shared/protocol/messages';
import { commitAuthorsOf } from '../platform/config';
import type { ConfigProvider } from '../platform/config';
import { t } from '../platform/i18n';
import type { Logger } from '../platform/logger';

/**
 * The global (User) settings the graph view's Settings Widget may write, together with the
 * save flow and the global-author side effects of 'commitAuthors'. The pure decision functions
 * stay exported for their unit tests (globalSettings.test.ts); the read side (the settings
 * snapshot, the parsed `commitAuthors` value) lives in platform/config.
 */

/**
 * The Global (User) Settings that the Settings Widget is allowed to write, and the validator of
 * each value. Requests naming a setting that isn't a key of this record are rejected, so a
 * compromised webview can't write arbitrary VS Code settings.
 */
const WRITABLE_GLOBAL_SETTINGS: { readonly [setting: string]: (value: any) => boolean } = {
	/* Commit Authors */
	'commitAuthors': isCommitAuthors,

	/* Graph & Display */
	'graph.style': isOneOf('rounded', 'angular'),
	'graph.rowHeight': isIntegerInRange(16, 48),
	'graph.fontSize': isIntegerInRange(8, 24),
	'date.type': isOneOf('Author Date', 'Commit Date'),
	'date.format': isOneOf('Date & Time', 'Date Only', 'ISO Date & Time', 'ISO Date Only', 'Relative'),
	'referenceLabels.combineLocalAndRemoteBranchLabels': isBoolean,
	'stickyHeader': isBoolean,
	'markdown': isBoolean,
	'mobileAdaptation': isBoolean,

	/* Commit Loading */
	'repository.commits.initialLoad': isIntegerInRange(1, 100000),
	'repository.commits.loadMore': isIntegerInRange(1, 100000),
	'repository.commits.loadMoreAutomatically': isBoolean,
	'repository.commits.order': isOneOf('date', 'author-date', 'topo'),
	'repository.commits.fetchAvatars': isBoolean,
	'repository.showUncommittedChanges': isBoolean,
	'repository.showUntrackedFiles': isBoolean,

	/* Remotes & Fetching */
	'repository.fetchAndPrune': isBoolean,
	'repository.fetchAndPruneTags': isBoolean,
	'repository.trackRemoteTags': isBoolean,
	'repository.showRemoteBranches': isBoolean,
	'repository.showRemoteHeads': isBoolean,

	/* Review Integration */
	'pullRequests.enabled': isBoolean,

	/* Logging */
	'enableLog': isBoolean
};

function isBoolean(value: any) {
	return typeof value === 'boolean';
}

function isOneOf(...allowed: string[]) {
	return (value: any) => typeof value === 'string' && allowed.includes(value);
}

function isIntegerInRange(min: number, max: number) {
	return (value: any) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** The most author identities the `git-graph-rs.commitAuthors` setting accepts. */
const MAX_COMMIT_AUTHORS = 50;

/**
 * Validate a value for the `git-graph-rs.commitAuthors` Extension Setting: an array of at most
 * MAX_COMMIT_AUTHORS `{ name, email }` entries with non-empty trimmed strings. Exported for tests.
 */
export function isCommitAuthors(value: any) {
	return Array.isArray(value) && value.length <= MAX_COMMIT_AUTHORS && value.every((author: any) =>
		typeof author === 'object' && author !== null &&
		typeof author.name === 'string' && author.name.trim() !== '' &&
		typeof author.email === 'string' && author.email.trim() !== ''
	);
}

/**
 * The author identity the global Git configuration should hold after the identity list was
 * saved: NULL when the identity already configured there matches the list (nothing to write),
 * otherwise the FIRST identity - the default global author, which repositories without their
 * own selection follow. Exported for tests.
 * @param authors The saved author identities.
 * @param globalUser The identity currently in the global Git configuration (NULL => not set).
 */
export function resolveGlobalAuthorAfterSave(authors: ReadonlyArray<CommitAuthor>, globalUser: { name: string | null, email: string | null }): CommitAuthor | null {
	if (authors.length === 0) return null;
	return authors.some((author) => author.name === globalUser.name && author.email === globalUser.email)
		? null
		: authors[0];
}

/**
 * What may be done to the global Git identity when a non-empty identity list was saved. The
 * list governs the global author, but only over identities Git Graph wrote itself: an identity
 * the user configured outside of Git Graph is never silently overwritten - it first asks.
 * Exported for tests.
 * @param authors The saved author identities.
 * @param globalUser The identity currently in the global Git configuration (NULL => not set).
 * @param owned The identity Git Graph last wrote to the global configuration (NULL when it never did).
 */
export function resolveGlobalAuthorWriteAction(authors: ReadonlyArray<CommitAuthor>, globalUser: { name: string | null, email: string | null }, owned: { name: string, email: string } | null): { action: 'none' | 'write' | 'confirmOverwrite', author: CommitAuthor | null } {
	const author = resolveGlobalAuthorAfterSave(authors, globalUser);
	if (author === null) return { action: 'none', author: null };
	if (globalUser.name === null && globalUser.email === null) return { action: 'write', author: author };
	const ownsCurrent = owned !== null && owned.name === globalUser.name && owned.email === globalUser.email;
	return { action: ownsCurrent ? 'write' : 'confirmOverwrite', author: author };
}

/**
 * What may be done to the global Git identity when the identity list is emptied. Deleting an
 * identity FROM the list is the act of removing it, so an identity the list held (the widget
 * seeds the list from the global identity, and users manage their identities through it) is
 * cleared as part of that act. What must never go silently is an identity that has nothing to
 * do with the list: one the user configured outside of Git Graph, which never appeared in it,
 * and which Git Graph did not write either - that one first asks. Exported for tests.
 * @param globalUser The identity currently in the global Git configuration (NULL => not set).
 * @param owned The identity Git Graph last wrote to the global configuration (NULL when it never did).
 * @param previousAuthors The identities the list held before the emptying save.
 */
export function resolveGlobalAuthorClearAction(globalUser: { name: string | null, email: string | null } | null, owned: { name: string, email: string } | null, previousAuthors: ReadonlyArray<CommitAuthor>): 'none' | 'clear' | 'confirmClear' {
	if (globalUser === null || (globalUser.name === null && globalUser.email === null)) return 'none';
	const governed = previousAuthors.some((author) => author.name === globalUser.name && author.email === globalUser.email);
	if (governed) return 'clear';
	const ownsCurrent = owned !== null && owned.name === globalUser.name && owned.email === globalUser.email;
	return ownsCurrent ? 'clear' : 'confirmClear';
}

/** Render a global author identity for a confirmation message ("Name <email>"). */
function formatGlobalAuthor(user: { name: string | null, email: string | null }) {
	return (user.name ?? '?') + ' <' + (user.email ?? '?') + '>';
}

/** The collaborators the global-setting save flow needs. */
export interface GlobalSettingDeps {
	/** The repository facade: the global identity read, the configuration writes. */
	readonly repo: ProductionGitRepository;
	/** The composed-configuration cache, invalidated when the global identity was rewritten. */
	readonly repoConfig: { invalidate(repo: string | null): void };
	/** The ExtensionState surface the flow reads and writes. */
	readonly state: {
		getGlobalAuthorWritten(): { name: string, email: string } | null;
		setGlobalAuthorWritten(identity: { name: string, email: string } | null): void;
	};
	/** The repository open in the view (the working directory of the Git invocations); NULL => no author side effects. */
	currentRepo(): string | null;
	readonly logger: Logger;
	/** The configuration service (the latest settings snapshot; the previous-identity fallback read). */
	readonly config: ConfigProvider;
}

/**
 * Save a Global (User) Setting on behalf of the Settings Widget. Only the settings named by
 * WRITABLE_GLOBAL_SETTINGS can be written, and only with a value their validator accepts.
 * The onDidChangeConfiguration listener reloads the Git Graph View, which re-renders the webview
 * with the new value (the settings page is restored from the persisted webview state).
 * @param setting The key of the setting, relative to the `git-graph-rs` section.
 * @param value The new value of the setting.
 * @param previousValue What the widget last rendered for the setting; for 'commitAuthors'
 * this is the list the user saw and edited, and the authoritative answer to "which identities
 * did the list govern" (the host's own configuration read can lag the editor's write).
 * @returns The ErrorInfo of the failure (NULL => saved successfully).
 */
export async function saveGlobalSetting(deps: GlobalSettingDeps, setting: string, value: any, previousValue?: any): Promise<ErrorInfo> {
	const isValid = Object.prototype.hasOwnProperty.call(WRITABLE_GLOBAL_SETTINGS, setting)
		? WRITABLE_GLOBAL_SETTINGS[setting]
		: null;
	if (isValid === null) {
		deps.logger.log('Rejected a request to save the setting "' + setting + '" (not a writable Global Setting).');
		return t('settingNotWritable', setting);
	}
	if (!isValid(value)) {
		return t('settingValueInvalid', setting);
	}
	// The identities the list held before this save: emptying the list only clears a global
	// identity the list governed (the deleted identity itself) or one Git Graph wrote - a
	// foreign identity that never appeared in the list is confirmed first. The widget's
	// rendered list is the source of truth; the host's configuration read is the fallback.
	const previousAuthors = setting === 'commitAuthors'
		? (Array.isArray(previousValue) ? previousValue : commitAuthorsOf(deps.config.current))
		: [];
	try {
		await vscode.workspace.getConfiguration('git-graph-rs').update(setting, value, vscode.ConfigurationTarget.Global);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.logger.log('Saving the setting "' + setting + '" failed: ' + message);
		// A window that outlived an extension install/update still holds the configuration
		// registry of the old version, so VS Code rejects writes of settings only the new
		// version registers ("... is not a registered configuration"). That state clears
		// with the next window reload, which only the user can perform.
		if (/is not a registered configuration/i.test(message)) {
			return t('settingSaveNeedsReload', setting);
		}
		return message;
	}
	const repo = deps.currentRepo();
	if (setting === 'commitAuthors' && repo !== null && Array.isArray(value)) {
		if (value.length > 0) {
			await applyDefaultGlobalAuthor(deps, repo, value);
		} else {
			await clearGlobalAuthor(deps, repo, previousAuthors);
		}
	}
	return null;
}

/**
 * Default the global author to the FIRST author identity whenever the global Git
 * configuration matches none of the configured identities, so repositories following the
 * global configuration always have a well-defined author. The user can change the global
 * author at any time in the Author Identities list (the check button materialises it the
 * same way). Only an identity Git Graph wrote itself (or an unset configuration) is
 * replaced without asking; a foreign identity the user configured outside of Git Graph is
 * confirmed before it is overwritten - the extension must not quietly rewrite config it
 * does not own. Failures are logged and ignored: the list itself was saved successfully.
 * @param repo The path of the repository open in the view (the working directory of the Git invocation).
 * @param authors The saved author identities.
 */
async function applyDefaultGlobalAuthor(deps: GlobalSettingDeps, repo: string, authors: ReadonlyArray<{ name: string, email: string }>) {
	const global = await deps.repo.read.getGlobalUserDetails(repo).catch(() => null);
	if (global === null) return;
	const decision = resolveGlobalAuthorWriteAction(authors, global, deps.state.getGlobalAuthorWritten());
	if (decision.action === 'none' || decision.author === null) return;
	const author = decision.author;
	if (decision.action === 'confirmOverwrite') {
		const overwrite = await vscode.window.showInformationMessage(
			t('globalAuthorTakeOverConfirm', formatGlobalAuthor(global), formatGlobalAuthor(author)),
			{ modal: true },
			t('globalAuthorTakeOverButton', formatGlobalAuthor(author))
		);
		if (overwrite !== t('globalAuthorTakeOverButton', formatGlobalAuthor(author))) return; // the existing identity stays
	}
	const nameError = await deps.repo.write.run(repo, setConfigValue({ key: GitConfigKey.UserName, value: author.name, location: GitConfigLocation.Global }));
	const emailError = await deps.repo.write.run(repo, setConfigValue({ key: GitConfigKey.UserEmail, value: author.email, location: GitConfigLocation.Global }));
	if (nameError !== null || emailError !== null) {
		deps.logger.log('Defaulting the global author to the first author identity failed: ' + (nameError ?? emailError));
	} else {
		// The write succeeded: the identity is now Git Graph's own to manage (and to undo)
		deps.state.setGlobalAuthorWritten({ name: author.name, email: author.email });
	}
	// The global Git configuration changed, which the repository's `.git/config` watcher
	// cannot see: drop the cached config data so the next load reflects it
	deps.repoConfig.invalidate(repo);
}

/**
 * Clear the global author (user.name/user.email of the global Git configuration) after the
 * last author identity was deleted from the list: an empty list means there is no global
 * author, rather than the deleted identity silently remaining what repositories without
 * their own selection commit with. Committing must then FAIL until the user configures an
 * identity again, so user.useConfigOnly forbids Git's fallback of fabricating an address
 * from the operating system account: a commit without user.name/user.email dies with Git's
 * "Please tell me who you are" instead of recording an invented author. The guard is left
 * in place when an identity is later re-added - with an identity configured it is inert.
 *
 * Only an identity the list governed (held it before the emptying save) or one Git Graph
 * wrote itself (tracked in the extension state) is cleared as a side effect of emptying the
 * list; a foreign identity that never appeared in the list is confirmed before it is
 * removed - and when it is kept, nothing is written at all. Failures are logged and
 * ignored: the list itself was saved successfully.
 * @param repo The path of the repository open in the view (the working directory of the Git invocation).
 * @param previousAuthors The identities the list held before it was emptied.
 */
async function clearGlobalAuthor(deps: GlobalSettingDeps, repo: string, previousAuthors: ReadonlyArray<{ name: string, email: string }>) {
	const global = await deps.repo.read.getGlobalUserDetails(repo).catch(() => null);
	const decision = resolveGlobalAuthorClearAction(global, deps.state.getGlobalAuthorWritten(), previousAuthors);
	// A decision other than 'none' implies an identity is configured (resolveGlobalAuthorClearAction
	// answers 'none' for an unset configuration), but the compiler cannot see through it: narrow here.
	if (decision === 'none' || global === null) return;
	if (decision === 'confirmClear') {
		const remove = await vscode.window.showInformationMessage(
			t('globalAuthorRemoveConfirm', formatGlobalAuthor(global)),
			{ modal: true },
			t('globalAuthorRemoveButton', formatGlobalAuthor(global))
		);
		if (remove !== t('globalAuthorRemoveButton', formatGlobalAuthor(global))) return; // the foreign identity stays
	}
	const guardError = await deps.repo.write.run(repo, setConfigValue({ key: GitConfigKey.UseConfigOnly, value: 'true', location: GitConfigLocation.Global }));
	const nameError = global !== null && global.name !== null ? await deps.repo.write.run(repo, unsetConfigValue({ key: GitConfigKey.UserName, location: GitConfigLocation.Global })) : null;
	const emailError = global !== null && global.email !== null ? await deps.repo.write.run(repo, unsetConfigValue({ key: GitConfigKey.UserEmail, location: GitConfigLocation.Global })) : null;
	if (guardError !== null || nameError !== null || emailError !== null) {
		deps.logger.log('Clearing the global author after the identity list was emptied failed: ' + (guardError ?? nameError ?? emailError));
	} else {
		deps.state.setGlobalAuthorWritten(null);
	}
	// The global Git configuration changed, which the repository's `.git/config` watcher
	// cannot see: drop the cached config data so the next load reflects it
	deps.repoConfig.invalidate(repo);
}
