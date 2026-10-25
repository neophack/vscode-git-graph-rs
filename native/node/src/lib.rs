//! Node-API bindings: the seam between the extension host and the Git engine.
//!
//! The ABI is deliberately tiny — eight functions. Everything the engine answers goes through
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
//! Cancellation (task 2.9): a call named by a `requestId` can be stopped from JavaScript with
//! [`cancel`] — the engine's long-running loops unwind with `{"error": {"kind": "cancelled"}}`.
//! An omitted id behaves exactly as before.
//!
//! Compatibility: the asynchronous calls are `AsyncTask`s (`napi_create_async_work`, Node-API 1),
//! and the crate is built against Node-API 3 — the version VS Code 1.38's Node 10.11 offers — so
//! the oldest supported editor can load the engine too. Nothing here may need a newer Node-API.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use git_graph_core::repository::RepoManager;
use git_graph_core::{cancel, protocol};

/// Answer one protocol request against the repository containing `repo` (any path inside it).
///
/// Resolves to the envelope `{"ok": …}` or `{"error": {"kind", "message"}}` as a JSON string;
/// it never rejects, so the host has a single failure path to handle. A `requestId` registers
/// the in-flight work for [`cancel`]; omitted, the request runs uncancellable, as before.
#[napi(ts_return_type = "Promise<string>")]
pub fn request(
    repo: String,
    request_json: String,
    request_id: Option<u32>,
) -> AsyncTask<RequestTask> {
    AsyncTask::new(RequestTask {
        repo,
        request_json,
        request_id,
    })
}

pub struct RequestTask {
    repo: String,
    request_json: String,
    request_id: Option<u32>,
}

impl Task for RequestTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        Ok(match self.request_id {
            Some(id) => protocol::request_with_id(&self.repo, &self.request_json, id),
            None => protocol::request(&self.repo, &self.request_json),
        })
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
///
/// A `requestId` registers the read for [`cancel`]; a cancellation ahead of the read is honored
/// rather than answered with bytes nobody waits for any more.
#[napi(ts_return_type = "Promise<BytesAnswer>")]
pub fn request_bytes(
    repo: String,
    revision: String,
    path: String,
    request_id: Option<u32>,
) -> AsyncTask<BytesTask> {
    AsyncTask::new(BytesTask {
        repo,
        revision,
        path,
        request_id,
    })
}

pub struct BytesTask {
    repo: String,
    revision: String,
    path: String,
    request_id: Option<u32>,
}

impl Task for BytesTask {
    type Output = git_graph_core::Result<Option<Vec<u8>>>;
    type JsValue = BytesAnswer;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match self.request_id {
            Some(id) => protocol::file_bytes_with_id(&self.repo, &self.revision, &self.path, id),
            None => protocol::file_bytes(&self.repo, &self.revision, &self.path),
        })
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
    request(path, r#"{"method":"open"}"#.to_string(), None)
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

/// Cancel the request registered under `requestId` (task 2.9). The request answers the error
/// envelope `{"kind": "cancelled"}` at its next checkpoint; its repository handles and caches
/// are left intact. Cancelling an unknown id, or one whose request already finished, costs
/// nothing and affects no other request — but the cancellation is remembered for a request that
/// has not started yet, so the host scheduler's "cancel, then issue" ordering never runs
/// unwanted work.
#[napi]
pub fn cancel(request_id: u32) {
    cancel::Registry::global().cancel(request_id);
}
