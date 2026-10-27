import { AutomationAction, AutomationMode } from './catalog';

/**
 * The run context: the `{{placeholder}}` values (commit, branch, tag, stash, file, ...) an
 * action's UI steps / requests / command arguments are expanded with, resolved from LIVE
 * repository state right before the run starts. The resolution reads through the same hard
 * probes the engine's state queries use, expressed here as the {@link ContextProbes} seam so the
 * context builder is testable and the server keeps the only pipeline-coupled implementation.
 */

/** The slice of a loadRepoInfo response the placeholder resolution reads. */
export interface RepoInfoState {
	readonly head?: string | null;
	readonly branches?: readonly string[];
	readonly remotes?: readonly string[];
	readonly stashes?: readonly { readonly selector: string }[];
}

/** The slice of one commit of a loadCommits response the placeholder resolution reads. */
export interface CommitState {
	readonly hash: string;
	readonly parents?: readonly string[];
	readonly message: string;
	readonly author?: string;
	readonly stash?: { readonly selector: string } | null;
	readonly heads?: readonly string[];
	readonly tags?: readonly { readonly name: string; readonly annotated: boolean }[];
}

/** One file change of a commitDetails response. */
export interface FileChangeState {
	readonly type: string;
	readonly additions: number | null;
	readonly deletions: number | null;
	readonly newFilePath: string;
}

/** The slice of a commitDetails response the placeholder resolution reads. */
export interface CommitDetailsState {
	readonly fileChanges?: readonly FileChangeState[];
}

/** The live-state reads the context builder and the post-run verify resolve through. */
export interface ContextProbes {
	viewState(): { currentRepo: string | null; repos: readonly string[] };
	workingTreeFileExists(context: Record<string, string>): boolean;
	queryRepoInfo(repo: string): Promise<RepoInfoState>;
	queryCommits(repo: string, maxCommits: number): Promise<readonly CommitState[]>;
	queryCommitDetails(repo: string, commitHash: string): Promise<CommitDetailsState | null>;
}

/** Does any path of the action reference the placeholder? */
export function references(action: AutomationAction, name: string): boolean {
	const needle = '{{' + name + '}}';
	if (JSON.stringify(action.ui ?? []).indexOf(needle) !== -1
		|| JSON.stringify(action.uiAfter ?? []).indexOf(needle) !== -1
		|| JSON.stringify(action.request ?? []).indexOf(needle) !== -1) return true;
	// Command-mode argument shapes build their values from the context without a template:
	// every shape but the repository-root one carries a file, and the diff-document URI also
	// carries a commit.
	if (action.vscodeCommand !== undefined) {
		const arg = action.vscodeCommand.arg;
		if (name === 'file' && arg !== undefined && arg.kind !== 'rootUri') return true;
		if (name === 'commit' && arg !== undefined && arg.kind === 'diffUri') return true;
	}
	return false;
}

/** Flatten run params into string placeholders (non-string values serialise as JSON). */
export function stringifyParams(params: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(params)) {
		if (key === 'timeoutMs' || key === 'mode' || key === 'id') continue;
		out[key] = typeof value === 'string' ? value : JSON.stringify(value);
	}
	return out;
}

