//! Node-API bindings: the seam between the extension host and the Git engine.
//!
//! The ABI is deliberately tiny — eight functions. Everything the engine answers goes through
//! [`request`], one `{"method", "params"}` JSON call routed by the typed protocol table in
//! `git_graph_core::protocol`; the host's TypeScript types for it are generated from that same
//! table, so this file never changes when a method is added.
//!
//! Structured data crosses as JSON on purpose: building JavaScript objects property by property
//! costs a Node-API call *per field*, and a page of a thousand commits has tens of thousands
//! of them. Serialising once in Rust and calling `JSON.parse` once in JavaScript is faster, and it
//! keeps the ABI stable while the engine's types evolve. Raw file bytes are the one exception:
//! [`request_bytes`] hands them over as a `Buffer`, never through a text encoding.
//!
//! Cancellation (task 2.9): a call named by a `requestId` can be stopped from JavaScript with
//! [`cancel`] — the engine's long-running loops unwind with `{"error": {"kind": "cancelled"}}`.
//! An omitted id behaves exactly as before.
//!
//! Threading: the engine computes at most two at a time, and requests beyond that wait on the
//! Rust side rather than on libuv's shared thread pool — see `gate`, which owns that policy and
//! the reasoning behind it.
//!
//! Compatibility: the asynchronous calls are `AsyncTask`s (`napi_create_async_work`, Node-API 1),
//! and the crate is built against Node-API 3 — the version VS Code 1.38's Node 10.11 offers —
//! so the oldest supported editor can load the engine too. Nothing here may need a newer Node-API
//! (the two raw calls the gate makes, `napi_create_promise` and `napi_resolve_deferred`, are
//! Node-API 1, invoked on the JavaScript thread only).

mod gate;

use gate::{EngineOutput, GatedAnswer, Submission};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use git_graph_core::protocol;

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
    type Output = Submission;
    type JsValue = GatedAnswer<String>;

    fn compute(&mut self) -> Result<Submission> {
        // The strings move into the job (a queued job outlives this call), so take them rather
        // than cloning what is about to be nobody's.
        let repo = std::mem::take(&mut self.repo);
        let request_json = std::mem::take(&mut self.request_json);
        let request_id = self.request_id;
        Ok(gate::gate().submit(move || {
            EngineOutput::Envelope(match request_id {
                Some(id) => protocol::request_with_id(&repo, &request_json, id),
                None => protocol::request(&repo, &request_json),
            })
        }))
    }

    fn resolve(&mut self, env: Env, submission: Submission) -> Result<GatedAnswer<String>> {
        Ok(match submission {
            Submission::Computed(output) => GatedAnswer::Now(envelope_of(output)),
            Submission::Queued(id) => match gate::gate().claim(&env, id)? {
                gate::Claim::Ready(output) => GatedAnswer::Now(envelope_of(output)),
                gate::Claim::Late(promise) => GatedAnswer::Later(promise),
            },
        })
    }
}

/// The envelope of an output this task knows is a protocol answer.
fn envelope_of(output: EngineOutput) -> String {
    match output {
        EngineOutput::Envelope(answer) => answer,
        EngineOutput::Bytes(_) => r#"{"error":{"kind":"internal","message":"the engine gate handed a byte read to a protocol request"}}"#.to_owned(),
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
    type Output = Submission;
    type JsValue = GatedAnswer<BytesAnswer>;

    fn compute(&mut self) -> Result<Submission> {
        let repo = std::mem::take(&mut self.repo);
        let revision = std::mem::take(&mut self.revision);
        let path = std::mem::take(&mut self.path);
        let request_id = self.request_id;
        Ok(gate::gate().submit(move || {
            EngineOutput::Bytes(match request_id {
                Some(id) => protocol::file_bytes_with_id(&repo, &revision, &path, id),
                None => protocol::file_bytes(&repo, &revision, &path),
            })
        }))
    }

    fn resolve(&mut self, env: Env, submission: Submission) -> Result<GatedAnswer<BytesAnswer>> {
        Ok(match submission {
            Submission::Computed(output) => GatedAnswer::Now(bytes_answer(bytes_of(output))),
            Submission::Queued(id) => match gate::gate().claim(&env, id)? {
                gate::Claim::Ready(output) => GatedAnswer::Now(bytes_answer(bytes_of(output))),
                gate::Claim::Late(promise) => GatedAnswer::Later(promise),
            },
        })
    }
}

/// The raw result of an output this task knows is a byte read.
fn bytes_of(output: EngineOutput) -> git_graph_core::Result<Option<Vec<u8>>> {
    match output {
        EngineOutput::Bytes(result) => result,
        EngineOutput::Envelope(_) => Err(git_graph_core::Error::internal(
            "the engine gate handed a protocol request to a byte read",
        )),
    }
}

/// The answer shape of [`request_bytes`] — shared by its own `resolve` and by the delivery
/// sentinel, which settles queued byte reads on the JavaScript thread for it.
pub(crate) fn bytes_answer(output: git_graph_core::Result<Option<Vec<u8>>>) -> BytesAnswer {
    match output {
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
    }
}

/// Open a repository and keep its handle warm; resolves to the repository root.
#[napi(ts_return_type = "Promise<string>")]
pub fn open(path: String) -> AsyncTask<RequestTask> {
    request(path, r#"{"method":"open"}"#.to_string(), None)
}

/// Drop a repository handle, releasing its object cache and open pack files.
#[napi]
#[allow(clippy::needless_pass_by_value)] // the parameter crosses the Node-API boundary, where `String` is the idiom
pub fn close(path: String) {
    protocol::close(&path);
}

/// Drop every repository handle.
#[napi]
pub fn close_all() {
    protocol::close_all();
}

/// How many repositories are currently open. Exposed for the tests and for diagnostics.
#[napi]
pub fn open_count() -> u32 {
    protocol::open_count() as u32
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
    protocol::cancel(request_id);
}
