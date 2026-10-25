//! Where gix and git read the same repository differently, checked against git itself.
//!
//! Each test pins one place a differential run of the two backends found the engine disagreeing
//! with the `git` command line: working-tree states gix classifies differently, commit text gix does
//! not re-encode or fold, shallow boundaries, rename and binary rules, and the objects a tag can
//! name. The expected answer always comes from running git on the same fixture.
//!
//! Every engine call goes through the public surface — `Engine` and the request protocol — so
//! these tests exercise exactly what a host receives.

#[macro_use]
mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use git_graph_core::engine::Engine;
use git_graph_core::model::{GitCommitData, GitFileStatus, GitLineCounts, LogOptions};
use git_graph_core::ErrorKind;

use common::TestRepo;

fn open(repo: &TestRepo) -> Engine {
    Engine::open(repo.path()).expect("could not open the fixture repository")
}

/// The load options that walk every ref, as `git log --all` does.
fn all_refs(max_commits: u32) -> LogOptions {
    LogOptions {
        max_commits,
        show_tags: true,
        show_remote_branches: true,
        show_commits_only_referenced_by_tags: true,
        ..Default::default()
    }
}

/// The commits of one full load, in page order.
fn load(repo: &TestRepo, options: &LogOptions) -> GitCommitData {
    common::ask(repo, "loadCommits", options)
}

/// The uncommitted file changes, staged and unstaged together — what the
/// "Uncommitted Changes" row's details list.
fn uncommitted_changes(repo: &TestRepo) -> Vec<git_graph_core::model::GitFileChange> {
    let details: git_graph_core::model::GitCommitDetails =
        common::ask(repo, "uncommittedDetails", serde_json::json!({}));
    details.file_changes
}

/// How many lines `git status --porcelain` prints — what "Uncommitted Changes (N)" counts.
fn porcelain_lines(repo: &TestRepo) -> usize {
    repo.git(&["status", "--porcelain", "--untracked-files=all"])
        .lines()
        .filter(|line| !line.is_empty())
        .count()
}

/// The paths the working tree scan reports as deleted (either half) and as untracked.
fn deleted_and_untracked(engine: &Engine) -> (Vec<String>, Vec<String>) {
    let mut deleted = Vec::new();
    let mut untracked = Vec::new();
    for change in engine.status().unwrap() {
        if change.staged == Some("deleted") || change.unstaged == Some("deleted") {
            deleted.push(change.path.clone());
        }
        if change.untracked {
            untracked.push(change.path);
        }
    }
    (deleted, untracked)
}

/// Run git with bytes on stdin, returning stdout — for objects `git` must store verbatim.
fn git_with_input(dir: &Path, args: &[&str], input: &[u8]) -> String {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("could not run git");
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "`git {}` failed", args.join(" "));
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The `+N/-M` counts of paths between a revision and its first parent (or an explicit `from`).
fn line_counts(
    repo: &TestRepo,
    from: Option<&str>,
    to: &str,
    paths: &[String],
) -> std::collections::BTreeMap<String, GitLineCounts> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        from: Option<&'a str>,
        to: &'a str,
        paths: &'a [String],
    }
    common::ask(repo, "lineCounts", Params { from, to, paths })
}

/* ---------- Working-tree status ---------- */

#[test]
fn an_intent_to_add_file_is_an_uncommitted_addition() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "one");
    repo.write("new.txt", "new\n");
    repo.git(&["add", "-N", "new.txt"]);

    let count: usize = common::ask(
        &repo,
        "countUncommittedChanges",
        serde_json::json!({ "includeUntracked": true }),
    );
    // git: ` A new.txt`.
    assert_eq!(count, porcelain_lines(&repo));
    assert_eq!(count, 1);
    let changes = uncommitted_changes(&repo);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].new_file_path, "new.txt");
    assert_eq!(changes[0].kind, GitFileStatus::Added);
}

#[test]
fn a_file_removed_from_the_index_but_kept_on_disk_is_two_changes() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "one");
    repo.git(&["rm", "--quiet", "--cached", "a.txt"]);

    let count: usize = common::ask(
        &repo,
        "countUncommittedChanges",
        serde_json::json!({ "includeUntracked": true }),
    );
    // git: `D  a.txt` and `?? a.txt`.
    assert_eq!(count, porcelain_lines(&repo));
    assert_eq!(count, 2);
    let kinds: Vec<GitFileStatus> = uncommitted_changes(&repo)
        .into_iter()
        .map(|change| change.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![GitFileStatus::Deleted, GitFileStatus::Untracked]
    );
    let engine = open(&repo);
    let (deleted, untracked) = deleted_and_untracked(&engine);
    assert_eq!(deleted, vec!["a.txt"]);
    assert_eq!(untracked, vec!["a.txt"]);
}

