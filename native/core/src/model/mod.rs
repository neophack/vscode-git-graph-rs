//! The data contract shared with the TypeScript extension.
//!
//! Every struct here serialises to exactly the shape the existing webview already consumes (see
//! the shared types in `src/types` in the original extension), so the graph rendering, commit
//! details view and context menus keep working unchanged against this engine. The TypeScript
//! module under `src/shared/engine/` regenerates from these types — via `protocol::typescript`,
//! run by `cargo test -p git-graph-core --test protocol` — so a type added here crosses the
//! protocol without a hand-written mirror. This module is the one re-export point: the types
//! below are the crate's public model, split by theme across the submodules.

pub mod commits;
pub mod config;
pub mod details;
pub mod files;
pub mod gerrit;
pub mod refs;
pub mod repo;
pub mod stats;

pub use commits::{
    CommitOrdering, CommitRecord, GitCommit, GitCommitData, GitCommitRemote, GitCommitStash,
    GitCommitSummary, GitCommitTag, LogOptions, UNCOMMITTED,
};
pub use config::{ConfigSnapshot, RemoteConfig};
pub use details::{GitCommitDetails, GitSignature, GitSignatureStatus, GitTagDetails};
pub use files::{CommitFile, GitFileChange, GitFileStatus, GitLineCounts, GitStatusFiles};
pub use gerrit::{GerritChangeEvent, GerritChangeState, GerritVote};
pub use refs::{
    AnnotateParams, AnnotateResult, GitCommitRefs, GitRef, GitRefData, GitTagRef, RefOptions,
    RefReadOptions, RefSnapshot,
};
pub use repo::{GitRepoInfo, GitStash, GitViewData};
pub use stats::{GitActivityCell, GitAuthor, GitAuthorStat, GitHistoryMatch};
