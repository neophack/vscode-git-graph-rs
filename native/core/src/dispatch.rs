//! The engine's whole read surface behind one call: a JSON request in, a JSON answer out.
//!
//! [`crate::api::Engine`] is the Rust-facing contract and `native/node`'s typed exports are the
//! extension's; this module is the seam for every front end that wants the full surface without
//! a binding per method — the Node addon's single `request` export, a REPL or a
//! debugger probe. One table routes every method, so the front ends
//! cannot drift: a method added here is callable from all of them at once.
//!
//! A request is `{"method": "loadCommits", "params": {…}}`; the answer is the method's own JSON
//! document. Failures ride in-band as `{"error": "Kind: message"}` — the same prefixed kinds the
//! typed boundaries throw ([`Error::with_kind_prefix`]) — so a caller's failure path is one
//! parse, not a throwing ABI, and a repository that cannot be opened answers instead of
//! crashing the host. A missing or `null` params object means "the defaults".
//!
//! Lifecycle rides the same table: `open` answers the repository root (creating the warm handle
//! on the way), `close` drops one handle, `closeAll` drops every one, `openCount` counts them,
//! `engineVersion` names the engine, `repoRoot` answers without keeping a handle. Every other
//! method shares the warm handle for its `repo` path — the same [`RepoManager`] the typed
//! boundaries use — and never writes: the engine's read-only rule holds here too.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::{Engine, GraphOptions};
use crate::error::{Error, Result};
use crate::types::{GitCommitStash, LogOptions, RefReadOptions};
use crate::RepoManager;

/// Answer one JSON request against the repository containing `repo_path` (any path inside the
/// working tree, like `git rev-parse --show-toplevel`).
///
/// Never fails: every failure — malformed request JSON, a method the table does not know,
/// parameters that do not fit, a repository that cannot be opened — is the answer
/// `{"error": "Kind: message"}`.
pub fn request(repo_path: &str, request: &str) -> String {
    let parsed: Value = match serde_json::from_str(request) {
        Ok(value) => value,
        Err(error) => {
            return answer_error(&Error::invalid_argument(format!(
                "invalid request JSON: {error}"
            )))
        }
    };
    let method = parsed
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = match parsed.get("params") {
        Some(params) if !params.is_null() => params.clone(),
        _ => json!({}),
    };
    match answer(repo_path, method, params) {
        Ok(value) => value.to_string(),
        Err(error) => answer_error(&error),
    }
}

