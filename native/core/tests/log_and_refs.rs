//! The commit walk and the ref scan, checked against what git itself reports.

#[macro_use]
mod common;

use git_graph_core::log::{self, WalkOptions};
use git_graph_core::refs::read_refs;
use git_graph_core::repository::Repo;
use git_graph_core::types::{CommitOrdering, RefReadOptions};

use common::TestRepo;

fn open(repo: &TestRepo) -> Repo {
    Repo::discover(repo.path()).expect("could not open the fixture repository")
}

fn walk_all(repo: &TestRepo, limit: usize, ordering: CommitOrdering) -> Vec<String> {
    let engine = open(repo);
    let tips = log::all_tips(&engine, true, true).expect("could not resolve the tips");
    let options = WalkOptions {
        limit,
        ordering,
        ..Default::default()
    };
    log::walk(&engine, &tips, &options)
        .expect("the walk failed")
        .into_iter()
        .map(|record| record.hash)
        .collect()
}

#[test]
fn walks_a_linear_history_in_the_same_order_as_git() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");
    repo.commit_file("b.txt", "2", "second");
    repo.commit_file("c.txt", "3", "third");

    let expected = repo.log_hashes(&["--date-order", "--all"]);
    assert_eq!(walk_all(&repo, 100, CommitOrdering::Date), expected);
}

#[test]
fn walks_a_branching_history_in_the_same_order_as_git() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "base");
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    repo.commit_file("feature.txt", "f", "feature work");
    repo.git(&["checkout", "--quiet", "main"]);
    repo.commit_file("main.txt", "m", "main work");
    repo.git(&[
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        "merge feature",
        "feature",
    ]);

    let expected = repo.log_hashes(&["--date-order", "--all"]);
    assert_eq!(walk_all(&repo, 100, CommitOrdering::Date), expected);
}

#[test]
fn never_shows_a_parent_before_its_child() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "base");
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    repo.commit_file("f1.txt", "f", "feature one");
    repo.commit_file("f2.txt", "f", "feature two");
    repo.git(&["checkout", "--quiet", "main"]);
    repo.commit_file("m1.txt", "m", "main one");
    repo.git(&["merge", "--quiet", "--no-ff", "-m", "merge", "feature"]);

    // The invariant every one of git's orderings guarantees, and the one the graph renderer
    // depends on to lay out its lanes.
    for ordering in [
        CommitOrdering::Date,
        CommitOrdering::AuthorDate,
        CommitOrdering::Topo,
    ] {
        let hashes = walk_all(&repo, 100, ordering);
        let position: std::collections::HashMap<&str, usize> = hashes
            .iter()
            .enumerate()
            .map(|(index, hash)| (hash.as_str(), index))
            .collect();

        let engine = open(&repo);
        let git = engine.borrow();
        for hash in &hashes {
            let id = gix::ObjectId::from_hex(hash.as_bytes()).unwrap();
            let commit = git.find_commit(id).unwrap();
            for parent in commit.parent_ids() {
                let parent = parent.detach().to_string();
                if let Some(&parent_index) = position.get(parent.as_str()) {
                    assert!(
                        parent_index > position[hash.as_str()],
                        "{ordering:?}: parent {parent} was shown before its child {hash}"
                    );
                }
            }
        }
    }
}

#[test]
fn limits_the_page_to_the_requested_size() {
    require_git!();
    let mut repo = TestRepo::new();
    for index in 0..20 {
        repo.commit_file("a.txt", &index.to_string(), &format!("commit {index}"));
    }

    let hashes = walk_all(&repo, 5, CommitOrdering::Date);
    assert_eq!(hashes.len(), 5);
    assert_eq!(
        hashes,
        repo.log_hashes(&["--date-order", "--all", "--max-count=5"])
    );
}

