//! Repository discovery and the handle cache.
//!
//! The original extension answered every question by spawning `git`, which re-reads the pack
//! index files before doing any useful work — and a single view refresh makes several such calls.
//! Here a repository is opened once and kept open for the whole editor session, so the pack
//! indexes and the object cache stay resident between requests.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use crate::error::{Error, Result, ResultExt};
use crate::model::{GitEngineStats, GitRepoHandleStats};

/// How much decompressed object data to keep per repository. Commit objects are small and the
/// graph walk reads each of them at least twice (once to order, once to render), so a modest
/// cache removes the second decompression entirely.
const OBJECT_CACHE_BYTES: usize = 32 * 1024 * 1024;

/// An open repository, shareable across threads.
///
/// `gix::Repository` is deliberately not `Sync` (it owns mutable caches), so the shared handle is
/// the `ThreadSafeRepository` and each request materialises its own cheap thread-local view.
pub struct Repo {
    inner: gix::ThreadSafeRepository,
    /// The worktree root, or the git directory for a bare repository.
    root: PathBuf,
    /// The git directory. Cached because the shared handle does not expose it.
    git_dir: PathBuf,
}

impl Repo {
    /// Open the repository containing `path`, searching upwards like `git rev-parse --show-toplevel`.
    pub fn discover(path: impl AsRef<Path>) -> Result<Repo> {
        let path = path.as_ref();
        let repo = gix::discover(path)
            .map_err(|e| Error::not_a_repository(format!("{}: {e}", path.display())))?;
        Repo::from_gix(repo)
    }

    fn from_gix(repo: gix::Repository) -> Result<Repo> {
        let git_dir = repo.git_dir().to_path_buf();
        let root = repo
            .workdir()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| git_dir.clone());
        // Declined before anything is read: an openable-looking repository whose refs cannot be
        // seen would render as an empty graph, which the caller cannot tell from an empty
        // repository.
        if uses_reftable(&git_dir) {
            return Err(Error::unsupported(format!(
                "{} stores its refs in the reftable format, which this engine cannot read",
                git_dir.display()
            )));
        }
        Ok(Repo {
            inner: repo.into_sync(),
            root,
            git_dir,
        })
    }

    /// A thread-local view of the repository, for use within a single request.
    pub fn borrow(&self) -> gix::Repository {
        let mut repo = self.inner.to_thread_local();
        repo.object_cache_size_if_unset(OBJECT_CACHE_BYTES);
        repo
    }

    /// Does the repository carry replacement objects (`git replace`, `refs/replace/*`)?
    ///
    /// git applies them to every object read unless `core.useReplaceRefs=false` turns that off.
    /// gix 0.87 inverts the setting when it opens a repository (the "enabled" answer is bound to
    /// `is_disabled`): by default it never applies them, and with `core.useReplaceRefs=false` it
    /// does — the opposite of git either way. Reads whose answer depends on them are declined
    /// whenever any exist, and the CLI answers them.
    pub fn uses_replace_refs(&self) -> bool {
        let git = self.borrow();
        git.references()
            .ok()
            .and_then(|platform| {
                platform
                    .prefixed("refs/replace/")
                    .ok()
                    .map(|mut refs| refs.next().is_some())
            })
            .unwrap_or(false)
    }

    /// The worktree root (what `git rev-parse --show-toplevel` prints), or the git directory when
    /// the repository is bare.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The `.git` directory.
    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    pub fn is_bare(&self) -> bool {
        self.inner.work_tree.is_none()
    }

    /// The names of the repository's remotes, in the order `git remote` lists them (alphabetical).
    pub fn remote_names(&self) -> Vec<String> {
        let repo = self.borrow();
        let mut names: Vec<String> = repo
            .remote_names()
            .into_iter()
            .map(|name| name.to_string())
            .collect();
        names.sort();
        names
    }

    /// Resolve a revision specification (`HEAD`, a branch name, a hash, `HEAD~2`, ...) to a commit.
    pub fn resolve_commit(&self, rev: &str) -> Result<gix::ObjectId> {
        resolve_commit_in(&self.borrow(), rev)
    }
}

