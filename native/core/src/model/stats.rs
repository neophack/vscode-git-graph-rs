//! The statistics and search model: authors, per-author counts, activity cells, search hits.

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
