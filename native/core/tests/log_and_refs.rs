//! The commit walk and the ref scan, checked against what git itself reports.
//!
//! The walk is exercised through the `loadCommits` request the view sends — the page is cut from
//! the same walk the graph renders, so ordering, filtering and re-parenting all show up in it.

#[macro_use]
mod common;

use git_graph_core::model::{CommitOrdering, GitCommitData, LogOptions, RefOptions, RefSnapshot};

use common::TestRepo;

/// The load options that walk every ref the view shows (`git log --all`).
fn all_refs(max_commits: u32, ordering: CommitOrdering) -> LogOptions {
    LogOptions {
        max_commits,
        show_tags: true,
        show_remote_branches: true,
        show_commits_only_referenced_by_tags: true,
        commit_ordering: ordering,
        ..Default::default()
    }
}

fn load(repo: &TestRepo, options: &LogOptions) -> GitCommitData {
    common::ask(repo, "loadCommits", options)
}

fn walk_all(repo: &TestRepo, limit: u32, ordering: CommitOrdering) -> Vec<String> {
    load(repo, &all_refs(limit, ordering))
        .commits
        .into_iter()
        .map(|commit| commit.hash)
        .collect()
}

/// One ref scan, through the `refs` request the refs-only refresh sends. The options are the
/// wire form; `show_stashes` is not part of the raw scan and is ignored by it.
fn read_refs(repo: &TestRepo, options: &RefOptions) -> RefSnapshot {
    common::ask(repo, "refs", options)
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
    // depends on to lay out its lanes. git itself names each commit's real parents.
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

        for hash in &hashes {
            let parents = repo.git(&["log", "-1", "--format=%P", hash]);
            for parent in parents.split_whitespace() {
                if let Some(&parent_index) = position.get(parent) {
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

    let data = load(&repo, &all_refs(10, CommitOrdering::Date));

    assert_eq!(data.commits.len(), 1);
    let record = &data.commits[0];
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

    let options = LogOptions {
        authors: Some(vec!["Other Person".to_string()]),
        ..all_refs(100, CommitOrdering::Date)
    };
    let data = load(&repo, &options);

    assert_eq!(data.commits.len(), 1);
    assert_eq!(data.commits[0].hash, other);
}

#[test]
fn filters_commits_by_path() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("src/a.txt", "1", "touches src");
    repo.commit_file("docs/b.txt", "2", "touches docs");
    repo.commit_file("src/c.txt", "3", "touches src again");

    let options = LogOptions {
        filter_paths: vec!["src".to_string()],
        ..all_refs(100, CommitOrdering::Date)
    };
    let hashes: Vec<String> = load(&repo, &options)
        .commits
        .into_iter()
        .map(|commit| commit.hash)
        .collect();

    assert_eq!(
        hashes,
        repo.log_hashes(&["--format=%H", "--all", "--", "src"])
    );
}

#[test]
fn filters_commits_by_a_single_file_path() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("src/keep.txt", "1", "base");
    let added = repo.commit_file("src/watched.txt", "1", "add the watched file");
    // A sibling changing must not read as the watched file changing, even though both commits
    // rewrite the same directory tree.
    repo.commit_file("src/keep.txt", "2", "touch only the sibling");
    repo.remove("src/watched.txt");
    let removed = repo.commit("remove the watched file");

    let options = LogOptions {
        filter_paths: vec!["src/watched.txt".to_string()],
        ..all_refs(100, CommitOrdering::Date)
    };
    let hashes: Vec<String> = load(&repo, &options)
        .commits
        .into_iter()
        .map(|commit| commit.hash)
        .collect();

    assert_eq!(
        hashes,
        repo.log_hashes(&["--format=%H", "--all", "--", "src/watched.txt"])
    );
    assert_eq!(hashes, vec![removed, added]);
}

#[test]
fn filters_commits_by_several_paths_at_once() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("src/a.txt", "1", "base");
    let second = repo.commit_file("docs/b.txt", "2", "docs");
    repo.commit_file("src/c.txt", "3", "src");
    repo.commit_file("other/d.txt", "4", "neither of the filtered paths");

    let options = LogOptions {
        filter_paths: vec!["src/a.txt".to_string(), "docs/b.txt".to_string()],
        ..all_refs(100, CommitOrdering::Date)
    };
    let hashes: Vec<String> = load(&repo, &options)
        .commits
        .into_iter()
        .map(|commit| commit.hash)
        .collect();

    assert_eq!(
        hashes,
        repo.log_hashes(&["--format=%H", "--all", "--", "src/a.txt", "docs/b.txt"])
    );
    assert_eq!(hashes, vec![second, first]);
}

