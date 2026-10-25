//! The Git engine behind the Git Graph VS Code extension.
//!
//! This crate never shells out to `git`. It reads the object database, the index and the refs
//! directly, in-process, from a repository handle that stays warm for the whole editor session.
//! It knows nothing about VS Code: it takes plain requests and returns plain data, so it can be
//! exercised by `cargo test` without Node in the picture.
//!
//! **Using it as a library**: start at [`engine::Engine`] — one type, in one file
//! (`src/engine.rs`), that exposes everything a host needs (graph pages, commit details, diffs,
//! file contents at a revision, working-tree status, configuration, statistics). The per-topic
//! modules below are the implementation; they stay public for finer-grained access, but
//! `engine` is the contract. A host that speaks JSON instead of Rust — the Node addon — goes
//! through [`protocol::request`]: one typed `Request` enum, one `{"method", "params"}` call.

pub mod blob;
pub mod cancel;
pub mod config;
pub mod details;
pub mod diff;
pub mod engine;
pub mod error;
pub mod gerrit;
pub mod graph;
pub mod log;
pub mod protocol;
pub mod refs;
pub mod repository;
pub mod stash;
pub mod stats;
pub mod status;
pub mod text;
pub mod types;

pub use engine::{Engine, GraphOptions};
pub use error::{Error, ErrorKind, Result};
pub use repository::{Repo, RepoManager};

/// The engine's version, so a host that links it can tell whether an installed package's
/// backend process would answer identically (and can then skip the process entirely).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
