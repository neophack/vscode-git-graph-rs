//! Gerrit `NoteDb` meta histories, parsed in one in-process pass.
//!
//! A Gerrit repository under the view's "Fetch change refs" setting holds a `NoteDb` *meta* ref for
//! every fetched change — a linear chain of commits whose messages record the change's review
//! events (uploads, votes, status transitions). Turning those into the states the badges and the
//! review dialog show is pure parsing over the object database, which is exactly what the engine
//! is for: one native call reads every requested history from the warm repository handle, where
//! the previous implementation spawned one `git log` per change and dominated the view's load time
//! on large Gerrit repositories.
//!
//! The message grammar itself is Gerrit's, not ours: subjects like "Uploaded patch set 2" and
//! "Patch Set 3: Code-Review+2" with `Patch-set:`/`Status:`/`Commit:`/`Label:` footers. The
//! classification below is a faithful port of the parser that ran on the extension host (see
//! `src/gerrit.ts`), case for case, so the two agree on every record shape Gerrit writes — the
//! differential tests pin that.
//!
//! The submodules split that pipeline in two — [`meta`] reads a `NoteDb` history and parses each
//! message through the grammar, [`state`] derives a change's state from the parsed records — and
//! the engine-facing entry points stay here.

mod meta;
mod state;

use crate::error::{Result, ResultExt};
use crate::model::{GerritChangeEvent, GerritChangeState};
use crate::repository::Repo;

use meta::{read_meta_history, MetaCommitRecord};
use state::parse_meta_history;

/// Parse one `NoteDb` meta commit message through Gerrit's grammar, without a repository.
///
/// The pure half of [`parse_gerrit_metas`]: that function reads a meta ref's history and feeds
/// every record to the same parser in `meta` that this exposes. `committer` and `timestamp` are
/// the meta commit's own signature (who wrote the record, when); the returned event, when the
/// message is a recognised review event, carries the derived kind, patchset and labels.
///
/// This is the engine-facing entry for the boundary fuzzing: the always-on property
/// tests and the cargo-fuzz target drive exactly this function with
/// pseudo-random bytes, so a panic here is found before it reaches a user's repository data.
pub fn parse_meta_message(
    committer: &str,
    timestamp: i64,
    message: &str,
) -> Option<GerritChangeEvent> {
    meta::parse_meta_commit(&MetaCommitRecord {
        committer: committer.to_string(),
        timestamp,
        message: message.to_string(),
    })
    .map(|parsed| parsed.event)
}

/// Parse the `NoteDb` meta histories of the given changes into their states, in one pass.
///
/// The result is aligned with `changes`: an entry is `None` when the change's meta ref is not
/// available locally (never fetched, or pruned). `url_base`, when given, is prefixed onto each
/// change number to produce the state's web URL, so the states arrive complete.
pub fn parse_gerrit_metas(
    repo: &Repo,
    remote: &str,
    changes: &[i64],
    url_base: Option<&str>,
) -> Result<Vec<Option<GerritChangeState>>> {
    let git = repo.borrow();
    let mut states = Vec::with_capacity(changes.len());
    for &change in changes {
        // A change number comes from the extension's own ref parsing, so a non-positive one can
        // only be a bug on the other side of the boundary — answered with "no meta" rather than a
        // malformed ref lookup.
        if change <= 0 {
            states.push(None);
            continue;
        }
        let meta_ref = format!(
            "refs/remotes/{remote}/changes/{:02}/{change}/meta",
            change % 100
        );
        let records = read_meta_history(&git, &meta_ref)?;
        let state = parse_meta_history(change as u64, &records).map(|mut state| {
            state.url = url_base.map(|base| format!("{base}{change}"));
            state
        });
        states.push(state);
    }
    Ok(states)
}

/// The local change refs of a remote (`refs/remotes/<remote>/changes/**`), each with the hash it
/// points at, read in one in-process scan of the ref store.
///
/// This is the engine counterpart of `git for-each-ref refs/remotes/<remote>/changes/`, which the
/// Gerrit integration runs both to list the locally cached changes (the offline cache rebuild, and
/// the "ls-remote returned nothing" unreachable-remote check) and to resolve every `NoteDb` meta ref
/// hash in bulk — each use costing one child process on the extension host otherwise.
///
/// Symbolic refs under the prefix are skipped: change refs are always direct, and the common
/// symbolic ref of a remote (`refs/remotes/<remote>/HEAD`) lives outside the `changes/` tree.
pub fn list_change_refs(repo: &Repo, remote: &str) -> Result<Vec<(String, String)>> {
    let git = repo.borrow();
    let prefix = format!("refs/remotes/{remote}/changes/");
    let platform = git.references().git_ctx("Could not read references")?;
    let mut refs = Vec::new();
    for reference in platform
        .prefixed(prefix.as_str())
        .git_ctx("Could not read the Gerrit change refs")?
        .filter_map(std::result::Result::ok)
    {
        if let gix::refs::TargetRef::Object(id) = reference.target() {
            refs.push((reference.name().as_bstr().to_string(), id.to_string()));
        }
    }
    Ok(refs)
}

#[cfg(test)]
mod tests {
    use super::meta::{parse_meta_commit, MetaCommitRecord};
    use super::state::parse_meta_history;

    /// A record with the given committer, timestamp and message.
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
    fn reads_a_header_only_vote_without_a_label_footer() {
        // The canonical NoteDb shape of a modern vote: "Patch Set N: Label±V" with NO space before
        // the value and no `Label:` footer at all — the header is then the only evidence of the
        // vote, and a miss degrades the record to a comment (silently dropping every badge).
        let parsed = parse_meta_commit(&record(
            "Reviewer",
            1_600_000_150,
            "Patch Set 2: Code-Review+2\n\nPatch-set: 2\nCommit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        ))
        .expect("a vote record is a review event");
        assert_eq!(parsed.event.kind, "vote");
        let labels = parsed.event.labels.as_ref().expect("the votes are carried");
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "Code-Review");
        assert_eq!(labels[0].value, 2);
    }

    #[test]
    fn classifies_restore_ready_for_review_as_ready() {
        // "Restore Ready for Review" readies the change in the same record that restores it: the
        // plain "Restore" fallback must not swallow it and leave the change stuck as WIP.
        let parsed = parse_meta_commit(&record(
            "Dev",
            1_600_000_300,
            "Restore Ready for Review\n\nPatch-set: 2\n",
        ))
        .expect("a restore-ready record is a review event");
        assert_eq!(parsed.event.kind, "ready");
        assert_eq!(parsed.wip, Some(false));
        assert_eq!(parsed.status, Some("new"));
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
        let parsed =
            parse_meta_commit(&record("Dev", 1_600_000_240, "Abandoned\n\nPatch-set: 2\n"))
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
}
