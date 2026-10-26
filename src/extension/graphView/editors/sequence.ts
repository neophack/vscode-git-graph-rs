/**
 * The sequence editor of the automated reword rebase (writeFlows' editCommitMessage): git runs
 * this script as GIT_SEQUENCE_EDITOR when the interactive rebase starts, with the commit hash as
 * the first argument and the git-rebase-todo path appended as the last one. It rewrites the one
 * `pick` line of the target commit - to `reword` when only the message changes, or to `pick` plus
 * a following `exec git commit --amend` line when the author changes with it (the exec line's
 * shell references expand inside the rebase, so the author and message never appear on a command
 * line or inside executed code: their file paths travel in the environment only).
 *
 * Shipped as a real compiled file (dist/editors/sequence.js, built by scripts/build/build.mjs the
 * same way as the askpass helper) instead of source strings generated at runtime, so nothing
 * user-provided is ever embedded in code a shell executes. Runs on plain Node also when the
 * extension host is Electron (the caller sets ELECTRON_RUN_AS_NODE).
 */

import * as fs from 'fs';

/**
 * The exec line appended after the target pick when the author changes with the message. Git runs
 * it through the shell mid-rebase, where the environment-variable file references expand to the
 * staged author and message - the only place a shell ever sees them, and it reads files, not
 * interpolated values.
 */
export const AMEND_EXEC = 'exec git commit --amend --no-edit --author="$(cat "$GG_AMEND_AUTHOR_FILE")" -F "$GG_AMEND_MESSAGE"';

/** The arguments git invokes the sequence editor with. */
export interface SequenceEditorArgs {
	/** The full hash of the commit whose pick line is rewritten (argv[2]). */
	readonly hash: string;
	/** The git-rebase-todo file git appended as the last argument. */
	readonly todoFile: string;
}

/** The slice of the environment the editors read (both variables are set together or not at all). */
export interface EditorEnvironment {
	readonly GG_AMEND_AUTHOR_FILE?: string;
	readonly GG_AMEND_MESSAGE?: string;
}

/**
 * Parse the invocation `node sequence.js <commit-hash> <git-rebase-todo>` (git appends the todo
 * path after the editor command writeFlows puts in GIT_SEQUENCE_EDITOR). Returns NULL when the
 * arguments are not that shape - the editor then exits non-zero, git fails the rebase and the
 * caller aborts it, restoring the pre-rebase state.
 */
export function parseSequenceArgs(argv: readonly string[]): SequenceEditorArgs | null {
	if (argv.length < 4) return null;
	const hash = argv[2];
	// Hex object names only: the hash reaches the rebase through the editor command line, so it
	// must never be able to carry shell syntax.
	if (!/^[0-9a-f]+$/i.test(hash)) return null;
	return { hash: hash, todoFile: argv[argv.length - 1] };
}

/** TRUE when the caller staged an author alongside the message (writeFlows sets both variables). */
export function authorChangeRequested(env: EditorEnvironment): boolean {
	return typeof env.GG_AMEND_AUTHOR_FILE === 'string' && typeof env.GG_AMEND_MESSAGE === 'string';
}

/**
 * Rewrite the todo: the pick line whose abbreviated hash starts the target hash becomes `reword`,
 * or keeps its `pick` and gains the amend exec line on the FOLLOWING line when the author changes
 * too. Every other line - other picks, comments, breaks - is preserved untouched.
 *
 * The whole pick line (verb, abbreviated hash, subject) is matched and rebuilt, never spliced
 * mid-line: appending the exec to the match of a hash-only pattern would glue the commit subject
 * onto the exec command, where git would read its words as pathspecs (a bug the unit tests of
 * rebaseEditors.test.ts caught while porting the editor from its generated-source-string form).
 */
export function rewriteSequenceTodo(todo: string, hash: string, authorChange: boolean): string {
	return todo.replace(/^pick ([0-9a-f]+)([^\r\n]*)$/gm, (match, abbrev: string, rest: string) => {
		if (!hash.toLowerCase().startsWith(abbrev.toLowerCase())) return match;
		return authorChange ? match + '\n' + AMEND_EXEC : 'reword ' + abbrev + rest;
	});
}

/** Run one invocation (the module's CLI entry); returns the process exit code. */
export function runSequenceEditor(argv: readonly string[], env: EditorEnvironment): number {
	const args = parseSequenceArgs(argv);
	if (args === null) {
		process.stderr.write('usage: sequence.js <commit-hash> <git-rebase-todo>\n');
		return 1;
	}
	const todo = fs.readFileSync(args.todoFile, 'utf8');
	fs.writeFileSync(args.todoFile, rewriteSequenceTodo(todo, args.hash, authorChangeRequested(env)));
	return 0;
}

if (typeof require !== 'undefined' && require.main === module) {
	process.exit(runSequenceEditor(process.argv, process.env));
}
