//! The statistics and search model: authors, per-author counts, activity cells, search hits,
//! and the engine's own open-repository diagnostics.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A distinct commit author, as the settings widget's author dropdown lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthor {
    pub name: String,
    pub email: String,
}

/// Commit count for one author across all refs (branches, tags, remote-tracking, the stash),
/// merge commits excluded - what the Statistics view's author table lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthorStat {
    pub name: String,
    pub email: String,
    pub commits: usize,
}

/// One non-zero cell of the Statistics view's commit-activity heatmap, binned by each commit's
/// AUTHOR-LOCAL weekday/hour (not the viewer's timezone - see `stats::activity_heatmap`). Sparse:
/// a cell with no commits is omitted rather than sent as an explicit zero.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitActivityCell {
    /// 0 = Sunday, matching JavaScript's `Date.getUTCDay()`.
    pub weekday: u8,
    pub hour: u8,
    pub count: usize,
}

/// One hit of a commit-message search, as the Find dialogue lists them.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryMatch {
    pub hash: String,
    pub author: String,
    pub date: i64,
    /// The commit subject.
    pub message: String,
}

/// The engine's open-repository diagnostics, as the "Show Diagnostics" command lists them: the
/// repository handle cache behind every request. Handles are keyed by git directory, so one
/// repository appears once however the host addresses it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitEngineStats {
    /// How many repository handles are open (the `openCount` method's answer).
    pub open_count: usize,
    /// One row per open handle, unordered.
    pub handles: Vec<GitRepoHandleStats>,
}

/// One open repository handle of [`GitEngineStats`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoHandleStats {
    /// The canonical `.git` directory that keys this handle.
    pub git_dir: String,
    /// Milliseconds since this handle last served a request.
    pub idle_ms: u64,
    /// Approximate bytes of incremental traversal cache held for this repository (the gix
    /// object caches are per thread-local view and report no size of their own).
    pub cache_bytes: usize,
}
