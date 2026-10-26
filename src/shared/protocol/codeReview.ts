/**
 * The code-review-domain messages of the Git Graph view protocol: start, update and end a
 * workspace code review. Split out of src/types/messages.ts verbatim; the domain mirrors
 * handlers/codeReview.ts.
 */

import type { CodeReview } from '../model/repoState';
import type { RepoRequest, ResponseWithErrorInfo } from './messages';

export interface RequestEndCodeReview extends RepoRequest {
	readonly command: 'endCodeReview';
	readonly id: string;
}

export interface RequestStartCodeReview extends RepoRequest {
	readonly command: 'startCodeReview';
	readonly id: string;
	readonly files: string[];
	readonly lastViewedFile: string | null;
	readonly commitHash: string;
	readonly compareWithHash: string | null;
}
export interface ResponseStartCodeReview extends ResponseWithErrorInfo {
	readonly command: 'startCodeReview';
	readonly codeReview: CodeReview;
	readonly commitHash: string;
	readonly compareWithHash: string | null;
}

export interface RequestUpdateCodeReview extends RepoRequest {
	readonly command: 'updateCodeReview';
	readonly id: string;
	readonly remainingFiles: string[];
	readonly lastViewedFile: string | null;
}

export interface ResponseUpdateCodeReview extends ResponseWithErrorInfo {
	readonly command: 'updateCodeReview';
}
