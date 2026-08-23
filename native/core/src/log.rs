//! Walking the commit graph.
//!
//! ## Ordering
//!
//! All three orderings git offers are *topologically constrained*: a commit is never shown before
//! one of its children, and within that constraint the ready commits are ranked by commit date,
//! author date, or by staying on the current line of history.
//!
//! gix's traversal offers a commit-time priority queue but no topological guarantee, so the
//! ordering is done here instead: the traversal collects a **window** of commits, and the window is
//! then re-ordered by a Kahn-style topological sort whose ready set is ranked according to the
//! requested ordering. The window is a multiple of the requested page rather than the whole
//! history, which is what makes the first screen of a million-commit repository affordable —
//! ordering is exact within the window, and commits beyond it are not considered.

use std::collections::{BinaryHeap, HashMap, HashSet};

use gix::ObjectId;

use crate::error::{Error, Result, ResultExt};
use crate::repository::Repo;
use crate::types::{CommitOrdering, CommitRecord, GitAuthor, GitHistoryMatch};

/// How many commits are read for every commit displayed, so that the topological re-ordering has
/// enough of the graph to be exact over the page it returns.
const WINDOW_FACTOR: usize = 2;

/// A floor on the window, so that small pages still see enough of a branchy history.
const WINDOW_MINIMUM: usize = 256;

/// A ceiling on how far a path-filtered walk searches before giving up on filling the page.
/// Without it, filtering by a path that only a very old commit touched would walk all of history.
const FILTERED_WALK_LIMIT: usize = 250_000;

#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    /// The maximum number of commits to return.
    pub limit: usize,
    pub ordering: CommitOrdering,
    /// Follow only the first parent of each merge.
    pub first_parent_only: bool,
    /// Keep only commits whose author name matches one of these (case-insensitive substring, as
    /// `git log --author` matches).
    pub authors: Option<Vec<String>>,
    /// Keep only commits that changed one of these repository-relative paths.
    pub filter_paths: Vec<String>,
}

/// Walk from `tips` and return the page of commits the view should render.
pub fn walk(repo: &Repo, tips: &[ObjectId], options: &WalkOptions) -> Result<Vec<CommitRecord>> {
    if options.limit == 0 || tips.is_empty() {
        return Ok(Vec::new());
    }
    let git = repo.borrow();
    let filtering = !options.filter_paths.is_empty();

    // A filtered walk cannot know in advance how deep it must go to fill a page, so it walks until
    // the page is full (or the safety limit is hit) instead of taking a fixed window.
    let window = if filtering {
        FILTERED_WALK_LIMIT
    } else {
        (options.limit * WINDOW_FACTOR).max(WINDOW_MINIMUM)
    };

    let mut platform =
        git.rev_walk(tips.iter().copied())
            .sorting(gix::revision::walk::Sorting::ByCommitTime(
                gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
            ));
    if options.first_parent_only {
        platform = platform.first_parent_only();
    }
    let walk = platform.all().git_ctx("Could not walk the commit graph")?;

    let mut records: Vec<CommitRecord> = Vec::new();
    // While filtering, the parents of every commit the walk *reads* are kept, not just of the
    // ones it keeps: re-parenting a shown commit means tracing through the hidden commits
    // between it and its nearest shown ancestor, which requires their parents too.
    let mut visited_parents: Vec<(String, Vec<String>)> = Vec::new();
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

        let commit = match git.find_commit(info.id) {
            Ok(commit) => commit,
            Err(_) => continue,
        };
        let record = read_commit(&commit)?;
        if filtering {
            visited_parents.push((record.hash.clone(), record.parents.clone()));
        }

        if let Some(authors) = &options.authors {
            if !matches_author(&record, authors) {
                continue;
            }
        }
        if filtering && !touches_paths(&git, &commit, &options.filter_paths)? {
            continue;
        }

        records.push(record);
        if filtering && records.len() >= options.limit {
            break;
        }
    }

    if filtering {
        // History simplification: a commit whose parent was filtered out is re-parented onto its
        // nearest shown ancestor, so the graph stays connected instead of breaking into fragments.
        rewrite_parents(&mut records, &visited_parents);
        return Ok(records);
    }

    Ok(order(records, options.ordering, options.limit))
}

