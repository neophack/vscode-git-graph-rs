//! The commit-details model: the full detail row, signatures, and annotated tag details.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::model::files::GitFileChange;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
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
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct GitSignature {
    pub key: String,
    pub signer: String,
    pub status: GitSignatureStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
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

/// An annotated tag in full, or the fields a lightweight tag can fill in.
///
/// A lightweight tag has no tagger and no message of its own: the tagger fields are empty and the
/// message is the tagged commit's, which is what `for-each-ref %(contents)` reports for one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct GitTagDetails {
    /// The tag object for an annotated tag, the commit for a lightweight one.
    pub hash: String,
    pub tagger_name: String,
    pub tagger_email: String,
    pub tagger_date: i64,
    pub message: String,
    /// Present when the tag carries a signature; the host may replace status E after Git verifies it.
    pub signature: Option<GitSignature>,
}
