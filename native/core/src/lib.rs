//! The Git engine behind the Git Graph VS Code extension.
//!
//! This crate never shells out to `git`. It reads the object database, the index and the refs
//! directly, in-process, from a repository handle that stays warm for the whole editor session.
//! It knows nothing about VS Code: it takes plain requests and returns plain data, so it can be
//! exercised by `cargo test` without Node in the picture.
//!
//! **Using it as a library**: start at [`api::Engine`] — one type, in one file (`src/api.rs`),
//! that exposes everything a host needs (graph pages, commit details, diffs, file contents at a
//! revision, working-tree status, configuration, statistics). The per-topic modules below are
//! the implementation; they stay public for finer-grained access, but `api` is the contract.

pub mod api;
pub mod blob;
pub mod config;
pub mod details;
pub mod diff;
pub mod error;
pub mod gerrit;
pub mod graph;
pub mod log;
pub mod refs;
pub mod repository;
pub mod stash;
pub mod stats;
pub mod status;
pub mod types;

pub use api::{Engine, GraphOptions};
pub use error::{Error, ErrorKind, Result};
pub use repository::{Repo, RepoManager};

/// The engine's version, so a host that links it can tell whether an installed package's
/// backend process would answer identically (and can then skip the process entirely).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
