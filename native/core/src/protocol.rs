//! The engine's request protocol: every method a host can call, declared once.
//!
//! A request is `{"method": "loadCommits", "params": {…}}`, decoded by serde straight into the
//! typed [`Request`] enum — there is no hand-written method-name `match` and no hand-written
//! parameter parsing. The answer is an envelope: `{"ok": <the method's result>}` or
//! `{"error": {"kind": "notFound", "message": "…"}}`.
//!
//! The one [`protocol!`] table below declares, per method, its wire name, its parameter type,
//! its result type and its handler. The same table generates the TypeScript method map
//! ([`typescript`]), so adding a method here is the whole job: the Node binding forwards any
//! method unchanged, and the host's types regenerate from `cargo test` (see `tests/protocol.rs`).
//!
//! Lifecycle rides the same table: `open` answers the repository root (creating the warm handle
//! on the way), `close` drops one handle, `closeAll` drops every one, `openCount` counts them,
//! `engineVersion` names the engine, `repoRoot` answers without keeping a handle. Every other
//! method shares the warm handle for its repository path and never writes.

use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::{Config, TypeVisitor, TS};

use crate::cancel::{Cancel, Registry};
use crate::error::{Error, Result};
use crate::model::{
    AnnotateParams, AnnotateResult, CommitFile, ConfigSnapshot, GerritChangeState, GitActivityCell,
    GitAuthor, GitAuthorStat, GitCommitData, GitCommitDetails, GitCommitStash, GitCommitSummary,
    GitFileChange, GitHistoryMatch, GitLineCounts, GitRefData, GitRepoInfo, GitStash,
    GitTagDetails, GitViewData, LogOptions, RefOptions, RefSnapshot,
};
use crate::read::status::ScmChange;
use crate::repository::{Repo, RepoManager};

/// What a handler sees: the repository path the request names, a warm handle on demand, and the
/// request's cancellation state (task 2.9) for the handlers whose work loops.
pub(crate) struct Context<'a> {
    repo_path: &'a str,
    cancel: Cancel,
}

impl Context<'_> {
    /// The shared handle of the repository containing the request's path.
    fn repo(&self) -> Result<Arc<Repo>> {
        RepoManager::global().get(self.repo_path)
    }

    /// The request's cancellation token, for the handlers that loop over commits or the working
    /// tree. A request without a request id hands out [`Cancel::none`], whose checks cost nothing.
    fn cancel(&self) -> Cancel {
        self.cancel.clone()
    }
}

/// The parameters of a method that takes none. On the wire: `{}`, or the `params` key omitted.
#[derive(Debug, Clone, Default, Deserialize, TS)]
pub struct NoParams {}

macro_rules! protocol {
    ($(
        $(#[doc = $doc:literal])*
        $method:literal => $variant:ident($params:ty) -> $result:ty
            = |$ctx:ident, $p:pat_param| $body:expr;
    )*) => {
        /// Every request the engine answers, decoded from `{"method", "params"}`.
        #[derive(Debug, Deserialize)]
        #[serde(tag = "method", content = "params")]
        pub enum Request {
            $(
                $(#[doc = $doc])*
                #[serde(rename = $method)]
                $variant($params),
            )*
        }

        /// The wire names of every method, in table order.
        pub const METHODS: &[&str] = &[$($method),*];

        impl Request {
            /// The wire name of this request's method.
            pub fn method(&self) -> &'static str {
                match self {
                    $(Request::$variant(_) => $method,)*
                }
            }

            /// Run the request and serialise its result.
            pub(crate) fn answer(self, context: &Context<'_>) -> Result<Value> {
                match self {
                    $(Request::$variant($p) => {
                        let $ctx = context;
                        let result: Result<$result> = $body;
                        encode(result?)
                    })*
                }
            }
        }

        /// The TypeScript method map — `EngineMethods[M]` is `{ params; result }` — together with
        /// every type the parameters and results refer to, as one self-contained module.
        pub fn typescript() -> String {
            let config = typescript_config();
            let mut declarations = Declarations::default();
            let mut methods = String::new();
            $(
                declarations.visit_root::<$params>(&config);
                declarations.visit_root::<$result>(&config);
                methods.push_str(&format!(
                    "\t{}: {{ params: {}; result: {} }};\n",
                    $method,
                    <$params as TS>::name(&config),
                    <$result as TS>::name(&config),
                ));
            )*
            declarations.visit_root::<Error>(&config);
            // Declarations are emitted sorted by name, not in traversal order: the order the type
            // visitor reaches them in is fixed per compilation of this crate (ts-rs's derive emits
            // its per-struct dependency walks from a hash set), so relying on it would reshuffle
            // the generated module on every rebuild and churn the file for no content change.
            let ordered = declarations
                .output
                .values()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "{GENERATED_HEADER}\n{ordered}\n/** Every engine method: its parameters and its result. */\nexport interface EngineMethods {{\n{methods}}}\n\nexport type EngineMethod = keyof EngineMethods;\n",
            )
        }
    };
}

