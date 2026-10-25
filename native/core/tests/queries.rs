//! The on-demand reads: commit bodies, subjects and summaries, history search, tag details,
//! remote URLs, upstream names, submodule roots, rename tracking and commit counting.
//!
//! Everything goes through the public surface — `Engine` where a Rust host has a method, the
//! request protocol where the call is one of the wire methods a host sends.

#[macro_use]
mod common;

use std::process::Command;

use git_graph_core::engine::Engine;
use git_graph_core::model::GitCommitSummary;
use git_graph_core::ErrorKind;

use common::TestRepo;

fn open(repo: &TestRepo) -> Engine {
    Engine::open(repo.path()).expect("could not open the fixture repository")
}

/// The summaries of a batch of commits, as the Commit Comparison view asks for them.
fn commit_summaries(
    repo: &TestRepo,
    hashes: &[String],
) -> std::collections::BTreeMap<String, GitCommitSummary> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        hashes: &'a [String],
    }
    common::ask(repo, "commitSummaries", Params { hashes })
}

/// The new path of a renamed file, as the file viewer follows a rename into the working tree.
fn new_path_of_renamed_file(
    repo: &TestRepo,
    commit_hash: &str,
    old_file_path: &str,
) -> Option<String> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        commit_hash: &'a str,
        old_file_path: &'a str,
    }
    common::ask(
        repo,
        "newPathOfRenamedFile",
        Params {
            commit_hash,
            old_file_path,
        },
    )
}

/// How many commits of the shown refs precede `hash` (`git rev-list --count`).
fn count_commits_before(
    repo: &TestRepo,
    branches: Option<&[&str]>,
    hash: &str,
    show_remote_branches: bool,
    include_reflogs: bool,
) -> u64 {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        branches: Option<Vec<&'a str>>,
        hash: &'a str,
        show_remote_branches: bool,
        include_reflogs: bool,
    }
    common::ask(
        repo,
        "countCommitsBefore",
        Params {
            branches: branches.map(|branches| branches.to_vec()),
            hash,
            show_remote_branches,
            include_reflogs,
        },
    )
}

/// How the same count fails, with the structured error a host falls back on.
fn count_commits_before_error(
    repo: &TestRepo,
    branches: Option<&[&str]>,
    hash: &str,
    show_remote_branches: bool,
    include_reflogs: bool,
) -> git_graph_core::Error {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        branches: Option<Vec<&'a str>>,
        hash: &'a str,
        show_remote_branches: bool,
        include_reflogs: bool,
    }
    common::ask_error(
        repo,
        "countCommitsBefore",
        Params {
            branches: branches.map(|branches| branches.to_vec()),
            hash,
            show_remote_branches,
            include_reflogs,
        },
    )
}

/// The key/value list of one configuration location, with git's own resolution semantics.
fn config_list(repo: &TestRepo, local: bool) -> std::collections::BTreeMap<String, String> {
    common::ask(repo, "configList", serde_json::json!({ "local": local }))
}

/// The repository's remote names, in the order `git remote` lists them.
fn remote_names(repo: &TestRepo) -> Vec<String> {
    common::ask(repo, "remoteNames", serde_json::json!({}))
}

#[test]
fn reads_commit_bodies_without_the_trailing_newline() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "1\n", "the subject\n\nthe body paragraph\n");
    let second = repo.commit_file("b.txt", "2\n", "single-line subject");

    let engine = open(&repo);
    let bodies = engine
        .commit_bodies(&[first.clone(), second.clone()])
        .unwrap();

    // git's `%B` carries the message's trailing newline; the caller has always stripped it.
    assert_eq!(bodies[&first], "the subject\n\nthe body paragraph");
    assert_eq!(bodies[&second], "single-line subject");
}

#[test]
fn commit_bodies_fail_on_an_unknown_hash() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");

    let engine = open(&repo);
    let error = engine
        .commit_bodies(&["0123456789012345678901234567890123456789".to_string()])
        .unwrap_err();

    assert_eq!(error.kind, ErrorKind::NotFound);
}

