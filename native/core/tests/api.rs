//! The library façade (`git_graph_core::api::Engine`) end to end on a fixture repository: the
//! calls a host makes to draw a graph, show a commit, diff, read a file at a revision and list
//! the working tree's state, all through the one public interface file.

#[macro_use]
mod common;

use git_graph_core::api::{Engine, GraphOptions, INDEX, WORKING_TREE};
use git_graph_core::types::GitFileStatus;

use common::TestRepo;

#[test]
fn the_engine_facade_covers_the_host_workflow() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "one\n", "first commit");
    repo.git(&["tag", "v1"]);
    let second = repo.commit_file("a.txt", "one\ntwo\n", "second commit");
    repo.git(&["add", "-A"]);
    repo.write("a.txt", "one\ntwo\nthree\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "one\ntwo\nthree\nfour\n");
    repo.write("new.txt", "untracked\n");

    // Opening works from a sub-path and resolves to the root.
    std::fs::create_dir_all(repo.path().join("sub")).unwrap();
    let engine = Engine::open(repo.path().join("sub")).unwrap();
    assert_eq!(engine.root().file_name(), repo.path().file_name());
    assert!(engine.root().join("a.txt").is_file());
    assert!(!engine.is_bare());

    // The graph: two commits plus the uncommitted-changes row, newest first, tag attached.
    let page = engine.graph(&GraphOptions::default()).unwrap();
    let hashes: Vec<&str> = page.commits.iter().map(|c| c.hash.as_str()).collect();
    assert_eq!(hashes, [WORKING_TREE, second.as_str(), first.as_str()]);
    assert_eq!(page.commits[2].tags[0].name, "v1");
    assert_eq!(page.head.as_deref(), Some(second.as_str()));
    assert!(!page.more_commits_available);

    let info = engine.info(&GraphOptions::default()).unwrap();
    assert_eq!(info.branches, ["main"]);
    assert_eq!(info.tags, ["v1"]);
    assert_eq!(engine.current_branch().unwrap().as_deref(), Some("main"));

    // Commit details and the files it touched.
    let details = engine.commit(&second).unwrap();
    assert_eq!(details.body.trim_end(), "second commit");
    let files = engine.commit_files(&second).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].new_file_path, "a.txt");
    assert_eq!(files[0].kind, GitFileStatus::Modified);
    assert!(engine.file_diff(&second, "a.txt").unwrap().contains("+two"));

    // A file at every kind of revision.
    assert_eq!(
        engine.file(&first, "a.txt").unwrap().contents.as_deref(),
        Some("one\n")
    );
    assert_eq!(
        engine.file(INDEX, "a.txt").unwrap().contents.as_deref(),
        Some("one\ntwo\nthree\n")
    );
    assert_eq!(
        engine
            .file(WORKING_TREE, "a.txt")
            .unwrap()
            .contents
            .as_deref(),
        Some("one\ntwo\nthree\nfour\n")
    );

    // The working tree's state, as a Source Control view lists it.
    assert!(engine.is_dirty().unwrap());
    let status = engine.status().unwrap();
    let a = status.iter().find(|c| c.path == "a.txt").unwrap();
    assert_eq!(
        (a.staged, a.unstaged, a.conflicted),
        (Some("modified"), Some("modified"), false)
    );
    let new = status.iter().find(|c| c.path == "new.txt").unwrap();
    assert!(new.untracked);

    // Diffs between revisions, and history search.
    let changes = engine.diff(&first, &second).unwrap();
    assert_eq!(changes[0].new_file_path, "a.txt");
    let hits = engine.search_history("second").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(engine.commit_subject(&first).unwrap(), "first commit");
    assert_eq!(engine.authors().unwrap()[0].name, "Test User");

    engine.close();
}