/// Does the repository store its refs in the [reftable] format?
///
/// gitoxide reads only the files backend (loose refs and `packed-refs`); a reftable repository
/// opens without complaint but reports no refs and no HEAD at all, which the view renders as an
/// empty graph — indistinguishable from an empty repository. Answering `Unsupported` instead
/// hands the repository to the extension's `git` CLI backend, which reads reftable natively.
///
/// The layout is detected from the shapes only git's reftable backend produces, in both of its
/// arrangements: the default *dirtree* layout keeps the tables in `<git-dir>/reftable/` and
/// replaces `refs/heads` with a regular file saying so, while the rare *embedded* layout makes
/// `refs` itself a file pointing at the tables. A linked worktree keeps its refs in the main
/// repository's reftable, reached through the `commondir` file.
///
/// [reftable]: https://git-scm.com/docs/reftable
fn uses_reftable(git_dir: &Path) -> bool {
    fn markers(dir: &Path) -> bool {
        dir.join("refs").is_file()
            || dir.join("refs").join("heads").is_file()
            || dir.join("reftable").join("tables.list").is_file()
    }

    if markers(git_dir) {
        return true;
    }
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(common) => {
            let common = common.trim();
            if common.is_empty() {
                return false;
            }
            let common = Path::new(common);
            let common_dir = if common.is_absolute() {
                common.to_path_buf()
            } else {
                git_dir.join(common)
            };
            markers(&common_dir)
        }
        Err(_) => false,
    }
}

/// Resolve a revision against an already-borrowed repository.
///
/// Resolving a list of revisions goes through this rather than through [`Repo::resolve_commit`]:
/// borrowing costs a fresh object cache and a config re-derivation, and a view of a repository with
/// a few hundred tags resolves a few hundred revisions per load.
pub fn resolve_commit_in(repo: &gix::Repository, rev: &str) -> Result<gix::ObjectId> {
    // Most of what a view load resolves is already a full hash — the refs were just read, and
    // their targets are handed straight back here. Going through the revspec *parser* for those
    // is pure overhead, and there are hundreds of them on a repository with many tags.
    if let Ok(id) = gix::ObjectId::from_hex(rev.as_bytes()) {
        // A commit is by far the common case and needs no peeling at all; only a tag object does.
        return match repo.find_object(id) {
            Ok(object) if object.kind == gix::object::Kind::Commit => Ok(id),
            Ok(object) => object
                .peel_to_kind(gix::object::Kind::Commit)
                .map(|commit| commit.id)
                .map_err(|e| Error::not_found(format!("'{rev}' is not a commit: {e}"))),
            Err(e) => Err(Error::not_found(format!("Could not resolve '{rev}': {e}"))),
        };
    }

    let id = repo
        .rev_parse_single(rev)
        .map_err(|e| Error::not_found(format!("Could not resolve '{rev}': {e}")))?;
    let object = id.object().git_ctx("Could not read object")?;
    let commit = object
        .peel_to_kind(gix::object::Kind::Commit)
        .map_err(|e| Error::not_found(format!("'{rev}' is not a commit: {e}")))?;
    Ok(commit.id)
}

/// The commits on a shallow clone's boundary (`.git/shallow`), whose parents git treats as absent.
///
/// gix hands out a boundary commit's parent ids as its object records them, but those parents were
/// never fetched: git shows the commit as a root (`git log --format=%P` prints nothing for it), and
/// diffs it against the empty tree. Every parent the engine reports or diffs against goes through
/// [`Shallow::parents`] so the two agree. Read once per operation — the boundary is a small file,
/// and a missing one (every non-shallow repository) costs a failed open.
#[derive(Debug, Default)]
pub struct Shallow(HashSet<gix::ObjectId>);

impl Shallow {
    pub fn of(git: &gix::Repository) -> Shallow {
        match git.shallow_commits() {
            Ok(Some(commits)) => Shallow(commits.iter().copied().collect()),
            _ => Shallow::default(),
        }
    }

    /// A commit's parents as git reports them: none for a commit on the shallow boundary.
    pub fn parents(&self, commit: &gix::Commit<'_>) -> Vec<gix::ObjectId> {
        if self.0.contains(&commit.id) {
            return Vec::new();
        }
        commit.parent_ids().map(|parent| parent.detach()).collect()
    }
}

/// How long a handle may sit unused before the next `get` drops it: the object cache of an
/// unused repository is pure memory cost, and re-opening costs one index read (10 minutes).
pub const IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);

/// How many path→git-directory redirects the memo holds before it resets. Hosts normally pass
/// repository roots, so the memo stays tiny; the cap only stops pathological growth (a caller
/// minting a fresh subdirectory path per request), and a reset costs one re-discovery each.
const MEMO_LIMIT: usize = 1024;

/// One cached handle, and when it last served a request.
struct Handle {
    repo: Arc<Repo>,
    last_used: Instant,
}

/// The mutable state of the handle cache, under one lock: the handles themselves and the memo
/// that turns a requested path into its handle's key without a second discovery.
#[derive(Default)]
struct State {
    /// Canonical git directory → handle.
    handles: HashMap<PathBuf, Handle>,
    /// Requested path → canonical git directory (the handle key), for paths that are not
    /// themselves the repository root.
    memo: HashMap<PathBuf, PathBuf>,
}

