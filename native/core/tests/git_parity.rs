//! Where gix and git read the same repository differently, checked against git itself.
//!
//! Each test pins one place a differential run of the two backends found the engine disagreeing
//! with the `git` command line: working-tree states gix classifies differently, commit text gix does
//! not re-encode or fold, shallow boundaries, rename and binary rules, and the objects a tag can
//! name. The expected answer always comes from running git on the same fixture.

#[macro_use]
mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use git_graph_core::repository::Repo;
use git_graph_core::types::{GitFileStatus, LogOptions};
use git_graph_core::{blob, details, diff, graph, log, stats, status, ErrorKind};

use common::TestRepo;

fn open(repo: &TestRepo) -> Repo {
    Repo::discover(repo.path()).expect("could not open the fixture repository")
}

/// How many lines `git status --porcelain` prints — what "Uncommitted Changes (N)" counts.
fn porcelain_lines(repo: &TestRepo) -> usize {
    repo.git(&["status", "--porcelain", "--untracked-files=all"])
        .lines()
        .filter(|line| !line.is_empty())
        .count()
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

/* ---------- Working-tree status ---------- */

#[test]
fn an_intent_to_add_file_is_an_uncommitted_addition() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "one");
    repo.write("new.txt", "new\n");
    repo.git(&["add", "-N", "new.txt"]);

    let engine = open(&repo);
    // git: ` A new.txt`.
    assert_eq!(
        status::count_changes(&engine, true).unwrap(),
        porcelain_lines(&repo)
    );
    assert_eq!(status::count_changes(&engine, true).unwrap(), 1);
    let changes = status::uncommitted_changes(&engine).unwrap();
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

    let engine = open(&repo);
    // git: `D  a.txt` and `?? a.txt`.
    assert_eq!(
        status::count_changes(&engine, true).unwrap(),
        porcelain_lines(&repo)
    );
    assert_eq!(status::count_changes(&engine, true).unwrap(), 2);
    let kinds: Vec<GitFileStatus> = status::uncommitted_changes(&engine)
        .unwrap()
        .into_iter()
        .map(|change| change.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![GitFileStatus::Deleted, GitFileStatus::Untracked]
    );
    let files = status::status_files(&engine, true).unwrap();
    assert_eq!(files.deleted, vec!["a.txt"]);
    assert_eq!(files.untracked, vec!["a.txt"]);
}

#[test]
fn status_renames_off_counts_both_halves_of_a_staged_rename() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", &"x\n".repeat(20), "one");
    repo.git(&["config", "status.renames", "false"]);
    repo.git(&["mv", "a.txt", "b.txt"]);

    let engine = open(&repo);
    // git: `D  a.txt` and `A  b.txt`, not one `R` line.
    assert_eq!(porcelain_lines(&repo), 2);
    assert_eq!(status::count_changes(&engine, true).unwrap(), 2);
    // The details still pair the rename, as the CLI backend's `git diff --find-renames` does.
    let changes = status::uncommitted_changes(&engine).unwrap();
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

    let engine = open(&repo);
    let expected: Vec<String> = repo
        .git(&["status", "--porcelain", "--untracked-files=all"])
        .lines()
        .map(|line| line[3..].to_string())
        .collect();
    assert_eq!(expected, vec!["inner/"]);
    assert_eq!(
        status::status_files(&engine, true).unwrap().untracked,
        expected
    );
}

#[test]
fn comparing_with_the_working_tree_keeps_a_file_added_since_the_revision_an_addition() {
    require_git!();
    let mut repo = TestRepo::new();
    let base = repo.commit_file("a.txt", "1\n", "base");
    repo.commit_file("new.txt", "new\n", "add a file");
    repo.write("new.txt", "edited since\n");

    let engine = open(&repo);
    let changes = diff::diff_revisions(&engine, &base, "").unwrap();
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

    let engine = open(&repo);
    let tips = log::all_tips(&engine, true, true).unwrap();
    let records = log::walk(
        &engine,
        &tips,
        &log::WalkOptions {
            limit: 10,
            ..Default::default()
        },
    )
    .unwrap();
    let expected = repo.git(&["log", "-1", "--format=%s"]);
    assert_eq!(records[0].message, expected.trim_end_matches('\n'));
    assert_eq!(records[0].message, "  leading blanks");
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
    let details = details::commit_details(&engine, &hash).unwrap();
    assert_eq!(
        details.author,
        repo.git(&["log", "-1", "--format=%an"]).trim()
    );
    assert_eq!(details.author, "José");
    assert_eq!(details.body, "café");
    assert_eq!(details::commit_subject(&engine, &hash).unwrap(), "café");
    let matches = log::search_history(&engine, "café").unwrap();
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

    let engine = Repo::discover(&clone_path).unwrap();
    let tips = log::all_tips(&engine, true, true).unwrap();
    let records = log::walk(
        &engine,
        &tips,
        &log::WalkOptions {
            limit: 10,
            ..Default::default()
        },
    )
    .unwrap();
    let record = records
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
    let details = details::commit_details(&engine, &boundary).unwrap();
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

    let engine = open(&repo);
    let counts = diff::line_counts(&engine, None, &commit, &["noeol.txt".to_string()]).unwrap();
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
    let changes = diff::diff_commit(&engine, &commit).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].kind, GitFileStatus::Renamed);
    assert_eq!(changes[0].old_file_path, "empty.txt");
    // A pure rename has no content diff: git prints the header alone.
    let file_diff = blob::commit_file_diff(&engine, &commit, "moved.txt").unwrap();
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
    let counts = diff::line_counts(&engine, None, &commit, &["vendored".to_string()]).unwrap();
    assert_eq!(
        numstat(&repo, &commit),
        vec![("vendored".to_string(), Some(1), Some(0))]
    );
    assert_eq!(counts["vendored"].additions, Some(1));
    assert_eq!(counts["vendored"].deletions, Some(0));
    let file_diff = blob::commit_file_diff(&engine, &commit, "vendored").unwrap();
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
    let dat = blob::commit_file_diff(&engine, &commit, "a.dat").unwrap();
    assert!(
        dat.contains("Binary files a/a.dat and b/a.dat differ"),
        "`binary` in .gitattributes makes git print no hunks: {dat}"
    );
    let script = blob::commit_file_diff(&engine, &commit, "run.sh").unwrap();
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
    let matches = log::search_history(&engine, "one").unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].hash, expected.trim());
    assert_eq!(stats::author_stats(&engine).unwrap()[0].commits, 1);

    let tag = details::tag_details(&engine, "lighttree").unwrap();
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
    let stats = stats::author_stats(&engine).unwrap();
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

    let engine = open(&repo);
    // git now shows `two` as a root; gix would still show its original parent.
    assert_eq!(repo.git(&["log", "--format=%H"]).lines().count(), 2);
    let options = LogOptions {
        max_commits: 10,
        ..Default::default()
    };
    let error = graph::load_commits(&engine, &options).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Unsupported);
    assert_eq!(
        details::commit_details(&engine, &two).unwrap_err().kind,
        ErrorKind::Unsupported
    );

    // `core.useReplaceRefs=false` makes git read the original objects, and gix 0.87 then applies
    // the replacements (it inverts the setting), so the engine still hands the load to git.
    repo.git(&["config", "core.useReplaceRefs", "false"]);
    assert_eq!(repo.git(&["log", "--format=%H"]).lines().count(), 3);
    let engine = open(&repo);
    assert_eq!(
        graph::load_commits(&engine, &options).unwrap_err().kind,
        ErrorKind::Unsupported
    );
}
