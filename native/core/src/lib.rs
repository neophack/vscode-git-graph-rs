//! The Git engine behind the Git Graph VS Code extension.
//!
//! This crate never shells out to `git`. It reads the object database, the index and the refs
//! directly, in-process, from a repository handle that stays warm for the whole editor session.
//! It knows nothing about VS Code: it takes plain requests and returns plain data, so it can be
//! exercised by `cargo test` without Node in the picture.

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
pub mod status;
pub mod types;

pub use error::{Error, ErrorKind, Result};
pub use repository::{Repo, RepoManager};