/// The set of repositories the extension has open.
///
/// Handles are keyed by the repository's canonical **git directory**, not by the path a request
/// happens to name: every path inside one repository — the root a view opens, a subdirectory a
/// file-history request names — resolves to the same key, so they share one handle and one warm
/// object cache instead of opening one per spelling. A small memo remembers the path→key
/// redirect so repeated subdirectory requests skip the discovery walk.
pub struct RepoManager {
    state: Mutex<State>,
    /// How long a handle may stay unused before it is evicted; `IDLE_LIMIT` in production, and
    /// shorter in tests so eviction can be exercised without waiting. Deliberately no `Default`:
    /// the derived one would evict everything on every `get`.
    idle_limit: Duration,
}

impl RepoManager {
    pub fn new() -> RepoManager {
        RepoManager {
            state: Mutex::new(State::default()),
            idle_limit: IDLE_LIMIT,
        }
    }

    /// A manager with a custom idle-eviction limit (tests shrink it to prove eviction).
    #[cfg(test)]
    pub fn with_idle_limit(idle_limit: Duration) -> RepoManager {
        RepoManager {
            state: Mutex::new(State::default()),
            idle_limit,
        }
    }

    /// The process-wide manager. The extension host is one process per window, and the handles are
    /// meant to outlive individual requests, so a single instance is what the whole extension uses.
    pub fn global() -> &'static RepoManager {
        static MANAGER: OnceLock<RepoManager> = OnceLock::new();
        MANAGER.get_or_init(RepoManager::new)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // A poisoned lock means a panic while the bookkeeping was held — the state itself is still
        // structurally valid, and the cache is an optimisation every entry of which re-validates
        // itself — so recovering beats failing every later request, the same trade the incremental
        // traversal cache makes.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Get the open handle for the repository containing `path`, opening it if this is the first
    /// request for it. Any path inside the working tree answers the same handle.
    pub fn get(&self, path: impl AsRef<Path>) -> Result<Arc<Repo>> {
        let path = path.as_ref();
        {
            let mut state = self.lock();
            if let Some(key) = state.memo.get(path).cloned() {
                if let Some(handle) = state.handles.get_mut(&key) {
                    handle.last_used = Instant::now();
                    let repo = Arc::clone(&handle.repo);
                    evict_idle(&mut state, &key, self.idle_limit);
                    return Ok(repo);
                }
            }
        }
        // Opening happens outside the lock: it touches the disk, and a slow open of one repository
        // must not block requests for the others.
        let repo = Repo::discover(path)?;
        let key = canonical_git_dir(repo.git_dir());
        let mut state = self.lock();
        if state.memo.len() >= MEMO_LIMIT {
            state.memo.clear();
        }
        state.memo.insert(path.to_path_buf(), key.clone());
        // Another thread may have opened it while we were; keep whichever handle landed first so
        // that callers never hold two handles to the same repository.
        let now = Instant::now();
        let handle = state.handles.entry(key.clone()).or_insert_with(|| Handle {
            repo: Arc::new(repo),
            last_used: now,
        });
        handle.last_used = now;
        let repo = Arc::clone(&handle.repo);
        evict_idle(&mut state, &key, self.idle_limit);
        Ok(repo)
    }

    /// Drop the handle for the repository containing `path` (e.g. because the folder was removed
    /// from the workspace). Any path inside the repository names its handle.
    pub fn close(&self, path: impl AsRef<Path>) {
        let path = path.as_ref();
        let known = self.lock().memo.get(path).cloned();
        // A path the memo has never seen still names a repository: discover it the way `get`
        // would have, so closing by any path inside the repository works. A path outside every
        // repository discovers nothing and closes nothing, as before.
        let key = known.or_else(|| {
            Repo::discover(path)
                .ok()
                .map(|repo| canonical_git_dir(repo.git_dir()))
        });
        let Some(key) = key else { return };
        let mut state = self.lock();
        state.handles.remove(&key);
        // The redirects that pointed here are stale now; drop them so the next `get` re-discovers
        // rather than trusting a memo entry whose handle is gone.
        state.memo.retain(|_, target| *target != key);
    }

    /// Drop every handle.
    pub fn close_all(&self) {
        let mut state = self.lock();
        state.handles.clear();
        state.memo.clear();
    }

    pub fn open_count(&self) -> usize {
        self.lock().handles.len()
    }

    /// The diagnostics view of the handle cache: how many repositories are open, and per handle
    /// the git directory that keys it, how long since it last served a request, and the
    /// approximate bytes of incremental traversal cache held for it. (The gix object caches are
    /// per thread-local view and do not report their own size, so the traversal cache is the
    /// honest per-handle figure; its bytes are counted by the same approximation that bounds
    /// them.)
    pub fn stats(&self) -> GitEngineStats {
        let state = self.lock();
        let store = crate::read::incremental::Store::global();
        GitEngineStats {
            open_count: state.handles.len(),
            handles: state
                .handles
                .values()
                .map(|handle| GitRepoHandleStats {
                    git_dir: handle.repo.git_dir().display().to_string(),
                    idle_ms: elapsed_ms(handle.last_used),
                    cache_bytes: store.bytes_for(handle.repo.root()),
                })
                .collect(),
        }
    }
}

