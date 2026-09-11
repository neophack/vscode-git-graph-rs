/**
 * The extension-host helpers in src/utils.ts (path normalisation, untrusted-input validation,
 * relative time, repository naming/sorting, the Visual Studio Code command wrappers, promise
 * pooling, Git executable discovery and version comparison) and the BufferedQueue in
 * src/utils/bufferedQueue.ts. Everything that touches the editor runs against the recording
 * `vscode` stub, so each wrapper is checked for both the command it issues and the ErrorInfo it
 * resolves to when the editor refuses.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createVscodeStub, installVscodeStub } from './vscodeStub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-utils-ws-'));
const workspacePath = workspaceRoot.replace(/\\/g, '/');
const vscode = createVscodeStub({ workspaceFolders: [{ path: workspaceRoot }] });
installVscodeStub(vscode);

const utils = await import('../out/utils.js');
const { t } = await import('../out/i18n.js');
const { BufferedQueue } = await import('../out/utils/bufferedQueue.js');
const { decodeDiffDocUri } = await import('../out/diffDocProvider.js');

/* Mirrors of the const enums (inlined by tsc, so not exported at runtime) */
const GitFileStatus = { Added: 'A', Modified: 'M', Deleted: 'D', Renamed: 'R', Untracked: 'U' };
const RepoDropdownOrder = { FullPath: 0, Name: 1, WorkspaceFullPath: 2 };
const PullRequestProvider = { Bitbucket: 0, Custom: 1, GitHub: 2, GitLab: 3 };

after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

describe('path helpers', () => {
	it('normalise backslashes to forward slashes', () => {
		assert.equal(utils.getPathFromStr('C:\\repo\\sub\\file.txt'), 'C:/repo/sub/file.txt');
		assert.equal(utils.getPathFromUri(vscode.Uri.file('C:\\repo\\x')), 'C:/repo/x');
		assert.equal(utils.pathWithTrailingSlash('/a/b'), '/a/b/');
		assert.equal(utils.pathWithTrailingSlash('/a/b/'), '/a/b/');
	});

	it('isPathInWorkspace accepts the workspace root itself and anything below it', () => {
		assert.equal(utils.isPathInWorkspace(workspacePath), true);
		assert.equal(utils.isPathInWorkspace(workspacePath + '/nested/dir'), true);
		assert.equal(utils.isPathInWorkspace(workspacePath + '-sibling'), false);
		assert.equal(utils.isPathInWorkspace('/somewhere/else'), false);
	});

	it('isPathInWorkspace is false without any workspace folder', () => {
		const saved = vscode.workspace.workspaceFolders;
		vscode.workspace.workspaceFolders = undefined;
		try {
			assert.equal(utils.isPathInWorkspace(workspacePath), false);
		} finally {
			vscode.workspace.workspaceFolders = saved;
		}
	});

	it('realpath resolves an existing path and falls back to the input for a missing one', async () => {
		const resolved = await utils.realpath(workspaceRoot);
		assert.equal(resolved, fs.realpathSync(workspaceRoot).replace(/\\/g, '/'));
		const native = await utils.realpath(workspaceRoot, true);
		assert.equal(native, fs.realpathSync.native(workspaceRoot).replace(/\\/g, '/'));
		assert.equal(await utils.realpath('/definitely/not/here'), '/definitely/not/here');
	});

	it('resolveToSymbolicPath maps canonical paths back onto the workspace folder', async () => {
		const canonical = await utils.realpath(workspaceRoot);
		assert.equal(await utils.resolveToSymbolicPath(canonical), workspacePath);
		assert.equal(await utils.resolveToSymbolicPath(canonical + '/child'), workspacePath + '/child');
		// A parent of the workspace folder resolves to itself (walking the symbolic path upwards)
		const parent = canonical.substring(0, canonical.lastIndexOf('/'));
		assert.equal(await utils.resolveToSymbolicPath(parent), parent);
		assert.equal(await utils.resolveToSymbolicPath('/unrelated/path'), '/unrelated/path');
	});

	it('doesFileExist reports readable files only', async () => {
		const file = path.join(workspaceRoot, 'exists.txt');
		fs.writeFileSync(file, 'x');
		assert.equal(await utils.doesFileExist(file), true);
		assert.equal(await utils.doesFileExist(path.join(workspaceRoot, 'missing.txt')), false);
	});
});

