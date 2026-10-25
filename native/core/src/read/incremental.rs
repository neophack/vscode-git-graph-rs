//! The incremental traversal cache (refactor plan, task 2.10, §3.8.3).
//!
//! A view refresh after a commit, a fetch or a branch change re-walks the same repository from
//! tips that moved only slightly. The engine therefore keeps the previous traversal — per
//! *repository + walk-affecting options* — and answers the next one out of it when it can:
//!
//! 1. **The new part is walked for real**, from the new tips down to the cached commits, and
//!    nothing below that boundary is read: the cached walk already visited it.
//! 2. **The pages are then identical to a full traversal**, because the merged record list is
//!    exactly the list a full walk would have collected. Two guards make that provable:
//!     - *tip coverage* — every tip of the cached walk must still be reachable from the new
//!       tips. A rebase, an amend, a reset or a deleted branch strands old commits; those cases
//!       fail this guard and fall back to a full traversal, which is how history rewrites stay
//!       correct without anyone detecting them explicitly.
//!     - *date dominance* — every new commit must carry a strictly newer committer date than
//!       every cached commit. This places all new commits before all cached ones in the
//!       commit-time walk order, so `[new records in walk order] ++ [cached window in walk
//!       order]` — the list the merge re-orders — is byte-identical to the full walk's input.
//!       A fetched branch with old dates fails this guard; such a refresh re-walks in full.
//!
//! The equivalence is enforced by property tests (`tests/incremental.rs`): random operation
//! sequences where every step's incremental answer must equal the full traversal's, under both
//! date and topo ordering.
//!
//! ## When the cache is not consulted
//!
//! Filtered walks (`--author`, path filters) re-parent their records through the hidden commits
//! between matches; Gerrit pinning pulls extra commits onto the page; a first-parent-only walk
//! in gix is queue-ordered rather than commit-time-ordered. None of those keep the invariant
//! above, so they always traverse in full (and are not cached at all).
//!
//! ## Commit-graph files
//!
//! Nothing here needs doing about them: gix's `rev_walk` already reads a commit-graph file when
//! one exists and `core.commitGraph` allows it (the default), which accelerates exactly the full
//! traversals this module tries to avoid. The boundary walk reads only the handful of new
//! commits, where a graph would not pay for its own lookup.
//!
//! ## Known caveat
//!
//! Commits that share a committer date are ordered by heap internals; if such a tie straddles
//! the new/cached boundary in a way the strict-dominance guard does not catch (a tie *within*
//! the new part or *within* the cached window), the incremental page can order the tied commits
//! differently than a fresh full walk would. `git log` itself does not promise an order between
//! equal-date commits; the fixtures of the property tests use distinct dates throughout.

use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use gix::ObjectId;

use crate::error::Result;
use crate::model::{CommitOrdering, CommitRecord, LogOptions};
use crate::read::log::{self, WalkOptions};
use crate::repository::{Repo, Shallow};

/// How many traversals are kept, process-wide. A session opens a handful of repositories with a
/// handful of option sets each; the cap only stops unbounded growth (each entry is at most one
/// window of records), and exceeding it simply drops the cache rather than evicting cleverly.
const MAX_ENTRIES: usize = 64;

/// The walk-affecting fields of a load request: two loads share a cache entry only when a full
/// traversal from the same options would visit the same commits. Fields that only shape the
/// ref scan still matter — the scan decides the tips. The fields that only shape the answer
/// *around* the walk (annotations, the uncommitted row, deferred remote refs' follow-up) are
/// deliberately absent: they are recomputed fresh on every load.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    /// The branch names to walk from, or `None` for all refs.
    pub branches: Option<Vec<String>>,
    pub max_commits: u32,
    pub show_tags: bool,
    pub show_remote_branches: bool,
    pub show_remote_heads: bool,
    pub hide_remotes: Vec<String>,
    pub gerrit_show_change_refs: bool,
    pub show_commits_only_referenced_by_tags: bool,
    pub commit_ordering: CommitOrdering,
}

impl CacheKey {
    pub fn of(options: &LogOptions) -> CacheKey {
        CacheKey {
            branches: options.branches.clone(),
            max_commits: options.max_commits,
            show_tags: options.show_tags,
            show_remote_branches: options.show_remote_branches,
            show_remote_heads: options.show_remote_heads,
            hide_remotes: options.hide_remotes.clone(),
            gerrit_show_change_refs: options.gerrit_show_change_refs,
            show_commits_only_referenced_by_tags: options.show_commits_only_referenced_by_tags,
            commit_ordering: options.commit_ordering,
        }
    }
}