#[test]
fn reads_a_folded_subject_as_git_folds_it() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file(
        "a.txt",
        "1\n",
        "a subject that spans\nseveral lines\n\nthe body is separate",
    );

    let expected = repo
        .git(&["log", "--format=%s", "-n", "1", &hash])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let engine = open(&repo);
    assert_eq!(engine.commit_subject(&hash).unwrap(), expected);
    assert_eq!(expected, "a subject that spans several lines");
}

#[test]
fn reads_commit_summaries_with_the_author_date() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "the subject\n\nthe body");

    let summaries = commit_summaries(&repo, std::slice::from_ref(&hash));
    let summary = &summaries[&hash];

    assert_eq!(summary.hash, hash);
    assert_eq!(summary.author, "Test User");
    assert_eq!(summary.email, "test@example.com");
    assert_eq!(summary.message, "the subject\n\nthe body");

    // `%at` is the author date, which the fixture clock pins for determinism.
    let git_date = repo.git(&["show", "--quiet", "--format=%at", &hash]);
    assert_eq!(summary.date.to_string(), git_date.trim());
}

#[test]
fn searches_history_like_git_log_grep() {
    require_git!();
    let mut repo = TestRepo::new();
    let alpha = repo.commit_file("a.txt", "1\n", "add the alpha feature");
    repo.commit_file("b.txt", "2\n", "an unrelated change");
    let gamma = repo.commit_file("c.txt", "3\n", "polish the gamma FEATURE");
    repo.git(&["checkout", "--quiet", "-b", "side"]);
    let delta = repo.commit_file("d.txt", "4\n", "the delta feature lands");

    // A stash is reachable from `--all` through refs/stash; its message must be searchable too.
    repo.write("a.txt", "stashed\n");
    repo.git(&["stash", "push", "--quiet", "-m", "the stashed feature work"]);
    let stash = repo.rev_parse("refs/stash");

    let expected = repo.log_hashes(&["--all", "-i", "--grep=feature"]);

    let engine = open(&repo);
    let matches = engine.search_history("feature").unwrap();
    let hashes: Vec<&String> = matches.iter().map(|m| &m.hash).collect();

    assert_eq!(hashes, expected.iter().collect::<Vec<_>>());
    assert!(hashes.contains(&&gamma));
    assert!(hashes.contains(&&stash), "the stash ref is part of --all");
    assert!(
        hashes.contains(&&alpha),
        "the alpha commit's message matches too"
    );

    // Subjects and authors come back with the hash.
    for m in &matches {
        if m.hash == delta {
            assert_eq!(m.message, "the delta feature lands");
            assert_eq!(m.author, "Test User");
        }
    }

    // A pattern that matches nothing matches nothing.
    assert!(engine
        .search_history("no-such-thing-at-all")
        .unwrap()
        .is_empty());
}

#[test]
fn search_rejects_a_pattern_that_is_not_a_regex() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");

    let engine = open(&repo);
    let error = engine.search_history("(unclosed").unwrap_err();

    assert_eq!(error.kind, ErrorKind::InvalidArgument);
}

#[test]
fn reads_an_annotated_tag_in_full() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "first");
    repo.git(&["tag", "-a", "v2.0", "-m", "the tag message"]);

    let tag_object = repo.rev_parse("refs/tags/v2.0");
    let tagger_date = repo.git(&[
        "for-each-ref",
        "refs/tags/v2.0",
        "--format=%(taggerdate:unix)",
    ]);

    let engine = open(&repo);
    let details = engine.tag("v2.0").unwrap();

    assert_eq!(details.hash, tag_object);
    assert_eq!(details.tagger_name, "Test User");
    assert_eq!(details.tagger_email, "test@example.com");
    assert_eq!(details.tagger_date.to_string(), tagger_date.trim());
    assert_eq!(details.message, "the tag message");
    // The tag is not signed in the fixture; presence is all either backend ever verifies.
    assert_eq!(details.signature, None);
    assert_ne!(details.hash, hash);
}