#[test]
fn a_mode_change_counts_as_a_change_to_the_file() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("run.sh", "1", "base");
    // The filesystem cannot carry the bit everywhere, so the index is told directly — the mode is
    // part of a tree entry, and a commit that only flips it is in the file's history.
    repo.git(&["config", "core.filemode", "false"]);
    repo.git(&["update-index", "--chmod=+x", "run.sh"]);
    let flipped = repo.commit("make the file executable");

    let options = LogOptions {
        filter_paths: vec!["run.sh".to_string()],
        ..all_refs(100, CommitOrdering::Date)
    };
    let hashes: Vec<String> = load(&repo, &options)
        .commits
        .into_iter()
        .map(|commit| commit.hash)
        .collect();

    assert_eq!(
        hashes,
        repo.log_hashes(&["--format=%H", "--all", "--", "run.sh"])
    );
    assert!(hashes.contains(&flipped));
}

#[test]
fn a_merge_carrying_a_branchs_changes_in_stays_out_of_the_filtered_log() {
    require_git!();
    let mut repo = TestRepo::new();
    let base = repo.commit_file("src/a.txt", "1", "base");
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    let feature = repo.commit_file("src/feature.txt", "f", "feature work");
    repo.git(&["checkout", "--quiet", "main"]);
    let main = repo.commit_file("docs/main.txt", "m", "main work");
    repo.git(&[
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        "merge feature",
        "feature",
    ]);

    // The merge is treesame to the feature side for src, and to the main side for docs, so neither
    // filtered log shows it — matching `git log -- <path>`, which simplifies it away.
    for (path, expected) in [("src", vec![feature, base.clone()]), ("docs", vec![main])] {
        let options = LogOptions {
            filter_paths: vec![path.to_string()],
            ..all_refs(100, CommitOrdering::Date)
        };
        let hashes: Vec<String> = load(&repo, &options)
            .commits
            .into_iter()
            .map(|commit| commit.hash)
            .collect();
        assert_eq!(hashes, expected, "filtering by {path}");
        assert_eq!(
            hashes,
            repo.log_hashes(&["--format=%H", "--all", "--", path]),
            "git disagrees about filtering by {path}"
        );
    }
}

#[test]
fn keeps_reparenting_when_the_author_filter_hides_the_commits_between() {
    require_git!();
    let mut repo = TestRepo::new();
    let base = repo.commit_file("src/a.txt", "1", "by the default user");
    repo.git(&["config", "user.name", "Other Person"]);
    repo.git(&["config", "user.email", "other@example.com"]);
    repo.commit_file("docs/b.txt", "2", "by the other user");
    repo.git(&["config", "user.name", "Test User"]);
    repo.git(&["config", "user.email", "test@example.com"]);
    let top = repo.commit_file("src/c.txt", "3", "by the default user again");

    let options = LogOptions {
        authors: Some(vec!["Test User".to_string()]),
        filter_paths: vec!["src".to_string()],
        ..all_refs(100, CommitOrdering::Date)
    };
    let data = load(&repo, &options);
    let hashes: Vec<String> = data
        .commits
        .iter()
        .map(|commit| commit.hash.clone())
        .collect();

    // The other user's commit was read by the walk even though both filters hid it — that is what
    // lets the src commit above it find its nearest shown ancestor, the base commit.
    assert_eq!(hashes, vec![top, base.clone()]);
    assert_eq!(data.commits[0].parents, vec![base]);
}