#[test]
fn status_renames_off_counts_both_halves_of_a_staged_rename() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", &"x\n".repeat(20), "one");
    repo.git(&["config", "status.renames", "false"]);
    repo.git(&["mv", "a.txt", "b.txt"]);

    let count: usize = common::ask(
        &repo,
        "countUncommittedChanges",
        serde_json::json!({ "includeUntracked": true }),
    );
    // git: `D  a.txt` and `A  b.txt`, not one `R` line.
    assert_eq!(porcelain_lines(&repo), 2);
    assert_eq!(count, 2);
    // The details still pair the rename, as the CLI backend's `git diff --find-renames` does.
    let changes = uncommitted_changes(&repo);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].kind, GitFileStatus::Renamed);
    assert_eq!(changes[0].old_file_path, "a.txt");
}

#[test]
fn a_nested_repository_is_listed_as_a_directory() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "one");
    std::fs::create_dir(repo.path().join("inner")).unwrap();
    Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(repo.path().join("inner"))
        .output()
        .unwrap();
    repo.write("inner/f.txt", "f");

    let expected: Vec<String> = repo
        .git(&["status", "--porcelain", "--untracked-files=all"])
        .lines()
        .map(|line| line[3..].to_string())
        .collect();
    assert_eq!(expected, vec!["inner/"]);
    let engine = open(&repo);
    let (_, untracked) = deleted_and_untracked(&engine);
    assert_eq!(untracked, expected);
}

#[test]
fn comparing_with_the_working_tree_keeps_a_file_added_since_the_revision_an_addition() {
    require_git!();
    let mut repo = TestRepo::new();
    let base = repo.commit_file("a.txt", "1\n", "base");
    repo.commit_file("new.txt", "new\n", "add a file");
    repo.write("new.txt", "edited since\n");

    let engine = open(&repo);
    let changes = engine.diff(&base, "").unwrap();
    // `git diff --name-status <base>`: `A new.txt`, however it has been edited since.
    assert_eq!(
        repo.git(&["diff", "--name-status", &base]).trim(),
        "A\tnew.txt"
    );
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].kind, GitFileStatus::Added);
}

/* ---------- Commit text ---------- */

#[test]
fn a_subject_after_leading_blank_lines_is_read_as_git_reads_it() {
    require_git!();
    let repo = TestRepo::new();
    repo.write("a.txt", "1");
    repo.git(&["add", "-A"]);
    repo.git(&[
        "commit",
        "--quiet",
        "--cleanup=verbatim",
        "-m",
        "\n\n  leading blanks  \n\nbody",
    ]);

    let data = load(&repo, &all_refs(10));
    let expected = repo.git(&["log", "-1", "--format=%s"]);
    assert_eq!(data.commits[0].message, expected.trim_end_matches('\n'));
    assert_eq!(data.commits[0].message, "  leading blanks");
}

#[test]
fn a_commit_in_a_legacy_encoding_is_decoded_as_git_log_decodes_it() {
    require_git!();
    let repo = TestRepo::new();
    repo.write("a.txt", "1");
    repo.git(&["add", "-A"]);
    let tree = repo.git(&["write-tree"]).trim().to_string();
    let mut raw = format!("tree {tree}\nauthor Jos").into_bytes();
    raw.push(0xe9);
    raw.extend_from_slice(
        b" <j@example.com> 1600000000 +0000\ncommitter C <c@example.com> 1600000000 +0000\nencoding ISO-8859-1\n\ncaf",
    );
    raw.push(0xe9);
    raw.push(b'\n');
    let hash = git_with_input(
        repo.path(),
        &["hash-object", "-t", "commit", "-w", "--stdin"],
        &raw,
    )
    .trim()
    .to_string();
    repo.update_ref("refs/heads/main", &hash);

    let engine = open(&repo);
    let details = engine.commit(&hash).unwrap();
    assert_eq!(
        details.author,
        repo.git(&["log", "-1", "--format=%an"]).trim()
    );
    assert_eq!(details.author, "José");
    assert_eq!(details.body, "café");
    assert_eq!(engine.commit_subject(&hash).unwrap(), "café");
    let matches = engine.search_history("café").unwrap();
    assert_eq!(matches.len(), 1, "--grep matches the re-encoded message");
}

/* ---------- Shallow clones ---------- */