#[test]
fn reads_a_lightweight_tag_from_its_commit() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "the commit subject");
    repo.git(&["tag", "v1.0"]);

    let engine = open(&repo);
    let details = engine.tag("v1.0").unwrap();

    // A lightweight tag has no object of its own: the ref names the commit, and the message the
    // dialogue shows is the commit's.
    assert_eq!(details.hash, hash);
    assert_eq!(details.tagger_name, "");
    assert_eq!(details.tagger_email, "");
    assert_eq!(details.tagger_date, 0);
    assert_eq!(details.message, "the commit subject");
    assert_eq!(details.signature, None);
}

#[test]
fn a_missing_tag_is_not_found() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");

    let engine = open(&repo);
    let error = engine.tag("no-such-tag").unwrap_err();

    assert_eq!(error.kind, ErrorKind::NotFound);
}

#[test]
fn reads_a_remote_url_and_reports_an_absent_one() {
    require_git!();
    let repo = TestRepo::new();
    repo.git(&["remote", "add", "origin", "https://example.invalid/one.git"]);

    let engine = open(&repo);
    assert_eq!(
        engine.remote_url("origin").unwrap().as_deref(),
        Some("https://example.invalid/one.git")
    );
    assert_eq!(engine.remote_url("no-such-remote").unwrap(), None);
}

#[test]
fn reads_the_upstream_of_the_checked_out_branch() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");
    repo.add_fake_remote("origin", "main", &repo.head());
    repo.git(&["config", "branch.main.remote", "origin"]);
    repo.git(&["config", "branch.main.merge", "refs/heads/main"]);

    let expected = repo
        .git(&[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ])
        .trim()
        .to_string();

    let engine = open(&repo);
    assert_eq!(
        engine.upstream_of_current_branch().unwrap().as_deref(),
        Some(expected.as_str())
    );
    assert_eq!(expected, "origin/main");
}

#[test]
fn a_branch_without_an_upstream_has_none() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");

    let engine = open(&repo);
    assert_eq!(engine.upstream_of_current_branch().unwrap(), None);
}

#[test]
fn lists_initialised_submodules_only() {
    require_git!();
    let repo = TestRepo::new();
    repo.write(
        ".gitmodules",
        "[submodule \"present\"]\n\tpath = present\n\turl = https://example.invalid/present.git\n[submodule \"absent\"]\n\tpath = absent\n\turl = https://example.invalid/absent.git\n",
    );
    // An initialised submodule is a repository below its path; an uninitialised one is not.
    repo.git(&["init", "--quiet", "present"]);

    let engine = open(&repo);
    let submodules = engine.submodules().unwrap();

    let expected = std::fs::canonicalize(repo.path().join("present"))
        .expect("the submodule directory exists")
        .display()
        .to_string()
        .trim_start_matches(r"\\?\")
        .to_string();

    assert_eq!(submodules, vec![expected]);
}

#[test]
fn follows_a_rename_into_the_working_tree() {
    require_git!();
    let mut repo = TestRepo::new();
    let contents = (0..40).map(|n| format!("line {n}\n")).collect::<String>();
    let first = repo.commit_file("original.txt", &contents, "first");
    repo.git(&["mv", "original.txt", "renamed.txt"]);
    repo.commit("rename it");
    // The working tree modifies the renamed file on top of the committed rename; the rename is
    // still the answer, because the file the old path named now lives at the new one.
    repo.write(
        "renamed.txt",
        &contents.replace("line 39", "line thirty-nine"),
    );

    let new_path = new_path_of_renamed_file(&repo, &first, "original.txt");

    assert_eq!(new_path.as_deref(), Some("renamed.txt"));
    assert_eq!(new_path_of_renamed_file(&repo, &first, "no-such.txt"), None);
}

#[test]
fn counts_commits_before_a_hash_as_rev_list_does() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "1\n", "first");
    repo.commit_file("b.txt", "2\n", "second");
    repo.git(&["checkout", "--quiet", "-b", "side"]);
    repo.commit_file("c.txt", "3\n", "third");
    repo.commit_file("d.txt", "4\n", "fourth");

    let expected: u64 = repo
        .git(&[
            "rev-list",
            "--count",
            "--branches",
            "--tags",
            "HEAD",
            &format!("^{first}"),
        ])
        .trim()
        .parse()
        .unwrap();

    let count = count_commits_before(&repo, None, &first, true, false);
    assert_eq!(count, expected);
    assert_eq!(count, 3);

    // Counting from a branch list is the same as naming the branches on the command line.
    let from_branches: u64 = repo
        .git(&["rev-list", "--count", "main", &format!("^{first}")])
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        count_commits_before(&repo, Some(&["main"]), &first, true, false),
        from_branches
    );
}

