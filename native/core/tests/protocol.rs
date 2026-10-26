//! The request protocol (`git_graph_core::protocol`) end to end on a fixture repository: the
//! envelope, the method table's coverage across the engine's groups, the structured error
//! contract — one JSON request in, one JSON answer out, never a panic — and the generated
//! TypeScript method map, which must match the file checked in under `src/shared/engine/`.

#[macro_use]
mod common;

use common::TestRepo;

use git_graph_core::protocol;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;

/// Both workflow tests drive the process-global handle registry (`open` / `close` / `closeAll`
/// / `openCount` share `RepoManager::global()`), and the default parallel test runner would
/// interleave them: one test's `closeAll` can drop the other's handle mid-assertion, or its
/// `open` can inflate the count the other reads. Serialize them instead.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

/// The raw envelope of one request, asserting it always parses.
fn envelope(repo_path: &str, method: &str, params: Value) -> Value {
    let mut request = json!({ "method": method });
    request["params"] = params;
    serde_json::from_str(&protocol::request(repo_path, &request.to_string()))
        .expect("the protocol always answers parseable JSON")
}

/// The `ok` value of a request that must succeed.
fn ask(repo_path: &str, method: &str, params: Value) -> Value {
    let answer = envelope(repo_path, method, params);
    match answer.get("ok") {
        Some(value) => value.clone(),
        None => panic!("{method} failed: {answer}"),
    }
}

