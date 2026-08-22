//! Repository discovery and the handle cache.
//!
//! The original extension answered every question by spawning `git`, which re-reads the pack
//! index files before doing any useful work — and a single view refresh makes several such calls.
//! Here a repository is opened once and kept open for the whole editor session, so the pack
//! indexes and the object cache stay resident between requests.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::{Error, Result, ResultExt};

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

    /// Open the repository rooted exactly at `path`, without searching upwards.
    pub fn open(path: impl AsRef<Path>) -> Result<Repo> {
        let path = path.as_ref();
        let repo = gix::open(path)
            .map_err(|e| Error::not_a_repository(format!("{}: {e}", path.display())))?;
        Repo::from_gix(repo)
    }

    fn from_gix(repo: gix::Repository) -> Result<Repo> {
        let git_dir = repo.git_dir().to_path_buf();
        let root = repo
            .workdir()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| git_dir.clone());
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

/// The set of repositories the extension has open.
///
/// Repositories are keyed by the path the caller passed, so two views of the same repository share
/// one handle and one warm object cache.
#[derive(Default)]
pub struct RepoManager {
    repos: Mutex<HashMap<PathBuf, Arc<Repo>>>,
}

impl RepoManager {
    pub fn new() -> RepoManager {
        RepoManager::default()
    }

    /// The process-wide manager. The extension host is one process per window, and the handles are
    /// meant to outlive individual requests, so a single instance is what the whole extension uses.
    pub fn global() -> &'static RepoManager {
        static MANAGER: OnceLock<RepoManager> = OnceLock::new();
        MANAGER.get_or_init(RepoManager::new)
    }

    /// Get the open handle for `path`, opening it if this is the first request for it.
    pub fn get(&self, path: impl AsRef<Path>) -> Result<Arc<Repo>> {
        let key = path.as_ref().to_path_buf();
        if let Some(repo) = self.repos.lock().unwrap().get(&key) {
            return Ok(Arc::clone(repo));
        }
        // Opening happens outside the lock: it touches the disk, and a slow open of one repository
        // must not block requests for the others.
        let repo = Arc::new(Repo::discover(&key)?);
        let mut repos = self.repos.lock().unwrap();
        // Another thread may have opened it while we were; keep whichever handle landed first so
        // that callers never hold two handles to the same repository.
        Ok(Arc::clone(repos.entry(key).or_insert(repo)))
    }

    /// Drop the handle for `path` (e.g. because the folder was removed from the workspace).
    pub fn close(&self, path: impl AsRef<Path>) {
        self.repos.lock().unwrap().remove(path.as_ref());
    }

    /// Drop every handle.
    pub fn close_all(&self) {
        self.repos.lock().unwrap().clear();
    }

    pub fn open_count(&self) -> usize {
        self.repos.lock().unwrap().len()
    }
}
