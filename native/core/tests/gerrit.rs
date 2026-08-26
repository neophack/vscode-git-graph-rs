//! The Gerrit NoteDb meta parser: the pure message grammar, and the repository walk that feeds it.
//!
//! The grammar cases mirror `tests/gerrit.test.mjs` on the extension side one for one — the engine
//! and the TypeScript pool must agree on every record shape Gerrit writes, or the badges would
//! change with the backend that answered. The repository test builds a meta history with
//! `git commit-tree` plumbing (exactly the records Gerrit's NoteDb writes) under
//! `refs/remotes/<remote>/changes/.../meta`, the ref a Gerrit fetch leaves behind.

#[macro_use]
mod common;

use std::process::Command;

use common::TestRepo;
use git_graph_core::gerrit::{
    parse_gerrit_metas, parse_meta_commit, parse_meta_history, MetaCommitRecord,
};
use git_graph_core::repository::Repo;

fn record(committer: &str, timestamp: i64, message: &str) -> MetaCommitRecord {
    MetaCommitRecord {
        committer: committer.to_string(),
        timestamp,
        message: message.to_string(),
    }
}

#[test]
fn recognises_the_create_change_event() {
    let parsed = parse_meta_commit(&record(
        "Dev",
        1_600_000_060,
        "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\n",
    ))
    .expect("a create record is a review event");
    assert_eq!(parsed.event.kind, "created");
    assert_eq!(parsed.patchset, 1);
    assert_eq!(parsed.event.patchset, 1);
}

#[test]
fn collects_label_footers_into_votes() {
    let parsed = parse_meta_commit(&record(
        "Dev",
        1_600_000_120,
        "Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\n",
    ))
    .expect("a vote record is a review event");
    assert_eq!(parsed.event.kind, "vote");
    let labels = parsed.event.labels.as_ref().expect("the votes are carried");
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0].name, "Code-Review");
    assert_eq!(labels[0].value, 2);
    assert_eq!(parsed.patchset, 2); // the "Patch Set N:" header overrides the footer
}

#[test]
fn resolves_the_submitter_of_a_merge_from_the_body() {
    let parsed = parse_meta_commit(&record(
        "Gerrit User 1000018",
        1_600_000_180,
        "Update patch set 3\n\nChange has been successfully merged by Alice Developer <alice@example.com>\n\nPatch-set: 3\nStatus: merged\n",
    ))
    .expect("a submit record is a review event");
    assert_eq!(parsed.event.kind, "merged");
    assert_eq!(parsed.status, Some("merged"));
    assert_eq!(parsed.event.reviewer.as_deref(), Some("Alice Developer"));
}

#[test]
fn maps_an_abandoned_header_to_the_abandoned_status() {
    let parsed = parse_meta_commit(&record("Dev", 1_600_000_240, "Abandoned\n\nPatch-set: 2\n"))
        .expect("an abandon record is a review event");
    assert_eq!(parsed.event.kind, "abandoned");
    assert_eq!(parsed.status, Some("abandoned"));
}

#[test]
fn recognises_work_in_progress_transitions() {
    let wip_started = parse_meta_commit(&record(
        "Dev",
        1_600_000_300,
        "Start Work In Progress\n\nPatch-set: 1\n",
    ))
    .expect("a WIP start is a review event");
    assert_eq!(wip_started.event.kind, "wip");
    assert_eq!(wip_started.wip, Some(true));

    let wip_upload = parse_meta_commit(&record(
        "Dev",
        1_600_000_360,
        "Uploaded patch set 2 (WIP)\n\nPatch-set: 2\nWork-in-progress: true\n",
    ))
    .expect("a WIP upload is a review event");
    // The WIP shape of an upload must be classified before the generic "Uploaded patch set" one
    assert_eq!(wip_upload.event.kind, "wip");
    assert_eq!(wip_upload.wip, Some(true));
    assert_eq!(wip_upload.patchset, 2);

    let plain_upload = parse_meta_commit(&record(
        "Dev",
        1_600_000_420,
        "Uploaded patch set 2.\n\nPatch-set: 2\n",
    ))
    .expect("an upload is a review event");
    assert_eq!(plain_upload.event.kind, "patchset");

    let ready = parse_meta_commit(&record(
        "Dev",
        1_600_000_480,
        "Remove WIP\n\nPatch-set: 1\nWork-in-progress: false\n",
    ))
    .expect("a ready-for-review record is a review event");
    assert_eq!(ready.event.kind, "ready");
    assert_eq!(ready.wip, Some(false));
}