/// Can a load with these options be served incrementally at all? See the module docs for why
/// filtered, Gerrit-pinned, reflog and first-parent walks cannot.
pub fn eligible(options: &LogOptions) -> bool {
    options.authors.as_deref().unwrap_or_default().is_empty()
        && options.filter_paths.iter().all(|path| path.is_empty())
        && options.gerrit_refs.is_none()
        && !options.only_follow_first_parent
        && !options.include_commits_mentioned_by_reflogs
}

/// One cached traversal: what the next load needs to answer without re-walking history.
#[derive(Debug, Clone)]
pub(crate) struct CachedWalk {
    /// The tips the cached walk started from, hex. The next load must still reach every one of
    /// them — that is the rewrite detector.
    tips: HashSet<String>,
    /// Every commit of the cached window, hex — the boundary the next walk stops at.
    visited: HashSet<String>,
    /// The window's records in walk (commit-time) order: the exact list a full traversal of the
    /// same repository state would feed the page ordering.
    window: Vec<CommitRecord>,
    /// The newest committer date in the window — the bar the new commits must clear strictly.
    newest_date: i64,
}

impl CachedWalk {
    fn new(tips: &[ObjectId], window: Vec<CommitRecord>) -> CachedWalk {
        CachedWalk {
            tips: tips.iter().map(|id| id.to_string()).collect(),
            visited: window.iter().map(|record| record.hash.clone()).collect(),
            newest_date: window.iter().map(|record| record.date).max().unwrap_or(0),
            window,
        }
    }
}

/// The traversals of every open repository, process-wide — the same shape as
/// [`crate::repository::RepoManager`]: a cache keyed by repository, guarded (not invalidated) by the walks
/// themselves, bounded by [`MAX_ENTRIES`].
#[derive(Default)]
pub struct Store {
    entries: Mutex<HashMap<(PathBuf, CacheKey), Arc<CachedWalk>>>,
    /// How many traversals the cache answered (`try_walk` returned a window) and how many fell
    /// back to a full walk — telemetry for hosts, tests and benchmarks to see that refreshing
    /// actually went the incremental way.
    hits: AtomicUsize,
    fallbacks: AtomicUsize,
}