#[test]
fn counting_before_an_unknown_hash_fails() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");

    let error = count_commits_before_error(
        &repo,
        None,
        "0123456789012345678901234567890123456789",
        true,
        false,
    );

    assert_eq!(error.kind, ErrorKind::NotFound);
}

#[test]
fn counting_reflog_tips_and_glob_patterns_is_reported_as_unsupported() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "1\n", "first");

    let reflog_error = count_commits_before_error(&repo, None, &first, true, true);
    assert_eq!(reflog_error.kind, ErrorKind::Unsupported);

    let glob_error =
        count_commits_before_error(&repo, Some(&["--glob=feature/**"]), &first, true, false);
    assert_eq!(glob_error.kind, ErrorKind::Unsupported);
}

#[test]
fn reads_a_tag_whose_name_contains_slashes() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "first");
    repo.git(&["tag", "-a", "release/v1.0", "-m", "a hierarchical tag"]);

    let tag_object = repo.rev_parse("refs/tags/release/v1.0");
    let engine = open(&repo);
    let details = engine.tag("release/v1.0").unwrap();

    assert_eq!(details.hash, tag_object);
    assert_eq!(details.message, "a hierarchical tag");
    assert_ne!(details.hash, hash);
}

#[test]
fn rejects_tag_names_git_would_reject() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");

    let engine = open(&repo);
    for bad in [
        "-leading-dash",
        "a/../traversal",
        "trailing-slash/",
        ".hidden",
        "double..dot",
        "ends-in.lock",
        "no spaces",
        "caret^",
    ] {
        let error = engine
            .tag(bad)
            .unwrap_err_or_else(|| panic!("the tag name {bad} was accepted"));
        assert_eq!(error.kind, ErrorKind::InvalidArgument, "tag name {bad}");
    }
}

#[test]
fn a_bare_repository_has_no_upstream_and_no_submodules() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "the subject\n\nand a body");

    let bare = tempfile::tempdir().expect("could not create a temporary directory");
    let clone = Command::new("git")
        .args(["clone", "--quiet", "--bare"])
        .arg(repo.path())
        .arg(bare.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("could not run `git clone --bare`");
    assert!(
        clone.status.success(),
        "`git clone --bare` failed: {}",
        String::from_utf8_lossy(&clone.stderr)
    );

    let engine = Engine::open(bare.path()).expect("could not open the bare repository");
    assert_eq!(engine.upstream_of_current_branch().unwrap(), None);
    assert!(engine.submodules().unwrap().is_empty());

    // The object database is all a bare repository has, and it is enough for every object read.
    assert_eq!(engine.commit_subject(&hash).unwrap(), "the subject");
    assert_eq!(
        engine.commit_bodies(std::slice::from_ref(&hash)).unwrap()[&hash],
        "the subject\n\nand a body"
    );
}

#[test]
fn a_detached_head_has_no_upstream() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "1\n", "first");
    repo.commit_file("b.txt", "2\n", "second");
    repo.git(&["checkout", "--quiet", "--detach", &first]);

    let engine = open(&repo);
    assert_eq!(engine.upstream_of_current_branch().unwrap(), None);
}