#[test]
fn rejects_records_without_any_patchset_reference() {
    assert!(parse_meta_commit(&record("Dev", 1_600_000_540, "Status: new\n")).is_none());
}

#[test]
fn derives_the_state_from_the_newest_first_records() {
    // Newest first, as the history walk and `git log` produce: a merged change of two patchsets
    // with a +2 on the second.
    let head2 = "0123456789012345678901234567890123456789";
    let head1 = "9876543210987654321098765432109876543210";
    let records = vec![
        record(
            "Gerrit User 1000018",
            1_600_000_600,
            "Update patch set 3\n\nChange has been successfully merged by Alice Developer\n\nPatch-set: 1\nStatus: merged\nCommit: 1111111111111111111111111111111111111111\n",
        ),
        record(
            "Reviewer",
            1_600_000_540,
            "Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\nCommit: 0123456789012345678901234567890123456789\n",
        ),
        record(
            "Dev",
            1_600_000_480,
            "Uploaded patch set 2.\n\nPatch-set: 2\nCommit: 9876543210987654321098765432109876543210\n",
        ),
        record(
            "Dev",
            1_600_000_420,
            "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nCommit: 9876543210987654321098765432109876543210\n",
        ),
    ];
    let state = parse_meta_history(41466, &records).expect("the history carries commit hashes");
    assert_eq!(state.change, 41466);
    assert_eq!(state.patchset, 2);
    assert_eq!(state.status, "merged");
    assert!(!state.wip);
    assert_eq!(state.code_review, 2);
    assert_eq!(state.verified, 0);
    // The merged record references an older patchset's commit (a stale footer Gerrit kept): the
    // latest patchset's own hash must win
    assert_eq!(state.head_hash, head2);
    assert_eq!(state.events.len(), 4);
    assert_eq!(state.events[0].kind, "merged"); // newest first
    assert_eq!(state.events[3].kind, "created");
    let _ = head1;
}

#[test]
fn prefers_the_strongest_vote_even_when_recorded_earlier() {
    let records = vec![
        record(
            "Dev",
            1_600_000_600,
            "Uploaded patch set 3.\n\nPatch-set: 3\nCommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        ),
        record(
            "Reviewer",
            1_600_000_540,
            "Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\nCommit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        ),
        record(
            "Other Reviewer",
            1_600_000_480,
            "Patch Set 1: Code-Review-1\n\nPatch-set: 1\nLabel: Code-Review=-1\nCommit: cccccccccccccccccccccccccccccccccccccccc\n",
        ),
    ];
    let state = parse_meta_history(41, &records).expect("the history carries commit hashes");
    assert_eq!(state.code_review, 2);
    assert_eq!(state.patchset, 3);
    assert_eq!(state.status, "new");
}

#[test]
fn falls_back_to_any_commit_footer_when_the_latest_patchset_has_none() {
    let records = vec![
        record(
            "Dev",
            1_600_000_600,
            "Uploaded patch set 2.\n\nPatch-set: 2\n",
        ),
        record(
            "Dev",
            1_600_000_540,
            "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nCommit: dddddddddddddddddddddddddddddddddddddddd\n",
        ),
    ];
    let state = parse_meta_history(42, &records).expect("a commit hash exists in the history");
    assert_eq!(state.patchset, 2);
    assert_eq!(state.head_hash, "dddddddddddddddddddddddddddddddddddddddd");
}

#[test]
fn returns_none_when_no_record_carries_a_commit_hash() {
    let records = vec![record(
        "Dev",
        1_600_000_600,
        "Uploaded patch set 1.\n\nPatch-set: 1\n",
    )];
    assert!(parse_meta_history(43, &records).is_none());
    assert!(parse_meta_history(44, &[]).is_none());
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

    let engine = Repo::discover(repo.path()).expect("could not open the fixture repository");
    let states = parse_gerrit_metas(
        &engine,
        "origin",
        &[41466, 5, 99999, 0],
        Some("https://gerrit.example.com/c/repo/+/"),
    )
    .expect("the meta histories are readable");

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

    let engine = Repo::discover(repo.path()).expect("could not open the fixture repository");
    let states =
        parse_gerrit_metas(&engine, "origin", &[7], None).expect("the meta history is readable");
    let state = states[0].as_ref().expect("the change has a state");
    assert_eq!(state.url, None);
    assert_eq!(state.status, "new");
}
