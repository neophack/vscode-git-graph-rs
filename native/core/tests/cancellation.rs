//! Cooperative cancellation (refactor plan, task 2.9), end to end through the protocol.
//!
//! The long-running requests — the graph walk above all — must unwind promptly when the host
//! cancels them, and a cancellation must cost nothing that outlives it: the repository handles
//! stay warm, the caches stay populated, and re-issuing the request answers exactly what it
//! answered before. These tests pin both halves on a generated large fixture.

#[macro_use]
mod common;

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use common::TestRepo;
use git_graph_core::protocol;
use git_graph_core::IncrementalStore;
use serde_json::Value;

/// These tests share the process-global registries (repository handles, cancellation ids) with
/// each other; the default parallel test runner would interleave them. Serialize them instead,
/// as `tests/protocol.rs` does for the same reason.
static CANCELLATION_LOCK: Mutex<()> = Mutex::new(());

/// A deep linear fixture: enough commits that a full traversal runs for far longer than the
/// cancellation needs to arrive, on every machine this suite runs on.
fn large_repo(commits: usize) -> TestRepo {
    let mut repo = TestRepo::new();
    repo.commit_linear_history(commits);
    repo
}

/// One protocol request against `repo`, as the Node binding sends it.
fn ask(repo: &TestRepo, method: &str, params: Value) -> String {
    let request = serde_json::json!({ "method": method, "params": params });
    protocol::request(repo.path().to_str().unwrap(), &request.to_string())
}

/// The same request, named by an id the test can cancel.
fn ask_cancellable(repo: &TestRepo, method: &str, params: Value, id: u32) -> String {
    let request = serde_json::json!({ "method": method, "params": params });
    protocol::request_with_id(repo.path().to_str().unwrap(), &request.to_string(), id)
}

/// The request a worker thread runs: owned root and JSON, so the closure outlives this frame.
fn owned_cancellable(
    repo: &TestRepo,
    method: &str,
    params: Value,
    id: u32,
) -> impl FnOnce() -> String {
    let root = repo.path().to_str().unwrap().to_string();
    let request = serde_json::json!({ "method": method, "params": params }).to_string();
    move || protocol::request_with_id(&root, &request, id)
}

/// The `(kind, message)` of an answer that must be the error envelope.
fn error_kind(answer: &str) -> String {
    let value: Value = serde_json::from_str(answer).expect("the protocol always answers JSON");
    value["error"]["kind"]
        .as_str()
        .unwrap_or_else(|| panic!("expected an error envelope, got {answer}"))
        .to_string()
}

/// Run `request` on another thread, cancel it after `delay`, and answer `(reply, how long the
/// unwind took after the cancellation)`. The request is a closure so that it really starts on
/// the worker thread — evaluating it on this thread would finish it before any cancellation.
fn cancel_while_running<R, F>(request: F, id: u32, delay: Duration) -> (String, Duration)
where
    R: Into<String>,
    F: FnOnce() -> R + Send + 'static,
{
    let worker = thread::spawn(move || request().into());
    thread::sleep(delay);
    let cancelled_at = Instant::now();
    protocol::cancel(id);
    let reply = worker.join().expect("the request thread panicked");
    (reply, cancelled_at.elapsed())
}

#[test]
fn cancelling_a_full_traversal_answers_cancelled_promptly() {
    let _lock = CANCELLATION_LOCK.lock().unwrap();
    require_git!();
    let repo = large_repo(50_000);

    // A full-page walk: the window (twice the page) covers the whole history, so the traversal
    // itself is what runs long — the very thing cancellation exists for.
    let (reply, unwind) = cancel_while_running(
        owned_cancellable(
            &repo,
            "loadCommits",
            serde_json::json!({ "maxCommits": 50_000 }),
            101,
        ),
        101,
        Duration::from_millis(20),
    );

    assert_eq!(
        error_kind(&reply),
        "cancelled",
        "the walk unwound, not answered"
    );
    // The plan's bound is ≤ 10 ms; the assertion leaves two orders of magnitude for a loaded CI
    // machine while still proving the walk stopped (an uncancellable walk of 50 000 commits
    // cannot finish anywhere near this bound — see the identical re-issue test below).
    assert!(
        unwind < Duration::from_millis(500),
        "the traversal took {unwind:?} to notice the cancellation"
    );
    eprintln!("cancellation noticed after {unwind:?}");
}

