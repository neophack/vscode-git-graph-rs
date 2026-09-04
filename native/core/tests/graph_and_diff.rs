//! The assembled graph, the file lists, and the working tree state.

#[macro_use]
mod common;

use git_graph_core::types::{GitFileStatus, LogOptions, RefReadOptions, UNCOMMITTED};
use git_graph_core::{details, diff, graph, repository::Repo, stash, status};

use common::TestRepo;

fn open(repo: &TestRepo) -> Repo {
    Repo::discover(repo.path()).expect("could not open the fixture repository")
}

/// The options a default view load sends.
fn view_options(max_commits: u32) -> LogOptions {
    LogOptions {
        max_commits,
        show_tags: true,
        show_remote_branches: true,
        show_uncommitted_changes: true,
        show_untracked_files: true,
        ..Default::default()
    }
}

#[test]
fn assembles_a_graph_with_its_branch_and_tag_labels() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "1", "first");
    repo.git(&["tag", "v1.0"]);
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    let second = repo.commit_file("b.txt", "2", "second");

    let engine = open(&repo);
    let data = graph::load_commits(&engine, &view_options(100)).unwrap();

    assert_eq!(data.head.as_deref(), Some(second.as_str()));
    assert!(!data.more_commits_available);
    assert_eq!(data.tags, vec!["v1.0"]);

    let newest = data.commits.iter().find(|c| c.hash == second).unwrap();
    assert_eq!(newest.heads, vec!["feature"]);

    let oldest = data.commits.iter().find(|c| c.hash == first).unwrap();
    assert_eq!(oldest.heads, vec!["main"]);
    assert_eq!(oldest.tags.len(), 1);
    assert_eq!(oldest.tags[0].name, "v1.0");
    assert!(!oldest.tags[0].annotated);
}

#[test]
fn reports_when_more_commits_are_available() {
    require_git!();
    let mut repo = TestRepo::new();
    for index in 0..10 {
        repo.commit_file("a.txt", &index.to_string(), &format!("commit {index}"));
    }

    let engine = open(&repo);

    let data = graph::load_commits(&engine, &view_options(4)).unwrap();
    assert_eq!(
        data.commits.len(),
        4,
        "the extra look-ahead commit must not be returned"
    );
    assert!(data.more_commits_available);

    let data = graph::load_commits(&engine, &view_options(50)).unwrap();
    assert_eq!(data.commits.len(), 10);
    assert!(!data.more_commits_available);
}

#[test]
fn declines_graphs_that_include_reflog_commits() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "first", "first");

    let engine = open(&repo);
    let mut options = view_options(100);
    options.include_commits_mentioned_by_reflogs = true;

    let error = graph::load_commits(&engine, &options).unwrap_err();
    assert_eq!(error.kind, git_graph_core::ErrorKind::Unsupported);
}

#[test]
fn adds_an_uncommitted_changes_row_above_head() {
    require_git!();
    let mut repo = TestRepo::new();
    let head = repo.commit_file("a.txt", "1", "first");

    let engine = open(&repo);

    // Nothing uncommitted: no row.
    let data = graph::load_commits(&engine, &view_options(100)).unwrap();
    assert!(data.commits.iter().all(|commit| commit.hash != UNCOMMITTED));

    repo.write("a.txt", "changed");
    repo.write("untracked.txt", "new");

    let data = graph::load_commits(&engine, &view_options(100)).unwrap();
    let row = &data.commits[0];
    assert_eq!(row.hash, UNCOMMITTED);
    assert_eq!(row.message, "Uncommitted Changes (2)");
    // The row hangs off HEAD, which is what connects it to the rest of the graph.
    assert_eq!(row.parents, vec![head]);
}

#[test]
fn skips_the_uncommitted_row_when_the_view_defers_it() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");
    repo.write("a.txt", "changed");

    let engine = open(&repo);
    let options = LogOptions {
        defer_uncommitted_changes: true,
        ..view_options(100)
    };
    let data = graph::load_commits(&engine, &options).unwrap();

    // Deferring lets the graph render before the working tree has been scanned.
    assert!(data.commits.iter().all(|commit| commit.hash != UNCOMMITTED));
}

