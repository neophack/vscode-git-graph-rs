//! Node-API bindings: the seam between the extension host and the Git engine.
//!
//! The ABI is deliberately tiny — seven functions. Everything the engine answers goes through
//! [`request`], one `{"method", "params"}` JSON call routed by the typed protocol table in
//! `git_graph_core::protocol`; the host's TypeScript types for it are generated from that same
//! table, so this file never changes when a method is added.
//!
//! Structured data crosses as JSON on purpose: building JavaScript objects property by property
//! costs a Node-API call *per field*, and a page of a thousand commits has tens of thousands of
//! them. Serialising once in Rust and calling `JSON.parse` once in JavaScript is faster, and it
//! keeps the ABI stable while the engine's types evolve. Raw file bytes are the one exception:
//! [`request_bytes`] hands them over as a `Buffer`, never through a text encoding.
//!
//! Compatibility: the asynchronous calls are `AsyncTask`s (`napi_create_async_work`, Node-API 1),
//! and the crate is built against Node-API 3 — the version VS Code 1.38's Node 10.11 offers — so
//! the oldest supported editor can load the engine too. Nothing here may need a newer Node-API.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use git_graph_core::{protocol, RepoManager};

/// Answer one protocol request against the repository containing `repo` (any path inside it).
///
/// Resolves to the envelope `{"ok": …}` or `{"error": {"kind", "message"}}` as a JSON string;
/// it never rejects, so the host has a single failure path to handle.
#[napi(ts_return_type = "Promise<string>")]
pub fn request(repo: String, request_json: String) -> AsyncTask<RequestTask> {
    AsyncTask::new(RequestTask { repo, request_json })
}

pub struct RequestTask {
    repo: String,
    request_json: String,
}

impl Task for RequestTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        Ok(protocol::request(&self.repo, &self.request_json))
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

/// The answer of [`request_bytes`]: `ok` is the file's bytes (`null` when the path does not
/// exist at that revision), or `error` says why the read failed.
#[napi(object)]
pub struct BytesAnswer {
    pub ok: Option<Buffer>,
    pub error: Option<EngineError>,
}

/// The `{kind, message}` failure, as the JSON envelope carries it.
#[napi(object)]
pub struct EngineError {
    pub kind: String,
    pub message: String,
}

/// A file's raw bytes at a revision (a commit-ish, or `:index` for the staged copy).
#[napi(ts_return_type = "Promise<BytesAnswer>")]
pub fn request_bytes(repo: String, revision: String, path: String) -> AsyncTask<BytesTask> {
    AsyncTask::new(BytesTask {
        repo,
        revision,
        path,
    })
}

pub struct BytesTask {
    repo: String,
    revision: String,
    path: String,
}

impl Task for BytesTask {
    type Output = git_graph_core::Result<Option<Vec<u8>>>;
    type JsValue = BytesAnswer;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(protocol::file_bytes(&self.repo, &self.revision, &self.path))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<BytesAnswer> {
        Ok(match output {
            Ok(bytes) => BytesAnswer {
                ok: bytes.map(Buffer::from),
                error: None,
            },
            Err(error) => BytesAnswer {
                ok: None,
                error: Some(EngineError {
                    kind: serde_json::to_value(error.kind)
                        .ok()
                        .and_then(|kind| kind.as_str().map(str::to_string))
                        .unwrap_or_else(|| "internal".into()),
                    message: error.message,
                }),
            },
        })
    }
}

/// Open a repository and keep its handle warm; resolves to the repository root.
#[napi(ts_return_type = "Promise<string>")]
pub fn open(path: String) -> AsyncTask<RequestTask> {
    request(path, r#"{"method":"open"}"#.to_string())
}

/// Drop a repository handle, releasing its object cache and open pack files.
#[napi]
pub fn close(path: String) {
    RepoManager::global().close(&path);
}

/// Drop every repository handle.
#[napi]
pub fn close_all() {
    RepoManager::global().close_all();
}

/// How many repositories are currently open. Exposed for the tests and for diagnostics.
#[napi]
pub fn open_count() -> u32 {
    RepoManager::global().open_count() as u32
}

/// The engine's version: the host compares it with its own to detect a stale binary.
#[napi]
pub fn engine_version() -> String {
    git_graph_core::VERSION.to_string()
}
