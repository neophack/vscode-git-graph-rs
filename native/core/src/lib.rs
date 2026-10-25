//! The Git engine behind the Git Graph VS Code extension.
//!
//! This crate never shells out to `git`. It reads the object database, the index and the refs
//! directly, in-process, from a repository handle that stays warm for the whole editor session.
//! It knows nothing about VS Code: it takes plain requests and returns plain data, so it can be
//! exercised by `cargo test` without Node in the picture.
//!
//! **The public surface** is four things, per the refactor plan (§3.5):
//!
//! - [`engine::Engine`] — one type exposing everything a Rust host needs (graph pages, commit
//!   details, diffs, file contents at a revision, working-tree status, configuration,
//!   statistics), plus [`GraphOptions`] and the [`engine::INDEX`]/[`engine::WORKING_TREE`] revision names.
//! - [`protocol`] — the JSON contract: one typed [`protocol::Request`] enum, one
//!   `{"method", "params"}` call ([`protocol::request`]), and the generated TypeScript method
//!   map the host's types come from.
//! - [`model`] — the data contract shared with the TypeScript extension.
//! - [`error::Error`] — the structured error, `{ kind, message }` on the wire.
//!
//! Everything else is implementation. The read modules under [`read`], the handle cache under
//! [`repository`], and the cancellation registry [`cancel`] are `#[doc(hidden)]`: they stay
//! nameable so this package's own integration tests (`native/core/tests`), benchmarks
//! (`native/core/benches`) and the Node binding (`native/node`) can reach the finer grain, but
//! they are not part of the documented API and may change between minor versions.

pub mod engine;
pub mod error;
pub mod model;
pub mod protocol;

#[doc(hidden)]
pub mod cancel;
#[doc(hidden)]
pub mod read;
#[doc(hidden)]
pub mod repository;

pub(crate) mod text;

pub use engine::{Engine, GraphOptions};
pub use error::{Error, ErrorKind, Result};

/// The engine's version, so a host that links it can tell whether an installed package's
/// backend process would answer identically (and can then skip the process entirely).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