#[test]
fn counts_uncommitted_changes_the_way_git_status_does() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");
    repo.commit_file("b.txt", "2", "second");

    repo.write("a.txt", "modified");
    repo.remove("b.txt");
    repo.write("c.txt", "untracked");
    repo.write("d.txt", "staged");
    repo.git(&["add", "d.txt"]);

    let engine = open(&repo);
    let expected = repo
        .git(&["status", "--porcelain", "--untracked-files=all"])
        .lines()
        .count();
    assert_eq!(status::count_changes(&engine, true).unwrap(), expected);

    let expected_no_untracked = repo
        .git(&["status", "--porcelain", "--untracked-files=no"])
        .lines()
        .count();
    assert_eq!(
        status::count_changes(&engine, false).unwrap(),
        expected_no_untracked
    );
}

#[test]
fn reports_the_untracked_and_deleted_files() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");
    repo.commit_file("b.txt", "2", "second");
    repo.remove("b.txt");
    repo.write("c.txt", "untracked");

    let engine = open(&repo);
    let files = status::status_files(&engine, true).unwrap();

    assert_eq!(files.deleted, vec!["b.txt"]);
    assert_eq!(files.untracked, vec!["c.txt"]);
}

#[test]
fn lists_the_files_a_commit_changed() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("keep.txt", "one\ntwo\n", "first");
    repo.commit_file("gone.txt", "x\n", "second");

    repo.write("keep.txt", "one\ntwo\nthree\n");
    repo.write("added.txt", "new\n");
    repo.remove("gone.txt");
    let hash = repo.commit("third");

    let engine = open(&repo);
    let changes = diff::diff_commit(&engine, &hash).unwrap();

    let by_path = |path: &str| {
        changes
            .iter()
            .find(|change| change.new_file_path == path)
            .expect("missing file change")
    };

    assert_eq!(by_path("added.txt").kind, GitFileStatus::Added);
    assert_eq!(by_path("gone.txt").kind, GitFileStatus::Deleted);

    let modified = by_path("keep.txt");
    assert_eq!(modified.kind, GitFileStatus::Modified);
    // The tree walk only settles statuses; the counts are deferred to `line_counts`, so a
    // many-file commit can render its file list before any blob is read.
    assert_eq!(modified.additions, None);
    assert_eq!(modified.deletions, None);

    // The deferred counts of a subset of paths, as the view asks for them.
    let counts = diff::line_counts(
        &engine,
        None,
        &hash,
        &["keep.txt".into(), "added.txt".into()],
    )
    .unwrap();
    assert_eq!(counts.len(), 2, "only the asked-for paths are settled");
    let keep = counts.get("keep.txt").copied().unwrap_or_default();
    assert_eq!(keep.additions, Some(1));
    assert_eq!(keep.deletions, Some(0));
    let added = counts.get("added.txt").copied().unwrap_or_default();
    assert_eq!(added.additions, Some(1));
    assert_eq!(added.deletions, Some(0));
}

#[test]
fn counts_only_the_paths_asked_for() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "one\ntwo\n", "first");
    repo.write("a.txt", "one\nchanged\n");
    repo.write("b.bin", "\u{0}\u{1}\u{2}\n");
    let second = repo.commit("second");

    let engine = open(&repo);
    // An explicit `from` is the comparison-view spelling; the binary file reports null counts,
    // exactly as `git diff --numstat` prints a dash for it.
    let counts = diff::line_counts(&engine, Some(&first), &second, &["b.bin".into()]).unwrap();
    assert_eq!(counts.len(), 1);
    let binary = counts.get("b.bin").copied().unwrap_or_default();
    assert_eq!(binary.additions, None);
    assert_eq!(binary.deletions, None);

    // A path the diff does not touch simply does not appear.
    let counts = diff::line_counts(&engine, None, &second, &["not-there.txt".into()]).unwrap();
    assert!(counts.is_empty());
}

#[test]
fn settles_the_line_counts_of_a_stash_against_its_base() {
    require_git!();
    let mut repo = TestRepo::new();
    let base = repo.commit_file("a.txt", "one\ntwo\nthree\n", "first");

    repo.write("a.txt", "one\nchanged\nthree\n");
    repo.git(&["stash", "push", "--quiet", "-m", "the stash"]);
    let stash_hash = repo.rev_parse("refs/stash");

    let engine = open(&repo);
    let stashes = stash::read_stashes(&engine).unwrap();
    assert_eq!(stashes[0].base_hash, base);

    // The stash's own file list arrives as statuses only, like every other details load.
    let commit_stash = git_graph_core::types::GitCommitStash {
        selector: stashes[0].selector.clone(),
        base_hash: stashes[0].base_hash.clone(),
        untracked_files_hash: None,
    };
    let details = details::stash_details(&engine, &stashes[0].hash, &commit_stash).unwrap();
    let modified = details
        .file_changes
        .iter()
        .find(|change| change.new_file_path == "a.txt")
        .expect("the stashed file is missing from the stash details");
    assert_eq!(modified.kind, GitFileStatus::Modified);
    assert_eq!(modified.additions, None);
    assert_eq!(modified.deletions, None);

    // The stash spelling of the deferred counts: `from` is the commit the stash was taken from,
    // not the stash commit's own first parent.
    let counts = diff::line_counts(
        &engine,
        Some(&stashes[0].base_hash),
        &stash_hash,
        &["a.txt".into()],
    )
    .unwrap();
    assert_eq!(counts.len(), 1);
    let settled = counts.get("a.txt").copied().unwrap_or_default();
    assert_eq!(settled.additions, Some(1));
    assert_eq!(settled.deletions, Some(1));
}

