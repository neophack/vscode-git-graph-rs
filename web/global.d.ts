import * as GG from '../out/types'; // Import types from back-end (requires `npm run compile-src`)

declare global {

	/* Visual Studio Code API Types */

	function acquireVsCodeApi(): {
		getState: () => WebViewState | null,
		postMessage: (message: GG.RequestMessage) => void,
		setState: (state: WebViewState) => void
	};


	/* State Types */

	type Config = GG.GitGraphViewConfig;

	const initialState: GG.GitGraphViewInitialState;
	const globalState: GG.DeepReadonly<GG.GitGraphViewGlobalState>;
	const workspaceState: GG.DeepReadonly<GG.GitGraphViewWorkspaceState>;

	type AvatarImageCollection = { [email: string]: string };

	interface ExpandedCommit {
		index: number;
		commitHash: string;
		commitElem: HTMLElement | null;
		compareWithHash: string | null;
		compareWithElem: HTMLElement | null;
		commitDetails: GG.GitCommitDetails | null;
		fileChanges: ReadonlyArray<GG.GitFileChange> | null;
		fileTree: FileTreeFolder | null;
		avatar: string | null;
		codeReview: GG.CodeReview | null;
		lastViewedFile: string | null;
		loading: boolean;
		/**
		 * TRUE once the entrance (fade-in) animation has played for this open commit. A CSS
		 * animation tied to `#cdv`'s connection to the document restarts whenever the element is
		 * disconnected and reconnected - which a table rebuild does even when the SAME element
		 * reference is carefully preserved and reinserted (see renderTable's cdvElem handling). Once
		 * `entered` is true, `renderCommitDetailsView` suppresses the animation via an inline style
		 * on every subsequent render of the same open commit, so a background refresh - however it
		 * happens to be implemented - can never make the panel visibly "flash" again.
		 */
		entered: boolean;
		/**
		 * The deferred `+N/-M` line counts of the file list. The details arrive without them (every
		 * file costs two blob reads, which dominates the load of a many-file commit); the paths
		 * near the viewport are settled first and the rest are filled in by background batches.
		 */
		lineCounts: LineCountsState;
		scrollTop: {
			summary: number,
			fileView: number
		};
		contextMenuOpen: {
			summary: boolean,
			fileView: number
		};
	}

	/** The deferred-counts state of an open Commit Details / Commit Comparison view. */
	interface LineCountsState {
		/** The paths whose counts have not been settled yet; null before the file list arrives. */
		pending: Set<string> | null;
		/** The paths already asked for, so a scroll never asks twice. */
		requested: Set<string>;
		/** The remaining paths, in list order, waiting for a background batch. */
		queue: string[];
		/** Path → index into the file list, built once per file list. */
		byPath: Map<string, number> | null;
		/** True while a background batch is in flight. */
		chunkInFlight: boolean;
		/** The debounce timer of a scroll-triggered viewport request. */
		scrollTimer: number;
	}

	interface WebViewState {
		readonly currentRepo: string;
		readonly currentRepoLoading: boolean;
		readonly gitRepos: GG.GitRepoSet;
		readonly gitBranches: ReadonlyArray<string>;
		readonly gitBranchHead: string | null;
		readonly gitConfig: GG.GitRepoConfig | null;
		readonly gitRemotes: ReadonlyArray<string>;
		readonly gitStashes: ReadonlyArray<GG.GitStash>;
		readonly gitTags: ReadonlyArray<string>;
		readonly commitHead: string | null;
		readonly currentBranches: string[] | null;
		readonly currentAuthors: string[] | null;
		readonly moreCommitsAvailable: boolean;
		readonly maxCommits: number;
		readonly onlyFollowFirstParent: boolean;
		readonly scrollTop: number;
		readonly findWidget: FindWidgetState;
		readonly settingsWidget: SettingsWidgetState;
		readonly commitPathFilter?: string | null; // only show commits that modified the file(s) at this path
		readonly compareSourceHash?: string | null; // the commit selected via "Select for Compare"
	}


	/* Commit Details / Comparison View File Tree Types */

	interface FileTreeFile {
		readonly type: 'file';
		readonly name: string;
		readonly index: number;
		reviewed: boolean;
	}

	interface FileTreeRepo {
		readonly type: 'repo';
		readonly name: string;
		readonly path: string;
	}

	interface FileTreeFolder {
		readonly type: 'folder';
		readonly name: string;
		readonly folderPath: string;
		readonly contents: FileTreeFolderContents;
		open: boolean;
		reviewed: boolean;
	}

	type FileTreeLeaf = FileTreeFile | FileTreeRepo;
	type FileTreeNode = FileTreeFolder | FileTreeLeaf;
	type FileTreeFolderContents = { [name: string]: FileTreeNode };


	/* Dialog & ContextMenu shared base Target interfaces */

	const enum TargetType {
		Commit = 'commit',
		CommitDetailsView = 'cdv',
		Ref = 'ref',
		Repo = 'repo'
	}

	interface CommitOrRefTarget {
		type: TargetType.Commit | TargetType.Ref | TargetType.CommitDetailsView;
		elem: HTMLElement;
	}

	interface RepoTarget {
		type: TargetType.Repo;
	}

	interface CommitTarget extends CommitOrRefTarget {
		hash: string;
	}

	interface RefTarget extends CommitTarget {
		ref: string;
	}
}

export as namespace GG;
export = GG;