#[test]
fn reads_the_commit_fields_the_graph_renders() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1", "the subject line\n\nthe body");

    let engine = open(&repo);
    let tips = log::all_tips(&engine, true, true).unwrap();
    let records = log::walk(
        &engine,
        &tips,
        &WalkOptions {
            limit: 10,
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record.hash, hash);
    assert_eq!(record.author, "Test User");
    assert_eq!(record.email, "test@example.com");
    // The graph's message column shows the subject only, as `git log --format=%s` does.
    assert_eq!(record.message, "the subject line");
    assert!(record.parents.is_empty());
    assert_eq!(
        record.date.to_string(),
        repo.git(&["log", "-1", "--format=%ct"]).trim()
    );
}

#[test]
fn filters_commits_by_author() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "by the default user");
    repo.git(&["config", "user.name", "Other Person"]);
    repo.git(&["config", "user.email", "other@example.com"]);
    let other = repo.commit_file("b.txt", "2", "by the other user");

    let engine = open(&repo);
    let tips = log::all_tips(&engine, true, true).unwrap();
    let options = WalkOptions {
        limit: 100,
        authors: Some(vec!["Other Person".to_string()]),
        ..Default::default()
    };
    let records = log::walk(&engine, &tips, &options).unwrap();

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].hash, other);
}

#[test]
fn filters_commits_by_path() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("src/a.txt", "1", "touches src");
    repo.commit_file("docs/b.txt", "2", "touches docs");
    repo.commit_file("src/c.txt", "3", "touches src again");

    let engine = open(&repo);
    let tips = log::all_tips(&engine, true, true).unwrap();
    let options = WalkOptions {
        limit: 100,
        filter_paths: vec!["src".to_string()],
        ..Default::default()
    };
    let records = log::walk(&engine, &tips, &options).unwrap();
    let hashes: Vec<String> = records.iter().map(|record| record.hash.clone()).collect();

    assert_eq!(
        hashes,
        repo.log_hashes(&["--format=%H", "--all", "--", "src"])
    );
}

#[test]
fn keeps_the_graph_connected_when_filtering_by_path() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("src/a.txt", "1", "touches src");
    repo.commit_file("docs/b.txt", "2", "touches docs only");
    let third = repo.commit_file("src/c.txt", "3", "touches src again");

    let engine = open(&repo);
    let tips = log::all_tips(&engine, true, true).unwrap();
    let options = WalkOptions {
        limit: 100,
        filter_paths: vec!["src".to_string()],
        ..Default::default()
    };
    let records = log::walk(&engine, &tips, &options).unwrap();

    // The docs-only commit is hidden, so the src commit above it must be re-parented onto the src
    // commit below it — otherwise the graph would render as two disconnected fragments.
    let newest = records
        .iter()
        .find(|record| record.hash == third)
        .expect("the newest commit");
    assert_eq!(
        newest.parents,
        vec![first],
        "the hidden commit was not simplified away"
    );
}

#[test]
fn reads_branches_tags_and_head() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "1", "first");
    repo.git(&["tag", "v1.0"]);
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    let second = repo.commit_file("b.txt", "2", "second");
    repo.git(&["tag", "-a", "v2.0", "-m", "annotated"]);

    let engine = open(&repo);
    let snapshot = read_refs(&engine, &RefReadOptions::default()).unwrap();

    assert_eq!(snapshot.ref_data.head.as_deref(), Some(second.as_str()));
    assert_eq!(snapshot.branch_head.as_deref(), Some("feature"));
    // The checked-out branch is listed first, as `git branch` lists it.
    assert_eq!(snapshot.branches, vec!["feature", "main"]);
    assert_eq!(snapshot.tag_names, vec!["v1.0", "v2.0"]);

    let heads: Vec<(&str, &str)> = snapshot
        .ref_data
        .heads
        .iter()
        .map(|head| (head.name.as_str(), head.hash.as_str()))
        .collect();
    assert!(heads.contains(&("main", first.as_str())));
    assert!(heads.contains(&("feature", second.as_str())));

    // A lightweight tag points straight at its commit; an annotated one only reaches its commit
    // through the peeled record, which is what carries the label in the graph.
    let lightweight = snapshot
        .ref_data
        .tags
        .iter()
        .find(|tag| tag.name == "v1.0")
        .unwrap();
    assert_eq!(lightweight.hash, first);
    assert!(!lightweight.annotated);

    let peeled = snapshot
        .ref_data
        .tags
        .iter()
        .find(|tag| tag.name == "v2.0" && tag.annotated)
        .expect("the annotated tag was not peeled");
    assert_eq!(peeled.hash, second);
}