#[test]
fn keeps_the_graph_connected_when_filtering_by_path() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("src/a.txt", "1", "touches src");
    repo.commit_file("docs/b.txt", "2", "touches docs only");
    let third = repo.commit_file("src/c.txt", "3", "touches src again");

    let options = LogOptions {
        filter_paths: vec!["src".to_string()],
        ..all_refs(100, CommitOrdering::Date)
    };
    let data = load(&repo, &options);

    // The docs-only commit is hidden, so the src commit above it must be re-parented onto the src
    // commit below it — otherwise the graph would render as two disconnected fragments.
    let newest = data
        .commits
        .iter()
        .find(|commit| commit.hash == third)
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

    // Remote branches hidden entirely, as `RefReadOptions::default()` always meant.
    let options = RefOptions {
        show_remote_branches: false,
        ..Default::default()
    };
    let snapshot = read_refs(&repo, &options);

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

    // Remote branches hidden entirely.
    let options = RefOptions {
        show_remote_branches: false,
        ..Default::default()
    };
    let snapshot = read_refs(&repo, &options);
    assert!(snapshot.ref_data.remotes.is_empty());

    // Remote branches shown, remote HEADs hidden (the default).
    let snapshot = read_refs(&repo, &RefOptions::default());
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
    let options = RefOptions {
        hide_remotes: vec!["upstream".to_string()],
        ..Default::default()
    };
    let snapshot = read_refs(&repo, &options);
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

    // A Gerrit repository can hold tens of thousands of change refs, so they stay out of the
    // graph — and out of the Branches dropdown — unless "Show Refs" is on.
    let snapshot = read_refs(&repo, &RefOptions::default());
    assert!(snapshot
        .ref_data
        .remotes
        .iter()
        .all(|r| !r.name.contains("changes/")));

    let options = RefOptions {
        show_change_refs: true,
        ..Default::default()
    };
    let snapshot = read_refs(&repo, &options);
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

    let options = RefOptions {
        show_remote_branches: false,
        ..Default::default()
    };
    let snapshot = read_refs(&repo, &options);
    assert_eq!(snapshot.ref_data.head, None);
    // The unborn branch has no ref, but its name is still listed — as the CLI backend and
    // `git status` report it — so the view names the branch the first commit will land on.
    assert_eq!(snapshot.branches, vec!["main"]);
}

#[test]
fn an_empty_author_list_filters_nothing() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");
    repo.commit_file("b.txt", "2", "second");

    // `git log` with no `--author` shows every commit; the CLI backend treats an empty author
    // list the same way, so the engine must not read it as "match nobody".
    let options = LogOptions {
        authors: Some(Vec::new()),
        ..all_refs(100, CommitOrdering::Date)
    };
    let hashes: Vec<String> = load(&repo, &options)
        .commits
        .into_iter()
        .map(|commit| commit.hash)
        .collect();
    assert_eq!(hashes, repo.log_hashes(&["--date-order", "--all"]));
}

#[test]
fn an_empty_filter_path_filters_nothing() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");
    // An empty commit changes no path, so any path filter at all would drop it.
    repo.git(&["commit", "--quiet", "--allow-empty", "-m", "empty"]);
    repo.commit_file("b.txt", "2", "third");

    // The CLI backend drops empty paths before building `-- <paths>`; with nothing left there is
    // no filter, and the empty commit is shown.
    let options = LogOptions {
        filter_paths: vec![String::new()],
        ..all_refs(100, CommitOrdering::Date)
    };
    let hashes: Vec<String> = load(&repo, &options)
        .commits
        .into_iter()
        .map(|commit| commit.hash)
        .collect();
    assert_eq!(hashes, repo.log_hashes(&["--date-order", "--all"]));
}

