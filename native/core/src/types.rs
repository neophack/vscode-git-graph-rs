//! The data contract shared with the TypeScript extension.
//!
//! Every struct here serialises to exactly the shape the existing webview already consumes (see
//! `src/types.ts` in the original extension), so the graph rendering, commit details view and
//! context menus keep working unchanged against this engine.

use serde::{Deserialize, Serialize};

/// The synthetic hash the view uses for the "Uncommitted Changes" row.
pub const UNCOMMITTED: &str = "*";

/* ---------- Commits ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitTag {
    pub name: String,
    pub annotated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRemote {
    pub name: String,
    /// `None` when the ref's remote is not one of the repository's known remotes.
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/* ---------- Refs ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub hash: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTagRef {
    pub hash: String,
    pub name: String,
    /// True for the peeled record of an annotated tag, which points at the commit rather than at
    /// the tag object.
    pub annotated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefData {
    /// The commit HEAD resolves to, or `None` when the repository has no commits.
    pub head: Option<String>,
    pub heads: Vec<GitRef>,
    pub tags: Vec<GitTagRef>,
    pub remotes: Vec<GitRef>,
}

/// One pass over the repository's refs, serving both the `loadRepoInfo` and `loadCommits`
/// requests of a single view load.
#[derive(Debug, Clone, Default)]
pub struct RefSnapshot {
    pub ref_data: GitRefData,
    /// Local branch names, in the order the view lists them.
    pub branches: Vec<String>,
    /// The checked-out branch, or `None` when HEAD is detached.
    pub branch_head: Option<String>,
    /// Tag names, excluding the duplicate peeled records of annotated tags.
    pub tag_names: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RefReadOptions {
    pub show_remote_branches: bool,
    pub show_remote_heads: bool,
    pub hide_remotes: Vec<String>,
    /// Show Gerrit change refs (below `changes/` on a remote) as remote branch refs.
    pub show_change_refs: bool,
}

/* ---------- Repository info ---------- */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub branches: Vec<String>,
    pub head: Option<String>,
    pub remotes: Vec<String>,
    pub stashes: Vec<GitStash>,
    pub tags: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    pub hash: String,
    pub base_hash: String,
    pub untracked_files_hash: Option<String>,
    pub selector: String,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitData {
    pub commits: Vec<GitCommit>,
    pub head: Option<String>,
    pub tags: Vec<String>,
    pub more_commits_available: bool,
    pub error: Option<String>,
}

/* ---------- File changes ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitFileStatus {
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
    #[serde(rename = "U")]
    Untracked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub old_file_path: String,
    pub new_file_path: String,
    #[serde(rename = "type")]
    pub kind: GitFileStatus,
    /// `None` for binary files, where git reports a dash instead of a line count — and while the
    /// counts of a freshly opened view are still being computed in the background.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

/// The `+N/-M` line counts of one file, as `git diff --numstat` reports them. Both fields are
/// `None` for a binary file.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLineCounts {
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

/* ---------- Commit details ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitSignatureStatus {
    #[serde(rename = "G")]
    GoodAndValid,
    #[serde(rename = "U")]
    GoodWithUnknownValidity,
    #[serde(rename = "X")]
    GoodButExpired,
    #[serde(rename = "Y")]
    GoodButMadeByExpiredKey,
    #[serde(rename = "R")]
    GoodButMadeByRevokedKey,
    #[serde(rename = "E")]
    CannotBeChecked,
    #[serde(rename = "B")]
    Bad,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSignature {
    pub key: String,
    pub signer: String,
    pub status: GitSignatureStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_date: i64,
    pub committer: String,
    pub committer_email: String,
    pub committer_date: i64,
    pub signature: Option<GitSignature>,
    /// The full commit message, including the subject.
    pub body: String,
    pub file_changes: Vec<GitFileChange>,
}

/* ---------- Configuration ---------- */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub remotes: Vec<RemoteConfig>,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub push_default: Option<String>,
    pub diff_tool: Option<String>,
    pub diff_gui_tool: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub name: String,
    pub url: Option<String>,
    pub push_url: Option<String>,
}

/* ---------- File content at a revision ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// The file's text, or `None` when it is not valid UTF-8.
    pub contents: Option<String>,
    /// True when the blob is binary and `contents` is `None`.
    pub binary: bool,
}

/* ---------- On-demand commit reads ---------- */

/// The fields the Commit Comparison View describes a commit with.
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// A distinct commit author, as the settings widget's author dropdown lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthor {
    pub name: String,
    pub email: String,
}

/// One hit of a commit-message search, as the Find dialogue lists them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryMatch {
    pub hash: String,
    pub author: String,
    pub date: i64,
    /// The commit subject.
    pub message: String,
}

/* ---------- Tag details ---------- */

/// An annotated tag in full, or the fields a lightweight tag can fill in.
///
/// A lightweight tag has no tagger and no message of its own: the tagger fields are empty and the
/// message is the tagged commit's, which is what `for-each-ref %(contents)` reports for one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTagDetails {
    /// The tag object for an annotated tag, the commit for a lightweight one.
    pub hash: String,
    pub tagger_name: String,
    pub tagger_email: String,
    pub tagger_date: i64,
    pub message: String,
    /// Present when the tag carries a signature (reported as unverified, like commit signatures).
    pub signature: Option<GitSignature>,
}

/* ---------- Working tree status ---------- */

#[derive(Debug, Clone, Default)]
pub struct GitStatusFiles {
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
}

/* ---------- Log options ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommitOrdering {
    #[default]
    Date,
    AuthorDate,
    Topo,
}

/// Everything `loadCommits` needs, in the shape the TypeScript side sends it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
}

/// The serde default of `LogOptions::show_tags`.
fn default_true() -> bool {
    true
}