describe('general helpers', () => {
	it('abbreviates commits and text', () => {
		assert.equal(utils.abbrevCommit('0123456789abcdef'), '01234567');
		assert.equal(utils.abbrevText('short', 10), 'short');
		assert.equal(utils.abbrevText('a much longer string', 8), 'a much ...');
	});

	it('validates untrusted commit hashes, ref names and stash selectors', () => {
		assert.equal(utils.isValidCommitHash('abcd'), true);
		assert.equal(utils.isValidCommitHash('a'.repeat(40)), true);
		assert.equal(utils.isValidCommitHash('abc'), false);
		assert.equal(utils.isValidCommitHash('--exec=rm'), false);
		assert.equal(utils.isValidCommitHash(42), false);

		assert.equal(utils.isSafeRefName('feature/thing'), true);
		for (const bad of ['', '-x', '.hidden', 'a/', 'a.', 'a.lock', 'a\nb', 'a..b', 'a@{b', 'a\\b', 'a^b', 'a:b', 'a?b', 'a[b', 'a*b', 42]) {
			assert.equal(utils.isSafeRefName(bad), false, JSON.stringify(bad));
		}

		assert.equal(utils.isSafeStashSelector('refs/stash@{0}'), true);
		assert.equal(utils.isSafeStashSelector('stash@{0}'), false);
		assert.equal(utils.isSafeStashSelector('refs/stash@{x}'), false);
	});

	it('quotes shell arguments and encodes JSON for inline scripts', () => {
		assert.equal(utils.quoteShellArg("it's"), "'it'\\''s'");
		assert.equal(utils.encodeJsonForInlineScript('{"a":"</script><!--&\u2028\u2029"}'), '{"a":"\\u003C/script\\u003E\\u003C!--\\u0026\\u2028\\u2029"}');
	});

	it('getRelativeTimeDiff picks the largest whole unit and pluralises', () => {
		const now = Math.round(Date.now() / 1000);
		assert.equal(utils.getRelativeTimeDiff(now - 1), '1 second ago');
		assert.equal(utils.getRelativeTimeDiff(now - 30), '30 seconds ago');
		assert.equal(utils.getRelativeTimeDiff(now - 120), '2 minutes ago');
		assert.equal(utils.getRelativeTimeDiff(now - 3600), '1 hour ago');
		assert.equal(utils.getRelativeTimeDiff(now - 2 * 86400), '2 days ago');
		assert.equal(utils.getRelativeTimeDiff(now - 3 * 604800), '3 weeks ago');
		assert.equal(utils.getRelativeTimeDiff(now - 2 * 2629800), '2 months ago');
		assert.equal(utils.getRelativeTimeDiff(now - 5 * 31557600), '5 years ago');
	});

	it('getRelativeTimeDiff uses the Chinese units when the interface language is zh-cn', () => {
		vscode.settings.interfaceLanguage = 'zh-cn';
		try {
			const now = Math.round(Date.now() / 1000);
			assert.equal(utils.getRelativeTimeDiff(now - 120), '2 分钟前');
			assert.equal(utils.getRelativeTimeDiff(now - 2 * 2629800), '2 个月前');
		} finally {
			delete vscode.settings.interfaceLanguage;
		}
	});

	it('getExtensionVersion reads package.json and rejects when it is missing or malformed', async () => {
		const version = await utils.getExtensionVersion({ extensionPath: root });
		assert.match(version, /^\d+\.\d+\.\d+/);
		await assert.rejects(utils.getExtensionVersion({ extensionPath: path.join(workspaceRoot, 'nope') }));
		fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{not json');
		await assert.rejects(utils.getExtensionVersion({ extensionPath: workspaceRoot }));
	});

	it('getNonce is 32 alphanumeric characters and differs between calls', () => {
		const a = utils.getNonce(), b = utils.getNonce();
		assert.match(a, /^[A-Za-z0-9]{32}$/);
		assert.notEqual(a, b);
	});

	it('getRepoName takes the last path component', () => {
		assert.equal(utils.getRepoName('/home/user/project'), 'project');
		assert.equal(utils.getRepoName('/home/user/project/'), 'project');
		assert.equal(utils.getRepoName('project'), 'project');
		assert.equal(utils.getRepoName('/'), '/');
	});

	it('getSortedRepositoryPaths honours each dropdown order', () => {
		const repos = {
			'/w/b-repo': { name: null, workspaceFolderIndex: 1 },
			'/w/a-repo': { name: 'zed', workspaceFolderIndex: 0 },
			'/outside/c': { name: null, workspaceFolderIndex: null },
			'/w/a-repo/inner': { name: 'zed', workspaceFolderIndex: 0 }
		};
		assert.deepEqual(utils.getSortedRepositoryPaths(repos, RepoDropdownOrder.FullPath), ['/outside/c', '/w/a-repo', '/w/a-repo/inner', '/w/b-repo']);
		assert.deepEqual(utils.getSortedRepositoryPaths(repos, RepoDropdownOrder.WorkspaceFullPath), ['/w/a-repo', '/w/a-repo/inner', '/w/b-repo', '/outside/c']);
		assert.deepEqual(utils.getSortedRepositoryPaths(repos, RepoDropdownOrder.Name), ['/w/b-repo', '/outside/c', '/w/a-repo', '/w/a-repo/inner']);
	});
});

describe('Visual Studio Code command wrappers', () => {
	const repo = workspacePath + '/repo';
	before(() => fs.mkdirSync(path.join(workspaceRoot, 'repo', 'dir'), { recursive: true }));

	it('archive passes the chosen file to the DataSource, and reports bad extensions / cancellation', async () => {
		const archived = [];
		const dataSource = { archive: async (...args) => { archived.push(args); return null; } };

		vscode.responses.showSaveDialog = [vscode.Uri.file('/out/x.zip')];
		assert.equal(await utils.archive(repo, 'main', dataSource), null);
		assert.deepEqual(archived, [[repo, 'main', '/out/x.zip', 'zip']]);

		vscode.responses.showSaveDialog = [vscode.Uri.file('/out/x.rar')];
		assert.equal(await utils.archive(repo, 'main', dataSource), t('archiveInvalidExtension', 'rar'));

		vscode.responses.showSaveDialog = [undefined];
		assert.equal(await utils.archive(repo, 'main', dataSource), t('archiveNoFileName'));

		vscode.responses.showSaveDialog = [new Error('no dialog')];
		assert.equal(await utils.archive(repo, 'main', dataSource), t('archiveNoSaveDialog'));
	});

	it('copies to the clipboard (relative and absolute file paths) and reports write failures', async () => {
		vscode.resetCalls();
		assert.equal(await utils.copyFilePathToClipboard(repo, 'dir/file.txt', false), null);
		assert.equal(await utils.copyFilePathToClipboard(repo, 'dir/file.txt', true), null);
		assert.deepEqual(vscode.callsTo('clipboard.writeText').map((c) => c.args[0]), ['dir/file.txt', path.join(repo, 'dir/file.txt')]);

		vscode.responses['clipboard.writeText'] = [new Error('denied')];
		assert.equal(await utils.copyToClipboard('x'), t('clipboardWriteFailed'));
	});

	it('createPullRequest builds the provider-specific URL and opens it', async () => {
		const opened = () => vscode.callsTo('env.openExternal').map((c) => c.args[0].toString());
		const base = { hostRootUrl: 'https://host', destOwner: 'org', destRepo: 'repo', destProjectId: '', destBranch: 'main', custom: null };
		vscode.responses['env.openExternal'] = () => true;

		vscode.resetCalls();
		assert.equal(await utils.createPullRequest({ ...base, provider: PullRequestProvider.GitHub }, 'me', 'fork', 'feat'), null);
		assert.deepEqual(opened(), ['https://host/org/repo/compare/main...me:feat']);

		vscode.resetCalls();
		await utils.createPullRequest({ ...base, provider: PullRequestProvider.Bitbucket }, 'me', 'fork', 'feat');
		assert.deepEqual(opened(), ['https://host/me/fork/pull-requests/new?source=me/fork::feat&dest=org/repo::main']);

		vscode.resetCalls();
		await utils.createPullRequest({ ...base, provider: PullRequestProvider.GitLab }, 'me', 'fork', 'feat');
		assert.deepEqual(opened(), ['https://host/me/fork/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main']);

		vscode.resetCalls();
		await utils.createPullRequest({ ...base, provider: PullRequestProvider.GitLab, destProjectId: '77' }, 'me', 'fork', 'feat');
		assert.deepEqual(opened(), ['https://host/me/fork/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main&merge_request[target_project_id]=77']);

		vscode.resetCalls();
		await utils.createPullRequest({ ...base, provider: PullRequestProvider.Custom, custom: { templateUrl: '$1/pr/$4/$7/$8' }, destProjectId: '9' }, 'me', 'fork', 'feat');
		assert.deepEqual(opened(), ['https://host/pr/feat/9/main']);
	});

	it('openExternalUrl maps refusal, rejection and parse failures onto the localised error', async () => {
		vscode.responses['env.openExternal'] = [false, new Error('nope')];
		assert.equal(await utils.openExternalUrl('https://x'), t('openUrlFailed', t('externalUrlType'), 'https://x'));
		assert.equal(await utils.openExternalUrl('https://x', 'Custom'), t('openUrlFailed', 'Custom', 'https://x'));
		assert.equal(await utils.openExternalUrl('not a uri'), t('openUrlFailed', t('externalUrlType'), 'not a uri'));
		vscode.responses['env.openExternal'] = () => true;
	});

	it('openExtensionSettings and viewScm run the workbench commands and surface failures', async () => {
		vscode.resetCalls();
		assert.equal(await utils.openExtensionSettings(), null);
		assert.equal(await utils.viewScm(), null);
		assert.deepEqual(vscode.callsTo('executeCommand').map((c) => c.args), [['workbench.action.openSettings', '@ext:aucneon.git-graph-rs'], ['workbench.view.scm']]);

		vscode.responses['executeCommand:workbench.action.openSettings'] = [new Error('x')];
		vscode.responses['executeCommand:workbench.view.scm'] = [new Error('x')];
		assert.equal(await utils.openExtensionSettings(), t('openExtensionSettingsFailed'));
		assert.equal(await utils.viewScm(), t('openScmFailed'));
	});

	it('openFile opens existing files, follows renames via the DataSource and reports missing files', async () => {
		fs.writeFileSync(path.join(workspaceRoot, 'repo', 'dir', 'new.txt'), 'x');
		vscode.resetCalls();
		assert.equal(await utils.openFile(repo, 'dir/new.txt'), null);
		let open = vscode.callsTo('executeCommand')[0];
		assert.equal(open.args[0], 'vscode.open');
		assert.equal(open.args[1].fsPath, path.join(repo, 'dir/new.txt'));
		assert.deepEqual(open.args[2], { preview: true, viewColumn: vscode.ViewColumn.Active });

		vscode.resetCalls();
		assert.equal(await utils.openFile(repo, 'dir/new.txt', null, null, vscode.ViewColumn.Two), null);
		assert.equal(vscode.callsTo('executeCommand')[0].args[2].viewColumn, vscode.ViewColumn.Two);

		const dataSource = { getNewPathOfRenamedFile: async (_repo, _hash, filePath) => filePath === 'dir/old.txt' ? 'dir/new.txt' : null };
		vscode.resetCalls();
		assert.equal(await utils.openFile(repo, 'dir/old.txt', 'abc123', dataSource), null);
		assert.equal(vscode.callsTo('executeCommand')[0].args[1].fsPath, path.join(repo, 'dir/new.txt'));

		assert.equal(await utils.openFile(repo, 'dir/gone.txt', 'abc123', dataSource), t('fileNotInRepo', 'dir/gone.txt'));
		assert.equal(await utils.openFile(repo, 'dir/gone.txt'), t('fileNotInRepo', 'dir/gone.txt'));

		vscode.responses['executeCommand:vscode.open'] = [new Error('x')];
		assert.equal(await utils.openFile(repo, 'dir/new.txt'), t('openFileFailed', 'dir/new.txt'));
	});

	it('resolveDiffFromHash expands the uncommitted / same-commit shorthands', () => {
		assert.equal(utils.resolveDiffFromHash('*', 'abc'), 'HEAD');
		assert.equal(utils.resolveDiffFromHash('*', '*'), 'HEAD'); // working tree against HEAD
		assert.equal(utils.resolveDiffFromHash('abc', 'abc'), 'abc^');
		assert.equal(utils.resolveDiffFromHash('abc', 'def'), 'abc');
	});

	it('viewDiff issues vscode.diff with the encoded revisions and a descriptive title', async () => {
		const from = '1111111111111111111111111111111111111111', to = '2222222222222222222222222222222222222222';
		const diffTitle = async (fromHash, toHash, type) => {
			vscode.resetCalls();
			assert.equal(await utils.viewDiff(repo, fromHash, toHash, 'dir/old.txt', 'dir/file.txt', type), null);
			const call = vscode.callsTo('executeCommand')[0];
			assert.equal(call.args[0], 'vscode.diff');
			return call;
		};

		let call = await diffTitle(from, to, GitFileStatus.Modified);
		assert.equal(call.args[3], 'file.txt (' + t('diffTitleChanged', '11111111', '22222222') + ')');
		assert.deepEqual(decodeDiffDocUri(call.args[1]), { filePath: 'dir/old.txt', commit: from, repo, exists: true });
		assert.deepEqual(decodeDiffDocUri(call.args[2]), { filePath: 'dir/file.txt', commit: to, repo, exists: true });

		call = await diffTitle(from, to, GitFileStatus.Added);
		assert.equal(call.args[3], 'file.txt (' + t('diffTitleAddedBetween', '11111111', '22222222') + ')');
		assert.equal(decodeDiffDocUri(call.args[1]).exists, false);

		call = await diffTitle(from, to, GitFileStatus.Deleted);
		assert.equal(call.args[3], 'file.txt (' + t('diffTitleDeletedBetween', '11111111', '22222222') + ')');
		assert.equal(decodeDiffDocUri(call.args[2]).exists, false);

		call = await diffTitle(to, to, GitFileStatus.Modified);
		assert.equal(call.args[3], 'file.txt (' + t('diffTitleChangedWithParent', '22222222', '22222222') + ')');
		assert.equal(decodeDiffDocUri(call.args[1]).commit, to + '^');

		call = await diffTitle(to, to, GitFileStatus.Added);
		assert.equal(call.args[3], 'file.txt (' + t('diffTitleAddedIn', '22222222') + ')');
		call = await diffTitle(to, to, GitFileStatus.Deleted);
		assert.equal(call.args[3], 'file.txt (' + t('diffTitleDeletedIn', '22222222') + ')');

		call = await diffTitle('*', '*', GitFileStatus.Modified);
		assert.equal(call.args[3], 'file.txt (' + t('diffTitleUncommitted') + ')');
		assert.equal(call.args[2].scheme, 'file'); // the working file itself

		call = await diffTitle(from, '*', GitFileStatus.Modified);
		assert.equal(call.args[3], 'file.txt (' + t('diffTitleChanged', '11111111', t('diffTitlePresent')) + ')');

		vscode.responses['executeCommand:vscode.diff'] = [new Error('x')];
		assert.equal(await utils.viewDiff(repo, from, to, 'dir/old.txt', 'dir/file.txt', GitFileStatus.Modified), t('diffEditorFailed', 'dir/file.txt'));
	});

	it('viewDiff opens untracked files directly instead of diffing them', async () => {
		vscode.resetCalls();
		assert.equal(await utils.viewDiff(repo, '*', '*', 'dir/new.txt', 'dir/new.txt', GitFileStatus.Untracked), null);
		assert.equal(vscode.callsTo('executeCommand')[0].args[0], 'vscode.open');
	});

	it('viewDiffWithWorkingFile classifies the change by whether the working file (or its rename) exists', async () => {
		const hash = '3333333333333333333333333333333333333333';
		const dataSource = { getNewPathOfRenamedFile: async (_repo, _hash, filePath) => filePath === 'dir/renamed-from.txt' ? 'dir/new.txt' : null };
		const run = async (filePath) => {
			vscode.resetCalls();
			assert.equal(await utils.viewDiffWithWorkingFile(repo, hash, filePath, dataSource), null);
			return vscode.callsTo('executeCommand')[0];
		};

		let call = await run('dir/new.txt');
		assert.equal(call.args[3], 'new.txt (' + t('diffTitleChanged', '33333333', t('diffTitlePresent')) + ')');

		call = await run('dir/renamed-from.txt');
		assert.deepEqual(decodeDiffDocUri(call.args[1]).filePath, 'dir/renamed-from.txt');
		assert.equal(call.args[2].fsPath, path.join(repo, 'dir/new.txt'));

		call = await run('dir/deleted.txt');
		assert.equal(call.args[3], 'deleted.txt (' + t('diffTitleDeletedBetween', '33333333', t('diffTitlePresent')) + ')');
		assert.equal(decodeDiffDocUri(call.args[2]).exists, false);
	});

	it('viewFileAtRevision opens a readonly revision document titled with the abbreviated hash', async () => {
		vscode.resetCalls();
		assert.equal(await utils.viewFileAtRevision(repo, '4444444444444444444444444444444444444444', 'dir/file.txt'), null);
		const call = vscode.callsTo('executeCommand')[0];
		assert.equal(call.args[0], 'vscode.open');
		assert.equal(call.args[1].scheme, 'git-graph-rs');
		assert.equal(call.args[1].path, '44444444: file.txt');
		assert.deepEqual(decodeDiffDocUri(call.args[1]), { filePath: 'dir/file.txt', commit: '4444444444444444444444444444444444444444', repo, exists: true });

		vscode.responses['executeCommand:vscode.open'] = [new Error('x')];
		assert.equal(await utils.viewFileAtRevision(repo, '4444444444444444444444444444444444444444', 'dir/file.txt'), t('viewFileAtRevisionFailed', 'dir/file.txt', '44444444'));
	});

	it('openGitTerminal adds the Git directory to PATH, runs the command and honours the configured shell', () => {
		const sep = process.platform === 'win32' ? ';' : ':';
		vscode.terminals.length = 0;
		utils.openGitTerminal('/repo', '/opt/git/bin/git', 'rebase -i HEAD~3', 'Rebase');
		let terminal = vscode.terminals[0];
		assert.equal(terminal.options.cwd, '/repo');
		assert.equal(terminal.options.name, t('terminalName', 'Rebase'));
		assert.ok(terminal.options.env.PATH.endsWith(sep + path.dirname('/opt/git/bin/git')), terminal.options.env.PATH);
		assert.equal(terminal.options.shellPath, undefined);
		assert.deepEqual(terminal.sent, ['git rebase -i HEAD~3']);
		assert.equal(terminal.shown, 1);

		vscode.settings.integratedTerminalShell = '/bin/zsh';
		try {
			utils.openGitTerminal('/repo', '/opt/git/bin/git', null, 'Shell');
		} finally {
			delete vscode.settings.integratedTerminalShell;
		}
		terminal = vscode.terminals[1];
		assert.equal(terminal.options.shellPath, '/bin/zsh');
		assert.deepEqual(terminal.sent, []);
	});

	it('showInformationMessage / showErrorMessage swallow editor failures', async () => {
		vscode.responses.showInformationMessage = [new Error('x')];
		vscode.responses.showErrorMessage = [new Error('x')];
		assert.equal(await utils.showInformationMessage('hello'), undefined);
		assert.equal(await utils.showErrorMessage('oops'), undefined);
		assert.equal(vscode.callsTo('showInformationMessage').at(-1).args[0], 'hello');
		assert.equal(vscode.callsTo('showErrorMessage').at(-1).args[0], 'oops');
	});
});

describe('evalPromises', () => {
	it('resolves an empty and a single-element input', async () => {
		assert.deepEqual(await utils.evalPromises([], 2, async (x) => x), []);
		assert.deepEqual(await utils.evalPromises([7], 2, async (x) => x * 2), [14]);
		await assert.rejects(utils.evalPromises([1], 2, async () => { throw new Error('x'); }));
	});

	it('keeps at most maxParallel promises in flight and preserves the input order', async () => {
		let inFlight = 0, peak = 0;
		const result = await utils.evalPromises([5, 1, 4, 2, 3], 2, (value) => new Promise((resolve) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			setTimeout(() => { inFlight--; resolve(value * 10); }, value);
		}));
		assert.deepEqual(result, [50, 10, 40, 20, 30]);
		assert.equal(peak, 2);
	});

	it('rejects as soon as one promise rejects, and tolerates an invalid parallelism', async () => {
		await assert.rejects(utils.evalPromises([1, 2, 3], 3, async (v) => { if (v === 2) throw new Error('x'); return v; }));
		assert.deepEqual(await utils.evalPromises([1, 2, 3], 0, async (v) => v), [1, 2, 3]);
		assert.deepEqual(await utils.evalPromises([1, 2], Infinity, async (v) => v), [1, 2]);
	});
});

