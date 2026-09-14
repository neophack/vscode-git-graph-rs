//! The public interface of `git-graph-core` as a library: **one type, one file**.
//!
//! Everything a host (the VS Code extension's Node addon, Git Graph Studio, a CLI, your own
//! program) needs is on [`Engine`]. The modules behind it (`graph`, `log`, `status`, `diff`,
//! `blob`, …) stay public for callers that need the finer grain, but a new integration should
//! not have to read them: this file is the contract, and it is kept small and stable.
//!
//! ```no_run
//! use git_graph_core::api::{Engine, GraphOptions};
//!
//! let engine = Engine::open("/path/inside/a/repository")?;
//! let page = engine.graph(&GraphOptions::default())?;
//! for commit in &page.commits {
//!     println!("{} {}", &commit.hash[..7], commit.message);
//! }
//! for change in engine.status()? {
//!     println!("{:?} {}", change.staged, change.path);
//! }
//! # Ok::<(), git_graph_core::Error>(())
//! ```
//!
//! Design rules for this surface:
//! - **Read-only.** The engine never writes to the repository and never spawns `git`. Writes
//!   (commit, push, checkout, …) are the host's business, through the git CLI or its own code.
//! - **Plain data in, plain data out.** Every result type derives `Serialize`, so it can cross
//!   any boundary (JSON over IPC, NAPI, a Tauri command) unchanged.
//! - **Warm handles.** [`Engine::open`] goes through the process-wide [`RepoManager`], so opening
//!   the same repository twice shares one parsed object database and one ref cache.
//! - **Every call is safe to run from any thread**; the engine takes care of its own locking.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use crate::error::Result;
use crate::repository::{Repo, RepoManager};
use crate::status::ScmChange;
use crate::types::{
    CommitFile, CommitOrdering, ConfigSnapshot, GitActivityCell, GitAuthor, GitAuthorStat,
    GitCommitData, GitCommitDetails, GitFileChange, GitHistoryMatch, GitRepoInfo, GitStash,
    GitTagDetails, LogOptions, RefReadOptions, RefSnapshot,
};

/// How a graph page is loaded. `Default` is the view's own default request: every local
/// branch, tag and remote-tracking branch, 300 commits, commit-date order.
#[derive(Debug, Clone)]
pub struct GraphOptions {
    /// The branch names to walk from, or `None` for all refs.
    pub branches: Option<Vec<String>>,
    /// Only commits by one of these author names.
    pub authors: Option<Vec<String>>,
    /// Page size; `more_commits_available` on the result says whether a larger page would grow.
    pub max_commits: u32,
    pub show_tags: bool,
    pub show_remote_branches: bool,
    /// Follow only the first parent of merges (`git log --first-parent`).
    pub first_parent_only: bool,
    pub ordering: CommitOrdering,
    /// Remotes whose tracking branches are hidden from the graph.
    pub hide_remotes: Vec<String>,
    /// Only commits touching one of these repository-relative paths.
    pub paths: Vec<String>,
}

impl Default for GraphOptions {
    fn default() -> Self {
        GraphOptions {
            branches: None,
            authors: None,
            max_commits: 300,
            show_tags: true,
            show_remote_branches: true,
            first_parent_only: false,
            ordering: CommitOrdering::Date,
            hide_remotes: Vec::new(),
            paths: Vec::new(),
        }
    }
}

impl GraphOptions {
    fn to_log_options(&self, remotes: Vec<String>) -> LogOptions {
        LogOptions {
            branches: self.branches.clone(),
            authors: self.authors.clone(),
            max_commits: self.max_commits,
            show_tags: self.show_tags,
            show_remote_branches: self.show_remote_branches,
            show_remote_heads: self.show_remote_branches,
            defer_remote_refs: false,
            include_commits_mentioned_by_reflogs: false,
            only_follow_first_parent: self.first_parent_only,
            commit_ordering: self.ordering,
            remotes,
            hide_remotes: self.hide_remotes.clone(),
            gerrit_refs: None,
            gerrit_show_change_refs: false,
            filter_paths: self.paths.clone(),
            defer_uncommitted_changes: false,
            show_uncommitted_changes: true,
            show_untracked_files: true,
            show_commits_only_referenced_by_tags: true,
            use_mailmap: false,
        }
    }

