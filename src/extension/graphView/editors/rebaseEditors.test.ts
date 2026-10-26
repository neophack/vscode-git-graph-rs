import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AMEND_EXEC, authorChangeRequested, parseSequenceArgs, rewriteSequenceTodo, runSequenceEditor } from './sequence';
import { parseMessageArgs, runMessageEditor } from './message';

/**
 * The rebase editors' argument handling (writeFlows' editCommitMessage hands them to git as
 * GIT_SEQUENCE_EDITOR / GIT_EDITOR): the parsing of the argv git produces, the environment
 * plumbing that signals an author change, and the exact git-rebase-todo text each combination
 * writes - the contract the automated reword rebase stands on, with no repository involved.
 */

const HASH = '9a3f02bd71c4e8fa2d66b0c1aa08e5d39c7b41f2';
const ABBREV = HASH.substring(0, 8);
const OTHER = '1111111111111111111111111111111111111111';

const TODO = [
	'# Rebase 2222222..3333333 onto 2222222 (3 commands)',
	'#',
	'pick ' + ABBREV + ' change something',
	'pick 55555555 change something else',
	'',
	'# Rebase todo shown by git'
].join('\n');

/** Scratch directories the file-writing cases run in, removed after the suite. */
const scratches: string[] = [];

afterEach(() => {
	for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-editor-test-'));
	scratches.push(dir);
	return dir;
}

describe('parseSequenceArgs', () => {
	it('takes the hash from argv[2] and the todo path from the last argument', () => {
		const todoFile = path.join('some', 'where', 'git-rebase-todo');
		expect(parseSequenceArgs(['node', 'sequence.js', HASH, todoFile])).toEqual({ hash: HASH, todoFile: todoFile });
	});

	it('rejects a missing argument and a hash that is not plain hex', () => {
		expect(parseSequenceArgs(['node', 'sequence.js', HASH])).toBeNull();
		expect(parseSequenceArgs(['node', 'sequence.js', 'HEAD;evil', 'git-rebase-todo'])).toBeNull();
		expect(parseSequenceArgs(['node', 'sequence.js', 'refs/heads/main', 'git-rebase-todo'])).toBeNull();
	});
});

describe('authorChangeRequested', () => {
	it('is true only when both staged-file variables are set', () => {
		expect(authorChangeRequested({ GG_AMEND_AUTHOR_FILE: '/tmp/a', GG_AMEND_MESSAGE: '/tmp/m' })).toBe(true);
		expect(authorChangeRequested({ GG_AMEND_AUTHOR_FILE: '/tmp/a' })).toBe(false);
		expect(authorChangeRequested({})).toBe(false);
	});
});

describe('rewriteSequenceTodo', () => {
	it('rewords exactly the target pick when only the message changes', () => {
		const rewritten = rewriteSequenceTodo(TODO, HASH, false);
		expect(rewritten).toContain('reword ' + ABBREV + ' change something');
		expect(rewritten).not.toContain('pick ' + ABBREV);
		expect(rewritten).toContain('pick 55555555 change something else');
		expect(rewritten).not.toContain(AMEND_EXEC);
	});

	it('keeps the pick and appends the amend exec line when the author changes', () => {
		const rewritten = rewriteSequenceTodo(TODO, HASH, true);
		expect(rewritten).toContain('pick ' + ABBREV + ' change something\n' + AMEND_EXEC);
		expect(rewritten).not.toContain('reword ' + ABBREV);
		// The other commands and every comment line are untouched.
		expect(rewritten).toContain('pick 55555555 change something else');
		expect(rewritten.split('\n').filter((line) => line.startsWith('#')).length).toBe(3);
	});

	it('leaves the todo alone when no pick matches the hash', () => {
		expect(rewriteSequenceTodo(TODO, OTHER, false)).toBe(TODO);
		expect(rewriteSequenceTodo(TODO, OTHER, true)).toBe(TODO);
	});

	it('matches an abbreviated hash that starts the full hash, not one that merely shares characters', () => {
		const todo = 'pick ' + HASH + ' exact\npick ' + OTHER + ' other';
		expect(rewriteSequenceTodo(todo, HASH, false)).toContain('reword ' + HASH + ' exact');
		expect(rewriteSequenceTodo(todo, HASH, false)).toContain('pick ' + OTHER + ' other');
		// A hash that is longer than the todo's abbreviation cannot be its continuation.
		expect(rewriteSequenceTodo('pick abc123 shorter', HASH, false)).toContain('pick abc123 shorter');
	});
});

describe('runSequenceEditor', () => {
	it('rewrites the todo file it is pointed at and exits zero', () => {
		const dir = scratchDir();
		const todoFile = path.join(dir, 'git-rebase-todo');
		fs.writeFileSync(todoFile, TODO);
		const code = runSequenceEditor(['node', 'sequence.js', HASH, todoFile], {});
		expect(code).toBe(0);
		expect(fs.readFileSync(todoFile, 'utf8')).toBe(rewriteSequenceTodo(TODO, HASH, false));
	});

	it('honors the author-change environment', () => {
		const dir = scratchDir();
		const todoFile = path.join(dir, 'git-rebase-todo');
		fs.writeFileSync(todoFile, TODO);
		const code = runSequenceEditor(['node', 'sequence.js', HASH, todoFile], { GG_AMEND_AUTHOR_FILE: path.join(dir, 'author'), GG_AMEND_MESSAGE: path.join(dir, 'message') });
		expect(code).toBe(0);
		expect(fs.readFileSync(todoFile, 'utf8')).toContain(AMEND_EXEC);
	});

	it('exits non-zero without touching any file when the arguments are invalid', () => {
		const dir = scratchDir();
		const todoFile = path.join(dir, 'git-rebase-todo');
		fs.writeFileSync(todoFile, TODO);
		expect(runSequenceEditor(['node', 'sequence.js', '--;reboot', todoFile], {})).toBe(1);
		expect(fs.readFileSync(todoFile, 'utf8')).toBe(TODO);
	});
});

describe('parseMessageArgs', () => {
	it('takes the staged message from argv[2] and git\'s editor file from the last argument', () => {
		expect(parseMessageArgs(['node', 'message.js', '/tmp/message', '/repo/.git/COMMIT_EDITMSG']))
			.toEqual({ source: '/tmp/message', target: '/repo/.git/COMMIT_EDITMSG' });
		expect(parseMessageArgs(['node', 'message.js', '/tmp/message'])).toBeNull();
	});
});

describe('runMessageEditor', () => {
	it('copies the staged message over git\'s editor file', () => {
		const dir = scratchDir();
		const source = path.join(dir, 'message');
		const target = path.join(dir, 'COMMIT_EDITMSG');
		fs.writeFileSync(source, 'New message\n\n# the comment block git appends');
		expect(runMessageEditor(['node', 'message.js', source, target])).toBe(0);
		expect(fs.readFileSync(target, 'utf8')).toBe('New message\n\n# the comment block git appends');
	});

	it('exits non-zero on malformed arguments', () => {
		expect(runMessageEditor(['node', 'message.js'])).toBe(1);
	});
});
