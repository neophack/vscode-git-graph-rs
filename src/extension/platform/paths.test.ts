/**
 * The path helpers of src/utils/paths.ts (ported from tests/utils.test.mjs): normalisation
 * across URI/string forms, workspace membership, realpath resolution, symbolic-path mapping and
 * repository naming. The `vscode` module is faked with a mutable stub so workspace membership
 * and URI conversion can be driven per test.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
	let workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
	return {
		workspace: {
			get workspaceFolders() { return workspaceFolders; },
			set workspaceFolders(value: Array<{ uri: { fsPath: string } }> | undefined) { workspaceFolders = value; }
		},
		Uri: { file: (p: string) => ({ fsPath: p, path: p }) }
	};
});

vi.mock('vscode', () => vscodeMock);

import { doesFileExist, getPathFromStr, getPathFromUri, getRepoName, isPathInWorkspace, pathWithTrailingSlash, realpath, resolveToSymbolicPath } from './paths';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-utils-ws-'));
const workspacePath = workspaceRoot.replace(/\\/g, '/');

beforeAll(() => {
	vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
});

afterAll(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('path helpers', () => {
	it('normalises backslashes to forward slashes', () => {
		expect(getPathFromStr('C:\\repo\\sub\\file.txt')).toBe('C:/repo/sub/file.txt');
		expect(getPathFromUri(<never>vscodeMock.Uri.file('C:\\repo\\x'))).toBe('C:/repo/x');
		expect(pathWithTrailingSlash('/a/b')).toBe('/a/b/');
		expect(pathWithTrailingSlash('/a/b/')).toBe('/a/b/');
	});

	it('isPathInWorkspace accepts the workspace root itself and anything below it', () => {
		expect(isPathInWorkspace(workspacePath)).toBe(true);
		expect(isPathInWorkspace(workspacePath + '/nested/dir')).toBe(true);
		expect(isPathInWorkspace(workspacePath + '-sibling')).toBe(false);
		expect(isPathInWorkspace('/somewhere/else')).toBe(false);
	});

	it('isPathInWorkspace is false without any workspace folder', () => {
		const saved = vscodeMock.workspace.workspaceFolders;
		vscodeMock.workspace.workspaceFolders = undefined;
		try {
			expect(isPathInWorkspace(workspacePath)).toBe(false);
		} finally {
			vscodeMock.workspace.workspaceFolders = saved;
		}
	});

	it('realpath resolves an existing path and falls back to the input for a missing one', async () => {
		const resolved = await realpath(workspaceRoot);
		expect(resolved).toBe(fs.realpathSync(workspaceRoot).replace(/\\/g, '/'));
		const native = await realpath(workspaceRoot, true);
		expect(native).toBe(fs.realpathSync.native(workspaceRoot).replace(/\\/g, '/'));
		expect(await realpath('/definitely/not/here')).toBe('/definitely/not/here');
	});

	it('resolveToSymbolicPath maps canonical paths back onto the workspace folder', async () => {
		const canonical = await realpath(workspaceRoot);
		expect(await resolveToSymbolicPath(canonical)).toBe(workspacePath);
		expect(await resolveToSymbolicPath(canonical + '/child')).toBe(workspacePath + '/child');
		// A parent of the workspace folder maps back onto the same level of the symbolic path
		// (identical strings when the workspace path has no symbolic links, but on macOS the
		// temp dir lives below /var, which realpath resolves to /private/var)
		const parent = canonical.substring(0, canonical.lastIndexOf('/'));
		const symbolicParent = workspacePath.substring(0, workspacePath.lastIndexOf('/'));
		expect(await resolveToSymbolicPath(parent)).toBe(symbolicParent);
		expect(await resolveToSymbolicPath('/unrelated/path')).toBe('/unrelated/path');
	});

	it('doesFileExist reports readable files only', async () => {
		const file = path.join(workspaceRoot, 'exists.txt');
		fs.writeFileSync(file, 'x');
		expect(await doesFileExist(file)).toBe(true);
		expect(await doesFileExist(path.join(workspaceRoot, 'missing.txt'))).toBe(false);
	});

	it('getRepoName takes the last path component', () => {
		expect(getRepoName('/home/user/project')).toBe('project');
		expect(getRepoName('/home/user/project/')).toBe('project');
		expect(getRepoName('project')).toBe('project');
		expect(getRepoName('/')).toBe('/');
	});
});