protocol! {
    /* ---------- Lifecycle ---------- */

    /// The engine's version (the crate version).
    "engineVersion" => EngineVersion(NoParams) -> String = |_ctx, _| Ok(crate::VERSION.to_string());
    /// How many repository handles are open.
    "openCount" => OpenCount(NoParams) -> usize = |_ctx, _| Ok(RepoManager::global().open_count());
    /// Drop every repository handle.
    "closeAll" => CloseAll(NoParams) -> () = |_ctx, _| {
        RepoManager::global().close_all();
        Ok(())
    };
    /// The root of the repository containing the path, without keeping a handle.
    "repoRoot" => RepoRoot(NoParams) -> String = |ctx, _| crate::repository::repo_root(ctx.repo_path);
    /// Open (or reuse) the warm handle and answer the repository root.
    "open" => Open(NoParams) -> String = |ctx, _| Ok(ctx.repo()?.root().display().to_string());
    /// Drop this repository's handle.
    "close" => Close(NoParams) -> () = |ctx, _| {
        RepoManager::global().close(ctx.repo_path);
        Ok(())
    };

    /* ---------- The graph and its refs ---------- */

    /// The view's opening load — `loadRepoInfo` and `loadCommits` from one ref scan.
    "loadView" => LoadView(LogOptions) -> GitViewData = |ctx, options| crate::read::graph::load_view(&*ctx.repo()?, &options, ctx.cancel());
    "loadRepoInfo" => LoadRepoInfo(RefOptions) -> GitRepoInfo = |ctx, options| {
        crate::read::graph::repo_info(&*ctx.repo()?, &options.to_read_options(), options.show_stashes)
    };
    "loadCommits" => LoadCommits(LogOptions) -> GitCommitData = |ctx, options| crate::read::graph::load_commits(&*ctx.repo()?, &options, ctx.cancel());
    "loadRefs" => LoadRefs(RefOptions) -> GitRefData = |ctx, options| {
        crate::read::refs::read_refs(&*ctx.repo()?, &options.to_read_options()).map(|snapshot| snapshot.ref_data)
    };
    /// Re-read the repository's refs — the refs-only refresh of the operate path (§3.8.3). One
    /// scan, no commits walked and no stashes read; answers the branch/tag name lists and the
    /// checked-out branch alongside the raw ref data, where `loadRefs` answers the raw data alone.
    "refs" => Refs(RefOptions) -> RefSnapshot = |ctx, options| crate::read::refs::read_refs(&*ctx.repo()?, &options.to_read_options());
    /// Re-annotate a commit list the caller already holds with freshly read refs, without
    /// walking a single commit — the other half of the refs-only refresh. A full `loadCommits`
    /// of the same options attaches the same labels to the same commits.
    "annotate" => Annotate(AnnotateParams) -> AnnotateResult = |ctx, p| crate::read::graph::annotate(&*ctx.repo()?, &p);
    /// The working tree's changes, staged and unstaged halves apart.
    "status" => Status(NoParams) -> Vec<ScmChange> = |ctx, _| crate::read::status::scm_changes(&*ctx.repo()?, ctx.cancel());
    "countUncommittedChanges" => CountUncommittedChanges(UntrackedParams) -> usize = |ctx, p| {
        crate::read::status::count_changes(&*ctx.repo()?, p.include_untracked, ctx.cancel())
    };

    /* ---------- Commits ---------- */

    "commitDetails" => CommitDetails(HashParams) -> GitCommitDetails = |ctx, p| crate::read::details::commit_details(&*ctx.repo()?, &p.hash);
    "commitBodies" => CommitBodies(HashesParams) -> BTreeMap<String, String> = |ctx, p| crate::read::details::commit_bodies(&*ctx.repo()?, &p.hashes);
    "commitSubject" => CommitSubject(HashParams) -> String = |ctx, p| crate::read::details::commit_subject(&*ctx.repo()?, &p.hash);
    "commitSummaries" => CommitSummaries(HashesParams) -> BTreeMap<String, GitCommitSummary> = |ctx, p| {
        crate::read::details::commit_summaries(&*ctx.repo()?, &p.hashes)
    };
    "tagDetails" => TagDetails(TagParams) -> GitTagDetails = |ctx, p| crate::read::details::tag_details(&*ctx.repo()?, &p.tag_name);
    "stashDetails" => StashDetails(StashParams) -> GitCommitDetails = |ctx, p| crate::read::details::stash_details(&*ctx.repo()?, &p.hash, &p.stash);
    /// The "Uncommitted Changes" row in full.
    "uncommittedDetails" => UncommittedDetails(NoParams) -> GitCommitDetails = |ctx, _| crate::read::details::uncommitted_details(&*ctx.repo()?, ctx.cancel());

