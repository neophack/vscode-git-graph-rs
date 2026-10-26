//! The history scans that do not build the graph: message search, commit counting and the
//! author list.

use std::collections::{HashMap, HashSet};

use gix::ObjectId;

use crate::cancel::Cancel;
use crate::error::{Error, Result, ResultExt};
use crate::model::{GitAuthor, GitHistoryMatch};
use crate::repository::Repo;
use crate::text::{self, CommitEncoding};

use super::tips::{all_tips, stash_tip};

/* ---------- History search ---------- */

/// How many hits the Find dialogue shows, matching the original's `--max-count=100`.
const SEARCH_LIMIT: usize = 100;

/// Search every commit message for a pattern, newest first, as `git log --all -E -i --grep`.
///
/// The tips are everything `git log --all` walks from — local branches, tags, remote-tracking
/// branches, HEAD, and the stash, whose ref lives in `refs/` even though the graph never shows it.
/// The walk is commit-date ordered (git's default for `--grep`), not topologically constrained, so
/// it needs none of the windowed re-ordering the graph does.
// The token stays by value: every engine read entry point takes `cancel: Cancel` the same way
// (see `crate::cancel`), and the call sites pass `Cancel::none()`/`ctx.cancel()` from `engine.rs`
// and `protocol.rs`. Taking `&Cancel` here is only worth it as one engine-wide change that moves
// every entry point at once, not piecemeal per module.
#[allow(clippy::needless_pass_by_value)]
pub fn search_history(repo: &Repo, query: &str, cancel: Cancel) -> Result<Vec<GitHistoryMatch>> {
    let matcher = regex::RegexBuilder::new(query)
        .case_insensitive(true)
        // git's grep matches the pattern line by line, so ^/$ anchor at any line boundary —
        // not at the ends of the whole (multi-line) commit message.
        .multi_line(true)
        .build()
        .map_err(|e| Error::invalid_argument(format!("Invalid search query: {e}")))?;
    // The history git searches runs through the replacement objects the engine cannot apply
    // (see `Repo::uses_replace_refs`).
    if repo.uses_replace_refs() {
        return Err(Error::unsupported(
            "The engine does not apply replacement objects (git replace)",
        ));
    }

    // A repository with no refs at all has nothing to search; git's `--all` simply matches nothing.
    let mut tips = all_tips(repo, true, true).unwrap_or_default();
    if let Some(stash) = stash_tip(repo) {
        if !tips.contains(&stash) {
            tips.push(stash);
        }
    }
    if tips.is_empty() {
        return Ok(Vec::new());
    }

    let git = repo.borrow();
    let walk = git
        .rev_walk(tips.iter().copied())
        .sorting(gix::revision::walk::Sorting::ByCommitTime(
            gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
        ))
        .all()
        .git_ctx("Could not walk the commit graph")?;

    let mut matches: Vec<GitHistoryMatch> = Vec::new();
    let mut visited = 0usize;
    for info in walk {
        let info = match info {
            Ok(info) => info,
            // A missing object truncates the search rather than failing it, as it truncates the
            // graph walk.
            Err(_) => break,
        };
        visited += 1;
        cancel.check(visited)?;
        let commit = match git.find_commit(info.id) {
            Ok(commit) => commit,
            Err(_) => continue,
        };
        // `--grep` matches the message as `git log` re-encodes it for output.
        let encoding = CommitEncoding::of(&commit);
        let raw = encoding.decode(
            commit
                .message_raw()
                .git_ctx("Could not decode the commit message")?,
        );
        if !matcher.is_match(&raw) {
            continue;
        }
        let author = commit
            .author()
            .git_ctx("Could not decode the commit author")?;
        matches.push(GitHistoryMatch {
            hash: commit.id().detach().to_string(),
            author: encoding.decode(author.name),
            date: author.time().map(|time| time.seconds).unwrap_or(0),
            message: text::commit_subject(&commit, &encoding),
        });
        if matches.len() >= SEARCH_LIMIT {
            break;
        }
    }
    Ok(matches)
}

/* ---------- Commit counting ---------- */