#[test]
fn a_cancelled_request_reissues_identically_and_the_id_is_reusable() {
    let _lock = CANCELLATION_LOCK.lock().unwrap();
    require_git!();
    let repo = large_repo(50_000);
    let root = repo.path().to_str().unwrap();
    let params = serde_json::json!({ "maxCommits": 50_000 });

    // The never-cancelled answer: what the same request must answer again after a cancellation.
    let reference = ask(&repo, "loadCommits", params.clone());
    assert!(
        serde_json::from_str::<Value>(&reference).unwrap()["ok"]["commits"]
            .as_array()
            .unwrap()
            .len()
            == 50_000,
        "the reference traversal really walked the whole fixture"
    );

    let handles_before = protocol::request(root, r#"{"method":"openCount","params":{}}"#);

    // The reference load above cached its traversal (task 2.10): a repeat load of unchanged
    // refs is answered from that cache in milliseconds and legitimately completes before any
    // cancellation could arrive. This test's subject is cancelling a real walk, so the cached
    // traversal is dropped first.
    IncrementalStore::global().invalidate(repo.path());
    // Cancel a run of the same request under id 202, then re-issue it under the SAME id — the
    // registry must not still carry the cancellation, or the id would be unusable.
    let (reply, _) = cancel_while_running(
        owned_cancellable(&repo, "loadCommits", params.clone(), 202),
        202,
        Duration::from_millis(20),
    );
    assert_eq!(error_kind(&reply), "cancelled");
    let reissued = ask_cancellable(&repo, "loadCommits", params.clone(), 202);
    assert_eq!(
        serde_json::from_str::<Value>(&reissued).unwrap()["ok"],
        serde_json::from_str::<Value>(&reference).unwrap()["ok"],
        "re-issuing the cancelled request answers what it answered before"
    );

    // Cancellation left no trace on the engine: the same handle count, and a fresh handle (what
    // a workspace-changed event makes the host build) answers the same bytes again.
    assert_eq!(
        protocol::request(root, r#"{"method":"openCount","params":{}}"#),
        handles_before,
        "cancellation dropped no repository handle"
    );
    protocol::request(root, r#"{"method":"closeAll","params":{}}"#);
    let fresh = ask(&repo, "loadCommits", params);
    assert_eq!(
        serde_json::from_str::<Value>(&fresh).unwrap()["ok"],
        serde_json::from_str::<Value>(&reference).unwrap()["ok"],
        "a fresh engine answers the same traversal identically"
    );
}

#[test]
fn a_cancellation_ahead_of_its_request_is_honored_and_a_stray_one_harms_nothing() {
    let _lock = CANCELLATION_LOCK.lock().unwrap();
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "one\n", "first");
    let params = serde_json::json!({ "maxCommits": 100 });

    // Cancelling an id no request carries is remembered for the request that later runs under
    // it: the host scheduler's "cancel, then issue" ordering must not run unwanted work.
    protocol::cancel(3000);
    let reply = ask_cancellable(&repo, "loadCommits", params.clone(), 3000);
    assert_eq!(error_kind(&reply), "cancelled");

    // It says nothing about any other id: an unrelated request answers normally, before and
    // after the stray cancellation, with the same bytes as the unnamed request.
    let reference = ask(&repo, "loadCommits", params.clone());
    let untouched = ask_cancellable(&repo, "loadCommits", params, 3001);
    assert_eq!(
        serde_json::from_str::<Value>(&untouched).unwrap()["ok"],
        serde_json::from_str::<Value>(&reference).unwrap()["ok"]
    );
}

#[test]
fn every_cancellable_request_unwinds_not_only_the_walk() {
    let _lock = CANCELLATION_LOCK.lock().unwrap();
    require_git!();
    let repo = large_repo(20_000);

    // The same proof for the other long-running requests: history search (which must walk until
    // it has matched 100 commits — this pattern matches nothing, so it walks all of history),
    // the statistics walks, and the commit counting walk.
    for (id, method, params) in [
        (
            401u32,
            "searchHistory",
            serde_json::json!({ "query": "no-such-commit-message" }),
        ),
        (402, "authorStats", serde_json::json!({})),
        (403, "activityHeatmap", serde_json::json!({})),
        (
            404,
            "countCommitsBefore",
            serde_json::json!({ "hash": "HEAD~1", "showRemoteBranches": true, "includeReflogs": false, "branches": null }),
        ),
    ] {
        let (reply, unwind) = cancel_while_running(
            owned_cancellable(&repo, method, params, id),
            id,
            Duration::from_millis(10),
        );
        assert_eq!(error_kind(&reply), "cancelled", "{method} did not unwind");
        assert!(
            unwind < Duration::from_millis(500),
            "{method} took {unwind:?} to notice the cancellation"
        );
    }
}