#[test]
fn counts_the_files_under_a_renamed_directory() {
    require_git!();
    let mut repo = TestRepo::new();
    let contents = (0..40).map(|n| format!("line {n}\n")).collect::<String>();
    let notes = (0..10).map(|n| format!("note {n}\n")).collect::<String>();
    repo.commit_file("old/guide.txt", &contents, "first");
    repo.commit_file("old/notes.txt", &notes, "second");

    repo.git(&["mv", "old", "new"]);
    // A file edited while the folder moves must survive as one rename, not an add plus a delete.
    repo.write(
        "new/notes.txt",
        "note 0\nchanged 1\nnote 2\nnote 3\nnote 4\nnote 5\nnote 6\nnote 7\nnote 8\nchanged 9\n",
    );
    let hash = repo.commit("move the folder");

    let engine = open(&repo);
    let counts = diff::line_counts(
        &engine,
        None,
        &hash,
        &["new/guide.txt".into(), "new/notes.txt".into()],
    )
    .unwrap();
    assert_eq!(counts.len(), 2, "both moved files are settled: {counts:?}");
    let guide = counts.get("new/guide.txt").copied().unwrap_or_default();
    assert_eq!(guide.additions, Some(0));
    assert_eq!(guide.deletions, Some(0));
    let notes = counts.get("new/notes.txt").copied().unwrap_or_default();
    assert_eq!(notes.additions, Some(2));
    assert_eq!(notes.deletions, Some(2));

    // The pre-move paths are consumed by the renames, and the directory itself — which the
    // rewrite tracker also pairs — settles nothing.
    let none = diff::line_counts(
        &engine,
        None,
        &hash,
        &["old/guide.txt".into(), "old/notes.txt".into(), "new".into()],
    )
    .unwrap();
    assert!(
        none.is_empty(),
        "nothing but the new paths are settled: {none:?}"
    );
}

#[test]
fn reports_statuses_only_against_the_working_tree() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "one\n", "first");
    repo.commit_file("b.txt", "two\n", "second");
    repo.write("a.txt", "changed\n");
    repo.write("c.txt", "uncommitted\n");

    let engine = open(&repo);
    let changes = diff::diff_revisions(&engine, &first, UNCOMMITTED).unwrap();

    // Counting a worktree-touched file means hashing the file on disk, so a comparison against
    // the working tree reports no counts at all rather than exact ones beside uncounted ones.
    assert!(changes.len() >= 2);
    for change in &changes {
        assert_eq!(change.additions, None, "{}", change.new_file_path);
        assert_eq!(change.deletions, None, "{}", change.new_file_path);
    }
}

#[test]
fn drops_a_type_change_like_the_cli_filter_does() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("keep.txt", "one\n", "first");
    repo.write("gone.txt", "regular contents\n");
    repo.commit("second");

    // Replace gone.txt with a symlink through plumbing (no working-tree symlink needed on
    // Windows): a symlink's blob content is the path it points at.
    repo.write("link-target.txt", "gone.txt\n");
    let blob = repo
        .git(&["hash-object", "-w", "link-target.txt"])
        .trim()
        .to_string();
    repo.git(&[
        "update-index",
        "--cacheinfo",
        &format!("120000,{blob},gone.txt"),
    ]);
    // Commit the index as it stands — `add -A` would undo the plumbing (the worktree has no file).
    repo.git(&["commit", "--quiet", "-m", "turn gone.txt into a symlink"]);
    let hash = repo.head();

    let engine = open(&repo);
    let changes = diff::diff_commit(&engine, &hash).unwrap();
    assert!(
        !changes
            .iter()
            .any(|change| change.new_file_path == "gone.txt"),
        "a regular-file-to-symlink type change is not one of the listed statuses: {changes:?}"
    );
}

