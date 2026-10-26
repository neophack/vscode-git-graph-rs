//! The Gerrit model: the review state of a change, as the badges and the review dialog consume it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One review event parsed out of a `NoteDb` meta commit, in the shape the webview renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GerritChangeEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub patchset: u32,
    /// The Gerrit user that performed the action; omitted when the record names none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    /// The votes a review event recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<GerritVote>>,
    pub timestamp: i64,
    /// The meta commit's subject line.
    pub raw: String,
    /// The verbatim meta commit message, shown when the event is expanded.
    pub raw_full: String,
}

/// One label vote of a review event (e.g. `Code-Review +2`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GerritVote {
    pub name: String,
    pub value: i32,
}

/// The review state of one Gerrit change, as the badges and the review dialog consume it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GerritChangeState {
    pub change: u64,
    /// The latest patchset.
    pub patchset: u32,
    /// -2..2, the Code-Review vote with the greatest absolute value.
    pub code_review: i32,
    /// -1..1, the Verified vote with the greatest absolute value.
    pub verified: i32,
    /// `new`, `merged` or `abandoned`.
    pub status: String,
    pub wip: bool,
    /// The code commit of the latest patchset — the badge's anchor.
    pub head_hash: String,
    pub events: Vec<GerritChangeEvent>,
    /// The change's web URL, when the remote's URL allowed deriving one.
    pub url: Option<String>,
}