    fn to_ref_options(&self) -> RefReadOptions {
        RefReadOptions {
            show_remote_branches: self.show_remote_branches,
            show_remote_heads: self.show_remote_branches,
            hide_remotes: self.hide_remotes.clone(),
            show_change_refs: false,
        }
    }
}

/// A revision as the engine's file and diff calls take it: a hash, a ref name, `HEAD~2`, …,
/// or one of the two special sides of a working tree.
pub const WORKING_TREE: &str = crate::types::UNCOMMITTED;
/// The staged copy of a file (`git show :path`).
pub const INDEX: &str = ":index";

/// One open repository. Cheap to clone (it is a handle); drop it when done, or keep it for the
/// session - the underlying repository stays warm in the [`RepoManager`] either way.
#[derive(Clone)]
pub struct Engine {
    repo: Arc<Repo>,
}

impl Engine {
    /// Open the repository containing `path` (any path inside the working tree, like
    /// `git rev-parse --show-toplevel`). Fails when the path is not inside a git repository.
    pub fn open(path: impl AsRef<Path>) -> Result<Engine> {
        let root = crate::repository::repo_root(&path.as_ref().to_string_lossy())?;
        Ok(Engine {
            repo: RepoManager::global().get(root)?,
        })
    }

    /// The repository's root: the working tree, or the git directory of a bare repository.
    pub fn root(&self) -> &Path {
        self.repo.root()
    }

    /// The git directory (`.git`, or the repository itself when bare).
    pub fn git_dir(&self) -> &Path {
        self.repo.git_dir()
    }

    pub fn is_bare(&self) -> bool {
        self.repo.is_bare()
    }

    /// The underlying handle, for callers that need the module-level functions directly.
    pub fn repo(&self) -> &Repo {
        &self.repo
    }

    /// Forget the cached handle of this repository (after it was deleted or moved on disk).
    pub fn close(self) {
        RepoManager::global().close(self.repo.root());
    }

    /* ---------- The graph ---------- */

    /// Branch names, tag names, remote names, stashes and HEAD - what a graph host shows in
    /// its dropdowns before (or alongside) the first page.
    pub fn info(&self, options: &GraphOptions) -> Result<GitRepoInfo> {
        crate::graph::repo_info(&self.repo, &options.to_ref_options(), true)
    }

    /// One page of the commit graph, with the refs attached to each commit.
    pub fn graph(&self, options: &GraphOptions) -> Result<GitCommitData> {
        let remotes = self.repo.remote_names();
        crate::graph::load_commits(&self.repo, &options.to_log_options(remotes))
    }

    /// Every ref the graph annotates commits with, plus the branch and tag name lists.
    pub fn refs(&self, options: &GraphOptions) -> Result<RefSnapshot> {
        crate::refs::read_refs(&self.repo, &options.to_ref_options())
    }

    pub fn stashes(&self) -> Result<Vec<GitStash>> {
        crate::stash::read_stashes(&self.repo)
    }

    /// Search commit messages, newest first (`git log --all -E -i --grep`).
    pub fn search_history(&self, query: &str) -> Result<Vec<GitHistoryMatch>> {
        crate::log::search_history(&self.repo, query)
    }

    /* ---------- Commits ---------- */

    /// A commit in full: message, author, signature, parents and the files it changed.
    pub fn commit(&self, hash: &str) -> Result<GitCommitDetails> {
        crate::details::commit_details(&self.repo, hash)
    }

    /// The full message bodies of several commits at once.
    pub fn commit_bodies(&self, hashes: &[String]) -> Result<BTreeMap<String, String>> {
        crate::details::commit_bodies(&self.repo, hashes)
    }

    pub fn commit_subject(&self, hash: &str) -> Result<String> {
        crate::details::commit_subject(&self.repo, hash)
    }

