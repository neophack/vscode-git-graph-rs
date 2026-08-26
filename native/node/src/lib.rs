//! Node-API bindings: the seam between the extension host and the Git engine.
//!
//! The ABI is deliberately small — a handful of functions, with structured data carried as JSON.
//! That is not laziness about typing: the alternative, building JavaScript objects property by
//! property across the boundary, costs a Node-API call *per field*, and a page of a thousand
//! commits has tens of thousands of them. Serialising once in Rust and calling `JSON.parse` once
//! in JavaScript is measurably faster, and it keeps the ABI stable while the engine's types evolve.
//!
//! The extension never calls this module directly: `src/backend/addon.ts` wraps it in the typed
//! API, and `src/backend/api.ts` is what replaces the original `DataSource`.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use git_graph_core::types::{LogOptions, RefReadOptions};
use git_graph_core::{
    blob, config, details, diff, gerrit, graph, log, refs, stash, status, Error, ErrorKind,
    RepoManager,
};

/// Open a repository and keep it open.
///
/// Returns the repository root — what `git rev-parse --show-toplevel` prints — because the caller
/// passes any path inside the repository and needs to know which repository it landed in.
#[napi]
pub async fn open_repository(path: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        Ok(repo.root().display().to_string())
    })
    .await
}

/// Drop a repository handle, releasing its object cache and open pack files.
///
/// Worth calling when a folder leaves the workspace; the handles are otherwise meant to live for
/// the whole editor session, which is where the performance comes from.
#[napi]
pub fn close_repository(path: String) {
    RepoManager::global().close(&path);
}

/// Drop every repository handle.
#[napi]
pub fn close_all_repositories() {
    RepoManager::global().close_all();
}

/// How many repositories are currently open. Exposed for the tests and for diagnostics.
#[napi]
pub fn open_repository_count() -> u32 {
    RepoManager::global().open_count() as u32
}

/// The repository information the view opens with: branches, tags, remotes, stashes and HEAD.
///
/// `options_json` is a [`RefOptionsPayload`].
#[napi]
pub async fn load_repo_info(path: String, options_json: String) -> Result<String> {
    run(move || {
        let payload: RefOptionsPayload = decode(&options_json)?;
        let repo = RepoManager::global().get(&path)?;
        let info = graph::repo_info(&repo, &payload.to_options(), payload.show_stashes)?;
        encode(&info)
    })
    .await
}

/// A page of the graph. `options_json` is a serialised `LogOptions`.
#[napi]
pub async fn load_commits(path: String, options_json: String) -> Result<String> {
    run(move || {
        let options: LogOptions = decode(&options_json)?;
        let repo = RepoManager::global().get(&path)?;
        let data = graph::load_commits(&repo, &options)?;
        encode(&data)
    })
    .await
}

/// The refs of a repository, without the commits.
#[napi]
pub async fn load_refs(path: String, options_json: String) -> Result<String> {
    run(move || {
        let payload: RefOptionsPayload = decode(&options_json)?;
        let repo = RepoManager::global().get(&path)?;
        let snapshot = refs::read_refs(&repo, &payload.to_options())?;
        encode(&snapshot.ref_data)
    })
    .await
}

/// One commit in full, with the files it changed — their statuses only, without line counts,
/// which arrive separately through [`load_line_counts`] so a many-file commit renders at once.
#[napi]
pub async fn load_commit_details(path: String, hash: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&details::commit_details(&repo, &hash)?)
    })
    .await
}

/// The `+N/-M` line counts of the given paths, keyed by path.
///
/// `from` is null to diff `to` against its first parent (the Commit Details view), or a revision
/// (the Commit Comparison view, or a stash's base). `paths_json` is a JSON array of paths; binary
/// files come back with null counts, as `git diff --numstat` prints a dash for them.
#[napi]
pub async fn load_line_counts(
    path: String,
    from: Option<String>,
    to: String,
    paths_json: String,
) -> Result<String> {
    run(move || {
        let paths: Vec<String> = decode(&paths_json)?;
        let repo = RepoManager::global().get(&path)?;
        encode(&diff::line_counts(&repo, from.as_deref(), &to, &paths)?)
    })
    .await
}

/// The "Uncommitted Changes" row in full.
#[napi]
pub async fn load_uncommitted_details(path: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&details::uncommitted_details(&repo)?)
    })
    .await
}