#[test]
fn a_shallow_boundary_commit_has_no_parents_and_opens_its_details() {
    require_git!();
    let mut source = TestRepo::new();
    for n in 1..=4 {
        source.commit_file("a.txt", &format!("{n}\n"), &format!("commit {n}"));
    }
    let clone_dir = tempfile::tempdir().unwrap();
    let url = format!("file://{}", source.path().display()).replace('\\', "/");
    let clone_path = clone_dir.path().join("clone");
    let output = Command::new("git")
        .args(["clone", "--quiet", "--depth", "2", &url])
        .arg(&clone_path)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let git_in_clone = |args: &[&str]| {
        String::from_utf8(
            Command::new("git")
                .args(args)
                .current_dir(&clone_path)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
    };
    let boundary = git_in_clone(&["rev-parse", "HEAD~1"]).trim().to_string();

    let data: GitCommitData =
        common::ask_at(clone_path.to_str().unwrap(), "loadCommits", all_refs(10));
    let record = data
        .commits
        .iter()
        .find(|record| record.hash == boundary)
        .unwrap();
    // git: `%P` is empty for the boundary commit.
    assert_eq!(
        git_in_clone(&["log", "-1", "--format=%P", &boundary]).trim(),
        ""
    );
    assert!(record.parents.is_empty(), "{:?}", record.parents);

    // Its details diff against the empty tree, as `git show` does, instead of failing on the
    // parent that was never fetched.
    let details: git_graph_core::model::GitCommitDetails = common::ask_at(
        clone_path.to_str().unwrap(),
        "commitDetails",
        serde_json::json!({ "hash": &boundary }),
    );
    assert!(details.parents.is_empty());
    assert_eq!(details.file_changes.len(), 1);
    assert_eq!(details.file_changes[0].kind, GitFileStatus::Added);
}

/* ---------- Diffs and line counts ---------- */

/// `git diff --numstat <parent> <commit>`, keyed by path.
fn numstat(repo: &TestRepo, commit: &str) -> Vec<(String, Option<u32>, Option<u32>)> {
    repo.git(&["diff", "--numstat", &format!("{commit}^"), commit])
        .lines()
        .map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            (
                fields[2].to_string(),
                fields[0].parse().ok(),
                fields[1].parse().ok(),
            )
        })
        .collect()
}

#[test]
fn line_counts_see_a_last_line_gaining_its_newline() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("noeol.txt", "a\nb", "without a final newline");
    let commit = repo.commit_file("noeol.txt", "a\nb\n", "with one");

    let counts = line_counts(&repo, None, &commit, &["noeol.txt".to_string()]);
    // git: `1 1 noeol.txt` — `-b` / `+b` with "\ No newline at end of file".
    assert_eq!(
        numstat(&repo, &commit),
        vec![("noeol.txt".to_string(), Some(1), Some(1))]
    );
    assert_eq!(counts["noeol.txt"].additions, Some(1));
    assert_eq!(counts["noeol.txt"].deletions, Some(1));
}

#[test]
fn an_empty_file_is_renamed_as_git_renames_it() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("empty.txt", "", "an empty file");
    repo.git(&["mv", "empty.txt", "moved.txt"]);
    let commit = repo.commit("move it");

    let engine = open(&repo);
    assert_eq!(
        repo.git(&[
            "diff",
            "--name-status",
            "--find-renames",
            &format!("{commit}^"),
            &commit
        ])
        .trim(),
        "R100\tempty.txt\tmoved.txt"
    );
    let changes = engine.commit_files(&commit).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].kind, GitFileStatus::Renamed);
    assert_eq!(changes[0].old_file_path, "empty.txt");
    // A pure rename has no content diff: git prints the header alone.
    let file_diff = engine.file_diff(&commit, "moved.txt").unwrap();
    assert!(!file_diff.contains("--- "), "{file_diff}");
}

#[test]
fn a_submodule_change_counts_and_diffs_as_its_subproject_line() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "1", "one");
    repo.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{first},vendored"),
    ]);
    repo.git(&["commit", "--quiet", "-m", "add a gitlink"]);
    let commit = repo.head();

    let engine = open(&repo);
    let counts = line_counts(&repo, None, &commit, &["vendored".to_string()]);
    assert_eq!(
        numstat(&repo, &commit),
        vec![("vendored".to_string(), Some(1), Some(0))]
    );
    assert_eq!(counts["vendored"].additions, Some(1));
    assert_eq!(counts["vendored"].deletions, Some(0));
    let file_diff = engine.file_diff(&commit, "vendored").unwrap();
    assert!(file_diff.contains("new file mode 160000\n"), "{file_diff}");
    assert!(
        file_diff.contains(&format!("+Subproject commit {first}\n")),
        "{file_diff}"
    );
}

