//! The ref model: the raw ref scan, the wire options that drive it, and the refs-only refresh.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::model::commits::{GitCommitRemote, GitCommitTag};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub hash: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct GitTagRef {
    pub hash: String,
    pub name: String,
    /// True for the peeled record of an annotated tag, which points at the commit rather than at
    /// the tag object.
    pub annotated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
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

/// The wire form of the ref-reading options, plus the stash flag `loadRepoInfo` also needs.
/// The defaults are the ones a view load uses, so an omitted field means "the usual".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase", default)]
pub struct RefOptions {
    pub show_remote_branches: bool,
    pub show_remote_heads: bool,
    pub hide_remotes: Vec<String>,
    pub show_change_refs: bool,
    pub show_stashes: bool,
}

impl Default for RefOptions {
    fn default() -> Self {
        RefOptions {
            show_remote_branches: true,
            show_remote_heads: false,
            hide_remotes: Vec::new(),
            show_change_refs: false,
            show_stashes: true,
        }
    }
}

impl RefOptions {
    pub fn to_read_options(&self) -> RefReadOptions {
        RefReadOptions {
            show_remote_branches: self.show_remote_branches,
            show_remote_heads: self.show_remote_heads,
            hide_remotes: self.hide_remotes.clone(),
            show_change_refs: self.show_change_refs,
        }
    }
}

/// The parameters of the `annotate` request (task 2.10): the commits to re-annotate — the list
/// the caller already holds on screen — plus which refs to annotate them with.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct AnnotateParams {
    /// The commits to re-annotate, newest first as the view shows them.
    pub commits: Vec<String>,
    /// Which refs to read and annotate with (the same options `loadRefs` takes).
    pub refs: RefOptions,
    /// Whether tags are annotated — the view's "Show Tags" setting, as `loadCommits` receives it.
    pub show_tags: bool,
}

/// The refs of one commit, as a refs-only refresh re-annotates it: exactly the labels a full
/// `loadCommits` of the same options would attach to that commit, in the same order.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRefs {
    pub hash: String,
    pub heads: Vec<String>,
    pub tags: Vec<GitCommitTag>,
    pub remotes: Vec<GitCommitRemote>,
}

/// The answer of the `annotate` request: a freshly read HEAD together with the re-annotated
/// commits, in the order they were given.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct AnnotateResult {
    /// The commit HEAD resolves to now — the page's `head` field, refreshed.
    pub head: Option<String>,
    pub commits: Vec<GitCommitRefs>,
}
