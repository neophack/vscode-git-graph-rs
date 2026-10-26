/**
 * The tag-domain messages of the Git Graph view protocol: add, delete, push and the tag
 * details read. Split out of src/types/messages.ts verbatim; the domain mirrors
 * handlers/tags.ts.
 */

import type { GitTagDetails } from '../model/git';
import type { TagType } from '../model/webview';
import type { RepoRequest, ResponseWithErrorInfo, ResponseWithMultiErrorInfo } from './messages';

export interface RequestAddTag extends RepoRequest {
	readonly command: 'addTag';
	readonly commitHash: string;
	readonly tagName: string;
	readonly type: TagType;
	readonly message: string;
	readonly pushToRemote: string | null; // string => name of the remote to push the tag to, null => don't push to a remote
	readonly pushSkipRemoteCheck: boolean;
	readonly force: boolean;
}
export interface ResponseAddTag extends ResponseWithMultiErrorInfo {
	readonly command: 'addTag';
	readonly repo: string;
	readonly tagName: string;
	readonly pushToRemote: string | null;
	readonly commitHash: string;
}

export interface RequestDeleteTag extends RepoRequest {
	readonly command: 'deleteTag';
	readonly tagName: string;
	readonly deleteOnRemote: string | null; // null => don't delete on remote, otherwise => remote to delete on
}
export interface ResponseDeleteTag extends ResponseWithErrorInfo {
	readonly command: 'deleteTag';
}

export interface RequestPushTag extends RepoRequest {
	readonly command: 'pushTag';
	readonly tagName: string;
	readonly remotes: string[];
	readonly commitHash: string;
	readonly skipRemoteCheck: boolean;
}
export interface ResponsePushTag extends ResponseWithMultiErrorInfo {
	readonly command: 'pushTag';
	readonly repo: string;
	readonly tagName: string;
	readonly remotes: string[];
	readonly commitHash: string;
}

export interface RequestTagDetails extends RepoRequest {
	readonly command: 'tagDetails';
	readonly tagName: string;
	readonly commitHash: string;
}
export interface ResponseTagDetails extends ResponseWithErrorInfo {
	readonly command: 'tagDetails';
	readonly tagName: string;
	readonly commitHash: string;
	readonly details: GitTagDetails | null;
}
