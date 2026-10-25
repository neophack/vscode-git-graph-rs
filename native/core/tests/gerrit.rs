//! The Gerrit NoteDb meta parser's repository walk: the ref scan and meta-history reads that feed
//! the pure message grammar (whose cases live in `read/gerrit.rs`'s unit tests).
//!
//! The repository test builds a meta history with `git commit-tree` plumbing (exactly the records
//! Gerrit's NoteDb writes) under `refs/remotes/<remote>/changes/.../meta`, the ref a Gerrit fetch
//! leaves behind.

#[macro_use]
mod common;

use std::process::Command;

use common::TestRepo;
use git_graph_core::model::GerritChangeState;

/// The parsed states of a batch of changes, through the request the badge column sends.
fn parse_gerrit_metas(
    repo: &TestRepo,
    remote: &str,
    changes: &[i64],
    url_base: Option<&str>,
) -> Vec<Option<GerritChangeState>> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Params<'a> {
        remote: &'a str,
        changes: &'a [i64],
        url_base: Option<&'a str>,
    }
    common::ask(
        repo,
        "parseGerritMetas",
        Params {
            remote,
            changes,
            url_base,
        },
    )
}

/// `(change ref, hash)` pairs below the remote's `changes/` namespace.
fn list_change_refs(repo: &TestRepo, remote: &str) -> Vec<(String, String)> {
    common::ask(
        repo,
        "listChangeRefs",
        serde_json::json!({ "remote": remote }),
    )
}

/* ---------- The repository walk ---------- */

/// One NoteDb meta commit, built with plumbing at the fixture clock's next tick: the committer
/// (the Gerrit user that acted) and an increasing timestamp, so newest-first order is exact.
fn commit_meta(
    repo: &TestRepo,
    parent: Option<&str>,
    committer: &str,
    clock: &mut i64,
    message: &str,
) -> String {
    *clock += 60;
    let date = format!("{} +0000", *clock);
    let empty_tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let mut args: Vec<String> = vec!["commit-tree".to_string(), empty_tree.to_string()];
    if let Some(parent) = parent {
        args.push("-p".to_string());
        args.push(parent.to_string());
    }
    args.push("-m".to_string());
    args.push(message.to_string());
    let output = Command::new("git")
        .args(&args)
        .current_dir(repo.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", repo.path())
        .env("GIT_COMMITTER_NAME", committer)
        .env("GIT_COMMITTER_EMAIL", "1000018@gerrit.example.com")
        .env("GIT_COMMITTER_DATE", &date)
        .output()
        .expect("could not run `git commit-tree`");
    assert!(
        output.status.success(),
        "`git commit-tree` failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn parses_the_meta_histories_the_refs_point_at() {
    require_git!();
    let repo = TestRepo::new();
    let mut clock = 1_600_000_000_i64;

    // A change of two patchsets, merged: created → upload 2 → vote → submit (oldest built first)
    let head1 = commit_meta(
        &repo,
        None,
        "Dev",
        &mut clock,
        "Create change in repo by Dev\n\nUploaded patch set 1.\n\nPatch-set: 1\nCommit: 1111111111111111111111111111111111111111\n",
    );
    let _ = head1;
    let head2 = commit_meta(
        &repo,
        Some(&head1),
        "Dev",
        &mut clock,
        "Uploaded patch set 2.\n\nPatch-set: 2\nCommit: 2222222222222222222222222222222222222222\n",
    );
    let voted = commit_meta(
        &repo,
        Some(&head2),
        "Reviewer",
        &mut clock,
        "Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\n",
    );
    let merged = commit_meta(
        &repo,
        Some(&voted),
        "Gerrit User 1000018",
        &mut clock,
        "Update patch set 2\n\nChange has been successfully merged by Alice Developer\n\nPatch-set: 2\nStatus: merged\n",
    );
    repo.update_ref("refs/remotes/origin/changes/66/41466/meta", &merged);

    // A WIP change with no head hash at all
    let wip = commit_meta(
        &repo,
        None,
        "Dev",
        &mut clock,
        "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\n",
    );
    repo.update_ref("refs/remotes/origin/changes/05/5/meta", &wip);

    let states = parse_gerrit_metas(
        &repo,
        "origin",
        &[41466, 5, 99999, 0],
        Some("https://gerrit.example.com/c/repo/+/"),
    );

    assert_eq!(states.len(), 4);
    let state = states[0].as_ref().expect("the merged change has a state");
    assert_eq!(state.change, 41466);
    assert_eq!(state.patchset, 2);
    assert_eq!(state.status, "merged");
    assert_eq!(state.code_review, 2);
    assert_eq!(state.head_hash, "2222222222222222222222222222222222222222");
    assert_eq!(
        state.url.as_deref(),
        Some("https://gerrit.example.com/c/repo/+/41466")
    );
    // The events are newest first, as `git log` prints them
    assert_eq!(
        state
            .events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["merged", "vote", "patchset", "created"]
    );
    assert_eq!(state.events[0].reviewer.as_deref(), Some("Alice Developer"));

    // No commit hash anywhere in the history: no state (the change has no badge anchor)
    assert!(states[1].is_none());
    // A change whose meta ref was never fetched
    assert!(states[2].is_none());
    // A non-positive change number cannot have a meta ref
    assert!(states[3].is_none());
}

#[test]
fn joins_the_url_base_when_there_is_none() {
    require_git!();
    let repo = TestRepo::new();
    let mut clock = 1_600_000_000_i64;
    let tip = commit_meta(
        &repo,
        None,
        "Dev",
        &mut clock,
        "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nCommit: 3333333333333333333333333333333333333333\n",
    );
    repo.update_ref("refs/remotes/origin/changes/07/7/meta", &tip);

    let states = parse_gerrit_metas(&repo, "origin", &[7], None);
    let state = states[0].as_ref().expect("the change has a state");
    assert_eq!(state.url, None);
    assert_eq!(state.status, "new");
}

#[test]
fn lists_the_local_change_refs_with_their_hashes() {
    require_git!();
    let repo = TestRepo::new();
    let mut clock = 1_600_000_000_i64;
    let ps1 = commit_meta(
        &repo,
        None,
        "Dev",
        &mut clock,
        "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\n",
    );
    let ps2 = commit_meta(
        &repo,
        None,
        "Dev",
        &mut clock,
        "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\n",
    );
    let meta = commit_meta(
        &repo,
        None,
        "Dev",
        &mut clock,
        "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\n",
    );
    repo.update_ref("refs/remotes/origin/changes/34/1234/1", &ps1);
    repo.update_ref("refs/remotes/origin/changes/34/1234/2", &ps2);
    repo.update_ref("refs/remotes/origin/changes/34/1234/meta", &meta);
    // Refs of other remotes and non-change refs must not leak into the listing
    repo.update_ref("refs/remotes/origin/main", &ps1);
    repo.update_ref("refs/remotes/upstream/changes/34/1234/1", &ps1);
    repo.update_ref("refs/heads/main", &ps1);

    let mut refs = list_change_refs(&repo, "origin");
    refs.sort();
    assert_eq!(
        refs,
        vec![
            ("refs/remotes/origin/changes/34/1234/1".to_string(), ps1),
            ("refs/remotes/origin/changes/34/1234/2".to_string(), ps2),
            ("refs/remotes/origin/changes/34/1234/meta".to_string(), meta),
        ]
    );

    // A remote with no change refs yields an empty listing (not an error)
    let empty = list_change_refs(&repo, "other");
    assert!(empty.is_empty());
}