/// A stash entry in full. `stash_json` is a serialised `GitCommitStash`.
#[napi]
pub async fn load_stash_details(path: String, hash: String, stash_json: String) -> Result<String> {
    run(move || {
        let commit_stash: git_graph_core::types::GitCommitStash = decode(&stash_json)?;
        let repo = RepoManager::global().get(&path)?;
        encode(&details::stash_details(&repo, &hash, &commit_stash)?)
    })
    .await
}

/// The files that differ between two revisions. An empty `to` compares against the working tree.
#[napi]
pub async fn compare_commits(path: String, from: String, to: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&diff::diff_revisions(&repo, &from, &to)?)
    })
    .await
}

/// How many uncommitted changes there are — the number the "Uncommitted Changes" row shows.
#[napi]
pub async fn count_uncommitted_changes(path: String, include_untracked: bool) -> Result<u32> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        Ok(status::count_changes(&repo, include_untracked)? as u32)
    })
    .await
}

/// The stashes of a repository, newest first.
#[napi]
pub async fn load_stashes(path: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&stash::read_stashes(&repo)?)
    })
    .await
}

/// The repository configuration: remotes, identity and diff tool settings.
#[napi]
pub async fn load_config(path: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&config::read_config(&repo)?)
    })
    .await
}

/// The content of one file at one revision, or a binary marker when it is not text.
#[napi]
pub async fn load_commit_file(path: String, commit_hash: String, file: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&blob::commit_file(&repo, &commit_hash, &file)?)
    })
    .await
}

/// The unified diff of one file between a commit and its first parent.
#[napi]
pub async fn load_commit_file_diff(
    path: String,
    commit_hash: String,
    file: String,
) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        blob::commit_file_diff(&repo, &commit_hash, &file)
    })
    .await
}

/// The full commit message of each of the given commits, keyed by hash, as a JSON object.
#[napi]
pub async fn load_commit_bodies(path: String, hashes: Vec<String>) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&details::commit_bodies(&repo, &hashes)?)
    })
    .await
}

/// The subject of one commit.
#[napi]
pub async fn load_commit_subject(path: String, hash: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        details::commit_subject(&repo, &hash)
    })
    .await
}

/// The summary of each of the given commits, keyed by hash, as a JSON object.
#[napi]
pub async fn load_commit_summaries(path: String, hashes: Vec<String>) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&details::commit_summaries(&repo, &hashes)?)
    })
    .await
}

/// The commits whose message matches a pattern, newest first, as a JSON array.
#[napi]
pub async fn search_history(path: String, query: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&log::search_history(&repo, &query)?)
    })
    .await
}

/// A tag in full (tagger, message, signature presence), as a JSON object.
#[napi]
pub async fn load_tag_details(path: String, tag_name: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&details::tag_details(&repo, &tag_name)?)
    })
    .await
}

/// The fetch URL of a remote, or NULL when it is not configured.
#[napi]
pub async fn remote_url(path: String, remote: String) -> Result<Option<String>> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        config::remote_url(&repo, &remote)
    })
    .await
}

/// Where a file was renamed to between a commit and the working tree, or NULL when it was not.
#[napi]
pub async fn new_path_of_renamed_file(
    path: String,
    commit_hash: String,
    old_file_path: String,
) -> Result<Option<String>> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        diff::new_path_of_renamed_file(&repo, &commit_hash, &old_file_path)
    })
    .await
}

/// The roots of the repository's initialised submodules.
#[napi]
pub async fn submodules(path: String) -> Result<Vec<String>> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        config::submodules(&repo)
    })
    .await
}

/// The upstream of the checked-out branch (`origin/main`), or NULL when there is none.
#[napi]
pub async fn current_branch_upstream(path: String) -> Result<Option<String>> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        config::current_branch_upstream(&repo)
    })
    .await
}

/// How many commits are reachable from the shown refs but not from `hash` — `git rev-list --count`.
#[napi]
pub async fn count_commits_before(
    path: String,
    branches: Option<Vec<String>>,
    hash: String,
    show_remote_branches: bool,
    include_reflogs: bool,
) -> Result<u32> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        Ok(log::count_commits_before(
            &repo,
            branches.as_deref(),
            &hash,
            show_remote_branches,
            include_reflogs,
        )? as u32)
    })
    .await
}

/// The root of the repository containing a path, without keeping the repository open.
#[napi]
pub async fn repo_root(path: String) -> Result<String> {
    run(move || git_graph_core::repository::repo_root(&path)).await
}

/// The names of the repository's remotes.
#[napi]
pub async fn remote_names(path: String) -> Result<Vec<String>> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        config::remote_names(&repo)
    })
    .await
}

/// The distinct commit authors of the current branch's history, as a JSON array.
#[napi]
pub async fn authors(path: String) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&log::authors(&repo)?)
    })
    .await
}

