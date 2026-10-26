//! The window: how many commits a walk reads, and how pinned commits are spliced into the page
//! cut from it.

use std::collections::HashSet;

use gix::ObjectId;

use crate::error::Result;
use crate::model::CommitRecord;
use crate::repository::{Repo, Shallow};

use super::walk::read_commit;

/// How many commits are read for every commit displayed, so that the topological re-ordering has
/// enough of the graph to be exact over the page it returns.
const WINDOW_FACTOR: usize = 2;

/// A floor on the window, so that small pages still see enough of a branchy history.
const WINDOW_MINIMUM: usize = 256;

/// A ceiling on how far a path-filtered walk searches before giving up on filling the page.
/// Without it, filtering by a path that only a very old commit touched would walk all of history.
pub(super) const FILTERED_WALK_LIMIT: usize = 250_000;

/// How many commits a plain (unfiltered) walk of `limit` reads, so that the topological
/// re-ordering has enough of the graph to be exact over the page it returns. The incremental
/// boundary walk caps itself with the same number, keeping its merged window identical to what
/// a full traversal would have read.
pub(crate) fn window_size(limit: usize) -> usize {
    (limit * WINDOW_FACTOR).max(WINDOW_MINIMUM)
}

/// Keep the commits at `pinned` on the page, wherever the walk left them.
///
/// The page is the newest `limit` commits reachable from the tips, so a tip whose commit is older
/// than the page's last commit — a Gerrit change opened months ago, say — is walked from and then
/// dropped by the page cut. The Gerrit integration promises a badge for every change it injects,
/// so each pinned commit missing from `records` is read and inserted at its date position: below
/// every newer commit (its children, if any are on the page, are newer than it) and above every
/// older one (its parents), which keeps the page's topological ordering intact. A pinned commit
/// that does not resolve is skipped rather than failing the load.
pub fn pin_commits(
    repo: &Repo,
    records: &mut Vec<CommitRecord>,
    pinned: &[ObjectId],
) -> Result<()> {
    if pinned.is_empty() {
        return Ok(());
    }
    let git = repo.borrow();
    let shallow = Shallow::of(&git);
    let mut present: HashSet<String> = records.iter().map(|record| record.hash.clone()).collect();
    for id in pinned {
        if present.contains(&id.to_string()) {
            continue;
        }
        let Ok(commit) = git.find_commit(*id) else {
            continue;
        };
        let record = read_commit(&commit, &shallow)?;
        let position = records
            .iter()
            .position(|existing| existing.date < record.date)
            .unwrap_or(records.len());
        present.insert(record.hash.clone());
        records.insert(position, record);
    }
    Ok(())
}