    /* ---------- Diffs and files ---------- */

    /// The files that differ between two revisions; `to` may be `*` for the working tree.
    "compareCommits" => CompareCommits(TwoRevisionsParams) -> Vec<GitFileChange> = |ctx, p| {
        crate::read::diff::diff_revisions(&*ctx.repo()?, &p.from, &p.to)
    };
    /// The `+N/-M` counts of the given paths; `from: null` diffs `to` against its first parent.
    "lineCounts" => LineCounts(LineCountsParams) -> BTreeMap<String, GitLineCounts> = |ctx, p| {
        crate::read::diff::line_counts(&*ctx.repo()?, p.from.as_deref(), &p.to, &p.paths)
    };
    "newPathOfRenamedFile" => NewPathOfRenamedFile(RenamedFileParams) -> Option<String> = |ctx, p| {
        crate::read::diff::new_path_of_renamed_file(&*ctx.repo()?, &p.commit_hash, &p.old_file_path)
    };
    /// A file's text at a revision: a commit-ish, `:index` for the staged copy or `*` for the
    /// working tree. Binary or non-UTF-8 files answer `contents: null`.
    "fileContents" => FileContents(FileParams) -> CommitFile = |ctx, p| file_contents(&*ctx.repo()?, &p.revision, &p.path);
    /// The unified diff of one file in one commit, against its first parent.
    "fileDiff" => FileDiff(FileParams) -> String = |ctx, p| crate::read::blob::commit_file_diff(&*ctx.repo()?, &p.revision, &p.path);

    /* ---------- Stashes, configuration, statistics, history ---------- */

    "stashes" => Stashes(NoParams) -> Vec<GitStash> = |ctx, _| crate::read::stash::read_stashes(&*ctx.repo()?);
    "config" => Config(NoParams) -> ConfigSnapshot = |ctx, _| crate::read::config::read_config(&*ctx.repo()?);
    "configList" => ConfigList(ConfigListParams) -> BTreeMap<String, String> = |ctx, p| {
        let location = if p.local { crate::read::config::ConfigLocation::Local } else { crate::read::config::ConfigLocation::Global };
        crate::read::config::config_list(&*ctx.repo()?, location)
    };
    "remoteUrl" => RemoteUrl(RemoteParams) -> Option<String> = |ctx, p| crate::read::config::remote_url(&*ctx.repo()?, &p.remote);
    "remoteNames" => RemoteNames(NoParams) -> Vec<String> = |ctx, _| crate::read::config::remote_names(&*ctx.repo()?);
    "submodules" => Submodules(NoParams) -> Vec<String> = |ctx, _| crate::read::config::submodules(&*ctx.repo()?);
    "currentBranchName" => CurrentBranchName(NoParams) -> Option<String> = |ctx, _| crate::read::config::current_branch_name(&*ctx.repo()?);
    "currentBranchUpstream" => CurrentBranchUpstream(NoParams) -> Option<String> = |ctx, _| {
        crate::read::config::current_branch_upstream(&*ctx.repo()?)
    };
    /// Commit messages matching a pattern, newest first (`git log --all -E -i --grep`).
    "searchHistory" => SearchHistory(SearchParams) -> Vec<GitHistoryMatch> = |ctx, p| crate::read::log::search_history(&*ctx.repo()?, &p.query, ctx.cancel());
    "authors" => Authors(NoParams) -> Vec<GitAuthor> = |ctx, _| crate::read::log::authors(&*ctx.repo()?, ctx.cancel());
    "authorStats" => AuthorStats(NoParams) -> Vec<GitAuthorStat> = |ctx, _| crate::read::stats::author_stats(&*ctx.repo()?, ctx.cancel());
    "activityHeatmap" => ActivityHeatmap(NoParams) -> Vec<GitActivityCell> = |ctx, _| crate::read::stats::activity_heatmap(&*ctx.repo()?, ctx.cancel());
    /// How many commits of the shown refs precede `hash` (`git rev-list --count`).
    "countCommitsBefore" => CountCommitsBefore(CountBeforeParams) -> u64 = |ctx, p| {
        crate::read::log::count_commits_before(&*ctx.repo()?, p.branches.as_deref(), &p.hash, p.show_remote_branches, p.include_reflogs, ctx.cancel())
    };

