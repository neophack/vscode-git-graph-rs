/**
 * The misc-domain messages of the Git Graph view protocol: the repository-set load, the
 * IDE-oriented effects (open URL/terminal/SCM, error dialog), the config export, the
 * rescan request and the host-pushed refresh. Split out of src/types/messages.ts
 * verbatim; the domain mirrors handlers/misc.ts.
 */

import type { GitRepoSet } from '../model/repoState';
import type { LoadGitGraphViewTo } from '../model/webview';
import type { BaseMessage, RepoRequest, ResponseWithErrorInfo } from './messages';

export interface RequestExportRepoConfig extends RepoRequest {
	readonly command: 'exportRepoConfig';
}
export interface ResponseExportRepoConfig extends ResponseWithErrorInfo {
	readonly command: 'exportRepoConfig';
}

export interface RequestLoadRepos extends BaseMessage {
	readonly command: 'loadRepos';
	readonly check: boolean;
}
export interface ResponseLoadRepos extends BaseMessage {
	readonly command: 'loadRepos';
	readonly repos: GitRepoSet;
	readonly lastActiveRepo: string | null;
	readonly loadViewTo: LoadGitGraphViewTo;
}

export interface RequestOpenExternalUrl extends BaseMessage {
	readonly command: 'openExternalUrl';
	readonly url: string;
}

export interface ResponseOpenExternalUrl extends ResponseWithErrorInfo {
	readonly command: 'openExternalUrl';
}

export interface RequestOpenTerminal extends RepoRequest {
	readonly command: 'openTerminal';
	readonly name: string;
}
export interface ResponseOpenTerminal extends ResponseWithErrorInfo {
	readonly command: 'openTerminal';
}

export interface ResponseRefresh extends BaseMessage {
	readonly command: 'refresh';
}

export interface RequestRescanForRepos extends BaseMessage {
	readonly command: 'rescanForRepos';
}

export interface RequestShowErrorDialog extends BaseMessage {
	readonly command: 'showErrorMessage';
	readonly message: string;
}

export interface RequestViewScm extends BaseMessage {
	readonly command: 'viewScm';
}
export interface ResponseViewScm extends ResponseWithErrorInfo {
	readonly command: 'viewScm';
}
