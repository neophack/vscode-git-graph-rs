/**
 * The comparison page's own mutable model of one file change. The `init` message delivers the
 * host's file changes as fresh (readonly) copies; the deferred +N/-M counts patch them in place
 * once they arrive, so the model the sidebar, the header and the diff view share is this mutable
 * form.
 */

export interface ComparisonFileModel {
	oldFilePath: string;
	newFilePath: string;
	type: string;
	additions: number | null;
	deletions: number | null;
}

/** The status letter a file's change type renders as in the sidebar and the file header. */
const LETTERS: { [type: string]: string } = { A: 'A', C: 'C', D: 'D', M: 'M', R: 'R', T: 'T', U: 'U', '??': 'U' };

export function statusLetter(file: ComparisonFileModel): string {
	return LETTERS[file.type] || '?';
}

export function statusColour(file: ComparisonFileModel): string {
	return file.type === 'D' ? 'var(--vscode-gitDecoration-deletedResourceForeground, #b31d28)'
		: file.type === 'A' || file.type === 'R' ? 'var(--vscode-gitDecoration-addedResourceForeground, #22863a)'
		: 'var(--vscode-gitDecoration-modifiedResourceForeground, inherit)';
}

/** The path a file change is listed under (its new path, or the old one of a deletion). */
export function changePath(file: ComparisonFileModel): string {
	return file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
}
