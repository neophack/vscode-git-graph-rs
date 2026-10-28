//! The incremental traversal cache.
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
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use gix::ObjectId;

use crate::error::Result;
use crate::model::{CommitOrdering, CommitRecord, LogOptions};
use crate::read::log::{self, committer_date, WalkOptions};
use crate::repository::{Repo, Shallow};

/// The memory budget of the traversal cache, process-wide: entries are evicted
/// least-recently-used until their approximate total fits under it. A host-configurable budget
/// (an `open` parameter) is deliberately deferred; the constant covers the sessions the plan
/// sizes the engine for (a handful of repositories with a handful of option sets each, every
/// entry at most one window of records).
pub const DEFAULT_BUDGET_BYTES: usize = 64 * 1024 * 1024;

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
/// filtered, Gerrit-pinned, reflog and first-parent walks cannot. An author-date-ordered page
/// cannot either: this cache's windows and merge are ranked by COMMITTER date (git's
/// `--date-order`), and feeding the author-date ranking a commit-time-cut window could answer
/// a different page than the full walk of the same repository state would.
pub fn eligible(options: &LogOptions) -> bool {
    options.authors.as_deref().unwrap_or_default().is_empty()
        && options.filter_paths.iter().all(|path| path.is_empty())
        && options.gerrit_refs.is_none()
        && !options.only_follow_first_parent
        && !options.include_commits_mentioned_by_reflogs
        && options.commit_ordering != crate::model::CommitOrdering::AuthorDate
}

/// One cached traversal: what the next load needs to answer without re-walking history.
#[derive(Debug, Clone)]
pub(crate) struct CachedWalk {
    /// The tips the cached walk started from. The next load must still reach every one of them —
    /// that is the rewrite detector.
    tips: HashSet<ObjectId>,
    /// Every commit of the cached window — the boundary the next walk stops at. Ids, not hex
    /// strings: a third of the bytes per entry and no allocation per commit looked up.
    visited: HashSet<ObjectId>,
    /// The window's records in walk (commit-time) order: the exact list a full traversal of the
    /// same repository state would feed the page ordering.
    window: Vec<CommitRecord>,
    /// The newest committer date in the window — the bar the new commits must clear strictly.
    newest_date: i64,
    /// The approximate heap bytes this entry costs — the eviction budget's unit. Computed once
    /// at construction, so a record's memory is charged to the cache exactly once.
    size_bytes: usize,
}

impl CachedWalk {
    fn new(tips: &[ObjectId], window: Vec<CommitRecord>) -> CachedWalk {
        let visited: HashSet<ObjectId> = window
            .iter()
            .filter_map(|record| ObjectId::from_hex(record.hash.as_bytes()).ok())
            .collect();
        let tips: HashSet<ObjectId> = tips.iter().copied().collect();
        let size_bytes = approximate_bytes(&window, &tips, &visited);
        CachedWalk {
            tips,
            visited,
            newest_date: window.iter().map(|record| record.date).max().unwrap_or(0),
            window,
            size_bytes,
        }
    }
}

/// The approximate heap bytes of one cached traversal: the window's records plus the id sets.
/// Exact accounting would need the allocator's size classes; this counts each string's bytes
/// with a fixed allowance for its header, and each set entry as an id plus a bucket — erring
/// high, the right side to err for a memory budget.
fn approximate_bytes(
    window: &[CommitRecord],
    tips: &HashSet<ObjectId>,
    visited: &HashSet<ObjectId>,
) -> usize {
    let records: usize = window
        .iter()
        .map(|record| {
            std::mem::size_of::<CommitRecord>()
                + 4 * std::mem::size_of::<String>()
                + record.hash.len()
                + record.author.len()
                + record.email.len()
                + record.message.len()
                + record
                    .parents
                    .iter()
                    .map(|parent| std::mem::size_of::<String>() + parent.len())
                    .sum::<usize>()
        })
        .sum();
    let ids = (tips.len() + visited.len())
        * (std::mem::size_of::<ObjectId>() + std::mem::size_of::<usize>());
    records + ids + std::mem::size_of::<Vec<CommitRecord>>()
}

/// One cached traversal and when it last answered a load — the eviction ordering.
struct Slot {
    walk: Arc<CachedWalk>,
    last_used: u64,
}

/// The store's mutable state: the entries and the approximate bytes they total to.
#[derive(Default)]
struct StoreState {
    slots: HashMap<(PathBuf, CacheKey), Slot>,
    total_bytes: usize,
}