/// The `(kind, message)` of a request that must fail.
fn error_of(answer: &Value) -> (String, String) {
    let error = answer
        .get("error")
        .unwrap_or_else(|| panic!("expected an error envelope, got {answer}"));
    (
        error["kind"].as_str().unwrap().to_string(),
        error["message"].as_str().unwrap().to_string(),
    )
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
    assert_eq!(
        error_of(&envelope(outside_path, "repoRoot", json!({}))).0,
        "notARepository"
    );

    // Malformed request JSON names itself as a contract bug.
    let answer: Value =
        serde_json::from_str(&protocol::request(outside_path, "{not json")).unwrap();
    let (kind, message) = error_of(&answer);
    assert_eq!(kind, "invalidArgument");
    assert!(message.starts_with("invalid request JSON"), "{message}");

    // An omitted params object means "no parameters".
    let answer: Value =
        serde_json::from_str(&protocol::request("", r#"{"method":"engineVersion"}"#)).unwrap();
    assert_eq!(answer["ok"], json!(git_graph_core::VERSION));

    // A repository, so the remaining lifecycle calls have something to hold.
    let mut repo = TestRepo::new();
    let _ = repo.commit_file("a.txt", "one\n", "first commit");
    let root = repo.path().to_str().unwrap();

    // An unknown method is unsupported (an older engine lacks it: the host falls back to the
    // CLI); parameters that do not fit a known method name the method.
    assert_eq!(
        error_of(&envelope(root, "noSuchMethod", json!({}))).0,
        "unsupported"
    );
    let (kind, message) = error_of(&envelope(root, "commitDetails", json!({})));
    assert_eq!(kind, "invalidArgument");
    assert!(
        message.starts_with("commitDetails: could not decode"),
        "{message}"
    );

    // open answers the root and the handle it created is counted; close drops it.
    assert_eq!(ask(root, "open", json!({})), json!(root));
    assert_eq!(ask(root, "openCount", json!({})), json!(1));
    assert_eq!(ask(root, "close", json!({})), Value::Null);
    assert_eq!(ask(root, "openCount", json!({})), json!(0));
    assert_eq!(ask(root, "closeAll", json!({})), Value::Null);
}

#[test]
fn repeated_opens_of_one_repository_share_one_handle() {
    let _registry = REGISTRY_LOCK.lock().unwrap();
    require_git!();
    let mut repo = TestRepo::new();
    let _ = repo.commit_file("a.txt", "one\n", "first commit");
    let root = repo.path().to_str().unwrap().to_string();

    // The whole point of the warm handles: a second request for the same root reuses the cached
    // handle instead of re-reading the pack indexes, and the Rust-side lifecycle functions (the
    // ones the Node binding calls) see the same count the protocol's methods answer.
    assert_eq!(protocol::open_count(), 0);
    assert_eq!(ask(&root, "open", json!({})), json!(root));
    let _again = ask(&root, "open", json!({}));
    assert_eq!(ask(&root, "openCount", json!({})), json!(1));
    assert_eq!(
        protocol::open_count(),
        1,
        "the second open reuses the warm handle"
    );

    protocol::close(&root);
    assert_eq!(protocol::open_count(), 0);
    assert_eq!(ask(&root, "openCount", json!({})), json!(0));

    // The out-of-band cancellation entry point: cancelling an id nobody registered costs nothing
    // and leaves the registry able to answer requests.
    protocol::cancel(u32::MAX);
    assert_eq!(
        ask(&root, "engineVersion", json!({})),
        json!(git_graph_core::VERSION)
    );

    protocol::close_all();
}

#[test]
fn subdirectory_requests_share_the_roots_handle() {
    let _registry = REGISTRY_LOCK.lock().unwrap();
    require_git!();
    let mut repo = TestRepo::new();
    let _ = repo.commit_file("docs/a.txt", "one\n", "first commit");
    let root = repo.path().to_str().unwrap();
    let nested = repo.path().join("docs");
    let nested = nested.to_str().unwrap();

    // Opening through a subdirectory discovers the same repository; the handle is keyed by the
    // git directory, not by the path the request named, so both spellings share one handle and
    // one object cache instead of opening a second one for the same repository.
    assert_eq!(ask(root, "open", json!({})), json!(root));
    assert_eq!(ask(nested, "open", json!({})), json!(root));
    assert_eq!(ask(root, "openCount", json!({})), json!(1));

    // The stats pair answers the cache behind that count: one row, keyed by the git directory,
    // with the idle age and the traversal-cache bytes the diagnostics command lists.
    let stats = ask(root, "engineStats", json!({}));
    assert_eq!(stats["openCount"], json!(1));
    let handles = stats["handles"].as_array().unwrap();
    assert_eq!(handles.len(), 1);
    let git_dir = handles[0]["gitDir"].as_str().unwrap();
    assert!(
        Path::new(git_dir).ends_with(".git"),
        "the handle is keyed by the git directory, got {git_dir}"
    );
    assert!(handles[0]["idleMs"].is_u64());
    assert!(handles[0]["cacheBytes"].is_u64());

    // Closing through the subdirectory drops that one shared handle.
    assert_eq!(ask(nested, "close", json!({})), Value::Null);
    assert_eq!(ask(root, "openCount", json!({})), json!(0));
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

    /* The graph page, and the view's opening load answering the same page together with the
    dropdown data from the same ref scan. */
    let page = ask(&root, "loadCommits", json!({ "maxCommits": 300 }));
    assert_eq!(page["error"], Value::Null);
    let hashes: Vec<&str> = page["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|commit| commit["hash"].as_str().unwrap())
        .collect();
    assert_eq!(hashes, [second.as_str(), first.as_str()]);
    let view = ask(&root, "loadView", json!({ "maxCommits": 300 }));
    assert_eq!(view["commits"], page, "loadView answers loadCommits' page");

    /* Refs and the opening snapshot, with the tag visible in both. */
    let info = ask(&root, "loadRepoInfo", json!({}));
    assert_eq!(info["branches"], json!(["main"]));
    assert_eq!(info["tags"], json!(["v1"]));
    assert_eq!(info["head"], json!("main"));
    assert_eq!(view["info"], info, "loadView answers loadRepoInfo's info");
    let refs = ask(&root, "loadRefs", json!({}));
    let head_names: Vec<&str> = refs["heads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|head| head["name"].as_str().unwrap())
        .collect();
    assert_eq!(head_names, ["main"]);

    /* A commit in full: details, bodies, subject, summaries, its file and its diff. */
    let details = ask(&root, "commitDetails", json!({ "hash": &second }));
    assert_eq!(details["hash"], json!(&second));
    assert_eq!(details["body"], json!("second commit"));
    assert_eq!(details["fileChanges"][0]["newFilePath"], json!("a.txt"));
    let bodies = ask(&root, "commitBodies", json!({ "hashes": [&second] }));
    assert_eq!(bodies[second.as_str()], json!("second commit"));
    assert_eq!(
        ask(&root, "commitSubject", json!({ "hash": &first })),
        json!("first commit")
    );
    let summaries = ask(&root, "commitSummaries", json!({ "hashes": [&first] }));
    assert_eq!(summaries[first.as_str()]["message"], json!("first commit"));
    let file = ask(
        &root,
        "fileContents",
        json!({ "revision": &first, "path": "a.txt" }),
    );
    assert_eq!(file["contents"], json!("one\n"));
    assert_eq!(file["binary"], json!(false));
    let diff = ask(
        &root,
        "fileDiff",
        json!({ "revision": &second, "path": "a.txt" }),
    );
    assert!(
        diff.as_str().unwrap().contains("+two"),
        "the file diff carries the added line, got {diff}"
    );

    /* Raw bytes through the binary channel: the staged copy through the `:index` revision, and
    None for a path that is not there. */
    assert_eq!(
        protocol::file_bytes(&root, &first, "a.txt").unwrap(),
        Some(b"one\n".to_vec())
    );
    assert!(
        protocol::file_bytes(&root, ":index", "a.txt")
            .unwrap()
            .is_some(),
        "the staged copy reads through the index revision"
    );
    assert_eq!(
        protocol::file_bytes(&root, &first, "no-such").unwrap(),
        None
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
        "lineCounts",
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
    let uncommitted = ask(&root, "uncommittedDetails", json!({}));
    assert!(
        !uncommitted["fileChanges"].as_array().unwrap().is_empty(),
        "the uncommitted row lists its files"
    );
    let working = ask(
        &root,
        "fileContents",
        json!({ "revision": "*", "path": "b.txt" }),
    );
    assert_eq!(working["contents"], json!("uncommitted\n"));

    /* Configuration, statistics and history. */
    assert_eq!(ask(&root, "currentBranchName", json!({})), json!("main"));
    assert_eq!(ask(&root, "remoteNames", json!({})), json!([]));
    assert_eq!(ask(&root, "submodules", json!({})), json!([]));
    assert!(ask(&root, "config", json!({}))["remotes"]
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
            json!({ "hash": &second, "showRemoteBranches": true, "includeReflogs": false, "branches": null })
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
        "the newer commit is reachable from the refs but not from an ancestor"
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
        ask(&root, "stashes", json!({})).as_array().unwrap().len(),
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

#[test]
fn every_method_decodes_its_documented_shape() {
    // Each method decodes from the minimal parameters its generated TypeScript type asks for:
    // the two halves of the contract agree for every variant.
    let stash = json!({ "selector": "stash@{0}", "baseHash": "b", "untrackedFilesHash": null });
    let minimal: Vec<(&str, Value)> = vec![
        ("engineVersion", json!({})),
        ("openCount", json!({})),
        ("engineStats", json!({})),
        ("closeAll", json!({})),
        ("repoRoot", json!({})),
        ("open", json!({})),
        ("close", json!({})),
        ("loadView", json!({})),
        ("loadRepoInfo", json!({})),
        ("loadCommits", json!({})),
        ("loadRefs", json!({})),
        ("refs", json!({})),
        (
            "annotate",
            json!({ "commits": [], "refs": {}, "showTags": true }),
        ),
        ("status", json!({})),
        (
            "countUncommittedChanges",
            json!({ "includeUntracked": true }),
        ),
        ("commitDetails", json!({ "hash": "HEAD" })),
        ("commitBodies", json!({ "hashes": [] })),
        ("commitSubject", json!({ "hash": "HEAD" })),
        ("commitSummaries", json!({ "hashes": [] })),
        ("tagDetails", json!({ "tagName": "v1" })),
        ("stashDetails", json!({ "hash": "a", "stash": stash })),
        ("uncommittedDetails", json!({})),
        ("compareCommits", json!({ "from": "a", "to": "b" })),
        (
            "lineCounts",
            json!({ "from": null, "to": "a", "paths": [] }),
        ),
        (
            "newPathOfRenamedFile",
            json!({ "commitHash": "a", "oldFilePath": "x" }),
        ),
        ("fileContents", json!({ "revision": "a", "path": "x" })),
        ("fileDiff", json!({ "revision": "a", "path": "x" })),
        ("stashes", json!({})),
        ("config", json!({})),
        ("configList", json!({ "local": true })),
        ("remoteUrl", json!({ "remote": "origin" })),
        ("remoteNames", json!({})),
        ("submodules", json!({})),
        ("currentBranchName", json!({})),
        ("currentBranchUpstream", json!({})),
        ("searchHistory", json!({ "query": "x" })),
        ("authors", json!({})),
        ("authorStats", json!({})),
        ("activityHeatmap", json!({})),
        (
            "countCommitsBefore",
            json!({ "branches": null, "hash": "a", "showRemoteBranches": true, "includeReflogs": false }),
        ),
        (
            "parseGerritMetas",
            json!({ "remote": "origin", "changes": [], "urlBase": null }),
        ),
        ("listChangeRefs", json!({ "remote": "origin" })),
    ];
    let listed: Vec<&str> = minimal.iter().map(|(method, _)| *method).collect();
    assert_eq!(
        listed,
        protocol::METHODS,
        "this table lists every protocol method, in order"
    );
    for (method, params) in &minimal {
        let request = json!({ "method": method, "params": params }).to_string();
        let decoded =
            protocol::decode_request(&request).unwrap_or_else(|error| panic!("{method}: {error}"));
        assert_eq!(decoded.method(), *method);
    }
}

#[test]
fn the_generated_typescript_is_checked_in() {
    let generated = protocol::typescript();
    assert!(generated.contains("export interface EngineMethods"));
    assert!(
        !generated.contains("bigint"),
        "integers cross as JSON numbers"
    );
    for method in protocol::METHODS {
        assert!(
            generated.contains(&format!("\t{method}: {{ params: ")),
            "{method} is in the method map"
        );
    }
    // Regenerate in place when it differs. CI runs `git diff --exit-code src/shared/engine`
    // afterwards, so a Rust type change that was not regenerated and committed fails the build.
    let path = protocol::typescript_output_path();
    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    if checked_in.replace("\r\n", "\n") != generated {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &generated).unwrap();
    }
}