#[test]
fn detects_renames() {
    require_git!();
    let mut repo = TestRepo::new();
    let contents = (0..40).map(|n| format!("line {n}\n")).collect::<String>();
    repo.commit_file("original.txt", &contents, "first");

    repo.git(&["mv", "original.txt", "renamed.txt"]);
    let hash = repo.commit("rename it");

    let engine = open(&repo);
    let changes = diff::diff_commit(&engine, &hash).unwrap();

    assert_eq!(
        changes.len(),
        1,
        "a rename is one change, not an add plus a delete"
    );
    assert_eq!(changes[0].kind, GitFileStatus::Renamed);
    assert_eq!(changes[0].old_file_path, "original.txt");
    assert_eq!(changes[0].new_file_path, "renamed.txt");
}

#[test]
fn does_not_list_a_renamed_directory_as_a_file() {
    require_git!();
    let mut repo = TestRepo::new();
    let contents = (0..40).map(|n| format!("line {n}\n")).collect::<String>();
    repo.commit_file("old/kept.txt", &contents, "first");

    repo.git(&["mv", "old", "new"]);
    repo.write("new/added.txt", "brand new\n");
    let hash = repo.commit("rename the folder");

    let engine = open(&repo);
    let changes = diff::diff_commit(&engine, &hash).unwrap();

    // The rewrite tracker pairs the deleted `old` tree with the added `new` tree as a rewrite of
    // the directory itself, and a directory path in the list would collide with the entries under
    // it when the view builds its file tree.
    assert_eq!(
        changes.len(),
        2,
        "only the moved file and the added file are changes: {changes:?}"
    );
    assert_eq!(changes[0].kind, GitFileStatus::Renamed);
    assert_eq!(changes[0].old_file_path, "old/kept.txt");
    assert_eq!(changes[0].new_file_path, "new/kept.txt");
    assert_eq!(changes[1].kind, GitFileStatus::Added);
    assert_eq!(changes[1].new_file_path, "new/added.txt");
    assert!(
        !changes
            .iter()
            .any(|change| change.new_file_path == "old" || change.new_file_path == "new"),
        "the renamed directory itself must not be listed as a file"
    );
}

#[test]
fn shows_the_first_commit_as_adding_its_files() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "first");

    let engine = open(&repo);
    let changes = diff::diff_commit(&engine, &hash).unwrap();

    // A root commit has no parent, so it is compared against the empty tree.
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].kind, GitFileStatus::Added);
    assert_eq!(changes[0].new_file_path, "a.txt");
}

#[test]
fn reads_the_full_commit_message_and_both_signatures() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1", "the subject\n\nthe body goes here");

    let engine = open(&repo);
    let details = details::commit_details(&engine, &hash).unwrap();

    assert_eq!(details.hash, hash);
    assert_eq!(details.author, "Test User");
    assert_eq!(details.committer, "Test User");
    assert_eq!(details.author_email, "test@example.com");
    // The details view shows the whole message, unlike the graph row which shows the subject.
    assert!(details.body.starts_with("the subject"));
    assert!(details.body.contains("the body goes here"));
    assert_eq!(details.signature, None);
    assert_eq!(details.file_changes.len(), 1);
}

#[test]
fn reads_stashes_with_their_selectors_and_base_commits() {
    require_git!();
    let mut repo = TestRepo::new();
    let base = repo.commit_file("a.txt", "1", "first");

    repo.write("a.txt", "stashed change");
    repo.git(&["stash", "push", "--quiet", "-m", "first stash"]);
    repo.write("a.txt", "another change");
    repo.git(&["stash", "push", "--quiet", "-m", "second stash"]);

    let engine = open(&repo);
    let stashes = stash::read_stashes(&engine).unwrap();

    assert_eq!(stashes.len(), 2);
    // Newest first, as `git stash list` reports them.
    assert_eq!(stashes[0].selector, "refs/stash@{0}");
    assert_eq!(stashes[1].selector, "refs/stash@{1}");
    assert!(stashes[0].message.contains("second stash"));
    assert_eq!(stashes[0].base_hash, base);
    assert_eq!(stashes[0].untracked_files_hash, None);
}