#[test]
fn searching_a_repository_without_commits_matches_nothing() {
    require_git!();
    let repo = TestRepo::new();

    let engine = open(&repo);
    assert!(engine.search_history("anything").unwrap().is_empty());
    // count_commits_before on this repo is covered by counting_before_an_unknown_hash_fails:
    // its error fires at hash resolution, before any walk, so an empty repository reaches the
    // same branch a populated one does.
}

/// The assertion helper the loop above uses, so each rejected name is reported individually.
trait UnwrapErrOrElse {
    fn unwrap_err_or_else(self, message: impl FnOnce() -> String) -> git_graph_core::Error;
}

impl UnwrapErrOrElse for Result<git_graph_core::model::GitTagDetails, git_graph_core::Error> {
    fn unwrap_err_or_else(self, message: impl FnOnce() -> String) -> git_graph_core::Error {
        match self {
            Ok(_) => panic!("{}", message()),
            Err(error) => error,
        }
    }
}

#[test]
fn reads_the_url_of_a_remote_with_an_unusual_name() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");
    // `git remote add` refuses unusual names, but a hand-edited .git/config can carry any
    // subsection, and the engine must read the URL of one as readily as the command line does.
    repo.git(&[
        "config",
        "remote.up stream.url",
        "https://example.invalid/spaced.git",
    ]);
    repo.git(&[
        "config",
        "remote.a..b.url",
        "https://example.invalid/dotted.git",
    ]);

    let engine = open(&repo);
    assert_eq!(
        engine.remote_url("up stream").unwrap().as_deref(),
        Some("https://example.invalid/spaced.git")
    );
    assert_eq!(
        engine.remote_url("a..b").unwrap().as_deref(),
        Some("https://example.invalid/dotted.git")
    );

    let error = engine.remote_url("").unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidArgument);
}

#[test]
fn counting_an_empty_branch_list_is_declined() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "first");

    let error = count_commits_before_error(&repo, Some(&[]), &hash, true, false);

    // The command line this replaces would count from HEAD for an empty ref list; the engine
    // declines rather than guess, so the call falls back and behaviour is preserved exactly.
    assert_eq!(error.kind, ErrorKind::Unsupported);
}

#[test]
fn reads_a_tag_message_without_its_trailing_blank_lines() {
    require_git!();
    let mut repo = TestRepo::new();
    let hash = repo.commit_file("a.txt", "1\n", "first");
    repo.write("tag-message.txt", "line one\n\nline two\n\n\n");
    repo.git(&["tag", "-a", "wordy", "-F", "tag-message.txt"]);

    let engine = open(&repo);
    let details = engine.tag("wordy").unwrap();

    assert_ne!(details.hash, hash);
    assert_eq!(details.message, "line one\n\nline two");
}

/// Serialises the tests that touch process-wide configuration environment variables.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn finds_the_repository_root_from_a_subdirectory() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");
    repo.write("nested/deep/file.txt", "x\n");

    let nested = repo.path().join("nested").join("deep");
    let root: String = common::ask_at(nested.to_str().unwrap(), "repoRoot", serde_json::json!({}));

    let normalise = |path: String| {
        path.trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .to_lowercase()
    };
    assert_eq!(
        normalise(root),
        normalise(repo.path().display().to_string())
    );

    let error = common::ask_error_at(
        std::env::temp_dir().to_str().unwrap(),
        "repoRoot",
        serde_json::json!({}),
    );
    assert_eq!(error.kind, ErrorKind::NotARepository);
}