#[test]
fn the_file_diff_honours_gitattributes_and_mode_changes() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.write(".gitattributes", "*.dat binary\n");
    repo.write("a.dat", "text\n");
    repo.write("run.sh", "echo\n");
    repo.commit("one");
    repo.write("a.dat", "text2\n");
    repo.git(&["add", "-A"]);
    // `commit()` restages everything with its own `add -A`, which on a platform that tracks
    // the executable bit restats every path from disk - so `update-index --chmod` alone would
    // be undone by that restage. The real chmod survives it; `update-index` is kept for
    // Windows, where the filesystem has no executable bit for `add -A` to restage from.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = repo.path().join("run.sh");
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
    }
    repo.git(&["update-index", "--chmod=+x", "run.sh"]);
    let commit = repo.commit("two");

    let engine = open(&repo);
    let dat = engine.file_diff(&commit, "a.dat").unwrap();
    assert!(
        dat.contains("Binary files a/a.dat and b/a.dat differ"),
        "`binary` in .gitattributes makes git print no hunks: {dat}"
    );
    let script = engine.file_diff(&commit, "run.sh").unwrap();
    assert!(
        script.contains("old mode 100644\nnew mode 100755\n"),
        "{script}"
    );
    assert!(
        !script.contains("--- "),
        "a mode-only change has no content diff: {script}"
    );
}

/* ---------- Tags of trees and blobs ---------- */

#[test]
fn a_tag_of_a_blob_or_a_tree_does_not_break_history_reads() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "one");
    let blob = repo.rev_parse("HEAD:a.txt");
    let tree = repo.rev_parse("HEAD^{tree}");
    repo.git(&["tag", "blobtag", &blob]);
    repo.git(&["tag", "-a", "treetag", "-m", "a tree", &tree]);
    repo.git(&["tag", "lighttree", &tree]);

    let engine = open(&repo);
    // `git log --all` passes over the tags that name no commit.
    let expected = repo.git(&["log", "--all", "--format=%H"]);
    let matches = engine.search_history("one").unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].hash, expected.trim());
    assert_eq!(engine.author_stats().unwrap()[0].commits, 1);

    let tag = engine.tag("lighttree").unwrap();
    assert_eq!(tag.hash, tree);
    assert_eq!(tag.message, "");
}

/* ---------- Mailmap in the statistics ---------- */

#[test]
fn author_statistics_apply_the_mailmap_as_shortlog_does() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file(
        ".mailmap",
        "Canonical Name <test@example.com> Test User <test@example.com>\n",
        "add a mailmap",
    );

    let engine = open(&repo);
    let shortlog = repo.git(&["shortlog", "-sne", "--all", "--no-merges", "HEAD"]);
    assert!(
        shortlog.contains("Canonical Name <test@example.com>"),
        "{shortlog}"
    );
    let stats = engine.author_stats().unwrap();
    assert_eq!(stats[0].name, "Canonical Name");
}

/* ---------- Replacement objects ---------- */

#[test]
fn replacement_objects_hand_the_graph_to_git() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "one");
    let two = repo.commit_file("a.txt", "2", "two");
    repo.commit_file("a.txt", "3", "three");
    repo.git(&["replace", "--graft", &two]);

    // git now shows `two` as a root; gix would still show its original parent.
    assert_eq!(repo.git(&["log", "--format=%H"]).lines().count(), 2);
    let options = LogOptions {
        max_commits: 10,
        ..Default::default()
    };
    let error = common::ask_error(&repo, "loadCommits", &options);
    assert_eq!(error.kind, ErrorKind::Unsupported);
    let error = open(&repo).commit(&two).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Unsupported);

    // `core.useReplaceRefs=false` makes git read the original objects, and gix 0.87 then applies
    // the replacements (it inverts the setting), so the engine still hands the load to git.
    // The warm handle was opened under the old setting, so it is dropped first — what a host
    // does when it knows the repository changed underneath it.
    git_graph_core::protocol::close(repo.path().to_str().unwrap());
    repo.git(&["config", "core.useReplaceRefs", "false"]);
    assert_eq!(repo.git(&["log", "--format=%H"]).lines().count(), 3);
    let error = common::ask_error(&repo, "loadCommits", &options);
    assert_eq!(error.kind, ErrorKind::Unsupported);
}
