import { describe, expect, it, vi } from 'vitest';
import type { CommitAuthor } from '../../types';

/**
 * The pure decision functions of the global-settings module (task 4.4's extraction from
 * GitGraphView), ported from tests/commitAuthors.test.mjs's pure portion: the commitAuthors
 * validator and the global-author write/clear decisions. The real-git integration halves of
 * the legacy file (applyDefaultGlobalAuthor / clearGlobalAuthor against a scratch repository)
 * keep running through the out/ shim until the deeper layers land. The module imports 'vscode'
 * for its save flow, so the mock only stands in for that.
 */

vi.mock('vscode', () => ({
	Uri: { file: (p: string) => ({ fsPath: p }) },
	ViewColumn: { One: 1 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	window: { showInformationMessage: async () => undefined, showErrorMessage: async () => undefined },
	workspace: {
		getConfiguration: () => ({ get: (_k: string, d: unknown) => d, inspect: () => undefined, update: async () => { } }),
		onDidChangeConfiguration: () => ({ dispose: () => { } })
	}
}));

import { isCommitAuthors, resolveGlobalAuthorAfterSave, resolveGlobalAuthorClearAction, resolveGlobalAuthorWriteAction } from './globalSettings';

const author = (name: string, email: string): CommitAuthor => ({ name: name, email: email });

describe('isCommitAuthors', () => {
	it('accepts an array of author identities with non-empty names and emails', () => {
		expect(isCommitAuthors([author('A', 'a@x'), author('B', 'b@x')])).toBe(true);
	});
	it('accepts an empty array', () => {
		expect(isCommitAuthors([])).toBe(true);
	});
	it('rejects entries with an empty or whitespace-only name or email', () => {
		expect(isCommitAuthors([author('A', ' ')])).toBe(false);
		expect(isCommitAuthors([author('\t', 'a@x')])).toBe(false);
	});
	it('rejects entries that are not name/email objects', () => {
		expect(isCommitAuthors([null])).toBe(false);
		expect(isCommitAuthors(['a@x'])).toBe(false);
		expect(isCommitAuthors([{ name: 'A' }])).toBe(false);
	});
	it('rejects arrays of more than 50 identities', () => {
		expect(isCommitAuthors(new Array(51).fill(author('A', 'a@x')))).toBe(false);
		expect(isCommitAuthors(new Array(50).fill(author('A', 'a@x')))).toBe(true);
	});
	it('rejects values that are not arrays', () => {
		expect(isCommitAuthors(undefined)).toBe(false);
		expect(isCommitAuthors('A <a@x>')).toBe(false);
	});
});

describe('resolveGlobalAuthorAfterSave', () => {
	const list = [author('A', 'a@x'), author('B', 'b@x')];
	it('writes nothing when the global configuration already matches an identity of the list', () => {
		expect(resolveGlobalAuthorAfterSave(list, { name: 'B', email: 'b@x' })).toBeNull();
	});
	it('defaults the global author to the FIRST identity when nothing matches', () => {
		expect(resolveGlobalAuthorAfterSave(list, { name: 'C', email: 'c@x' })).toEqual(author('A', 'a@x'));
	});
	it('defaults the global author to the first identity when the global configuration has no identity', () => {
		expect(resolveGlobalAuthorAfterSave(list, { name: null, email: null })).toEqual(author('A', 'a@x'));
	});
	it('defaults the global author to the first identity when the global identity is only partial', () => {
		expect(resolveGlobalAuthorAfterSave(list, { name: 'A', email: null })).toEqual(author('A', 'a@x'));
	});
	it('writes nothing for an empty identity list', () => {
		expect(resolveGlobalAuthorAfterSave([], { name: 'A', email: 'a@x' })).toBeNull();
	});
});

describe('resolveGlobalAuthorWriteAction', () => {
	const list = [author('A', 'a@x')];
	it('writes silently when the global configuration holds no identity', () => {
		expect(resolveGlobalAuthorWriteAction(list, { name: null, email: null }, null)).toEqual({ action: 'write', author: author('A', 'a@x') });
	});
	it('writes silently when the current global identity is the one Git Graph wrote', () => {
		const list = [author('A', 'a@x')];
		// The global identity is NOT in the list (so a write is due), but Git Graph wrote it itself
		expect(resolveGlobalAuthorWriteAction(list, { name: 'Z', email: 'z@x' }, { name: 'Z', email: 'z@x' })).toEqual({ action: 'write', author: author('A', 'a@x') });
	});
	it('asks before overwriting an identity Git Graph did not write', () => {
		expect(resolveGlobalAuthorWriteAction(list, { name: 'Z', email: 'z@x' }, null)).toEqual({ action: 'confirmOverwrite', author: author('A', 'a@x') });
	});
	it('writes nothing when the global identity already matches the list', () => {
		expect(resolveGlobalAuthorWriteAction(list, { name: 'A', email: 'a@x' }, null)).toEqual({ action: 'none', author: null });
	});
	it('writes nothing for an empty list', () => {
		expect(resolveGlobalAuthorWriteAction([], { name: null, email: null }, null)).toEqual({ action: 'none', author: null });
	});
});

describe('resolveGlobalAuthorClearAction', () => {
	it('does nothing when the global configuration holds no identity', () => {
		expect(resolveGlobalAuthorClearAction({ name: null, email: null }, null, [])).toBe('none');
		expect(resolveGlobalAuthorClearAction(null, null, [])).toBe('none');
	});
	it('clears an identity the emptied list governed (it held it before the save)', () => {
		expect(resolveGlobalAuthorClearAction({ name: 'A', email: 'a@x' }, null, [author('A', 'a@x')])).toBe('clear');
	});
	it('clears an identity Git Graph wrote itself, tracked in the extension state', () => {
		expect(resolveGlobalAuthorClearAction({ name: 'A', email: 'a@x' }, { name: 'A', email: 'a@x' }, [])).toBe('clear');
	});
	it('asks before clearing a foreign identity that never appeared in the list', () => {
		expect(resolveGlobalAuthorClearAction({ name: 'Z', email: 'z@x' }, null, [])).toBe('confirmClear');
		expect(resolveGlobalAuthorClearAction({ name: 'Z', email: 'z@x' }, { name: 'A', email: 'a@x' }, [])).toBe('confirmClear');
	});
});