/// Route one request to the engine. The whole single-interface surface is the arms of this
/// match, in the module groups the typed boundaries use.
fn answer(repo_path: &str, method: &str, params: Value) -> Result<Value> {
    /* The methods that answer before — or without — opening a handle. */
    match method {
        "engineVersion" => return Ok(json!(crate::VERSION)),
        "openCount" => return Ok(json!(RepoManager::global().open_count())),
        "closeAll" => {
            RepoManager::global().close_all();
            return Ok(Value::Null);
        }
        "repoRoot" => return Ok(json!(crate::repository::repo_root(repo_path)?)),
        _ => {}
    }
    let repo = RepoManager::global().get(repo_path)?;
    match method {
        "open" => Ok(json!({ "root": repo.root().display().to_string() })),
        "close" => {
            RepoManager::global().close(repo_path);
            Ok(Value::Null)
        }

        /* ---------- The graph and its refs ---------- */
        "graph" => {
            let options: GraphOptions = decode(method, params)?;
            respond(Engine::open(repo_path)?.graph(&options))
        }
        "info" => {
            let options: GraphOptions = decode(method, params)?;
            respond(Engine::open(repo_path)?.info(&options))
        }
        "refs" => {
            let options: GraphOptions = decode(method, params)?;
            respond(Engine::open(repo_path)?.refs(&options))
        }
        "status" => respond(crate::status::scm_changes(&repo)),
        "loadRepoInfo" => {
            let payload: RefOptionsPayload = decode(method, params)?;
            respond(crate::graph::repo_info(
                &repo,
                &payload.to_options(),
                payload.show_stashes,
            ))
        }
        "loadCommits" => {
            let options: LogOptions = decode(method, params)?;
            respond(crate::graph::load_commits(&repo, &options))
        }
        "loadRefs" => {
            let payload: RefOptionsPayload = decode(method, params)?;
            respond(
                crate::refs::read_refs(&repo, &payload.to_options())
                    .map(|snapshot| snapshot.ref_data),
            )
        }

        /* ---------- Commits ---------- */
        "loadCommitDetails" => {
            let request: CommitParams = decode(method, params)?;
            respond(crate::details::commit_details(&repo, &request.hash))
        }
        "loadCommitBodies" => {
            let request: HashesParams = decode(method, params)?;
            respond(crate::details::commit_bodies(&repo, &request.hashes))
        }
        "loadCommitSubject" => {
            let request: CommitParams = decode(method, params)?;
            respond(crate::details::commit_subject(&repo, &request.hash))
        }
        "loadCommitSummaries" => {
            let request: HashesParams = decode(method, params)?;
            respond(crate::details::commit_summaries(&repo, &request.hashes))
        }
        "loadTagDetails" => {
            let request: TagParams = decode(method, params)?;
            respond(crate::details::tag_details(&repo, &request.tag_name))
        }
        "loadStashDetails" => {
            let request: StashParams = decode(method, params)?;
            respond(crate::details::stash_details(
                &repo,
                &request.hash,
                &request.stash,
            ))
        }
        "loadUncommittedDetails" => respond(crate::details::uncommitted_details(&repo)),

        /* ---------- Diffs and files ---------- */
        "compareCommits" => {
            let request: TwoRevisionsParams = decode(method, params)?;
            respond(crate::diff::diff_revisions(
                &repo,
                &request.from,
                &request.to,
            ))
        }
        "loadLineCounts" => {
            let request: LineCountsParams = decode(method, params)?;
            respond(crate::diff::line_counts(
                &repo,
                request.from.as_deref(),
                &request.to,
                &request.paths,
            ))
        }
        "newPathOfRenamedFile" => {
            let request: RenamedFileParams = decode(method, params)?;
            respond(crate::diff::new_path_of_renamed_file(
                &repo,
                &request.commit_hash,
                &request.old_file_path,
            ))
        }
        "loadCommitFile" => {
            let request: CommitFileParams = decode(method, params)?;
            respond(crate::blob::commit_file(
                &repo,
                &request.commit_hash,
                &request.file,
            ))
        }
        "loadCommitFileDiff" => {
            let request: CommitFileParams = decode(method, params)?;
            respond(crate::blob::commit_file_diff(
                &repo,
                &request.commit_hash,
                &request.file,
            ))
        }

        /* ---------- The working tree ---------- */
        "countUncommittedChanges" => {
            let request: UntrackedParams = decode(method, params)?;
            respond(crate::status::count_changes(
                &repo,
                request.include_untracked,
            ))
        }

        /* ---------- Stashes, configuration, statistics, history ---------- */
        "loadStashes" => respond(crate::stash::read_stashes(&repo)),
        "loadConfig" => respond(crate::config::read_config(&repo)),
        "configList" => {
            let request: ConfigListParams = decode(method, params)?;
            respond(crate::config::config_list(
                &repo,
                if request.local {
                    crate::config::ConfigLocation::Local
                } else {
                    crate::config::ConfigLocation::Global
                },
            ))
        }
        "remoteUrl" => {
            let request: RemoteParams = decode(method, params)?;
            respond(crate::config::remote_url(&repo, &request.remote))
        }
        "remoteNames" => respond(crate::config::remote_names(&repo)),
        "submodules" => respond(crate::config::submodules(&repo)),
        "currentBranchName" => respond(crate::config::current_branch_name(&repo)),
        "currentBranchUpstream" => respond(crate::config::current_branch_upstream(&repo)),
        "searchHistory" => {
            let request: SearchParams = decode(method, params)?;
            respond(crate::log::search_history(&repo, &request.query))
        }
        "authors" => respond(crate::log::authors(&repo)),
        "authorStats" => respond(crate::stats::author_stats(&repo)),
        "activityHeatmap" => respond(crate::stats::activity_heatmap(&repo)),
        "countCommitsBefore" => {
            let request: CountBeforeParams = decode(method, params)?;
            respond(crate::log::count_commits_before(
                &repo,
                request.branches.as_deref(),
                &request.hash,
                request.show_remote_branches,
                request.include_reflogs,
            ))
        }

        /* ---------- Gerrit ---------- */
        "parseGerritMetas" => {
            let request: GerritMetasParams = decode(method, params)?;
            respond(crate::gerrit::parse_gerrit_metas(
                &repo,
                &request.remote,
                &request.changes,
                request.url_base.as_deref(),
            ))
        }
        "listChangeRefs" => {
            let request: RemoteParams = decode(method, params)?;
            respond(crate::gerrit::list_change_refs(&repo, &request.remote))
        }

        other => Err(Error::unsupported(format!("unsupported method: {other}"))),
    }
}

