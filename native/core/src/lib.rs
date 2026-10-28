//! The Git engine behind the Git Graph VS Code extension.
//!
//! This crate never shells out to `git`. It reads the object database, the index and the refs
//! directly, in-process, from a repository handle that stays warm for the whole editor session.
//! It knows nothing about VS Code: it takes plain requests and returns plain data, so it can be
//! exercised by `cargo test` without Node in the picture.
//!
//! **The public surface** is four things:
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
//! Everything else is implementation and lives behind `pub(crate)`: the read modules under
//! `read`, the handle cache under `repository`, and the cancellation registry `cancel` are
//! reachable only from inside this crate — the crate's own integration tests, benchmarks and
//! the Node binding exercise the engine through the four surfaces above, exactly as an outside
//! integration would.
//!
//! The two deliberate exceptions are [`IncrementalStore`]: the incremental-traversal cache's
//! control surface, kept nameable for this package's own integration tests and benchmarks (see
//! its documentation for why they cannot do without it), and [`parse_gerrit_meta_message`],
//! the pure half of the Gerrit meta parser that the boundary fuzzing drives (see its
//! documentation).

pub mod engine;
pub mod error;
pub mod model;
pub mod protocol;

// The TypeScript generation behind `protocol::typescript`, compiled only under the `ts` feature
// the `protocol` test enables: the release addon never generates types, so this module — and
// `ts-rs` with it — stays out of the shipped binary entirely.
#[cfg(feature = "ts")]
mod typescript;

pub(crate) mod cancel;
pub(crate) mod read;
pub(crate) mod repository;

pub(crate) mod text;

pub use engine::{Engine, GraphOptions};
pub use error::{Error, ErrorKind, Result};

/// The control surface of the incremental-traversal cache: [`IncrementalStore::invalidate`]
/// forces the next load of a repository to traverse in full, and [`IncrementalStore::stats`]
/// reports how often the cache answered a refresh and how often it fell back.
///
/// This is **not** part of the host contract. It stays nameable for exactly one kind of caller:
/// this package's own integration tests and benchmarks, which must compare an incrementally
/// served page against a *forced* full traversal of the same options (there is no way to force
/// one through the public API — the cache is the point of the load path), and must measure the
/// traversal itself rather than the cache hit that would otherwise answer every iteration.
/// Hidden from the docs; may change between minor versions.
#[doc(hidden)]
pub use read::incremental::Store as IncrementalStore;

/// The pure Gerrit `NoteDb` meta message parser (`read::gerrit::parse_meta_message`), so the
/// boundary fuzzing — the always-on property tests in this crate and the cargo-fuzz
/// target under `native/core/fuzz` — can feed it arbitrary bytes without a
/// repository. The `parse_gerrit_metas` protocol method reads meta refs and serves every
/// record to the same parser, so a panic found here is a panic the view would have hit on
/// real repository data. Hidden from the docs; may change between minor versions.
#[doc(hidden)]
pub use read::gerrit::parse_meta_message as parse_gerrit_meta_message;

/// The engine's version, so a host that links it can tell whether an installed package's
/// backend process would answer identically (and can then skip the process entirely).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
