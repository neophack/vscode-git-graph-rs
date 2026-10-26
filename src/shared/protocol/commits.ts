/**
 * The commit-domain messages of the Git Graph view protocol: checkout, cherrypick, drop,
 * revert, undo, fixup/squash, message editing and the resets. Split out of
 * src/types/messages.ts verbatim; the domain mirrors handlers/commits.ts.
 */

import type { GitResetMode } from '../model/git';
import type { RepoRequest, ResponseWithErrorInfo, ResponseWithMultiErrorInfo } from './messages';

export interface RequestCheckoutCommit extends RepoRequest {
	/** Set when the view already showed the data-loss warning and the user insisted. */
	readonly confirmed?: boolean;
	readonly command: 'checkoutCommit';
	readonly commitHash: string;
}
export interface ResponseCheckoutCommit extends ResponseWithErrorInfo {
	readonly command: 'checkoutCommit';
}

export interface RequestCherrypickCommit extends RepoRequest {
	readonly command: 'cherrypickCommit';
	readonly commitHash: string;
	readonly parentIndex: number;
	readonly recordOrigin: boolean;
	readonly noCommit: boolean;
}
export interface ResponseCherrypickCommit extends ResponseWithMultiErrorInfo {
	readonly command: 'cherrypickCommit';
}

export interface RequestDropCommit extends RepoRequest {
	readonly command: 'dropCommit';
	readonly commitHash: string;
}
export interface ResponseDropCommit extends ResponseWithErrorInfo {
	readonly command: 'dropCommit';
}

export interface RequestCommitFixup extends RepoRequest {
	readonly command: 'commitFixup';
	readonly commitHash: string;
}
export interface ResponseCommitFixup extends ResponseWithErrorInfo {
	readonly command: 'commitFixup';
}

export interface RequestCommitSquash extends RepoRequest {
	readonly command: 'commitSquash';
	readonly commitHash: string;
}
export interface ResponseCommitSquash extends ResponseWithErrorInfo {
	readonly command: 'commitSquash';
}

export interface RequestResetFileToRevision extends RepoRequest {
	readonly command: 'resetFileToRevision';
	readonly commitHash: string;
	readonly filePath: string;
}
export interface ResponseResetFileToRevision extends ResponseWithErrorInfo {
	readonly command: 'resetFileToRevision';
}

export interface RequestResetToCommit extends RepoRequest {
	/** Set when the view already showed the data-loss warning and the user insisted. */
	readonly confirmed?: boolean;
	readonly command: 'resetToCommit';
	readonly commit: string;
	readonly resetMode: GitResetMode;
}
export interface ResponseResetToCommit extends ResponseWithErrorInfo {
	readonly command: 'resetToCommit';
}

export interface RequestRevertCommit extends RepoRequest {
	readonly command: 'revertCommit';
	readonly commitHash: string;
	readonly parentIndex: number;
}
export interface ResponseRevertCommit extends ResponseWithErrorInfo {
	readonly command: 'revertCommit';
}

export interface RequestUndoLastCommit extends RepoRequest {
	readonly command: 'undoLastCommit';
}
export interface ResponseUndoLastCommit extends ResponseWithErrorInfo {
	readonly command: 'undoLastCommit';
}

export interface RequestEditCommitMessage extends RepoRequest {
	readonly command: 'editCommitMessage';
	readonly commitHash: string;
	readonly message: string;
	/** The commit's new author name and email (absent => the author is left unchanged). */
	readonly authorName?: string;
	readonly authorEmail?: string;
}
export interface ResponseEditCommitMessage extends ResponseWithErrorInfo {
	readonly command: 'editCommitMessage';
}