/// Count the commits reachable from the given tips but not from `hash` — `git rev-list --count
/// <tips> ^<hash>` — which is how the view jumps straight to a pinned commit without paging.
///
/// A starting point that does not resolve fails the call (as the command line fails), because a
/// silently smaller count would jump the view to the wrong place.
///
/// ### Deviation
///
/// Reflog tips and `--glob=` patterns are not understood; asking for either is reported as
/// unsupported so the call reaches the `git` CLI instead.
// `cancel` by value for the same engine-wide reason as `search_history` above.
#[allow(clippy::needless_pass_by_value)]
pub fn count_commits_before(
    repo: &Repo,
    branches: Option<&[String]>,
    hash: &str,
    show_remote_branches: bool,
    include_reflogs: bool,
    cancel: Cancel,
) -> Result<u64> {
    if include_reflogs {
        return Err(Error::unsupported(
            "Commits mentioned by reflogs are not counted by the engine",
        ));
    }
    if let Some(branches) = branches {
        if branches.iter().any(|branch| branch.starts_with("--glob=")) {
            return Err(Error::unsupported(
                "Custom branch glob patterns are not resolved by the engine",
            ));
        }
        // An empty branch list is what `git rev-list --count ^<hash>` with no refs is: a count
        // from HEAD. Rather than silently reimplement that different default, the call is
        // declined and the fallback runs the command line this replaces.
        if branches.is_empty() {
            return Err(Error::unsupported(
                "An empty branch list counts from HEAD; the engine does not guess that",
            ));
        }
    }

    let excluded_id = repo.resolve_commit(hash)?;
    let tips = match branches {
        Some(branches) => {
            let git = repo.borrow();
            let mut tips = Vec::with_capacity(branches.len());
            for branch in branches {
                // Strict, unlike the view's own tip resolution: the command line this replaces
                // fails on a stale branch name, and the caller treats a failure as "no count".
                tips.push(crate::repository::resolve_commit_in(&git, branch)?);
            }
            tips
        }
        None => all_tips(repo, true, show_remote_branches)?,
    };

    let git = repo.borrow();

    // Everything reachable from the excluded commit is crossed out first, so that the counting
    // walk is a single pass that only tests set membership.
    let mut excluded: HashSet<ObjectId> = HashSet::new();
    let mut visited = 0usize;
    for info in git
        .rev_walk([excluded_id])
        .all()
        .git_ctx("Could not walk the commit graph")?
    {
        match info {
            Ok(info) => {
                excluded.insert(info.id);
            }
            Err(_) => break,
        }
        visited += 1;
        cancel.check(visited)?;
    }

    let mut count = 0u64;
    let mut visited = 0usize;
    for info in git
        .rev_walk(tips.iter().copied())
        .all()
        .git_ctx("Could not walk the commit graph")?
    {
        match info {
            Ok(info) if !excluded.contains(&info.id) => count += 1,
            Ok(_) => {}
            Err(_) => break,
        }
        visited += 1;
        cancel.check(visited)?;
    }
    Ok(count)
}

/* ---------- Authors ---------- */

/// The distinct commit authors of the current branch's history — what `git shortlog -s -n -e`
/// is parsed into: aggregated per (name, email), ordered by commit count (most first), then
/// de-duplicated by name (the first, most-prolific spelling wins) and sorted by name.
// `cancel` by value for the same engine-wide reason as `search_history` above.
#[allow(clippy::needless_pass_by_value)]
pub fn authors(repo: &Repo, cancel: Cancel) -> Result<Vec<GitAuthor>> {
    let git = repo.borrow();
    let head = git
        .head_id()
        .map_err(|_| Error::not_found("The repository has no commits"))?;

    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    let mut visited = 0usize;
    for info in git
        .rev_walk(std::iter::once(head))
        .all()
        .git_ctx("Could not walk the commit graph")?
    {
        let info = match info {
            Ok(info) => info,
            Err(_) => break,
        };
        visited += 1;
        cancel.check(visited)?;
        let Ok(commit) = git.find_commit(info.id) else {
            continue;
        };
        let Ok(author) = commit.author() else {
            continue;
        };
        let encoding = CommitEncoding::of(&commit);
        *counts
            .entry((encoding.decode(author.name), encoding.decode(author.email)))
            .or_insert(0) += 1;
    }

    let mut ordered: Vec<((String, String), usize)> = counts.into_iter().collect();
    ordered.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let mut seen: HashSet<String> = HashSet::new();
    let mut authors: Vec<GitAuthor> = Vec::new();
    for ((name, email), _count) in ordered {
        if seen.insert(name.clone()) {
            authors.push(GitAuthor { name, email });
        }
    }
    authors.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(authors)
}
