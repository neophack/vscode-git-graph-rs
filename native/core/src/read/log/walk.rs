//! The traversal: walking from the tips and reading the commits the page is cut from.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

use gix::ObjectId;

use crate::cancel::Cancel;
use crate::error::{Result, ResultExt};
use crate::model::CommitRecord;
use crate::repository::{Repo, Shallow};
use crate::text::{self, CommitEncoding};

use super::filter::{commit_matches_author, rewrite_parents, touches_paths};
use super::window::{window_size, FILTERED_WALK_LIMIT};
use super::WalkResult;

#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    /// The maximum number of commits to return.
    pub limit: usize,
    /// Follow only the first parent of each merge.
    pub first_parent_only: bool,
    /// Keep only commits whose author name matches one of these (case-insensitive substring, as
    /// `git log --author` matches).
    pub authors: Option<Vec<String>>,
    /// Keep only commits that changed one of these repository-relative paths.
    pub filter_paths: Vec<String>,
    /// The request's cancellation state, checked every [`crate::cancel::CHECK_INTERVAL`]
    /// iterations; [`Cancel::none`] (the default) makes the walk uncancellable, as before.
    pub cancel: Cancel,
}

/// Walk from `tips`, answering the page of commits the view should render together with the
/// window the page was cut from (the incremental cache continues from that window).
pub fn walk_windowed(repo: &Repo, tips: &[ObjectId], options: &WalkOptions) -> Result<WalkResult> {
    if options.limit == 0 || tips.is_empty() {
        return Ok(WalkResult::default());
    }
    let git = repo.borrow();
    // An empty path and an empty author list are no filter at all, exactly as the CLI backend
    // reads them: it drops empty paths before `-- <paths>` and passes no `--author` for an empty
    // list. Taken literally they would instead filter out every empty commit and every commit.
    let filter_paths: Vec<String> = options
        .filter_paths
        .iter()
        .filter(|path| !path.is_empty())
        .cloned()
        .collect();
    let authors = options
        .authors
        .as_deref()
        .filter(|authors| !authors.is_empty());
    let filtering = !filter_paths.is_empty();
    // An author filter has the same problem as a path filter: matches can be sparse, so a fixed
    // window can run dry and silently return fewer commits than asked for (and hide "Load More"
    // even though more matches exist deeper in history) instead of searching until the page is
    // full, the way `git log --author` does.
    let searching = filtering || authors.is_some();

    // A filtered walk cannot know in advance how deep it must go to fill a page, so it walks until
    // the page is full (or the safety limit is hit) instead of taking a fixed window.
    let window = if searching {
        FILTERED_WALK_LIMIT
    } else {
        window_size(options.limit)
    };

    let mut records: Vec<CommitRecord> = Vec::new();
    // While filtering, the parents of every commit the walk *reads* are kept, not just of the
    // ones it keeps: re-parenting a shown commit means tracing through the hidden commits
    // between it and its nearest shown ancestor, which requires their parents too.
    let mut visited_parents: Vec<(String, Vec<String>)> = Vec::new();

    if searching {
        // The filtered search keeps the traversal it had: git's own filtering (`--author`,
        // `-- <paths>`) ranks and cuts matches the same way, and the re-parenting below needs the
        // hidden commits between matches, which a search to the safety limit reads anyway.
        let mut platform =
            git.rev_walk(tips.iter().copied())
                .sorting(gix::revision::walk::Sorting::ByCommitTime(
                    gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
                ));
        if options.first_parent_only {
            platform = platform.first_parent_only();
        }
        let walk = platform.all().git_ctx("Could not walk the commit graph")?;
        let shallow = Shallow::of(&git);

        let mut visited = 0usize;
        for info in walk {
            let info = match info {
                Ok(info) => info,
                // A missing object (a shallow clone's boundary, or a corrupt pack) truncates the walk
                // rather than failing the whole view.
                Err(_) => break,
            };
            visited += 1;
            if visited > window {
                break;
            }
            // The cancellation checkpoint: a relaxed flag read every CHECK_INTERVAL-th
            // commit, so a cancelled traversal unwinds promptly without costing the walk measurably.
            options.cancel.check(visited)?;

            let commit = match git.find_commit(info.id) {
                Ok(commit) => commit,
                Err(_) => continue,
            };

            // The filters judge a commit on its identity alone — author, parents, the object ids below
            // its tree — so the message and the dates of the commits about to be dropped are never
            // decoded. On a filtered walk through a large repository that is nearly every commit it
            // reads.
            let author_ok = match authors {
                Some(authors) => commit_matches_author(&commit, authors)?,
                None => true,
            };
            if filtering {
                visited_parents.push((
                    commit.id().detach().to_string(),
                    shallow
                        .parents(&commit)
                        .iter()
                        .map(ToString::to_string)
                        .collect(),
                ));
            }
            if !author_ok {
                continue;
            }
            if filtering
                && !touches_paths(
                    &git,
                    &commit,
                    &shallow,
                    &filter_paths,
                    options.first_parent_only,
                )?
            {
                continue;
            }

            records.push(read_commit(&commit, &shallow)?);
            if records.len() >= options.limit {
                break;
            }
        }
    } else {
        // The plain page: collect the window in git's date order directly.
        records = walk_date_order_window(
            &git,
            tips,
            window,
            options.first_parent_only,
            &options.cancel,
        )?;
    }

    if filtering {
        // History simplification: a commit whose parent was filtered out is re-parented onto its
        // nearest shown ancestor, so the graph stays connected instead of breaking into fragments.
        rewrite_parents(&mut records, &visited_parents);
    }

    // The page itself — the window ordered and cut — is derived by `read::graph`, which owns the
    // page assembly for every walk (full and incremental alike).
    Ok(WalkResult { window: records })
}

