//! The repository-level model: the dropdown data, the stash list, and the combined view load.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::commits::GitCommitData;

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub branches: Vec<String>,
    /// The checked-out branch's short name, or `None` when HEAD is detached.
    pub head: Option<String>,
    pub remotes: Vec<String>,
    pub stashes: Vec<GitStash>,
    pub tags: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

/// Everything the view opens with, from one ref scan: the dropdown data and the first page.
/// `loadRepoInfo` + `loadCommits` answer the same, in two calls and two scans.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitViewData {
    pub info: GitRepoInfo,
    pub commits: GitCommitData,
}
