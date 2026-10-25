//! The file model: changed-file rows, their line counts, file content at a revision, and the
//! working-tree status halves the uncommitted row is built from.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitLineCounts {
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// The file's text, or `None` when it is not valid UTF-8.
    pub contents: Option<String>,
    /// True when the blob is binary and `contents` is `None`.
    pub binary: bool,
}

#[derive(Debug, Clone, Default)]
pub struct GitStatusFiles {
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
}