/// Decode one method's parameters, naming the method when they do not fit: a malformed request
/// is the two sides disagreeing about the contract — a bug, not a user error.
fn decode<T: DeserializeOwned>(method: &str, value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| {
        Error::invalid_argument(format!(
            "{method}: could not decode the parameters: {error}"
        ))
    })
}

/// Serialise an engine answer. The engine's own types cannot fail to serialise, but a failure
/// would mean the host silently rendered nothing, so it is reported rather than swallowed.
fn respond<T: Serialize>(answer: crate::error::Result<T>) -> Result<Value> {
    serde_json::to_value(answer?)
        .map_err(|error| Error::git(format!("could not encode the response: {error}")))
}

/// The in-band failure: the same `Kind: message` string a typed call throws, so both paths read
/// alike on the far side.
fn answer_error(error: &Error) -> String {
    json!({ "error": error.with_kind_prefix() }).to_string()
}

/// The wire form of the ref-reading options, plus the stash flag `loadRepoInfo` also needs.
///
/// Shared with the Node addon's typed exports, so the typed and single interfaces cannot drift.
/// The defaults are the ones a view load uses, so an omitted field means "the usual".
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RefOptionsPayload {
    pub show_remote_branches: bool,
    pub show_remote_heads: bool,
    pub hide_remotes: Vec<String>,
    pub show_change_refs: bool,
    pub show_stashes: bool,
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
    pub fn to_options(&self) -> RefReadOptions {
        RefReadOptions {
            show_remote_branches: self.show_remote_branches,
            show_remote_heads: self.show_remote_heads,
            hide_remotes: self.hide_remotes.clone(),
            show_change_refs: self.show_change_refs,
        }
    }
}

/* ---------- Parameter shapes ----------
One struct per method, named after its fields exactly as the typed exports take them
(camelCase on the wire). Required fields carry no default, so an omitted one is a decode
error naming the method rather than a confusing engine answer down the line. */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitParams {
    hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitFileParams {
    commit_hash: String,
    file: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashesParams {
    hashes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagParams {
    tag_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StashParams {
    hash: String,
    stash: GitCommitStash,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwoRevisionsParams {
    from: String,
    to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LineCountsParams {
    from: Option<String>,
    to: String,
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenamedFileParams {
    commit_hash: String,
    old_file_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UntrackedParams {
    include_untracked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigListParams {
    local: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteParams {
    remote: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountBeforeParams {
    branches: Option<Vec<String>>,
    hash: String,
    show_remote_branches: bool,
    include_reflogs: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GerritMetasParams {
    remote: String,
    changes: Vec<i64>,
    url_base: Option<String>,
}