/** Build the placeholder context for an action from live repository state. */
export async function buildContext(
	probes: ContextProbes,
	action: AutomationAction,
	params: Record<string, unknown>,
	mode: AutomationMode
): Promise<Record<string, string>> {
	const state = probes.viewState();
	const repo = typeof params.repo === 'string' ? params.repo : state.currentRepo;
	if (typeof repo !== 'string' || repo === '') throw new Error('No repository is active in the Git Graph view');
	const context: Record<string, string> = { repo, ...stringifyParams(params) };
	context.reposCount = String(state.repos.length);

	const repoInfo = await probes.queryRepoInfo(repo);
	context.head = repoInfo.head ?? '';
	const branches: readonly string[] = repoInfo.branches ?? [];
	const localBranches: string[] = branches.filter((b) => b.indexOf('remotes/') !== 0);
	context.branch = localBranches.find((b) => b !== repoInfo.head) ?? localBranches[0] ?? '';
	// On a detached HEAD there is no checked-out branch name; any local branch still labels
	// a row the flows can reveal, so fall back to the first one.
	context.branchHead = repoInfo.head ?? localBranches[0] ?? '';
	context.branchCount = String(branches.length);
	// ResponseLoadRepoInfo carries remote NAMES only; remote-tracking branches appear in
	// `branches` as `remotes/<remote>/<branch>`.
	const remotes: readonly string[] = repoInfo.remotes ?? [];
	context.remote = remotes[0] ?? '';
	const remotePrefix = context.remote === '' ? '' : 'remotes/' + context.remote + '/';
	const remoteBranchFull = remotePrefix === '' ? '' : branches.find((b) => b.indexOf(remotePrefix) === 0) ?? '';
	context.remoteBranch = remoteBranchFull === '' ? '' : remoteBranchFull.slice(remotePrefix.length);
	if (references(action, 'stash')) {
		// UI mode right-clicks the rendered stash label, which only exists for a stash inside
		// the loaded graph — the reflog can hold stashes far older than the loaded page (real
		// repositories), so resolve the placeholder from the same probed page the view renders
		// and let requires:['stash'] skip cleanly. Request mode addresses the host directly,
		// where every recorded stash is reachable regardless of what the view loaded.
		if (mode === 'request') {
			context.stash = (repoInfo.stashes ?? [])[0]?.selector ?? '';
		} else {
			const probed = await probes.queryCommits(repo, 300);
			context.stash = probed.find((commit) => commit.stash !== null)?.stash?.selector ?? '';
		}
	}

	if (references(action, 'commit') || references(action, 'commitParent') || references(action, 'file')
		|| references(action, 'commitSubject')
		|| references(action, 'author') || references(action, 'findQuery')
		|| references(action, 'tag') || references(action, 'annotatedTag')
		|| references(action, 'binaryFile') || references(action, 'binaryCommit') || references(action, 'binaryCommitParent')
		|| references(action, 'imageFile') || references(action, 'imageCommit') || references(action, 'imageCommitParent')) {
		// A deeper page when tags are in play: they often sit further down the history than
		// the commits the other placeholders need (the fixture's first tag is ~100 deep).
		const wantsTags = references(action, 'tag') || references(action, 'annotatedTag');
		const commits = await probes.queryCommits(repo, wantsTags ? 300 : 100);
		const pick = commits.find((c) => c.hash !== repoInfo.head) ?? commits[0];
		context.commit = pick?.hash ?? '';
		context.commitParent = pick?.parents?.[0] ?? '';
		// The subject (first line of the message) — the text the rendered row's description cell
		// must show, so a text assertion can hold the view against the repository's own data.
		context.commitSubject = (pick?.message ?? '').split('\n')[0].trim();
		if (references(action, 'author')) context.author = pick?.author ?? '';

		// A find query guaranteed to match: the first branch label of the loaded page (the
		// newest commits render first); fall back to the checked-out branch, any branch, and
		// finally the context commit's abbreviated hash.
		let findQuery = '';
		for (const commit of commits) {
			const headLabel = (commit.heads ?? [])[0];
			if (headLabel !== undefined) { findQuery = headLabel; break; }
		}
		if (findQuery === '') findQuery = context.branchHead;
		if (findQuery === '') findQuery = context.branch;
		if (findQuery === '') findQuery = (context.commit ?? '').slice(0, 8);
		context.findQuery = findQuery;

		// Tags of the loaded graph, newest first; annotated ones are marked (GitCommitTag).
		context.tag = '';
		context.annotatedTag = '';
		for (const commit of commits) {
			for (const tag of commit.tags ?? []) {
				if (context.tag === '') context.tag = tag.name;
				if (context.annotatedTag === '' && tag.annotated === true) context.annotatedTag = tag.name;
			}
		}

		if (references(action, 'file') && context.commit !== '') {
			// Prefer a commit whose file change satisfies every Commit Details menu condition
			// (a Modified, non-binary file: deletions hide "Open File", binaries hide the
			// working-file diff); probe past empty commits before settling for any file.
			const usable = (file: FileChangeState) =>
				file.type === 'M' && (file.additions !== null || file.deletions !== null);
			const candidates = commits.filter((c) => c.hash !== repoInfo.head).slice(0, 5);
			if (candidates.length === 0 && commits.length > 0) candidates.push(commits[0]);
			let fallback: { hash: string; parent: string; file: string } | null = null;
			for (const candidate of candidates) {
				const changes = (await probes.queryCommitDetails(repo, candidate.hash))?.fileChanges ?? [];
				if (changes.length === 0) continue;
				const good = changes.find(usable);
				if (good !== undefined) {
					context.commit = candidate.hash;
					context.commitParent = candidate.parents?.[0] ?? '';
					context.commitSubject = candidate.message.split('\n')[0].trim();
					context.file = good.newFilePath;
					break;
				}
				if (fallback === null) {
					const anyExisting = changes.find((file) => file.type !== 'D') ?? changes[0];
					fallback = { hash: candidate.hash, parent: candidate.parents?.[0] ?? '', file: anyExisting.newFilePath };
				}
			}
			if (context.file === undefined && fallback !== null) {
				context.commit = fallback.hash;
				context.commitParent = fallback.parent;
				context.commitSubject = (commits.find((c) => c.hash === fallback.hash)?.message ?? '').split('\n')[0].trim();
				context.file = fallback.file;
			}
			context.file = context.file ?? '';
		}

		if (action.vscodeCommand !== undefined && action.vscodeCommand.arg?.kind === 'diffUri') {
			// The `openFile` command opens the WORKING-TREE file, but the generic picker above
			// prefers a commit ≠ HEAD whose file need not exist at HEAD (the fixture resolves
			// to local-ahead's added-only note). Re-target to a Modified file of the loaded
			// page that exists on disk, so the command has something real to open.
			const candidates10 = commits.slice(0, 10);
			if (!probes.workingTreeFileExists(context)) {
				for (const candidate of candidates10) {
					const changes = (await probes.queryCommitDetails(repo, candidate.hash))?.fileChanges ?? [];
					const existing = changes.find((file) =>
						file.type === 'M' && probes.workingTreeFileExists({ repo, file: file.newFilePath }));
					if (existing === undefined) continue;
					context.commit = candidate.hash;
					context.commitParent = candidate.parents?.[0] ?? '';
					context.file = existing.newFilePath;
					break;
				}
			}
		}

		if (references(action, 'binaryFile') || references(action, 'binaryCommit') || references(action, 'binaryCommitParent')
			|| references(action, 'imageFile') || references(action, 'imageCommit') || references(action, 'imageCommitParent')) {
			// Two independent binary scenarios the fixture seeds near HEAD (fixture.mjs's
			// specialAt commits): a plain binary file and a real decodable image, each added
			// then modified. Separate from `file`/`commit` above (which always prefers a
			// non-binary change) so an action can ask for either kind explicitly, to drive the
			// binary/image compare view (binaryCompareView.ts / comparisonView.ts) instead of
			// the text diff.
			const isImagePath = (filePath: string) => /\.(png|jpe?g|gif|bmp|webp|ico|avif|svg)$/i.test(filePath);
			context.binaryFile = ''; context.binaryCommit = ''; context.binaryCommitParent = '';
			context.imageFile = ''; context.imageCommit = ''; context.imageCommitParent = '';
			for (const candidate of commits) {
				if (candidate.hash === repoInfo.head) continue;
				if (context.binaryFile !== '' && context.imageFile !== '') break;
				const changes = (await probes.queryCommitDetails(repo, candidate.hash))?.fileChanges ?? [];
				const binary = changes.find((file) =>
					file.type === 'M' && file.additions === null && file.deletions === null);
				if (binary === undefined) continue;
				if (isImagePath(binary.newFilePath)) {
					if (context.imageFile === '') {
						context.imageFile = binary.newFilePath;
						context.imageCommit = candidate.hash;
						context.imageCommitParent = candidate.parents?.[0] ?? '';
					}
				} else if (context.binaryFile === '') {
					context.binaryFile = binary.newFilePath;
					context.binaryCommit = candidate.hash;
					context.binaryCommitParent = candidate.parents?.[0] ?? '';
				}
			}
		}
	}
	return context;
}
