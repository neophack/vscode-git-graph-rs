//! Deriving a change's state from its parsed `NoteDb` meta history.

use std::collections::HashMap;

use crate::model::{GerritChangeEvent, GerritChangeState};

use super::meta::{parse_meta_commit, regex_commit_footer, MetaCommitRecord};

/// Parse the full `NoteDb` meta history of a change into its state.
///
/// `records` are newest first, as the history walk and `git log` produce them.
pub(crate) fn parse_meta_history(
    change: u64,
    records: &[MetaCommitRecord],
) -> Option<GerritChangeState> {
    if records.is_empty() {
        return None;
    }

    let mut events: Vec<GerritChangeEvent> = Vec::new();
    let mut status = "new";
    let mut wip = false;
    let mut latest_patchset = 0;
    let mut status_determined = false;
    let mut wip_determined = false;
    // The vote values per label, in the order the (newest-first) records carry them.
    let mut cr_votes: Vec<i32> = Vec::new();
    let mut v_votes: Vec<i32> = Vec::new();
    // The first-seen (i.e. newest) `Commit:` hash of each patchset. The head hash cannot be picked
    // in passing: a record referencing an OLDER patchset (a late vote on it) can be newer than the
    // latest patchset's upload, and must not win over the latest patchset's own hash.
    let mut commit_by_patchset: HashMap<u32, String> = HashMap::new();

    for record in records {
        let Some(parsed) = parse_meta_commit(record) else {
            continue;
        };

        if parsed.patchset > latest_patchset {
            latest_patchset = parsed.patchset;
        }
        // Records are iterated newest first: the first (i.e. most recent) status/wip transition wins
        if let Some(parsed_status) = parsed.status {
            if !status_determined {
                status = parsed_status;
                status_determined = true;
            }
        }
        if let Some(parsed_wip) = parsed.wip {
            if !wip_determined {
                wip = parsed_wip;
                wip_determined = true;
            }
        }
        if let Some(hash) = parsed.commit_hash {
            commit_by_patchset.entry(parsed.patchset).or_insert(hash);
        }
        if parsed.event.kind == "vote" {
            if let Some(labels) = &parsed.event.labels {
                for label in labels {
                    if label.name == "Code-Review" {
                        cr_votes.push(label.value);
                    } else if label.name == "Verified" {
                        v_votes.push(label.value);
                    }
                }
            }
        }
        events.push(parsed.event);
    }

    // The head hash of the change is the newest `Commit:` referencing the latest patchset.
    let head_hash = match commit_by_patchset.get(&latest_patchset) {
        Some(hash) => hash.clone(),
        None => {
            // Fall back to any commit hash found in the history
            let mut fallback = None;
            for record in records {
                if let Some(m) = regex_commit_footer().captures(&record.message) {
                    fallback = Some(m[1].to_string());
                    break;
                }
            }
            fallback?
        }
    };

    Some(GerritChangeState {
        change,
        patchset: latest_patchset,
        code_review: strongest_vote(&cr_votes),
        verified: strongest_vote(&v_votes),
        status: status.to_string(),
        wip,
        head_hash,
        events,
        url: None,
    })
}

/// The strongest vote of one label: the value with the greatest absolute value (ties broken by
/// recency, so the first seen wins — the values are newest first).
fn strongest_vote(values: &[i32]) -> i32 {
    let mut best: i32 = 0;
    for &value in values {
        if value.abs() > best.abs() {
            best = value;
        }
    }
    best
}