impl Store {
    /// The process-wide store.
    pub fn global() -> &'static Store {
        static GLOBAL: OnceLock<Store> = OnceLock::new();
        GLOBAL.get_or_init(Store::default)
    }

    /// The cached traversal for (`root`, `key`), if one exists.
    fn get(&self, root: &Path, key: &CacheKey) -> Option<Arc<CachedWalk>> {
        self.lock().get(&(root.to_path_buf(), key.clone())).cloned()
    }

    /// `(incremental answers, full traversals)` so far, process-wide — how often the cache
    /// answered a refresh, and how often a guard sent it back to a full walk.
    pub fn stats(&self) -> (usize, usize) {
        (
            self.hits.load(Ordering::Relaxed),
            self.fallbacks.load(Ordering::Relaxed),
        )
    }

    /// Keep the traversal of (`root`, `key`) as the one the next load continues from.
    pub(crate) fn put(&self, root: &Path, key: &CacheKey, walk: CachedWalk) {
        let mut entries = self.lock();
        if entries.len() >= MAX_ENTRIES {
            entries.clear();
        }
        entries.insert((root.to_path_buf(), key.clone()), Arc::new(walk));
    }

    /// Drop every cached traversal of one repository — when a host knows the repository changed
    /// underneath it, or between comparisons in tests.
    pub fn invalidate(&self, root: &Path) {
        self.lock().retain(|(entry_root, _), _| entry_root != root);
    }

    /// Drop every cached traversal of every repository.
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(PathBuf, CacheKey), Arc<CachedWalk>>> {
        // A poisoned lock means a panic while inserting a cache entry; the cache is an
        // optimisation whose every entry re-validates itself, so recovering beats failing every
        // later load.
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Try to answer a traversal of `tips` out of the cache of (`repo`'s root, `key`).
///
/// `Ok(None)` — no cache entry, or one of the guards failed: the caller walks in full, which is
/// always correct and re-populates the cache. `Err` — the request was cancelled mid-walk: the
/// caller propagates it rather than retrying the work it was just told to stop.
pub(crate) fn try_walk(
    repo: &Repo,
    key: &CacheKey,
    tips: &[ObjectId],
    options: &WalkOptions,
) -> Result<Option<Vec<CommitRecord>>> {
    let outcome = boundary_walk(repo, key, tips, options)?;
    let store = Store::global();
    match outcome {
        Some(window) => {
            store.hits.fetch_add(1, Ordering::Relaxed);
            Ok(Some(window))
        }
        None => {
            store.fallbacks.fetch_add(1, Ordering::Relaxed);
            Ok(None)
        }
    }
}

/// The boundary walk itself, without the telemetry of [`try_walk`].
fn boundary_walk(
    repo: &Repo,
    key: &CacheKey,
    tips: &[ObjectId],
    options: &WalkOptions,
) -> Result<Option<Vec<CommitRecord>>> {
    let Some(cached) = Store::global().get(repo.root(), key) else {
        return Ok(None);
    };
    if tips.is_empty() || cached.window.is_empty() {
        return Ok(None);
    }
    let window_cap = log::window_size(options.limit);
    let git = repo.borrow();
    let shallow = Shallow::of(&git);

    /* The boundary walk: newest-first over the new commits, stopping at the cached ones.
     *
     * This is the gix walk's own discipline (a commit-time priority queue, parents enqueued on
     * pop) with one difference: a commit of the cached window is popped but never expanded —
     * everything below it was visited last time. The queue therefore empties at exactly the
     * boundary, having read only the new part plus the boundary commits' headers. */
    let mut queue: BinaryHeap<(i64, ObjectId)> = BinaryHeap::new();
    let mut seen: HashSet<ObjectId> = HashSet::new();
    for tip in tips {
        if seen.insert(*tip) {
            let Some(commit) = git.find_commit(*tip).ok() else {
                return Ok(None);
            };
            queue.push((commit_time(&commit), *tip));
        }
    }

    let mut new_records: Vec<CommitRecord> = Vec::new();
    let mut covered: HashSet<String> = HashSet::new();
    let mut iterated = 0usize;
    while let Some((_, id)) = queue.pop() {
        iterated += 1;
        // The same cap a full walk applies to its reads, so the merged window below is never
        // longer than what a full traversal would have collected.
        if iterated > window_cap {
            break;
        }
        // The cancellation checkpoint, at the same cadence the full walk's loop checks.
        options.cancel.check(iterated)?;

        let hex = id.to_string();
        if cached.visited.contains(&hex) {
            // The boundary: mark coverage and read nothing further below this commit.
            if cached.tips.contains(&hex) {
                covered.insert(hex);
            }
            continue;
        }
        let commit = match git.find_commit(id) {
            Ok(commit) => commit,
            // A missing object makes the boundary unknowable here; the full walk's own error
            // handling (it truncates) takes over.
            Err(_) => return Ok(None),
        };
        let record = log::read_commit(&commit, &shallow)?;
        // Date dominance, as an early abort: the first new commit that is not strictly newer
        // than everything cached means the new commits do not sit on top of the cached window,
        // and the merged list below could not equal a full walk's.
        if record.date <= cached.newest_date {
            return Ok(None);
        }
        new_records.push(record);
        for parent in shallow.parents(&commit) {
            if seen.insert(parent) {
                // A parent below the boundary still needs its committer date for the queue; one
                // header read per boundary edge, which is the whole cost of stopping there.
                let time = git
                    .find_commit(parent)
                    .ok()
                    .map(|parent| commit_time(&parent))
                    .unwrap_or_default();
                queue.push((time, parent));
            }
        }
    }

    // Every cached tip must have been reached from the new tips. One that was not is either
    // unreachable (history was rewritten or a branch was deleted — the cached window may hold
    // commits the new page must not show) or sits behind a boundary this walk never crossed;
    // both cases take the full traversal.
    if !cached.tips.iter().all(|tip| covered.contains(tip)) {
        return Ok(None);
    }

    // The merged window: new records in walk order, then the cached window's records — the
    // cached part truncated so the whole never exceeds the window a full walk would read. Under
    // date dominance this is the full walk's record list, so ordering it produces the full
    // walk's page.
    let keep = window_cap.saturating_sub(new_records.len());
    if new_records.len() > window_cap {
        new_records.truncate(window_cap);
    }
    let mut window = new_records;
    window.extend(cached.window.iter().take(keep).cloned());
    Store::global().hits.fetch_add(1, Ordering::Relaxed);
    Ok(Some(window))
}

/// The committer date of a commit, as the walk's queue ranks by (`0` where the header is absent,
/// matching what [`crate::model::CommitRecord::date`] records).
fn commit_time(commit: &gix::Commit<'_>) -> i64 {
    commit
        .committer()
        .ok()
        .and_then(|committer| committer.time().ok().map(|time| time.seconds))
        .unwrap_or(0)
}

/// Keep `window` (in walk order, from either a full or an incremental traversal) as the
/// traversal the next load of (`root`, `key`) continues from.
pub(crate) fn remember(root: &Path, key: &CacheKey, tips: &[ObjectId], window: Vec<CommitRecord>) {
    Store::global().put(root, key, CachedWalk::new(tips, window));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_options(ordering: CommitOrdering) -> LogOptions {
        LogOptions {
            max_commits: 50,
            show_tags: true,
            show_remote_branches: true,
            commit_ordering: ordering,
            ..Default::default()
        }
    }

    #[test]
    fn the_key_covers_every_walk_affecting_option() {
        let base = log_options(CommitOrdering::Date);
        let key = CacheKey::of(&base);
        assert_eq!(key, CacheKey::of(&log_options(CommitOrdering::Date)));
        assert_ne!(key, CacheKey::of(&log_options(CommitOrdering::Topo)));

        let mut other = base.clone();
        other.max_commits += 1;
        assert_ne!(key, CacheKey::of(&other));

        // The fields that only shape the answer around the walk do not partake: a load that
        // differs only in them shares the traversal, so it shares the cache.
        let mut annotated = base.clone();
        annotated.remotes.push("origin".into());
        annotated.defer_uncommitted_changes = true;
        annotated.show_untracked_files = false;
        annotated.show_uncommitted_changes = false;
        assert_eq!(key, CacheKey::of(&annotated));

        // The ref-scan fields do partake: they change which commits the walk starts from.
        let mut hidden = base.clone();
        hidden.hide_remotes.push("secret".into());
        assert_ne!(key, CacheKey::of(&hidden));
    }

    #[test]
    fn only_plain_walks_are_eligible() {
        assert!(eligible(&log_options(CommitOrdering::Topo)));

        let mut filtered = log_options(CommitOrdering::Topo);
        filtered.authors = Some(vec!["Test User".into()]);
        assert!(!eligible(&filtered));

        let mut by_path = log_options(CommitOrdering::Topo);
        by_path.filter_paths = vec!["src".into()];
        assert!(!eligible(&by_path));

        let mut pinned = log_options(CommitOrdering::Topo);
        pinned.gerrit_refs = Some(vec!["refs/changes/01/1".into()]);
        assert!(!eligible(&pinned));

        let mut first_parent = log_options(CommitOrdering::Topo);
        first_parent.only_follow_first_parent = true;
        assert!(!eligible(&first_parent));

        let mut reflogs = log_options(CommitOrdering::Topo);
        reflogs.include_commits_mentioned_by_reflogs = true;
        assert!(!eligible(&reflogs));
    }

    #[test]
    fn the_store_keeps_the_latest_traversal_per_key_and_invalidates_by_root() {
        let store = Store::default();
        let root = Path::new("/repo");
        let key = CacheKey::of(&log_options(CommitOrdering::Date));
        let tips = [ObjectId::from_hex(b"0000000000000000000000000000000000000001").unwrap()];
        let record = |date: i64| CommitRecord {
            hash: format!("{date:040}"),
            parents: Vec::new(),
            author: String::new(),
            email: String::new(),
            date,
            author_date: date,
            message: String::new(),
        };
        store.put(root, &key, CachedWalk::new(&tips, vec![record(1)]));
        store.put(
            root,
            &key,
            CachedWalk::new(&tips, vec![record(2), record(1)]),
        );
        assert_eq!(store.get(root, &key).unwrap().window.len(), 2);
        assert!(store
            .get(root, &CacheKey::of(&log_options(CommitOrdering::Topo)))
            .is_none());

        store.invalidate(root);
        assert!(store.get(root, &key).is_none());
    }
}
