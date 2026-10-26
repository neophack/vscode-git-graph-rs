/**
 * The file-domain messages of the Git Graph view protocol: opening files and diffs, the
 * binary-diff handoff, archive creation and clipboard copies. Split out of
 * src/types/messages.ts verbatim; the domain mirrors handlers/files.ts.
 */

import type { GitFileStatus } from '../model/git';
import type { BaseMessage, RepoRequest, ResponseWithErrorInfo } from './messages';

export interface RequestCopyFilePath extends RepoRequest {
	readonly command: 'copyFilePath';
	readonly filePath: string;
	readonly absolute: boolean;
}
export interface ResponseCopyFilePath extends ResponseWithErrorInfo {
	readonly command: 'copyFilePath';
}

export interface RequestCopyToClipboard extends BaseMessage {
	readonly command: 'copyToClipboard';
	readonly type: string;
	readonly data: string;
}
export interface ResponseCopyToClipboard extends ResponseWithErrorInfo {
	readonly command: 'copyToClipboard';
	readonly type: string;
}

export interface RequestCreateArchive extends RepoRequest {
	readonly command: 'createArchive';
	readonly ref: string;
}
export interface ResponseCreateArchive extends ResponseWithErrorInfo {
	readonly command: 'createArchive';
}

export interface RequestOpenExternalDirDiff extends RepoRequest {
	readonly command: 'openExternalDirDiff';
	readonly fromHash: string;
	readonly toHash: string;
	readonly isGui: boolean;
}
export interface ResponseOpenExternalDirDiff extends ResponseWithErrorInfo {
	readonly command: 'openExternalDirDiff';
}

export interface RequestOpenCompareTab extends RepoRequest {
	readonly command: 'openCompareTab';
	readonly fromHash: string;
	readonly toHash: string;
	/** Present the changes as those of `toHash` alone (its diff against `fromHash`, its first
	 *  parent) rather than as a comparison between two commits. */
	readonly singleCommit: boolean;
}

export interface RequestOpenFile extends RepoRequest {
	readonly command: 'openFile';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseOpenFile extends ResponseWithErrorInfo {
	readonly command: 'openFile';
}

export interface RequestViewDiff extends RepoRequest {
	readonly command: 'viewDiff';
	readonly fromHash: string;
	readonly toHash: string;
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
}
export interface ResponseViewDiff extends ResponseWithErrorInfo {
	readonly command: 'viewDiff';
}

/** Opens the Binary Compare tab for a file the native Diff View cannot show (a binary or image
 *  change): the same tab the Commit Comparison View's "open diff" button uses. No response is
 *  sent, exactly like `openCompareTab`, since it just reveals a webview panel. */
export interface RequestViewDiffBinary extends RepoRequest {
	readonly command: 'viewDiffBinary';
	readonly fromHash: string;
	readonly toHash: string;
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
}

export interface RequestViewDiffWithWorkingFile extends RepoRequest {
	readonly command: 'viewDiffWithWorkingFile';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseViewDiffWithWorkingFile extends ResponseWithErrorInfo {
	readonly command: 'viewDiffWithWorkingFile';
}

export interface RequestViewFileAtRevision extends RepoRequest {
	readonly command: 'viewFileAtRevision';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseViewFileAtRevision extends ResponseWithErrorInfo {
	readonly command: 'viewFileAtRevision';
}
