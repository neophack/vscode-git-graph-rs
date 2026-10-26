/**
 * The worktree-domain messages of the Git Graph view protocol: the worktree list, add,
 * remove and prune. Split out of src/types/messages.ts verbatim; the domain mirrors
 * handlers/worktrees.ts.
 */

import type { GitWorktree } from '../model/git';
import type { BaseMessage, RepoRequest, ResponseWithErrorInfo } from './messages';

export interface RequestWorktreeList extends RepoRequest {
	readonly command: 'worktreeList';
}
export interface ResponseWorktreeList extends BaseMessage {
	readonly command: 'worktreeList';
	readonly repo: string;
	readonly worktrees: ReadonlyArray<GitWorktree>;
}

export interface RequestWorktreeAdd extends RepoRequest {
	readonly command: 'worktreeAdd';
	readonly path: string;
	readonly branch: string | null;
	readonly newBranch: string | null;
}
export interface ResponseWorktreeAdd extends ResponseWithErrorInfo {
	readonly command: 'worktreeAdd';
}

export interface RequestWorktreeRemove extends RepoRequest {
	readonly command: 'worktreeRemove';
	readonly path: string;
	readonly force: boolean;
}
export interface ResponseWorktreeRemove extends ResponseWithErrorInfo {
	readonly command: 'worktreeRemove';
}

export interface RequestWorktreePrune extends RepoRequest {
	readonly command: 'worktreePrune';
}
export interface ResponseWorktreePrune extends ResponseWithErrorInfo {
	readonly command: 'worktreePrune';
}
