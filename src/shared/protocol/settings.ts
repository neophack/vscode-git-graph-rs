/**
 * The settings-domain messages of the Git Graph view protocol: the global/workspace/repo
 * view state writes, the live config-changed push, the Git user details editors and the
 * interface language switch. Split out of src/types/messages.ts verbatim; the domain
 * mirrors handlers/settings.ts.
 */

import type { GitConfigLocation } from '../model/git';
import type { GitRepoState } from '../model/repoState';
import type { GitGraphViewSnapshot, GitGraphViewConfig, GitGraphViewGlobalState, GitGraphViewWorkspaceState, CommitAuthor } from '../model/webview';
import type { BaseMessage, RepoRequest, ResponseWithErrorInfo, ResponseWithMultiErrorInfo } from './messages';

export interface RequestDeleteUserDetails extends RepoRequest {
	readonly command: 'deleteUserDetails';
	readonly name: boolean; // TRUE => Delete Name, FALSE => Don't Delete Name
	readonly email: boolean; // TRUE => Delete Email, FALSE => Don't Delete Email
	readonly location: GitConfigLocation.Global | GitConfigLocation.Local;
}
export interface ResponseDeleteUserDetails extends ResponseWithMultiErrorInfo {
	readonly command: 'deleteUserDetails';
}

export interface RequestEditUserDetails extends RepoRequest {
	readonly command: 'editUserDetails';
	readonly name: string;
	readonly email: string;
	readonly location: GitConfigLocation.Global | GitConfigLocation.Local;
	readonly deleteLocalName: boolean; // TRUE => Delete Local Name, FALSE => Don't Delete Local Name
	readonly deleteLocalEmail: boolean; // TRUE => Delete Local Email, FALSE => Don't Delete Local Email
}
export interface ResponseEditUserDetails extends ResponseWithMultiErrorInfo {
	readonly command: 'editUserDetails';
}

export interface RequestOpenExtensionSettings extends BaseMessage {
	readonly command: 'openExtensionSettings';
}
export interface ResponseOpenExtensionSettings extends ResponseWithErrorInfo {
	readonly command: 'openExtensionSettings';
}

export interface RequestOpenLogFile extends BaseMessage {
	readonly command: 'openLogFile';
}
export interface ResponseOpenLogFile extends ResponseWithErrorInfo {
	readonly command: 'openLogFile';
}

/**
 * A Git Graph Extension Setting changed: apply it live instead of regenerating the webview's HTML
 * (a full page reload that flashed the view and dropped the open Commit Details View). Only sent
 * for settings the webview can apply at runtime; an interface language change still regenerates
 * the page (every rendered label would have to be swapped).
 */
export interface ResponseConfigChanged extends BaseMessage {
	readonly command: 'configChanged';
	readonly config: GitGraphViewConfig;
}

export interface RequestSetGlobalViewState extends BaseMessage {
	readonly command: 'setGlobalViewState';
	readonly state: GitGraphViewGlobalState;
}
export interface ResponseSetGlobalViewState extends ResponseWithErrorInfo {
	readonly command: 'setGlobalViewState';
}

export interface RequestSetRepoState extends RepoRequest {
	readonly command: 'setRepoState';
	readonly state: GitRepoState;
}

export interface RequestSetViewSnapshot extends BaseMessage {
	readonly command: 'setViewSnapshot';
	readonly snapshot: GitGraphViewSnapshot;
}

export interface RequestSetWorkspaceViewState extends BaseMessage {
	readonly command: 'setWorkspaceViewState';
	readonly state: GitGraphViewWorkspaceState;
}
export interface ResponseSetWorkspaceViewState extends ResponseWithErrorInfo {
	readonly command: 'setWorkspaceViewState';
}

export interface RequestSetInterfaceLanguage extends BaseMessage {
	readonly command: 'setInterfaceLanguage';
	readonly language: 'auto' | 'en' | 'zh-cn';
}
export interface ResponseSetInterfaceLanguage extends ResponseWithErrorInfo {
	readonly command: 'setInterfaceLanguage';
}

/** The type of a Global Setting that can be written from the Settings Widget. */
export type GlobalSettingValue = boolean | number | string | ReadonlyArray<CommitAuthor>;

export interface RequestSetGlobalSetting extends BaseMessage {
	readonly command: 'setGlobalSetting';
	/** The key of the setting, relative to the `git-graph-rs` section (e.g. "graph.style"). */
	readonly setting: string;
	readonly value: GlobalSettingValue;
	/** What the widget last rendered for this setting, when it differs in kind from a plain
	 * read of the host's configuration (the host's read can lag the editor's write behind).
	 * Saving 'commitAuthors' judges its global-Git-configuration side effects against THIS
	 * list: the identities the user saw and edited are the ones the list governs. */
	readonly previousValue?: GlobalSettingValue;
}
export interface ResponseSetGlobalSetting extends ResponseWithErrorInfo {
	readonly command: 'setGlobalSetting';
	readonly setting: string;
	/** Saving 'commitAuthors' may write the global Git configuration (defaulting or clearing the
	 * global author): the webview must reload the repository configuration only once the save
	 * completed, or it renders the pre-save snapshot of the global author. */
	readonly authorConfigTouched: boolean;
}
