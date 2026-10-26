/**
 * The message editor of the automated reword rebase (writeFlows' editCommitMessage): git runs
 * this script as GIT_EDITOR for each `reword` stop of the rebase (and for the commit the
 * author-changing variant's exec line amends), with the staged message file as the first argument
 * and the file git opened for editing appended as the last one. It copies the staged message over
 * git's editor file - the editor "saving" without a human - so the message text never appears on
 * a command line or inside executed code, only in the two files the paths name.
 *
 * Shipped as a real compiled file (dist/editors/message.js, built by scripts/build/build.mjs the
 * same way as the askpass helper) instead of source strings generated at runtime. Runs on plain
 * Node also when the extension host is Electron (the caller sets ELECTRON_RUN_AS_NODE).
 */

import * as fs from 'fs';

/** The arguments git invokes the message editor with. */
export interface MessageEditorArgs {
	/** The staged new message (argv[2], a path inside the caller's private mkdtemp directory). */
	readonly source: string;
	/** The file git opened for editing, appended as the last argument. */
	readonly target: string;
}

/**
 * Parse the invocation `node message.js <staged-message> <git-editor-file>` (git appends its
 * editor file after the command writeFlows puts in GIT_EDITOR). Returns NULL when the arguments
 * are not that shape; the editor then exits non-zero and git fails the rebase.
 */
export function parseMessageArgs(argv: readonly string[]): MessageEditorArgs | null {
	if (argv.length < 4) return null;
	return { source: argv[2], target: argv[argv.length - 1] };
}

/** Run one invocation (the module's CLI entry); returns the process exit code. */
export function runMessageEditor(argv: readonly string[]): number {
	const args = parseMessageArgs(argv);
	if (args === null) {
		process.stderr.write('usage: message.js <staged-message-file> <git-editor-file>\n');
		return 1;
	}
	fs.writeFileSync(args.target, fs.readFileSync(args.source, 'utf8'));
	return 0;
}

if (typeof require !== 'undefined' && require.main === module) {
	process.exit(runMessageEditor(process.argv));
}