    /* ---------- Gerrit ---------- */

    "parseGerritMetas" => ParseGerritMetas(GerritMetasParams) -> Vec<Option<GerritChangeState>> = |ctx, p| {
        crate::read::gerrit::parse_gerrit_metas(&*ctx.repo()?, &p.remote, &p.changes, p.url_base.as_deref())
    };
    /// `(change ref, hash)` pairs below the remote's `changes/` namespace.
    "listChangeRefs" => ListChangeRefs(RemoteParams) -> Vec<(String, String)> = |ctx, p| crate::read::gerrit::list_change_refs(&*ctx.repo()?, &p.remote);
}

/// Answer one JSON request against the repository containing `repo_path`.
///
/// Never fails and never panics: every failure — malformed JSON, an unknown method, parameters
/// that do not fit, a repository that cannot be opened, a panic inside the engine — is the
/// envelope `{"error": {"kind", "message"}}`. The request runs uncancellable; a host that wants to
/// cancel it names it with [`request_with_id`].
pub fn request(repo_path: &str, request_json: &str) -> String {
    answer(repo_path, request_json, Cancel::none())
}

/// Answer one JSON request the host can cancel by its request id (task 2.9).
///
/// The id is registered for the duration of the call — the Node binding's `cancel(requestId)`
/// flips the flag from any thread, and the loops inside the traversal, status, statistics and
/// history-search handlers unwind with `{"error": {"kind": "cancelled", …}}` at their next
/// checkpoint. A cancellation that arrives before this call is honored just the same. The entry
/// and its answer are exactly [`request`]'s otherwise.
pub fn request_with_id(repo_path: &str, request_json: &str, request_id: u32) -> String {
    let guard = Registry::global().register(request_id);
    answer(repo_path, request_json, guard.token())
}

fn answer(repo_path: &str, request_json: &str, cancel: Cancel) -> String {
    // A request whose cancellation raced ahead of it answers Cancelled without touching the
    // repository: its answer is already unwanted, whatever the repository would say.
    let outcome = if cancel.is_cancelled() {
        Err(Error::cancelled())
    } else {
        catch_unwind(AssertUnwindSafe(|| {
            decode_request(request_json)
                .and_then(|request| request.answer(&Context { repo_path, cancel }))
        }))
        .unwrap_or_else(|panic| Err(Error::internal(panic_message(&panic))))
    };
    let envelope = match outcome {
        Ok(value) => serde_json::json!({ "ok": value }),
        Err(error) => serde_json::json!({ "error": error }),
    };
    envelope.to_string()
}

/// Decode `{"method", "params"}`. An unknown method is `Unsupported` — an engine older than the
/// host simply lacks it, and the host falls back to the `git` CLI — while known-method parameters
/// that do not fit are `InvalidArgument`: the two sides disagree about the contract, a bug.
pub fn decode_request(request_json: &str) -> Result<Request> {
    let mut value: Value = serde_json::from_str(request_json)
        .map_err(|error| Error::invalid_argument(format!("invalid request JSON: {error}")))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| Error::invalid_argument("a request is a JSON object"))?;
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !METHODS.contains(&method.as_str()) {
        return Err(Error::unsupported(format!("unsupported method: {method}")));
    }
    if object.get("params").is_none_or(Value::is_null) {
        object.insert("params".into(), Value::Object(Default::default()));
    }
    serde_json::from_value(value).map_err(|error| {
        Error::invalid_argument(format!(
            "{method}: could not decode the parameters: {error}"
        ))
    })
}

/// A file's raw bytes at one revision (a commit-ish, or `:index` for the staged copy), or `None`
/// when the path does not exist there. The binary channel: the Node binding hands the bytes to
/// JavaScript as a `Buffer`, never through a text encoding.
pub fn file_bytes(repo_path: &str, revision: &str, path: &str) -> Result<Option<Vec<u8>>> {
    file_bytes_answer(repo_path, revision, path, Cancel::none())
}

/// [`file_bytes`], named by a request id the host can cancel through. A single blob read has no
/// loop to unwind mid-flight, but a cancellation that raced ahead of the read is honored rather
/// than answered with bytes nobody is waiting for any more.
pub fn file_bytes_with_id(
    repo_path: &str,
    revision: &str,
    path: &str,
    request_id: u32,
) -> Result<Option<Vec<u8>>> {
    let guard = Registry::global().register(request_id);
    file_bytes_answer(repo_path, revision, path, guard.token())
}