/// Read the fields the graph renders out of a commit object.
pub fn read_commit(commit: &gix::Commit<'_>) -> Result<CommitRecord> {
    let author = commit
        .author()
        .git_ctx("Could not decode the commit author")?;
    let committer = commit
        .committer()
        .git_ctx("Could not decode the commit committer")?;
    let message = commit
        .message()
        .git_ctx("Could not decode the commit message")?;

    Ok(CommitRecord {
        hash: commit.id().detach().to_string(),
        parents: commit
            .parent_ids()
            .map(|id| id.detach().to_string())
            .collect(),
        author: author.name.to_string(),
        email: author.email.to_string(),
        // The graph's date column follows git's default and shows the *committer* date.
        date: committer.time().map(|time| time.seconds).unwrap_or(0),
        author_date: author.time().map(|time| time.seconds).unwrap_or(0),
        message: message.summary().to_string(),
    })
}

/// `git log --author=<name>` matches a case-insensitive substring of "Name <email>".
fn matches_author(record: &CommitRecord, authors: &[String]) -> bool {
    let haystack = format!("{} <{}>", record.author, record.email).to_lowercase();
    authors
        .iter()
        .any(|author| haystack.contains(&author.to_lowercase()))
}

/// Did this commit change anything below one of `paths`?
///
/// `git log -- <paths>` default history simplification judges a commit by the *filtered* tree: it
/// is shown only when it is not treesame to **any** parent. A merge that merely carries a branch's
/// changes in is treesame against that branch's side and stays out of the log, which is why the
/// comparison here runs against every parent rather than just the first.
///
/// A root commit is compared against the empty tree, which is what makes the commit that first
/// added a file show up in its filtered history.
fn touches_paths(
    git: &gix::Repository,
    commit: &gix::Commit<'_>,
    paths: &[String],
) -> Result<bool> {
    let tree = commit.tree().git_ctx("Could not read the commit tree")?;
    let parents: Vec<_> = commit.parent_ids().map(|id| id.detach()).collect();
    if parents.is_empty() {
        return changes_paths(git, None, &tree, paths);
    }
    for parent in parents {
        let parent_tree = git.find_commit(parent).ok().and_then(|c| c.tree().ok());
        if !changes_paths(git, parent_tree, &tree, paths)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Does `tree` differ from `parent_tree` (the empty tree when `None`) below any of `paths`?
fn changes_paths(
    git: &gix::Repository,
    parent_tree: Option<gix::Tree<'_>>,
    tree: &gix::Tree<'_>,
    paths: &[String],
) -> Result<bool> {
    let parent_tree = parent_tree.unwrap_or_else(|| git.empty_tree());

    let mut touched = false;
    let mut changes = parent_tree.changes().git_ctx("Could not diff the commit")?;
    // Rename detection is off here: this only answers "did anything under these paths change",
    // and rename detection is a similarity search that would cost far more than the answer.
    changes.options(|options| {
        options.track_rewrites(None);
    });
    let outcome = changes.for_each_to_obtain_tree(tree, |change| {
        let location = change.location().to_string();
        if paths.iter().any(|path| path_matches(&location, path)) {
            touched = true;
            // Stop at the first hit: the question is only whether the commit is in scope, and a
            // commit that rewrites a whole tree should not cost more to answer than one that
            // touches a single file.
            Ok::<_, std::convert::Infallible>(std::ops::ControlFlow::Break(()))
        } else {
            Ok(std::ops::ControlFlow::Continue(()))
        }
    });
    // Stopping early is reported as a cancellation. It is the success case here, so only a
    // failure that happened *before* a hit is a real error.
    match outcome {
        Ok(_) => Ok(touched),
        Err(_) if touched => Ok(true),
        Err(e) => Err(Error::git(format!("Could not diff the commit: {e}"))),
    }
}

/// A pathspec matches a file exactly, or any file below it when it names a directory.
fn path_matches(location: &str, path: &str) -> bool {
    let path = path.trim_end_matches('/');
    path.is_empty() || location == path || location.starts_with(&format!("{path}/"))
}

/// Re-parent each commit onto its nearest ancestor that survived filtering.
///
/// This is what `git log --simplify-merges` does: without it, git prints the *original* parent
/// hashes of every shown commit, which point at commits that are themselves hidden, and the graph
/// renders as disconnected fragments.
///
/// `visited` holds the parents of every commit the walk read, in walk order, so that a chain of
/// several hidden commits can be traced through rather than just a single one.
fn rewrite_parents(records: &mut [CommitRecord], visited: &[(String, Vec<String>)]) {
    let shown: HashSet<&str> = records.iter().map(|record| record.hash.as_str()).collect();

    // The walk is newest-first, so a commit's ancestors are always read after it. Resolving from
    // the oldest backwards means every lookup a commit needs is already resolved.
    let mut nearest: HashMap<&str, Vec<String>> = HashMap::new();
    for (hash, parents) in visited.iter().rev() {
        let mut resolved: Vec<String> = Vec::new();
        for parent in parents {
            if shown.contains(parent.as_str()) {
                if !resolved.contains(parent) {
                    resolved.push(parent.clone());
                }
            } else if let Some(ancestors) = nearest.get(parent.as_str()) {
                // The hidden parent's own nearest shown ancestors take its place.
                for ancestor in ancestors {
                    if !resolved.contains(ancestor) {
                        resolved.push(ancestor.clone());
                    }
                }
            }
        }
        nearest.insert(hash.as_str(), resolved);
    }

    for record in records.iter_mut() {
        if let Some(parents) = nearest.get(record.hash.as_str()) {
            record.parents = parents.clone();
        }
    }
}

/// Ranking key for the ready set, matching what each of git's orderings prioritises.
#[derive(PartialEq, Eq)]
struct Ready {
    /// The date the ordering ranks by; unused (and zero) for topological order.
    date: i64,
    /// Position in the traversal, used to break ties and to drive topological order.
    sequence: usize,
    index: usize,
    ordering: CommitOrdering,
}

impl Ord for Ready {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match self.ordering {
            // Newest first, ties broken by the order the traversal found them.
            CommitOrdering::Date | CommitOrdering::AuthorDate => self
                .date
                .cmp(&other.date)
                .then_with(|| other.sequence.cmp(&self.sequence)),
            // Topological order keeps walking down the line of history it is already on, rather
            // than intermixing branches: the most recently readied commit wins.
            CommitOrdering::Topo => self.sequence.cmp(&other.sequence),
        }
    }
}

impl PartialOrd for Ready {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Topologically sort `records`, ranking the commits that are ready to be shown by `ordering`.
fn order(records: Vec<CommitRecord>, ordering: CommitOrdering, limit: usize) -> Vec<CommitRecord> {
    let index_of: HashMap<&str, usize> = records
        .iter()
        .enumerate()
        .map(|(index, record)| (record.hash.as_str(), index))
        .collect();

    // How many children inside the window each commit is still waiting for.
    let mut pending = vec![0usize; records.len()];
    for record in &records {
        for parent in &record.parents {
            if let Some(&parent_index) = index_of.get(parent.as_str()) {
                pending[parent_index] += 1;
            }
        }
    }

    let key = |record: &CommitRecord| match ordering {
        CommitOrdering::Date => record.date,
        CommitOrdering::AuthorDate => record.author_date,
        CommitOrdering::Topo => 0,
    };

    let mut sequence = 0usize;
    let mut ready: BinaryHeap<Ready> = BinaryHeap::new();
    for (index, record) in records.iter().enumerate() {
        if pending[index] == 0 {
            ready.push(Ready {
                date: key(record),
                sequence,
                index,
                ordering,
            });
            sequence += 1;
        }
    }

    let mut ordered: Vec<CommitRecord> = Vec::with_capacity(limit.min(records.len()));
    let mut taken = vec![false; records.len()];
    while let Some(next) = ready.pop() {
        if ordered.len() == limit {
            break;
        }
        taken[next.index] = true;
        for parent in &records[next.index].parents {
            let Some(&parent_index) = index_of.get(parent.as_str()) else {
                continue;
            };
            pending[parent_index] -= 1;
            if pending[parent_index] == 0 {
                ready.push(Ready {
                    date: key(&records[parent_index]),
                    sequence,
                    index: parent_index,
                    ordering,
                });
                sequence += 1;
            }
        }
        ordered.push(records[next.index].clone());
    }

    ordered
}

/// Resolve the revisions a view load starts its walk from.
///
/// Anything that does not resolve is skipped rather than failing the load: a stale branch name in
/// the view's saved state should not stop the graph from rendering.
pub fn resolve_tips(repo: &Repo, revisions: &[String]) -> Result<Vec<ObjectId>> {
    // Borrowed once for the whole list: a repository with a few hundred tags resolves a few
    // hundred revisions per view load, and each borrow would rebuild the object cache.
    let git = repo.borrow();
    let mut tips = Vec::new();
    let mut seen = HashSet::new();
    // An annotated tag contributes two revisions (the tag object and the commit it peels to), and
    // a branch and its remote-tracking counterpart usually contribute the same hash twice, so the
    // list is deduplicated before anything is resolved rather than after.
    let mut requested = HashSet::new();
    for revision in revisions {
        if !requested.insert(revision.as_str()) {
            continue;
        }
        if let Ok(id) = crate::repository::resolve_commit_in(&git, revision) {
            if seen.insert(id) {
                tips.push(id);
            }
        }
    }
    Ok(tips)
}

/// Every ref the graph walks from when the view is showing all branches.
pub fn all_tips(repo: &Repo, include_tags: bool, include_remotes: bool) -> Result<Vec<ObjectId>> {
    let git = repo.borrow();
    let mut tips = Vec::new();
    let mut seen = HashSet::new();

    let add = |id: ObjectId, tips: &mut Vec<ObjectId>, seen: &mut HashSet<ObjectId>| {
        if seen.insert(id) {
            tips.push(id);
        }
    };

    if let Ok(head) = git.head_id() {
        add(head.detach(), &mut tips, &mut seen);
    }

    let prefixes: &[&str] = match (include_tags, include_remotes) {
        (true, true) => &["refs/heads/", "refs/tags/", "refs/remotes/"],
        (true, false) => &["refs/heads/", "refs/tags/"],
        (false, true) => &["refs/heads/", "refs/remotes/"],
        (false, false) => &["refs/heads/"],
    };

    for prefix in prefixes {
        let platform = git.references().git_ctx("Could not read references")?;
        for mut reference in platform
            .prefixed(*prefix)
            .git_ctx("Could not read references")?
            .filter_map(std::result::Result::ok)
        {
            // Tags are peeled because a tag object is not a commit and cannot be walked from.
            if let Ok(id) = reference.peel_to_id() {
                add(id.detach(), &mut tips, &mut seen);
            }
        }
    }

    if tips.is_empty() {
        return Err(Error::not_found("The repository has no commits"));
    }
    Ok(tips)
}

/* ---------- History search ---------- */

/// How many hits the Find dialogue shows, matching the original's `--max-count=100`.
const SEARCH_LIMIT: usize = 100;

/// Search every commit message for a pattern, newest first, as `git log --all -E -i --grep`.
///
/// The tips are everything `git log --all` walks from — local branches, tags, remote-tracking
/// branches, HEAD, and the stash, whose ref lives in `refs/` even though the graph never shows it.
/// The walk is commit-date ordered (git's default for `--grep`), not topologically constrained, so
/// it needs none of the windowed re-ordering the graph does.
pub fn search_history(repo: &Repo, query: &str) -> Result<Vec<GitHistoryMatch>> {
    let matcher = regex::RegexBuilder::new(query)
        .case_insensitive(true)
        .build()
        .map_err(|e| Error::invalid_argument(format!("Invalid search query: {e}")))?;

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
    for info in walk {
        let info = match info {
            Ok(info) => info,
            // A missing object truncates the search rather than failing it, as it truncates the
            // graph walk.
            Err(_) => break,
        };
        let commit = match git.find_commit(info.id) {
            Ok(commit) => commit,
            Err(_) => continue,
        };
        let raw = commit
            .message_raw()
            .git_ctx("Could not decode the commit message")?
            .to_string();
        if !matcher.is_match(&raw) {
            continue;
        }
        let author = commit
            .author()
            .git_ctx("Could not decode the commit author")?;
        matches.push(GitHistoryMatch {
            hash: commit.id().detach().to_string(),
            author: author.name.to_string(),
            date: author.time().map(|time| time.seconds).unwrap_or(0),
            message: commit
                .message()
                .git_ctx("Could not decode the commit message")?
                .summary()
                .to_string(),
        });
        if matches.len() >= SEARCH_LIMIT {
            break;
        }
    }
    Ok(matches)
}

/// The commit `refs/stash` points at, if a stash exists.
fn stash_tip(repo: &Repo) -> Option<ObjectId> {
    let git = repo.borrow();
    git.try_find_reference("refs/stash")
        .ok()
        .flatten()
        .and_then(|mut reference| reference.peel_to_id().ok())
        .map(|id| id.detach())
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
pub fn count_commits_before(
    repo: &Repo,
    branches: Option<&[String]>,
    hash: &str,
    show_remote_branches: bool,
    include_reflogs: bool,
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
    }

    let mut count = 0u64;
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
    }
    Ok(count)
}

/* ---------- Authors ---------- */

/// The distinct commit authors of the current branch's history — what `git shortlog -s -n -e`
/// is parsed into: aggregated per (name, email), ordered by commit count (most first), then
/// de-duplicated by name (the first, most-prolific spelling wins) and sorted by name.
pub fn authors(repo: &Repo) -> Result<Vec<GitAuthor>> {
    let git = repo.borrow();
    let head = git
        .head_id()
        .map_err(|_| Error::not_found("The repository has no commits"))?;

    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    for info in git
        .rev_walk(std::iter::once(head))
        .all()
        .git_ctx("Could not walk the commit graph")?
    {
        let info = match info {
            Ok(info) => info,
            Err(_) => break,
        };
        let Ok(commit) = git.find_commit(info.id) else {
            continue;
        };
        let Ok(author) = commit.author() else {
            continue;
        };
        *counts
            .entry((author.name.to_string(), author.email.to_string()))
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