/// The plain page's window: the first `window` commits of git's `--date-order`.
///
/// `--date-order` is topological. A commit is shown only once every child of it has been shown,
/// and among the commits whose children are all shown — the ready set — the newest committer
/// date goes first. The constraint is what keeps a tip whose committer date is older than the
/// history around it (an out-of-band commit under a pinned date, an imported branch) on the
/// page: the line it sits on cannot unwind until the tip itself has been shown, so the newest
/// line waits behind it instead of burying the tip below every newer-dated commit.
///
/// Which commits are ready cannot be decided during the walk itself: a commit whose child has
/// not been read yet looks childless, and would pop at its own date while git still holds it —
/// for a branch point whose second line unwinds much later, an entire newest line would pour
/// past the held commit. The traversal therefore has git's shape: one pass reading every
/// reachable commit's header and counting its children (git's `limit_list`), then the
/// date-ranked ready set over the counted graph (git's `sort_in_topological_order`), cut at the
/// window. The count pass is the price of the ordering — the CLI backend's `git log
/// --date-order` pays it too — and it reads headers only, the cheapest read a commit offers;
/// the incremental cache's guards decide per refresh whether even that is needed.
fn walk_date_order_window(
    git: &gix::Repository,
    tips: &[ObjectId],
    window: usize,
    first_parent_only: bool,
    cancel: &Cancel,
) -> Result<Vec<CommitRecord>> {
    let shallow = Shallow::of(git);

    // The committer date each discovered commit is ranked by, and how many of its children have
    // been found. A commit is ready when its child count is zero — which for a true tip (nothing
    // in the repository descends from it) is immediately, and for anything else only after every
    // child has been shown.
    let mut dates: HashMap<ObjectId, i64> = HashMap::new();
    let mut waiting: HashMap<ObjectId, u32> = HashMap::new();

    // The count pass: every commit reachable from the tips, headers only. The parents to visit
    // are collected rather than recursed, so a million-commit history costs heap, not stack.
    let mut reachable = 0usize;
    let mut stack: Vec<ObjectId> = Vec::new();
    for tip in tips {
        let commit = git
            .find_commit(*tip)
            .git_ctx("Could not walk the commit graph")?;
        dates.insert(*tip, committer_date(&commit));
        for parent in shallow_parents(&commit, &shallow, first_parent_only) {
            *waiting.entry(parent).or_insert(0) += 1;
            stack.push(parent);
        }
        reachable += 1;
    }
    while let Some(id) = stack.pop() {
        if dates.contains_key(&id) {
            continue;
        }
        // A commit that cannot be read — a corrupt pack — ends its line, the way the filtered
        // walk's truncation does; there is nothing to count past it.
        let Some(commit) = git.find_commit(id).ok() else {
            continue;
        };
        reachable += 1;
        // The cancellation checkpoint: a relaxed flag read every CHECK_INTERVAL-th
        // commit, so a cancelled traversal unwinds promptly without costing the walk measurably.
        cancel.check(reachable)?;
        dates.insert(id, committer_date(&commit));
        for parent in shallow_parents(&commit, &shallow, first_parent_only) {
            *waiting.entry(parent).or_insert(0) += 1;
            stack.push(parent);
        }
    }

    // The ready set: counted, nothing left to wait for, not yet shown. Ranked by committer date,
    // ties toward the commit readied first — the same tie order_records applies.
    let mut ready: BinaryHeap<(i64, Reverse<usize>, ObjectId)> = BinaryHeap::new();
    let mut sequence = 0usize;
    for tip in tips {
        if waiting.get(tip).copied().unwrap_or(0) == 0 {
            ready.push((
                dates.get(tip).copied().unwrap_or(0),
                Reverse(sequence),
                *tip,
            ));
            sequence += 1;
        }
    }

    let shallow_ref = &shallow;
    let mut records: Vec<CommitRecord> = Vec::new();
    let mut shown: HashSet<ObjectId> = HashSet::new();
    while records.len() < window {
        let Some((_, _, id)) = ready.pop() else {
            break;
        };
        if shown.contains(&id) || !dates.contains_key(&id) {
            continue;
        }
        dates.remove(&id);
        shown.insert(id);
        // The full object is read only now, for the record — the count pass read headers only.
        let commit = match git.find_commit(id) {
            Ok(commit) => commit,
            // A missing object (a shallow clone's boundary, or a corrupt pack) truncates the walk
            // rather than failing the whole view.
            Err(_) => continue,
        };
        records.push(read_commit(&commit, shallow_ref)?);
        // The cancellation checkpoint: a relaxed flag read every CHECK_INTERVAL-th
        // commit, so a cancelled traversal unwinds promptly without costing the walk measurably.
        cancel.check(records.len())?;

        // The commit's children may now have been shown; each parent loses one waiting child and
        // becomes ready when the last of them is gone.
        for parent in shallow_parents(&commit, shallow_ref, first_parent_only) {
            let entry = waiting.entry(parent).or_insert(0);
            *entry = entry.saturating_sub(1);
            if *entry == 0 && dates.contains_key(&parent) {
                ready.push((dates[&parent], Reverse(sequence), parent));
                sequence += 1;
            }
        }
    }

    Ok(records)
}