#[test]
fn records_the_untracked_files_of_a_stash_taken_with_them() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");
    repo.write("untracked.txt", "new file");
    repo.git(&[
        "stash",
        "push",
        "--quiet",
        "--include-untracked",
        "-m",
        "with untracked",
    ]);

    let engine = open(&repo);
    let stashes = stash::read_stashes(&engine).unwrap();

    assert_eq!(stashes.len(), 1);
    let untracked_hash = stashes[0]
        .untracked_files_hash
        .clone()
        .expect("the third parent recording the untracked files is missing");

    // The untracked file is listed as untracked, not as an addition.
    let commit_stash = git_graph_core::types::GitCommitStash {
        selector: stashes[0].selector.clone(),
        base_hash: stashes[0].base_hash.clone(),
        untracked_files_hash: Some(untracked_hash),
    };
    let details = details::stash_details(&engine, &stashes[0].hash, &commit_stash).unwrap();
    let untracked = details
        .file_changes
        .iter()
        .find(|change| change.new_file_path == "untracked.txt")
        .expect("the untracked file is missing from the stash details");
    assert_eq!(untracked.kind, GitFileStatus::Untracked);
}

#[test]
fn hangs_a_stash_row_off_the_commit_it_was_taken_from() {
    require_git!();
    let mut repo = TestRepo::new();
    let base = repo.commit_file("a.txt", "1", "first");
    repo.write("a.txt", "stashed");
    repo.git(&["stash", "push", "--quiet", "-m", "the stash"]);

    let engine = open(&repo);
    let data = graph::load_commits(&engine, &view_options(100)).unwrap();

    // The stash commit is not reachable from any branch, so it only appears because the graph
    // splices it in above its base commit.
    let position = |hash: &str| data.commits.iter().position(|c| c.hash == hash);
    let stash_row = data
        .commits
        .iter()
        .find(|commit| commit.stash.is_some())
        .expect("the stash was not added to the graph");

    assert!(stash_row.message.contains("the stash"));
    assert_eq!(stash_row.parents, vec![base.clone()]);
    assert!(
        position(&stash_row.hash) < position(&base),
        "the stash must sit above its base"
    );
}

#[test]
fn reports_the_repository_info_the_view_opens_with() {
    require_git!();
    let mut repo = TestRepo::new();
    let head = repo.commit_file("a.txt", "1", "first");
    repo.git(&["tag", "v1.0"]);
    repo.add_fake_remote("origin", "main", &head);

    let engine = open(&repo);
    let options = RefReadOptions {
        show_remote_branches: true,
        ..Default::default()
    };
    let info = graph::repo_info(&engine, &options, true).unwrap();

    assert_eq!(info.head.as_deref(), Some(head.as_str()));
    assert_eq!(info.remotes, vec!["origin"]);
    assert_eq!(info.tags, vec!["v1.0"]);
    assert!(info.branches.contains(&"main".to_string()));
    assert!(info.branches.contains(&"remotes/origin/main".to_string()));
    assert_eq!(info.error, None);
}

#[test]
fn compares_two_commits() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "one\n", "first");
    repo.commit_file("b.txt", "two\n", "second");
    let third = repo.commit_file("c.txt", "three\n", "third");

    let engine = open(&repo);
    let changes = diff::diff_revisions(&engine, &first, &third).unwrap();

    let mut paths: Vec<&str> = changes.iter().map(|c| c.new_file_path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, vec!["b.txt", "c.txt"]);
    assert!(changes
        .iter()
        .all(|change| change.kind == GitFileStatus::Added));
}

#[test]
fn compares_a_commit_against_the_working_tree() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "one\n", "first");
    repo.commit_file("b.txt", "two\n", "second");
    repo.write("c.txt", "uncommitted\n");

    let engine = open(&repo);
    let changes = diff::diff_revisions(&engine, &first, UNCOMMITTED).unwrap();

    let mut paths: Vec<&str> = changes.iter().map(|c| c.new_file_path.as_str()).collect();
    paths.sort();
    // Both the committed change and the untracked file are part of the difference.
    assert_eq!(paths, vec!["b.txt", "c.txt"]);
}

#[test]
fn keeps_repository_handles_open_across_requests() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");

    let manager = git_graph_core::RepoManager::new();
    let first = manager.get(repo.path()).unwrap();
    let second = manager.get(repo.path()).unwrap();

    // The whole point of the manager: the second request reuses the warm handle rather than
    // re-reading the pack indexes.
    assert_eq!(manager.open_count(), 1);
    assert!(std::sync::Arc::ptr_eq(&first, &second));

    manager.close(repo.path());
    assert_eq!(manager.open_count(), 0);
}