    pub fn tag(&self, name: &str) -> Result<GitTagDetails> {
        crate::details::tag_details(&self.repo, name)
    }

    /// The files changed between two revisions; `to` may be [`WORKING_TREE`].
    pub fn diff(&self, from: &str, to: &str) -> Result<Vec<GitFileChange>> {
        crate::diff::diff_revisions(&self.repo, from, to)
    }

    /// The files a single commit changed against its first parent.
    pub fn commit_files(&self, hash: &str) -> Result<Vec<GitFileChange>> {
        crate::diff::diff_commit(&self.repo, hash)
    }

    /* ---------- Files ---------- */

    /// A file's contents at a revision: a commit-ish, [`INDEX`] for the staged copy, or
    /// [`WORKING_TREE`] for the file on disk. Binary files come back with `contents: None`.
    pub fn file(&self, revision: &str, path: &str) -> Result<CommitFile> {
        if revision == WORKING_TREE {
            let bytes = std::fs::read(self.repo.root().join(path))
                .map_err(|e| crate::Error::git(format!("{path}: {e}")))?;
            let binary = bytes[..bytes.len().min(8000)].contains(&0);
            return Ok(CommitFile {
                contents: if binary {
                    None
                } else {
                    Some(String::from_utf8_lossy(&bytes).into_owned())
                },
                binary,
            });
        }
        if revision == INDEX {
            return crate::blob::index_file(&self.repo, path);
        }
        crate::blob::commit_file(&self.repo, revision, path)
    }

    /// The unified diff of one file in one commit, against its first parent.
    pub fn file_diff(&self, hash: &str, path: &str) -> Result<String> {
        crate::blob::commit_file_diff(&self.repo, hash, path)
    }

    /* ---------- The working tree ---------- */

    /// The working tree's changes, staged and unstaged halves apart, conflicts flagged - what
    /// a Source Control view lists.
    pub fn status(&self) -> Result<Vec<ScmChange>> {
        crate::status::scm_changes(&self.repo)
    }

    /// Whether anything is uncommitted (a cheaper question than [`Engine::status`]).
    pub fn is_dirty(&self) -> Result<bool> {
        crate::status::is_dirty(&self.repo)
    }

    /* ---------- Configuration and statistics ---------- */

    /// The repository's remotes, user identity and the settings the graph reads.
    pub fn config(&self) -> Result<ConfigSnapshot> {
        crate::config::read_config(&self.repo)
    }

    pub fn current_branch(&self) -> Result<Option<String>> {
        crate::config::current_branch_name(&self.repo)
    }

    pub fn upstream_of_current_branch(&self) -> Result<Option<String>> {
        crate::config::current_branch_upstream(&self.repo)
    }

    pub fn remote_url(&self, remote: &str) -> Result<Option<String>> {
        crate::config::remote_url(&self.repo, remote)
    }

    pub fn submodules(&self) -> Result<Vec<String>> {
        crate::config::submodules(&self.repo)
    }

    /// Every distinct author, for an author filter.
    pub fn authors(&self) -> Result<Vec<GitAuthor>> {
        crate::log::authors(&self.repo)
    }

    /// Commits per author.
    pub fn author_stats(&self) -> Result<Vec<GitAuthorStat>> {
        crate::stats::author_stats(&self.repo)
    }

    /// Commits per day, for an activity heat map.
    pub fn activity(&self) -> Result<Vec<GitActivityCell>> {
        crate::stats::activity_heatmap(&self.repo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_graph_options_match_the_views_first_request() {
        let options = GraphOptions::default();
        assert_eq!(options.max_commits, 300);
        assert!(options.show_tags && options.show_remote_branches);
        let log = options.to_log_options(vec!["origin".into()]);
        assert_eq!(log.remotes, ["origin"]);
        assert!(!log.defer_remote_refs && log.gerrit_refs.is_none());
    }

    #[test]
    fn opening_a_folder_outside_any_repository_fails() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Engine::open(dir.path()).is_err());
    }
}
