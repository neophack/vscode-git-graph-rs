//! The error type crossing the Rust/JavaScript boundary.
//!
//! The extension distinguishes "this repository is not usable" from "this Git operation failed"
//! (the first makes the view fall back to another backend, the second is shown to the user), so
//! the kind is carried alongside the message rather than being flattened into the text.

use std::fmt::Display;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The path is not inside a Git repository, or the repository cannot be opened at all.
    NotARepository,
    /// A ref, object or path the caller asked for does not exist.
    NotFound,
    /// The caller passed something the engine rejects before touching the repository.
    InvalidArgument,
    /// The repository was readable, but the operation on it failed.
    Git,
    /// The filesystem failed underneath us.
    Io,
    /// The operation was cancelled by the caller.
    Cancelled,
    /// The engine does not implement this yet; the caller should fall back to the `git` CLI.
    Unsupported,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Error {
            kind,
            message: message.into(),
        }
    }
    pub fn git(message: impl Into<String>) -> Self {
        Error::new(ErrorKind::Git, message)
    }
    pub fn not_a_repository(message: impl Into<String>) -> Self {
        Error::new(ErrorKind::NotARepository, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Error::new(ErrorKind::NotFound, message)
    }
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Error::new(ErrorKind::InvalidArgument, message)
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Error::new(ErrorKind::Unsupported, message)
    }
    pub fn cancelled() -> Self {
        Error::new(ErrorKind::Cancelled, "The operation was cancelled")
    }

    /// The failure with its kind named: `"NotARepository: …"`, the one string form every
    /// boundary agrees on. The typed ones throw it (`native/node`'s error conversion), the
    /// single dispatch surface answers it in-band (`dispatch::request`), and the TypeScript
    /// side parses the prefix back into a kind to decide between fallback and error dialogue.
    pub fn with_kind_prefix(&self) -> String {
        format!("{}: {}", self.kind.as_str(), self.message)
    }
}

impl ErrorKind {
    /// The kind's wire name — the prefix of [`Error::with_kind_prefix`].
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorKind::NotARepository => "NotARepository",
            ErrorKind::NotFound => "NotFound",
            ErrorKind::InvalidArgument => "InvalidArgument",
            ErrorKind::Git => "Git",
            ErrorKind::Io => "Io",
            ErrorKind::Cancelled => "Cancelled",
            ErrorKind::Unsupported => "Unsupported",
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::new(ErrorKind::Io, e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Attach a kind to any error that only knows how to display itself.
///
/// gix returns a distinct error type per operation, so there is no single `From` impl to write.
pub trait ResultExt<T> {
    /// Map the error to [`ErrorKind::Git`], prefixed with `context`.
    fn git_ctx(self, context: &str) -> Result<T>;
}

impl<T, E: Display> ResultExt<T> for std::result::Result<T, E> {
    fn git_ctx(self, context: &str) -> Result<T> {
        self.map_err(|e| Error::git(format!("{context}: {e}")))
    }
}