describe('resolveSpawnOutput', () => {
	function fakeProcess() {
		const proc = new EventEmitter();
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		return proc;
	}

	it('collects the exit code, stdout and stderr', async () => {
		const proc = fakeProcess();
		const pending = utils.resolveSpawnOutput(proc);
		proc.stdout.emit('data', Buffer.from('out'));
		proc.stdout.emit('data', Buffer.from('put'));
		proc.stderr.emit('data', 'warn');
		proc.emit('exit', 0);
		proc.emit('error', new Error('ignored after exit'));
		proc.stdout.emit('close');
		proc.stderr.emit('close');
		const [status, stdout, stderr] = await pending;
		assert.deepEqual(status, { code: 0, error: null });
		assert.equal(stdout.toString(), 'output');
		assert.equal(stderr, 'warn');
	});

	it('reports a spawn error with code -1', async () => {
		const proc = fakeProcess();
		const pending = utils.resolveSpawnOutput(proc);
		const error = new Error('ENOENT');
		proc.emit('error', error);
		proc.emit('exit', 1);
		proc.stdout.emit('close');
		proc.stderr.emit('close');
		const [status] = await pending;
		assert.deepEqual(status, { code: -1, error });
	});
});

describe('Git executable discovery', () => {
	it('getGitExecutable resolves a real git and rejects a command that fails', async () => {
		const executable = await utils.getGitExecutable('git');
		assert.equal(executable.path, 'git');
		assert.match(executable.version, /^\d+\.\d+/);
		await assert.rejects(utils.getGitExecutable(path.join(workspaceRoot, 'no-such-git')));
	});

	it('getGitExecutableFromPaths returns the first working path and throws when none work', async () => {
		const executable = await utils.getGitExecutableFromPaths([path.join(workspaceRoot, 'no-such-git'), 'git']);
		assert.equal(executable.path, 'git');
		await assert.rejects(utils.getGitExecutableFromPaths([path.join(workspaceRoot, 'no-such-git')]), /None of the provided paths/);
	});

	it('findGit prefers the last known path, then the git.path setting, then the platform search', async () => {
		const state = (lastKnownPath) => ({ getLastKnownGitPath: () => lastKnownPath });

		assert.equal((await utils.findGit(state('git'))).path, 'git');

		vscode.settings['git.path'] = 'git';
		assert.equal((await utils.findGit(state(path.join(workspaceRoot, 'no-such-git')))).path, 'git');
		vscode.settings['git.path'] = ['git'];
		assert.equal((await utils.findGit(state(null))).path, 'git');
		delete vscode.settings['git.path'];

		// Nothing configured: the platform search must still locate the git on PATH
		const found = await utils.findGit(state(null));
		assert.match(found.version, /^\d+\.\d+/);
	});
});

