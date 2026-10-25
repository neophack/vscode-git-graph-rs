//! The commit model: the graph page's rows, their ref annotations, and the options a load takes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The synthetic hash the view uses for the "Uncommitted Changes" row.
pub const UNCOMMITTED: &str = "*";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    pub date: i64,
    /// The commit subject (first line of the message).
    pub message: String,
    pub heads: Vec<String>,
    pub tags: Vec<GitCommitTag>,
    pub remotes: Vec<GitCommitRemote>,
    pub stash: Option<GitCommitStash>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitTag {
    pub name: String,
    pub annotated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRemote {
    pub name: String,
    /// `None` when the ref's remote is not one of the repository's known remotes.
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitStash {
    pub selector: String,
    pub base_hash: String,
    pub untracked_files_hash: Option<String>,
}

/// A commit as read from the object database, before refs and stashes are attached to it.
#[derive(Debug, Clone)]
pub struct CommitRecord {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub author_date: i64,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitData {
    pub commits: Vec<GitCommit>,
    pub head: Option<String>,
    pub tags: Vec<String>,
    /// The branch name list of the ref scan this page was built from — the same list `loadRepoInfo`
    /// returns, riding along so a deferred view load can complete the branch dropdown without a
    /// second scan. `None` on error (and for callers that did not ask for it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branches: Option<Vec<String>>,
    pub more_commits_available: bool,
    pub error: Option<String>,
}

/// The fields the Commit Comparison View describes a commit with.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub hash: String,
    pub author: String,
    pub email: String,
    /// The author date, which is what `git show --format=%at` reports.
    pub date: i64,
    /// The full commit message, trimmed as `git show --format=%B` output is.
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum CommitOrdering {
    #[default]
    Date,
    AuthorDate,
    Topo,
}

/// Everything `loadCommits` needs, in the shape the TypeScript side sends it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct LogOptions {
    /// The branch heads to show, or `None` to show all refs.
    pub branches: Option<Vec<String>>,
    /// Only show commits whose author matches one of these names.
    pub authors: Option<Vec<String>>,
    pub max_commits: u32,
    /// Defaults to true: `git log --decorate` always names tags, so a caller that does not say
    /// otherwise must not lose them.
    #[serde(default = "default_true")]
    pub show_tags: bool,
    pub show_remote_branches: bool,
    pub show_remote_heads: bool,
    /// Skip the `refs/remotes/` scan in this load: the response carries the local refs (and the
    /// tags) only, and the caller follows up with a complete load. The remote pass dominates the
    /// scan time on repositories with many remote-tracking refs — a Gerrit one above all.
    pub defer_remote_refs: bool,
    pub include_commits_mentioned_by_reflogs: bool,
    pub only_follow_first_parent: bool,
    pub commit_ordering: CommitOrdering,
    pub remotes: Vec<String>,
    pub hide_remotes: Vec<String>,
    /// Gerrit change refs allowed into the graph; `None` disables the Gerrit integration.
    pub gerrit_refs: Option<Vec<String>>,
    pub gerrit_show_change_refs: bool,
    /// Only show commits touching these repository-relative paths.
    pub filter_paths: Vec<String>,
    /// Skip the working-tree scan that produces the "Uncommitted Changes" row.
    pub defer_uncommitted_changes: bool,
    pub show_uncommitted_changes: bool,
    pub show_untracked_files: bool,
    /// Include commits that are only referenced by a tag.
    pub show_commits_only_referenced_by_tags: bool,
    /// Apply `.mailmap` to author names and emails. The engine does not read mailmaps: when this
    /// is set and the work tree carries a `.mailmap`, the load is declined (`Unsupported`) so the
    /// CLI backend serves the mapped names.
    pub use_mailmap: bool,
}

/// The serde default of `LogOptions::show_tags`.
fn default_true() -> bool {
    true
}