/// The traversals of every open repository, process-wide — the same shape as the repository
/// handle cache: a cache keyed by repository, guarded (not invalidated) by the walks themselves,
/// bounded by an approximate-byte budget with least-recently-used eviction.
pub struct Store {
    state: Mutex<StoreState>,
    /// The byte budget entries are evicted down to; [`DEFAULT_BUDGET_BYTES`] in production, and
    /// smaller in tests so eviction can be exercised without allocating 64 MiB of records.
    budget_bytes: usize,
    /// The LRU clock: bumped on every `get`, so `last_used` orders entries without holding a
    /// wall-clock time per access.
    clock: AtomicU64,
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
        GLOBAL.get_or_init(|| Store::with_budget(DEFAULT_BUDGET_BYTES))
    }

    /// A store with a custom byte budget (tests shrink it to prove eviction).
    pub fn with_budget(budget_bytes: usize) -> Store {
        Store {
            state: Mutex::new(StoreState::default()),
            budget_bytes,
            clock: AtomicU64::new(0),
            hits: AtomicUsize::new(0),
            fallbacks: AtomicUsize::new(0),
        }
    }

    /// The cached traversal for (`root`, `key`), if one exists — and the one most recently
    /// used, which is what the budget evicts last.
    fn get(&self, root: &Path, key: &CacheKey) -> Option<Arc<CachedWalk>> {
        let mut state = self.lock();
        state
            .slots
            .get_mut(&(root.to_path_buf(), key.clone()))
            .map(|slot| {
                slot.last_used = self.tick();
                Arc::clone(&slot.walk)
            })
    }

    /// `(incremental answers, full traversals)` so far, process-wide — how often the cache
    /// answered a refresh, and how often a guard sent it back to a full walk.
    pub fn stats(&self) -> (usize, usize) {
        (
            self.hits.load(Ordering::Relaxed),
            self.fallbacks.load(Ordering::Relaxed),
        )
    }

    /// The approximate bytes cached for one repository's traversals — the per-handle figure of
    /// the engine's stats answer.
    pub fn bytes_for(&self, root: &Path) -> usize {
        self.lock()
            .slots
            .iter()
            .filter(|((entry_root, _), _)| entry_root.as_path() == root)
            .map(|(_, slot)| slot.walk.size_bytes)
            .sum()
    }

    /// Keep the traversal of (`root`, `key`) as the one the next load continues from, evicting
    /// least-recently-used entries until the total fits the budget. The entry just inserted is
    /// never the eviction victim while anything older exists — and an entry larger than the
    /// whole budget is kept rather than dropped: a lone oversized window costs less than
    /// re-walking its repository on every refresh.
    pub(crate) fn put(&self, root: &Path, key: &CacheKey, walk: CachedWalk) {
        let mut state = self.lock();
        let bytes = walk.size_bytes;
        let slot = Slot {
            walk: Arc::new(walk),
            last_used: self.tick(),
        };
        if let Some(old) = state.slots.insert((root.to_path_buf(), key.clone()), slot) {
            state.total_bytes -= old.walk.size_bytes;
        }
        state.total_bytes += bytes;
        while state.total_bytes > self.budget_bytes && state.slots.len() > 1 {
            // The budget is the bound that matters, not the entry count; with the few hundred
            // entries 64 MiB buys, a linear scan for the least recently used is cheaper than
            // the ordered structure a larger cache would need.
            let victim = state
                .slots
                .iter()
                .min_by_key(|(_, slot)| slot.last_used)
                .map(|(entry_key, _)| entry_key.clone());
            match victim {
                Some(victim) => {
                    if let Some(evicted) = state.slots.remove(&victim) {
                        state.total_bytes -= evicted.walk.size_bytes;
                    }
                }
                None => break,
            }
        }
    }

    /// Drop every cached traversal of one repository — when a host knows the repository changed
    /// underneath it, or between comparisons in tests.
    pub fn invalidate(&self, root: &Path) {
        let mut state = self.lock();
        let dropped: usize = state
            .slots
            .iter()
            .filter(|((entry_root, _), _)| entry_root.as_path() == root)
            .map(|(_, slot)| slot.walk.size_bytes)
            .sum();
        state
            .slots
            .retain(|(entry_root, _), _| entry_root.as_path() != root);
        state.total_bytes = state.total_bytes.saturating_sub(dropped);
    }

    /// The next LRU tick.
    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StoreState> {
        // A poisoned lock means a panic while inserting a cache entry; the cache is an
        // optimisation whose every entry re-validates itself, so recovering beats failing every
        // later load.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for Store {
    fn default() -> Store {
        Store::with_budget(DEFAULT_BUDGET_BYTES)
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
            queue.push((committer_date(&commit), *tip));
        }
    }

    let mut new_records: Vec<CommitRecord> = Vec::new();
    let mut covered: HashSet<ObjectId> = HashSet::new();
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

        if cached.visited.contains(&id) {
            // The boundary: mark coverage and read nothing further below this commit.
            if cached.tips.contains(&id) {
                covered.insert(id);
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
                    .map(|parent| committer_date(&parent))
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
    // The hit is counted once, by the caller (try_walk) — the same place a fallback is counted.
    Ok(Some(window))
}

/// Keep `window` (in walk order, from either a full or an incremental traversal) as the
/// traversal the next load of (`root`, `key`) continues from.
pub(crate) fn remember(root: &Path, key: &CacheKey, tips: &[ObjectId], window: Vec<CommitRecord>) {
    Store::global().put(root, key, CachedWalk::new(tips, window));
}

#[cfg(test)]
mod tests;
