//! The single dispatch surface (`git_graph_core::dispatch::request`) end to end on a fixture
//! repository: the wire shape, the method table's coverage across the engine's groups, and the
//! in-band error contract — one JSON request in, one JSON answer out, never a panic and never a
//! null, for every front end that shares this table (the Node addon's `request`).

#[macro_use]
mod common;

use common::TestRepo;

use git_graph_core::dispatch;
use serde_json::{json, Value};
use std::sync::Mutex;

/// Both tests in this file drive the process-global handle registry (`open` / `close` /
/// `closeAll` / `openCount` share `RepoManager::global()`), and the default parallel test runner
/// would interleave them: one test's `closeAll` can drop the other's handle mid-assertion, or
/// its `open` can inflate the count the other reads. Serialize them instead.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

/// Ask the dispatcher, asserting it always answers parseable JSON.
fn ask(repo_path: &str, method: &str, params: Value) -> Value {
    let request = json!({ "method": method, "params": params });
    serde_json::from_str(&dispatch::request(repo_path, &request.to_string()))
        .expect("the dispatcher always answers parseable JSON")
}

/// The `{"error": "Kind: message"}` string of an answer that carries one.
fn error_of(answer: &Value) -> String {
    answer
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("expected an in-band error, got {answer}"))
        .to_string()
}

#[test]
fn lifecycle_meta_and_errors_answer_in_band() {
    let _registry = REGISTRY_LOCK.lock().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside_path = outside.path().to_str().unwrap();

    // The two calls that need no repository at all.
    assert_eq!(
        ask("", "engineVersion", json!({})),
        json!(git_graph_core::VERSION)
    );
    assert_eq!(ask("", "openCount", json!({})), json!(0));

    // A path outside any repository answers an error; it never panics and never throws.
    assert!(
        error_of(&ask(outside_path, "repoRoot", json!({}))).starts_with("NotARepository: "),
        "a path outside a repository answers NotARepository"
    );

    // Malformed request JSON names itself as a contract bug.
    let answer = dispatch::request(outside_path, "{not json");
    assert!(
        answer.starts_with("{\"error\":\"InvalidArgument: invalid request JSON"),
        "malformed JSON answers InvalidArgument, got {answer}"
    );

    // A repository, so the remaining lifecycle calls have something to hold.
    let mut repo = TestRepo::new();
    let _ = repo.commit_file("a.txt", "one\n", "first commit");
    let root = repo.path().to_str().unwrap();

    // An unknown method and malformed parameters name themselves, with the kind prefix the
    // typed boundaries throw.
    let answer = ask(root, "noSuchMethod", json!({}));
    assert!(error_of(&answer).starts_with("Unsupported: "), "{answer}");
    let answer = ask(root, "loadCommitDetails", json!({}));
    assert!(
        error_of(&answer).starts_with("InvalidArgument: loadCommitDetails: could not decode"),
        "{answer}"
    );

    // open answers the root and the handle it created is counted; close drops it.
    let answer = ask(root, "open", json!({}));
    assert_eq!(answer["root"].as_str(), Some(root));
    assert_eq!(ask(root, "openCount", json!({})), json!(1));
    assert_eq!(ask(root, "close", json!({})), Value::Null);
    assert_eq!(ask(root, "openCount", json!({})), json!(0));
    assert_eq!(ask(root, "closeAll", json!({})), Value::Null);
}

