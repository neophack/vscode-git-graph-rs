//! Node-API bindings: the seam between the extension host and the Git engine.
//!
//! The ABI is deliberately tiny — seven functions. Everything the engine answers goes through
//! [`request`], one `{"method", "params"}` JSON call routed by the typed protocol table in
//! `git_graph_core::protocol`; the host's TypeScript types for it are generated from that same
//! table, so this file never changes when a method is added.
//!
//! Structured data crosses as JSON on purpose: building JavaScript objects property by property
//! costs a Node-API call *per field*, and a page of a thousand commits has tens of thousands
//! of them. Serialising once in Rust and calling `JSON.parse` once in JavaScript is faster, and it
//! keeps the ABI stable while the engine's types evolve.
//!
//! Cancellation: a call named by a `requestId` can be stopped from JavaScript with
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

use gate::{GatedAnswer, Submission};
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
        Ok(gate::gate().submit(move || match request_id {
            Some(id) => protocol::request_with_id(&repo, &request_json, id),
            None => protocol::request(&repo, &request_json),
        }))
    }

    fn resolve(&mut self, env: Env, submission: Submission) -> Result<GatedAnswer<String>> {
        Ok(match submission {
            Submission::Computed(output) => GatedAnswer::Now(output),
            Submission::Queued(id) => match gate::gate().claim(&env, id)? {
                gate::Claim::Ready(output) => GatedAnswer::Now(output),
                gate::Claim::Late(promise) => GatedAnswer::Later(promise),
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

/// Cancel the request registered under `requestId`. The request answers the error
/// envelope `{"kind": "cancelled"}` at its next checkpoint; its repository handles and caches
/// are left intact. Cancelling an unknown id, or one whose request already finished, costs
/// nothing and affects no other request — but the cancellation is remembered for a request that
/// has not started yet, so the host scheduler's "cancel, then issue" ordering never runs
/// unwanted work.
#[napi]
pub fn cancel(request_id: u32) {
    protocol::cancel(request_id);
}