fn file_bytes_answer(
    repo_path: &str,
    revision: &str,
    path: &str,
    cancel: Cancel,
) -> Result<Option<Vec<u8>>> {
    if cancel.is_cancelled() {
        return Err(Error::cancelled());
    }
    catch_unwind(AssertUnwindSafe(|| {
        let repo = RepoManager::global().get(repo_path)?;
        if revision == crate::engine::INDEX {
            crate::read::blob::index_file_bytes(&repo, path)
        } else {
            crate::read::blob::commit_file_bytes(&repo, revision, path)
        }
    }))
    .unwrap_or_else(|panic| Err(Error::internal(panic_message(&panic))))
}

fn file_contents(repo: &Repo, revision: &str, path: &str) -> Result<CommitFile> {
    if revision == crate::engine::WORKING_TREE {
        let bytes = std::fs::read(repo.root().join(path))
            .map_err(|e| Error::git(format!("{path}: {e}")))?;
        let contents = String::from_utf8(bytes).ok();
        let binary = match &contents {
            None => true,
            Some(text) => text.as_bytes()[..text.len().min(8000)].contains(&0),
        };
        return Ok(CommitFile {
            contents: if binary { None } else { contents },
            binary,
        });
    }
    if revision == crate::engine::INDEX {
        return crate::read::blob::index_file(repo, path);
    }
    crate::read::blob::commit_file(repo, revision, path)
}

/// Serialise an engine answer. The engine's own types cannot fail to serialise, but a failure
/// would mean the host silently rendered nothing, so it is reported rather than swallowed.
fn encode<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value)
        .map_err(|error| Error::internal(format!("could not encode the response: {error}")))
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    let detail = panic
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into());
    format!("the engine panicked: {detail}")
}

/* ---------- TypeScript generation ---------- */

// Type declarations are emitted sorted by name, so regeneration is deterministic across rebuilds.
const GENERATED_HEADER: &str = "// @generated by native/core (protocol::typescript) — do not edit.\n// Regenerate with `cargo test -p git-graph-core --test protocol`.\n/* eslint-disable */";

/// Integers are JSON numbers on the wire and `JSON.parse` yields `number`, never `bigint`.
fn typescript_config() -> Config {
    Config::new().with_large_int("number")
}

/// Every named type reachable from the protocol's parameters and results, declared once each.
/// The output is keyed by the type's TypeScript name and emitted sorted by it, because the
/// visitor's traversal order is fixed per compilation (see `typescript`).
#[derive(Default)]
struct Declarations {
    seen: Vec<std::any::TypeId>,
    output: BTreeMap<String, String>,
}

impl Declarations {
    fn visit_root<T: TS + 'static + ?Sized>(&mut self, config: &Config) {
        let mut visitor = Visitor {
            config,
            declarations: self,
        };
        visitor.visit::<T>();
    }
}

struct Visitor<'a> {
    config: &'a Config,
    declarations: &'a mut Declarations,
}

impl TypeVisitor for Visitor<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        let named = <T as TS>::output_path().is_some();
        if named {
            let id = std::any::TypeId::of::<T>();
            if self.declarations.seen.contains(&id) {
                return;
            }
            self.declarations.seen.push(id);
        }
        <T as TS>::visit_dependencies(self);
        <T as TS>::visit_generics(self);
        if named {
            let docs = <T as TS>::docs().unwrap_or_default();
            self.declarations.output.insert(
                <T as TS>::name(self.config).to_string(),
                format!("{docs}export {}", <T as TS>::decl(self.config)),
            );
        }
    }
}

/// Where `cargo test` writes the generated module, relative to the repository root.
pub fn typescript_output_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/shared/engine/protocol.ts")
}

/* ---------- Parameter shapes ----------
One struct per method shape, camelCase on the wire. Required fields carry no default, so an
omitted one is a decode error naming the method rather than a confusing engine answer later. */

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HashParams {
    pub hash: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HashesParams {
    pub hashes: Vec<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TagParams {
    pub tag_name: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StashParams {
    pub hash: String,
    pub stash: GitCommitStash,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TwoRevisionsParams {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LineCountsParams {
    pub from: Option<String>,
    pub to: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenamedFileParams {
    pub commit_hash: String,
    pub old_file_path: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileParams {
    pub revision: String,
    pub path: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UntrackedParams {
    pub include_untracked: bool,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigListParams {
    pub local: bool,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteParams {
    pub remote: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CountBeforeParams {
    pub branches: Option<Vec<String>>,
    pub hash: String,
    pub show_remote_branches: bool,
    pub include_reflogs: bool,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GerritMetasParams {
    pub remote: String,
    pub changes: Vec<i64>,
    pub url_base: Option<String>,
}