#[test]
fn lists_the_local_configuration_with_git_resolution_semantics() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");
    repo.git(&["config", "branch.main.remote", "origin"]);
    // A repeated key keeps its last value, which is git's own resolution.
    repo.git(&["config", "--add", "custom.key", "first"]);
    repo.git(&["config", "--add", "custom.key", "second"]);
    // Section and key names are case-insensitive, so the list spells them lower-cased however
    // the file spells them, the shape `git config --list` prints; a subsection's case is
    // significant and is kept. (The macOS runners' own global configuration carries camelCase
    // advice keys, which is where a spelling mismatch between the engine and git first showed.)
    let local = repo.path().join(".git").join("config");
    let text = std::fs::read_to_string(&local).unwrap()
        + "[advice]\n\tamWorkDir = false\n[SomeSection \"CamelCase\"]\n\tSomeKey = mixed case\n";
    std::fs::write(&local, text).unwrap();

    let config = config_list(&repo, true);

    assert_eq!(config["user.name"], "Test User");
    assert_eq!(config["branch.main.remote"], "origin");
    assert_eq!(config["custom.key"], "second");
    assert_eq!(config["advice.amworkdir"], "false");
    assert_eq!(config["somesection.CamelCase.somekey"], "mixed case");
    assert!(!config.contains_key("advice.amWorkDir"));
}

#[test]
fn lists_the_global_configuration_and_declines_includes() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");

    let _guard = ENV_LOCK.lock().unwrap();
    let global = repo.path().join("global-gitconfig");
    std::fs::write(&global, "[user]\n\tname = Global Identity\n").unwrap();
    std::env::set_var("GIT_CONFIG_GLOBAL", &global);

    let config = config_list(&repo, false);

    std::env::remove_var("GIT_CONFIG_GLOBAL");

    assert_eq!(config["user.name"], "Global Identity");

    // An include directive is where the engine stops and lets the command line answer. The warm
    // handle predates the rewrite, so it is dropped first — what a host does when it knows the
    // repository changed underneath it.
    std::fs::write(&global, "[include]\n\tpath = elsewhere\n").unwrap();
    std::env::set_var("GIT_CONFIG_GLOBAL", &global);
    git_graph_core::protocol::close(repo.path().to_str().unwrap());
    let error = common::ask_error(&repo, "configList", serde_json::json!({ "local": false }));
    std::env::remove_var("GIT_CONFIG_GLOBAL");

    assert_eq!(error.kind, ErrorKind::Unsupported);
}

#[test]
fn aggregates_authors_like_shortlog() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");
    repo.git(&[
        "-c",
        "user.name=Second Author",
        "-c",
        "user.email=second@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "second",
    ]);
    // The same name with a second spelling of the email: one author, the most-prolific spelling.
    repo.git(&[
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=other@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "third",
    ]);
    repo.git(&[
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fourth",
    ]);

    let expected = repo.git(&["shortlog", "-e", "-s", "-n", "HEAD"]);
    let engine = open(&repo);
    let authors = engine.authors().unwrap();

    assert_eq!(
        authors,
        vec![
            git_graph_core::model::GitAuthor {
                name: "Second Author".into(),
                email: "second@example.com".into()
            },
            git_graph_core::model::GitAuthor {
                name: "Test User".into(),
                email: "test@example.com".into()
            },
        ]
    );
    // The same walk git's shortlog makes: three Test User commits against one Second Author.
    assert!(expected.contains("Second Author"), "shortlog: {expected}");
}

#[test]
fn reads_the_checked_out_branch_name() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");

    let engine = open(&repo);
    assert_eq!(engine.current_branch().unwrap().as_deref(), Some("main"));

    repo.git(&["checkout", "--quiet", "--detach", "HEAD"]);
    assert_eq!(engine.current_branch().unwrap(), None);
}

#[test]
fn an_unborn_head_still_names_its_branch() {
    require_git!();
    let repo = TestRepo::new();

    let engine = open(&repo);
    // `git symbolic-ref --short HEAD` prints the branch even before the first commit exists.
    assert_eq!(engine.current_branch().unwrap().as_deref(), Some("main"));
}

#[test]
fn lists_remote_names_alphabetically() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "first");
    repo.git(&["remote", "add", "zeta", "https://example.invalid/z.git"]);
    repo.git(&["remote", "add", "alpha", "https://example.invalid/a.git"]);

    assert_eq!(remote_names(&repo), vec!["alpha", "zeta"]);
}