#[test]
fn topological_order_matches_git_with_and_without_a_path_filter() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("src/base.txt", "0", "base");
    repo.git(&["checkout", "--quiet", "-b", "side"]);
    repo.commit_file("src/side1.txt", "1", "side 1");
    repo.git(&["checkout", "--quiet", "main"]);
    repo.commit_file("src/main1.txt", "1", "main 1");
    repo.git(&["checkout", "--quiet", "side"]);
    repo.commit_file("src/side2.txt", "2", "side 2");
    repo.git(&["checkout", "--quiet", "main"]);
    repo.commit_file("src/main2.txt", "2", "main 2");

    let walk = |filter_paths: Vec<String>| -> Vec<String> {
        let options = LogOptions {
            filter_paths,
            ..all_refs(100, CommitOrdering::Topo)
        };
        load(&repo, &options)
            .commits
            .into_iter()
            .map(|commit| commit.hash)
            .collect()
    };

    // git reverses its initially-ready commits so that the newest tip comes out first, then keeps
    // following the line it is on: main 2, main 1, side 2, side 1, base.
    assert_eq!(
        walk(Vec::new()),
        repo.log_hashes(&["--topo-order", "--all"])
    );
    // A path-filtered page is ordered the same way, not left in the walk's commit-time order.
    assert_eq!(
        walk(vec!["src".to_string()]),
        repo.log_hashes(&[
            "--topo-order",
            "--full-history",
            "--simplify-merges",
            "--all",
            "--",
            "src",
        ])
    );
}

#[test]
fn topological_order_matches_git_across_merges() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("base.txt", "0", "base");
    for round in 1..=3 {
        repo.git(&["checkout", "--quiet", "-b", &format!("topic{round}")]);
        repo.commit_file(
            &format!("topic{round}a.txt"),
            "a",
            &format!("topic {round} a"),
        );
        repo.git(&["checkout", "--quiet", "main"]);
        repo.commit_file(&format!("main{round}.txt"), "m", &format!("main {round}"));
        repo.git(&["checkout", "--quiet", &format!("topic{round}")]);
        repo.commit_file(
            &format!("topic{round}b.txt"),
            "b",
            &format!("topic {round} b"),
        );
        repo.git(&["checkout", "--quiet", "main"]);
        repo.git(&[
            "merge",
            "--quiet",
            "--no-ff",
            "-m",
            &format!("merge {round}"),
            &format!("topic{round}"),
        ]);
    }
    // One unmerged branch as a second tip.
    repo.git(&["checkout", "--quiet", "-b", "loose", "HEAD~1"]);
    repo.commit_file("loose.txt", "l", "loose");
    repo.git(&["checkout", "--quiet", "main"]);

    assert_eq!(
        walk_all(&repo, 100, CommitOrdering::Topo),
        repo.log_hashes(&["--topo-order", "--all"])
    );
}

#[test]
fn a_remote_branch_with_tags_in_its_path_stays_a_branch() {
    require_git!();
    let mut repo = TestRepo::new();
    let head = repo.commit_file("a.txt", "1", "first");
    repo.add_fake_remote("origin", "feature/tags/cleanup", &head);
    // The layout a `+refs/tags/*:refs/remotes/origin/tags/*` refspec writes: a real remote tag.
    repo.update_ref("refs/remotes/origin/tags/v1", &head);

    let snapshot = read_refs(&repo, &RefOptions::default());
    let remotes: Vec<&str> = snapshot
        .ref_data
        .remotes
        .iter()
        .map(|r| r.name.as_str())
        .collect();
    let tags: Vec<&str> = snapshot
        .ref_data
        .tags
        .iter()
        .map(|t| t.name.as_str())
        .collect();
    assert!(
        remotes.contains(&"origin/feature/tags/cleanup"),
        "a branch whose name contains `tags/` is still a branch: {remotes:?}"
    );
    assert!(snapshot
        .branches
        .contains(&"remotes/origin/feature/tags/cleanup".to_string()));
    assert!(
        !tags.contains(&"origin/feature/cleanup"),
        "the branch must not be mistaken for a tag: {tags:?}"
    );
    // The genuine remote tag directly below the remote is still read as one.
    assert!(tags.contains(&"origin/v1"), "{tags:?}");
    assert!(!remotes.contains(&"origin/tags/v1"));
}