#[test]
fn reads_remote_tracking_branches_and_honours_the_view_options() {
    require_git!();
    let mut repo = TestRepo::new();
    let head = repo.commit_file("a.txt", "1", "first");
    repo.add_fake_remote("origin", "main", &head);
    repo.update_ref("refs/remotes/origin/HEAD", &head);
    repo.update_ref("refs/remotes/upstream/main", &head);

    let engine = open(&repo);

    // Remote branches hidden entirely.
    let snapshot = read_refs(&engine, &RefReadOptions::default()).unwrap();
    assert!(snapshot.ref_data.remotes.is_empty());

    // Remote branches shown, remote HEADs hidden (the default).
    let options = RefReadOptions {
        show_remote_branches: true,
        ..Default::default()
    };
    let snapshot = read_refs(&engine, &options).unwrap();
    let names: Vec<&str> = snapshot
        .ref_data
        .remotes
        .iter()
        .map(|r| r.name.as_str())
        .collect();
    assert!(names.contains(&"origin/main"));
    assert!(names.contains(&"upstream/main"));
    assert!(
        !names.contains(&"origin/HEAD"),
        "remote HEADs should be hidden by default"
    );
    assert!(snapshot
        .branches
        .contains(&"remotes/origin/main".to_string()));

    // A hidden remote drops out completely.
    let options = RefReadOptions {
        show_remote_branches: true,
        hide_remotes: vec!["upstream".to_string()],
        ..Default::default()
    };
    let snapshot = read_refs(&engine, &options).unwrap();
    let names: Vec<&str> = snapshot
        .ref_data
        .remotes
        .iter()
        .map(|r| r.name.as_str())
        .collect();
    assert!(names.contains(&"origin/main"));
    assert!(!names.contains(&"upstream/main"));
}

#[test]
fn shows_gerrit_change_refs_only_when_asked() {
    require_git!();
    let mut repo = TestRepo::new();
    let head = repo.commit_file("a.txt", "1", "first");
    repo.add_fake_remote("origin", "main", &head);
    repo.update_ref("refs/remotes/origin/changes/45/12345/1", &head);
    repo.update_ref("refs/remotes/origin/changes/45/12345/meta", &head);

    let engine = open(&repo);

    // A Gerrit repository can hold tens of thousands of change refs, so they stay out of the
    // graph — and out of the Branches dropdown — unless "Show Refs" is on.
    let options = RefReadOptions {
        show_remote_branches: true,
        ..Default::default()
    };
    let snapshot = read_refs(&engine, &options).unwrap();
    assert!(snapshot
        .ref_data
        .remotes
        .iter()
        .all(|r| !r.name.contains("changes/")));

    let options = RefReadOptions {
        show_remote_branches: true,
        show_change_refs: true,
        ..Default::default()
    };
    let snapshot = read_refs(&engine, &options).unwrap();
    let names: Vec<&str> = snapshot
        .ref_data
        .remotes
        .iter()
        .map(|r| r.name.as_str())
        .collect();
    assert!(names.contains(&"origin/changes/45/12345/1"));
    // The NoteDb meta refs are never displayed.
    assert!(!names.iter().any(|name| name.ends_with("/meta")));
    // Change refs are never offered as branches, however they are displayed.
    assert!(snapshot
        .branches
        .iter()
        .all(|branch| !branch.contains("changes/")));
}

#[test]
fn an_empty_repository_reports_no_head_rather_than_failing() {
    require_git!();
    let repo = TestRepo::new();
    let engine = open(&repo);

    let snapshot = read_refs(&engine, &RefReadOptions::default()).unwrap();
    assert_eq!(snapshot.ref_data.head, None);
    // The unborn branch has no ref, but its name is still listed — as the CLI backend and
    // `git status` report it — so the view names the branch the first commit will land on.
    assert_eq!(snapshot.branches, vec!["main"]);
}