describe('version requirements', () => {
	it('doesVersionMeetRequirement compares major, minor and patch', () => {
		assert.equal(utils.doesVersionMeetRequirement('2.17.0', '2.17.0'), true);
		assert.equal(utils.doesVersionMeetRequirement('2.17.1', '2.17.0'), true);
		assert.equal(utils.doesVersionMeetRequirement('2.16.9', '2.17.0'), false);
		assert.equal(utils.doesVersionMeetRequirement('3.0.0', '2.17.0'), true);
		assert.equal(utils.doesVersionMeetRequirement('1.99.99', '2.17.0'), false);
		assert.equal(utils.doesVersionMeetRequirement('2.18', '2.17.0'), true);
		assert.equal(utils.doesVersionMeetRequirement('2', '2.17.0'), false);
		assert.equal(utils.doesVersionMeetRequirement('2.17.0.windows.1', '2.17.0'), true);
		assert.equal(utils.doesVersionMeetRequirement('2.17.0', '2.17.1'), false);
		assert.equal(utils.doesVersionMeetRequirement('2.18.0', '2.17.5'), true);
		assert.equal(utils.doesVersionMeetRequirement('2.16.0', '2.17.5'), false);
		// Unparseable versions are assumed compatible
		assert.equal(utils.doesVersionMeetRequirement('unknown', '2.17.0'), true);
	});

	it('constructIncompatibleGitVersionMessage names the feature when given', () => {
		const executable = { path: 'git', version: '2.10.0' };
		assert.equal(utils.constructIncompatibleGitVersionMessage(executable, '2.17.0'), t('incompatibleGitVersion', '2.17.0', t('thisFeature'), '2.10.0'));
		assert.equal(utils.constructIncompatibleGitVersionMessage(executable, '2.17.0', 'Fetch'), t('incompatibleGitVersion', '2.17.0', 'Fetch', '2.10.0'));
	});
});