#[test]
fn the_table_covers_the_host_workflow() {
    let _registry = REGISTRY_LOCK.lock().unwrap();
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "one\n", "first commit");
    repo.git(&["tag", "v1"]);
    let second = repo.commit_file("a.txt", "one\ntwo\n", "second commit");
    let root = repo.path().to_str().unwrap().to_string();

    /* The graph page, both through the Engine-level alias and the fine-grained read. The
    fine-grained read takes the LogOptions the typed boundary takes, page size included. */
    let page = ask(&root, "loadCommits", json!({ "maxCommits": 300 }));
    assert_eq!(page["error"], Value::Null);
    let hashes: Vec<&str> = page["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|commit| commit["hash"].as_str().unwrap())
        .collect();
    assert_eq!(hashes, [second.as_str(), first.as_str()]);
    let graph = ask(&root, "graph", json!({}));
    assert_eq!(
        graph["commits"].as_array().unwrap().len(),
        2,
        "the Engine-level alias answers the same repository"
    );

    /* Refs and the opening snapshot, with the tag visible in both. */
    let info = ask(&root, "loadRepoInfo", json!({}));
    assert_eq!(info["branches"], json!(["main"]));
    assert_eq!(info["tags"], json!(["v1"]));
    assert_eq!(info["head"], json!("main"));
    let refs = ask(&root, "loadRefs", json!({}));
    let head_names: Vec<&str> = refs["heads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|head| head["name"].as_str().unwrap())
        .collect();
    assert_eq!(head_names, ["main"]);
    let snapshot = ask(&root, "refs", json!({}));
    assert!(
        snapshot["branches"].as_array().is_some(),
        "the Engine-level alias answers the full snapshot"
    );

    /* A commit in full: details, bodies, subject, summaries, its file and its diff. */
    let details = ask(&root, "loadCommitDetails", json!({ "hash": &second }));
    assert_eq!(details["hash"], json!(&second));
    assert_eq!(details["body"], json!("second commit"));
    assert_eq!(details["fileChanges"][0]["newFilePath"], json!("a.txt"));
    let bodies = ask(&root, "loadCommitBodies", json!({ "hashes": [&second] }));
    assert_eq!(bodies[second.as_str()], json!("second commit"));
    assert_eq!(
        ask(&root, "loadCommitSubject", json!({ "hash": &first })),
        json!("first commit")
    );
    let summaries = ask(&root, "loadCommitSummaries", json!({ "hashes": [&first] }));
    assert_eq!(summaries[first.as_str()]["message"], json!("first commit"));
    let file = ask(
        &root,
        "loadCommitFile",
        json!({ "commitHash": &first, "file": "a.txt" }),
    );
    assert_eq!(file["contents"], json!("one\n"));
    assert_eq!(file["binary"], json!(false));
    let diff = ask(
        &root,
        "loadCommitFileDiff",
        json!({ "commitHash": &second, "file": "a.txt" }),
    );
    assert!(
        diff.as_str().unwrap().contains("+two"),
        "the file diff carries the added line, got {diff}"
    );

    /* Raw bytes: base64 across the JSON boundary, binary content included, the staged copy
    through the `:index` revision, and null for a path that is not there. */
    let bytes = ask(
        &root,
        "fileBytes",
        json!({ "revision": &first, "path": "a.txt" }),
    );
    assert_eq!(bytes["bytes"], json!("b25lCg==")); // base64 of "one\n"
    let staged = ask(
        &root,
        "fileBytes",
        json!({ "revision": ":index", "path": "a.txt" }),
    );
    assert!(
        staged["bytes"].is_string(),
        "the staged copy reads through the index revision"
    );
    assert_eq!(
        ask(
            &root,
            "fileBytes",
            json!({ "revision": &first, "path": "no-such" })
        )["bytes"],
        json!(null)
    );

    /* Diffs and line counts between the two revisions. */
    let changed = ask(
        &root,
        "compareCommits",
        json!({ "from": &first, "to": &second }),
    );
    assert_eq!(changed[0]["newFilePath"], json!("a.txt"));
    let counts = ask(
        &root,
        "loadLineCounts",
        json!({ "from": &first, "to": &second, "paths": ["a.txt"] }),
    );
    assert_eq!(counts["a.txt"]["additions"], json!(1));
    assert_eq!(counts["a.txt"]["deletions"], json!(0));

    /* The working tree, before and after an uncommitted change. */
    assert_eq!(
        ask(
            &root,
            "countUncommittedChanges",
            json!({ "includeUntracked": true })
        ),
        json!(0)
    );
    assert!(ask(&root, "status", json!({}))
        .as_array()
        .unwrap()
        .is_empty());
    repo.write("b.txt", "uncommitted\n");
    assert_eq!(
        ask(
            &root,
            "countUncommittedChanges",
            json!({ "includeUntracked": true })
        ),
        json!(1)
    );
    assert_eq!(
        ask(
            &root,
            "countUncommittedChanges",
            json!({ "includeUntracked": false })
        ),
        json!(0)
    );
    let changes = ask(&root, "status", json!({}));
    assert_eq!(changes[0]["path"], json!("b.txt"));
    let uncommitted = ask(&root, "loadUncommittedDetails", json!({}));
    assert!(
        !uncommitted["fileChanges"].as_array().unwrap().is_empty(),
        "the uncommitted row lists its files"
    );

    /* Configuration, statistics and history. */
    assert_eq!(ask(&root, "currentBranchName", json!({})), json!("main"));
    assert_eq!(ask(&root, "remoteNames", json!({})), json!([]));
    assert_eq!(ask(&root, "submodules", json!({})), json!([]));
    assert!(ask(&root, "loadConfig", json!({}))["remotes"]
        .as_array()
        .is_some());
    assert!(
        ask(&root, "configList", json!({ "local": true })).is_object(),
        "configList answers the key/value map of one location"
    );
    let authors = ask(&root, "authors", json!({}));
    assert_eq!(authors[0]["name"], json!("Test User"));
    assert_eq!(ask(&root, "authorStats", json!({}))[0]["commits"], json!(2));
    assert!(
        !ask(&root, "activityHeatmap", json!({}))
            .as_array()
            .unwrap()
            .is_empty(),
        "the heatmap carries the fixture's commit activity"
    );
    let matches = ask(&root, "searchHistory", json!({ "query": "first" }));
    assert_eq!(matches[0]["hash"], json!(&first));
    assert_eq!(
        ask(
            &root,
            "countCommitsBefore",
            json!({ "hash": &second, "showRemoteBranches": true, "includeReflogs": false })
        ),
        json!(0),
        "the head commit already reaches everything the shown refs do"
    );
    assert_eq!(
        ask(
            &root,
            "countCommitsBefore",
            json!({ "hash": &first, "showRemoteBranches": true, "includeReflogs": false, "branches": null })
        ),
        json!(1),
        "the newer commit is reachable from the refs but not from an ancestor; an explicit null optional rides the same way as an omitted one"
    );

    /* A remote, without a network: the remote-tracking ref is written directly. The warm handle
    predates it, so the test drops the handle first — what a workspace-changed event makes a
    host do — and the fresh open sees the new remote. */
    repo.add_fake_remote("origin", "main", &second);
    ask(&root, "close", json!({}));
    assert_eq!(ask(&root, "remoteNames", json!({})), json!(["origin"]));
    assert_eq!(
        ask(&root, "remoteUrl", json!({ "remote": "origin" })),
        json!("https://example.invalid/repo.git")
    );

    /* A stash, and the Gerrit reads (empty here — the routing is what is under test). */
    repo.git(&["add", "-A"]);
    repo.git(&[
        "stash",
        "push",
        "--quiet",
        "--include-untracked",
        "--message",
        "wip",
    ]);
    assert_eq!(
        ask(&root, "loadStashes", json!({}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        ask(&root, "listChangeRefs", json!({ "remote": "origin" })),
        json!([])
    );

    /* repoRoot answers without opening a handle: after closeAll, the count stays at zero. */
    ask(&root, "closeAll", json!({}));
    assert_eq!(ask(&root, "repoRoot", json!({})), json!(root));
    assert_eq!(ask(&root, "openCount", json!({})), json!(0));
}