/// The configuration entries of one location (local or global), last value per key, as JSON.
#[napi]
pub async fn config_list(path: String, local: bool) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&config::config_list(
            &repo,
            if local {
                config::ConfigLocation::Local
            } else {
                config::ConfigLocation::Global
            },
        )?)
    })
    .await
}

/// The checked-out branch's short name, or NULL when HEAD is detached.
#[napi]
pub async fn current_branch_name(path: String) -> Result<Option<String>> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        config::current_branch_name(&repo)
    })
    .await
}

/// The review states of the given Gerrit changes, parsed from their NoteDb meta histories in one
/// in-process pass, as a JSON array aligned with the input order.
///
/// An entry is NULL when the change's meta ref is not available locally. `url_base`, when given,
/// is prefixed onto each change number to produce the state's web URL.
#[napi]
pub async fn parse_gerrit_metas(
    path: String,
    remote: String,
    changes: Vec<i64>,
    url_base: Option<String>,
) -> Result<String> {
    run(move || {
        let repo = RepoManager::global().get(&path)?;
        encode(&gerrit::parse_gerrit_metas(
            &repo,
            &remote,
            &changes,
            url_base.as_deref(),
        )?)
    })
    .await
}

/// The engine's version, so the extension can report which backend it is running.
#[napi]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/* ---------- Plumbing ---------- */

/// Run a blocking engine call off the JavaScript thread.
///
/// The work is CPU- and disk-bound, and it runs on napi's own runtime rather than on libuv's
/// thread pool — which is capped at four threads and is already serving the editor's own file I/O.
///
/// The closure works in the engine's own `Result`, so `?` composes throughout it; the single
/// conversion to a JavaScript error happens here.
async fn run<T, F>(work: F) -> Result<T>
where
    F: FnOnce() -> git_graph_core::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let outcome = napi::tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("Git: {e}")))?;
    outcome.map_err(to_js_error)
}

/// Turn an engine error into the JavaScript error the extension will see.
///
/// The kind is prefixed onto the message so that the TypeScript side can tell "this repository is
/// not usable, fall back to the `git` CLI" from "this operation failed, show the user".
fn to_js_error(error: Error) -> napi::Error {
    let kind = match error.kind {
        ErrorKind::NotARepository => "NotARepository",
        ErrorKind::NotFound => "NotFound",
        ErrorKind::InvalidArgument => "InvalidArgument",
        ErrorKind::Git => "Git",
        ErrorKind::Io => "Io",
        ErrorKind::Cancelled => "Cancelled",
        ErrorKind::Unsupported => "Unsupported",
    };
    napi::Error::new(
        napi::Status::GenericFailure,
        format!("{kind}: {}", error.message),
    )
}

/// Serialising a response cannot fail for the engine's own types, but a failure would mean the
/// view silently rendered nothing, so it is reported rather than swallowed.
fn encode<T: serde::Serialize>(value: &T) -> git_graph_core::Result<String> {
    serde_json::to_string(value).map_err(|e| {
        Error::new(
            ErrorKind::Git,
            format!("Could not encode the response: {e}"),
        )
    })
}

/// A malformed request means the TypeScript and Rust sides disagree about the contract, which is a
/// bug rather than a user error — so it names the field that did not fit.
fn decode<T: serde::de::DeserializeOwned>(json: &str) -> git_graph_core::Result<T> {
    serde_json::from_str(json).map_err(|e| {
        Error::new(
            ErrorKind::InvalidArgument,
            format!("Could not decode the request: {e}"),
        )
    })
}

/// The wire form of [`RefReadOptions`], plus the stash flag `loadRepoInfo` also needs.
///
/// The defaults are the ones a view load uses, so an omitted field means "the usual".
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RefOptionsPayload {
    show_remote_branches: bool,
    show_remote_heads: bool,
    hide_remotes: Vec<String>,
    show_change_refs: bool,
    show_stashes: bool,
}

impl Default for RefOptionsPayload {
    fn default() -> Self {
        RefOptionsPayload {
            show_remote_branches: true,
            show_remote_heads: false,
            hide_remotes: Vec::new(),
            show_change_refs: false,
            show_stashes: true,
        }
    }
}

impl RefOptionsPayload {
    fn to_options(&self) -> RefReadOptions {
        RefReadOptions {
            show_remote_branches: self.show_remote_branches,
            show_remote_heads: self.show_remote_heads,
            hide_remotes: self.hide_remotes.clone(),
            show_change_refs: self.show_change_refs,
        }
    }
}