/// The committer date a commit is ranked and displayed by (zero when the header will not decode,
/// matching what `read_commit` records).
fn committer_date(commit: &gix::Commit<'_>) -> i64 {
    commit
        .committer()
        .ok()
        .and_then(|committer| committer.time().ok().map(|time| time.seconds))
        .unwrap_or(0)
}

/// The parents a count-pass or ready-set step descends to: the shallow boundary ends a line the
/// way git reports it, and the first-parent mode takes only the first parent.
fn shallow_parents(
    commit: &gix::Commit<'_>,
    shallow: &Shallow,
    first_parent_only: bool,
) -> Vec<ObjectId> {
    let parents = shallow.parents(commit);
    if first_parent_only {
        parents.into_iter().take(1).collect()
    } else {
        parents
    }
}

/// Read the fields the graph renders out of a commit object.
///
/// `shallow` is the repository's shallow boundary: a boundary commit is reported without parents,
/// as git reports it, rather than with parents that were never fetched.
pub fn read_commit(commit: &gix::Commit<'_>, shallow: &Shallow) -> Result<CommitRecord> {
    let author = commit
        .author()
        .git_ctx("Could not decode the commit author")?;
    let committer = commit
        .committer()
        .git_ctx("Could not decode the commit committer")?;
    let encoding = CommitEncoding::of(commit);

    Ok(CommitRecord {
        hash: commit.id().detach().to_string(),
        parents: shallow
            .parents(commit)
            .iter()
            .map(ToString::to_string)
            .collect(),
        author: encoding.decode(author.name),
        email: encoding.decode(author.email),
        // The graph's date column follows git's default and shows the *committer* date.
        date: committer.time().map(|time| time.seconds).unwrap_or(0),
        author_date: author.time().map(|time| time.seconds).unwrap_or(0),
        message: text::commit_subject(commit, &encoding),
    })
}
