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

/// The root of the repository containing `path` — what `git rev-parse --show-toplevel` prints —
/// without keeping the repository open afterwards (the caller may only be scanning for roots).
pub fn repo_root(path: &str) -> Result<String> {
    let repo = Repo::discover(path)?;
    Ok(repo.root().display().to_string())
}
