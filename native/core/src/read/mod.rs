//! The read modules: the per-topic implementations behind [`crate::engine::Engine`] and the
//! request protocol.
//!
//! Each module answers one family of questions against a [`crate::repository::Repo`] handle:
//! `log`/`graph`/`incremental` walk commits, `refs` scans refs, `details`/`diff`/`blob` read
//! commits' metadata, file pairs and contents, `status`/`stash`/`config`/`stats` cover the
//! working tree, stashes, settings and statistics, and `gerrit` parses NoteDb meta histories.
//! They are the implementation, not the contract: the public surface is the engine and the
//! protocol on top of them, and this module is kept visible only so the crate's own integration
//! tests and benchmarks can reach the finer grain.

pub mod blob;
pub mod config;
pub mod details;
pub mod diff;
pub mod gerrit;
pub mod graph;
pub mod incremental;
pub mod log;
pub mod refs;
pub mod stash;
pub mod stats;
pub mod status;