describe('BufferedQueue', () => {
	const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	it('buffers items, de-duplicates them, and calls onChanges once when any item changed', async () => {
		const processed = [];
		let changes = 0;
		const queue = new BufferedQueue(async (item) => { processed.push(item); return item !== 'b'; }, () => changes++, 20);
		queue.enqueue('a');
		queue.enqueue('b');
		queue.enqueue('a'); // moves 'a' to the back rather than duplicating it
		queue.enqueue(''); // falsy items must still be processed
		await tick(60);
		assert.deepEqual(processed, ['b', 'a', '']);
		assert.equal(changes, 1);
		queue.dispose();
	});

	it('does not call onChanges when nothing changed', async () => {
		let changes = 0;
		const queue = new BufferedQueue(async () => false, () => changes++, 10);
		queue.enqueue(1);
		await tick(40);
		assert.equal(changes, 0);
		queue.dispose();
	});

	it('items enqueued while processing are handled in the same run', async () => {
		const processed = [];
		let queue;
		queue = new BufferedQueue(async (item) => {
			processed.push(item);
			if (item === 1) queue.enqueue(2);
			await tick(5);
			return true;
		}, () => {}, 10);
		queue.enqueue(1);
		await tick(60);
		assert.deepEqual(processed, [1, 2]);
		queue.dispose();
	});

	it('dispose cancels a pending buffer timeout', async () => {
		const processed = [];
		const queue = new BufferedQueue(async (item) => { processed.push(item); return true; }, () => {}, 10);
		queue.enqueue('x');
		queue.dispose();
		await tick(40);
		assert.deepEqual(processed, []);
	});
});