/// Drop every handle idle for longer than `idle_limit`, except `current` (the handle this
/// eviction runs for — it has just been used). Evicting only drops the cache's own reference: a
/// request still holding the `Arc` keeps its repository open until it finishes. Memo entries
/// pointing at evicted keys are left alone; a lookup through a stale redirect simply misses and
/// re-discovers, and the redirect is overwritten when the repository re-opens.
fn evict_idle(state: &mut State, current: &Path, idle_limit: Duration) {
    state
        .handles
        .retain(|key, handle| key == current || handle.last_used.elapsed() <= idle_limit);
}

/// The canonical form of a git directory used as a handle key: `fs::canonicalize` resolves
/// symlinks, Windows 8.3 short paths and network-mapped spellings, so one repository discovered
/// through different paths lands on one key. A canonicalization failure (the directory vanished
/// mid-request) falls back to the path as discovered.
fn canonical_git_dir(git_dir: &Path) -> PathBuf {
    std::fs::canonicalize(git_dir).unwrap_or_else(|_| git_dir.to_path_buf())
}

/// Milliseconds since `since`, as the stats wire type reports them.
fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis().min(u64::MAX as u128) as u64
}

/// The root of the repository containing `path` — what `git rev-parse --show-toplevel` prints —
/// without keeping the repository open afterwards (the caller may only be scanning for roots).
pub fn repo_root(path: &str) -> Result<String> {
    let repo = Repo::discover(path)?;
    Ok(repo.root().display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty `git init` fixture — `Repo::discover` needs a real repository, and this module's
    /// tests need two of them. Returns `None` when `git` is unavailable (skip, not fail).
    fn init_repo(tag: &str) -> Option<tempfile::TempDir> {
        let dir = tempfile::tempdir().expect("could not create a temporary directory");
        let output = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(dir.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("could not run `git init`");
        if !output.status.success() {
            eprintln!("skipping: `git init {tag}` failed");
            return None;
        }
        Some(dir)
    }

    #[test]
    fn idle_handles_are_evicted_but_the_current_one_stays() {
        let Some(first) = init_repo("first") else {
            return;
        };
        let Some(second) = init_repo("second") else {
            return;
        };

        // A manager with a hair-trigger idle limit: a handle that has not served a request
        // within the limit is dropped by the next `get`, which must never evict the handle it
        // is serving.
        let manager = RepoManager::with_idle_limit(Duration::from_millis(25));
        assert!(manager.get(first.path()).is_ok());
        assert!(manager.get(second.path()).is_ok());
        assert_eq!(manager.open_count(), 2);
        std::thread::sleep(Duration::from_millis(60));
        assert!(manager.get(second.path()).is_ok());
        assert_eq!(manager.open_count(), 1, "the idle first handle was evicted");

        // An evicted repository re-opens on demand, and a request already holding the handle's
        // Arc keeps working across an eviction underneath it.
        let held = manager.get(first.path()).unwrap();
        assert_eq!(manager.open_count(), 2);
        std::thread::sleep(Duration::from_millis(60));
        assert!(manager.get(second.path()).is_ok());
        assert_eq!(
            manager.open_count(),
            1,
            "the re-opened idle handle was evicted again"
        );
        assert!(
            held.root().exists(),
            "the in-flight Arc outlives its eviction"
        );
    }

    #[test]
    fn subdirectory_and_root_share_one_keyed_handle() {
        let Some(repo) = init_repo("shared") else {
            return;
        };
        let nested = repo.path().join("sub");
        std::fs::create_dir_all(&nested).expect("could not create the subdirectory");

        // The handle is keyed by the canonical git directory, so the root and a subdirectory of
        // the same repository answer one handle — not two handles with two object caches.
        let manager = RepoManager::new();
        assert!(manager.get(repo.path()).is_ok());
        assert!(manager.get(&nested).is_ok());
        assert_eq!(manager.open_count(), 1);

        // Closing by either spelling drops that one handle.
        manager.close(&nested);
        assert_eq!(manager.open_count(), 0);

        // And the stats row is keyed by the git directory.
        assert!(manager.get(&nested).is_ok());
        let stats = manager.stats();
        assert_eq!(stats.open_count, 1);
        assert_eq!(stats.handles.len(), 1);
        assert!(
            Path::new(&stats.handles[0].git_dir).ends_with(".git"),
            "keyed by the git directory, got {}",
            stats.handles[0].git_dir
        );
    }
}
