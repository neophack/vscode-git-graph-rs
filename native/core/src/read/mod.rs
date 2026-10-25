//! The read modules: the per-topic implementations behind [`crate::engine::Engine`] and the
//! request protocol.
//!
//! Each module answers one family of questions against a `crate::repository::Repo` handle:
//! `log`/`graph`/`incremental` walk commits, `refs` scans refs, `details`/`diff`/`blob` read
//! commits' metadata, file pairs and contents, `status`/`stash`/`config`/`stats` cover the
//! working tree, stashes, settings and statistics, and `gerrit` parses NoteDb meta histories.
//! They are the implementation, not the contract: the public surface is the engine and the
//! protocol on top of them, and this tree is visible only inside the crate — the integration
//! tests and benchmarks drive it through `Engine` and `protocol` like any other caller.

pub(crate) mod blob;
pub(crate) mod config;
pub(crate) mod details;
pub(crate) mod diff;
pub(crate) mod gerrit;
pub(crate) mod graph;
pub(crate) mod incremental;
pub(crate) mod log;
pub(crate) mod refs;
pub(crate) mod stash;
pub(crate) mod stats;
pub(crate) mod status;
