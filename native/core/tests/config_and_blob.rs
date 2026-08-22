//! Configuration reads, file contents at a revision, and single-file diffs.

#[macro_use]
mod common;

use git_graph_core::repository::Repo;
use git_graph_core::{blob, config};

use common::TestRepo;

fn open(repo: &TestRepo) -> Repo {
    Repo::discover(repo.path()).expect("could not open the fixture repository")
}

#[test]
fn reads_the_identity_remotes_and_diff_tools() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");
    repo.git(&["remote", "add", "origin", "https://example.invalid/one.git"]);
    repo.git(&[
        "remote",
        "add",
        "upstream",
        "https://example.invalid/two.git",
    ]);
    repo.git(&[
        "config",
        "remote.origin.pushurl",
        "git@example.invalid:one.git",
    ]);
    repo.git(&["config", "remote.pushdefault", "origin"]);
    repo.git(&["config", "diff.tool", "vscode"]);

    let engine = open(&repo);
    let snapshot = config::read_config(&engine).unwrap();

    assert_eq!(snapshot.user_name.as_deref(), Some("Test User"));
    assert_eq!(snapshot.user_email.as_deref(), Some("test@example.com"));
    assert_eq!(snapshot.push_default.as_deref(), Some("origin"));
    assert_eq!(snapshot.diff_tool.as_deref(), Some("vscode"));
    assert_eq!(snapshot.diff_gui_tool, None);

    // Remotes keep the order the config files declare them in.
    assert_eq!(snapshot.remotes.len(), 2);
    assert_eq!(snapshot.remotes[0].name, "origin");
    assert_eq!(
        snapshot.remotes[0].url.as_deref(),
        Some("https://example.invalid/one.git")
    );
    assert_eq!(
        snapshot.remotes[0].push_url.as_deref(),
        Some("git@example.invalid:one.git")
    );
    assert_eq!(snapshot.remotes[1].name, "upstream");
    assert_eq!(snapshot.remotes[1].push_url, None);
}

#[test]
fn reports_absent_configuration_as_none() {
    require_git!();
    let repo = TestRepo::new();
    // The fixture's own identity lives in the local config; undo it so nothing is set.
    repo.git(&["config", "--unset", "user.name"]);
    repo.git(&["config", "--unset", "user.email"]);

    // The machine running the test may have its own global and system configs; the engine must
    // see none of them for "absent" to be observable. Environment variables are process-wide, so
    // the override is taken under a lock and restored before returning.
    let _guard = ENV_LOCK.lock().unwrap();
    std::env::set_var("GIT_CONFIG_GLOBAL", repo.path().join("no-such-gitconfig"));
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");

    let engine = open(&repo);
    let snapshot = config::read_config(&engine).unwrap();

    std::env::remove_var("GIT_CONFIG_GLOBAL");
    std::env::remove_var("GIT_CONFIG_NOSYSTEM");

    assert_eq!(snapshot.user_name, None);
    assert_eq!(snapshot.user_email, None);
    assert_eq!(snapshot.push_default, None);
    assert_eq!(snapshot.diff_tool, None);
    assert_eq!(snapshot.diff_gui_tool, None);
    assert!(snapshot.remotes.is_empty());
}

/// Serialises the tests that touch process-wide configuration environment variables.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn reads_a_text_file_at_a_revision() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "one\ntwo\n", "first");
    let hash = repo.commit_file("a.txt", "one\ntwo\nthree\n", "second");

    let engine = open(&repo);
    let file = blob::commit_file(&engine, &hash, "a.txt").unwrap();

    assert!(!file.binary);
    assert_eq!(file.contents.as_deref(), Some("one\ntwo\nthree\n"));
}

#[test]
fn reports_a_binary_file_as_binary() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.write("blob.bin", "text\0with a nul\n");
    let hash = repo.commit("add a binary file");

    let engine = open(&repo);
    let file = blob::commit_file(&engine, &hash, "blob.bin").unwrap();

    assert!(file.binary);
    assert_eq!(file.contents, None);
}

#[test]
fn a_missing_path_is_not_found() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "first");

    let engine = open(&repo);
    let error = blob::commit_file(&engine, &hash, "no-such.txt").unwrap_err();

    assert_eq!(error.kind, git_graph_core::ErrorKind::NotFound);
}

#[test]
fn diffs_a_modified_file_against_its_parent() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "one\ntwo\n", "first");
    repo.commit_file("other.txt", "x\n", "untouched");
    let hash = repo.commit_file("a.txt", "one\nthree\n", "third");

    let engine = open(&repo);
    let diff = blob::commit_file_diff(&engine, &hash, "a.txt").unwrap();

    assert!(diff.contains("a.txt"));
    assert!(diff.contains("-two"));
    assert!(diff.contains("+three"));
}

#[test]
fn diffs_a_file_added_by_a_root_commit() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "one\n", "first");

    let engine = open(&repo);
    let diff = blob::commit_file_diff(&engine, &hash, "a.txt").unwrap();

    assert!(diff.contains("a.txt"));
    assert!(diff.contains("+one"));
}

#[test]
fn diffs_a_renamed_file_across_the_rename() {
    require_git!();
    let mut repo = TestRepo::new();
    let contents = (0..40).map(|n| format!("line {n}\n")).collect::<String>();
    repo.commit_file("original.txt", &contents, "first");
    repo.git(&["mv", "original.txt", "renamed.txt"]);
    repo.write("renamed.txt", &contents);
    let hash = repo.commit("rename it");

    let engine = open(&repo);
    let diff = blob::commit_file_diff(&engine, &hash, "renamed.txt").unwrap();

    assert!(!diff.is_empty());
    assert!(diff.contains("renamed.txt") || diff.contains("original.txt"));
}

#[test]
fn an_untouched_file_diffs_to_nothing() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "one\n", "first");
    let hash = repo.commit_file("b.txt", "two\n", "second");

    let engine = open(&repo);
    let diff = blob::commit_file_diff(&engine, &hash, "a.txt").unwrap();

    assert_eq!(diff, "");
}

#[test]
fn a_deleted_file_diffs_against_the_empty_side() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "one\n", "first");
    repo.remove("a.txt");
    let hash = repo.commit("remove it");

    let engine = open(&repo);
    let diff = blob::commit_file_diff(&engine, &hash, "a.txt").unwrap();

    assert!(diff.contains("a.txt"));
    assert!(diff.contains("-one"));
    assert!(diff.contains("/dev/null"));
}
