//! Gerrit NoteDb meta histories, parsed in one in-process pass.
//!
//! A Gerrit repository under the view's "Fetch change refs" setting holds a NoteDb *meta* ref for
//! every fetched change — a linear chain of commits whose messages record the change's review
//! events (uploads, votes, status transitions). Turning those into the states the badges and the
//! review dialog show is pure parsing over the object database, which is exactly what the engine
//! is for: one native call reads every requested history from the warm repository handle, where
//! the previous implementation spawned one `git log` per change and dominated the view's load time
//! on large Gerrit repositories.
//!
//! The message grammar itself is Gerrit's, not ours: subjects like "Uploaded patch set 2" and
//! "Patch Set 3: Code-Review+2" with `Patch-set:`/`Status:`/`Commit:`/`Label:` footers. The
//! classification below is a faithful port of the parser that ran on the extension host (see
//! `src/gerrit.ts`), case for case, so the two agree on every record shape Gerrit writes — the
//! differential tests pin that.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use crate::error::{Result, ResultExt};
use crate::repository::Repo;
use crate::types::{GerritChangeEvent, GerritChangeState, GerritVote};

/// One commit of a NoteDb meta history: who acted, when, and the verbatim message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaCommitRecord {
    /// The Gerrit user that performed the action (e.g. "Gerrit User 1000018").
    pub committer: String,
    /// The commit timestamp, in seconds since the Unix epoch.
    pub timestamp: i64,
    /// The full commit message.
    pub message: String,
}

/// A meta commit parsed into an event plus the state transitions it carries.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMetaCommit {
    pub event: GerritChangeEvent,
    pub patchset: u32,
    pub status: Option<&'static str>,
    pub wip: Option<bool>,
    pub commit_hash: Option<String>,
}

/// Parse the NoteDb meta histories of the given changes into their states, in one pass.
///
/// The result is aligned with `changes`: an entry is `None` when the change's meta ref is not
/// available locally (never fetched, or pruned). `url_base`, when given, is prefixed onto each
/// change number to produce the state's web URL, so the states arrive complete.
pub fn parse_gerrit_metas(
    repo: &Repo,
    remote: &str,
    changes: &[i64],
    url_base: Option<&str>,
) -> Result<Vec<Option<GerritChangeState>>> {
    let git = repo.borrow();
    let mut states = Vec::with_capacity(changes.len());
    for &change in changes {
        // A change number comes from the extension's own ref parsing, so a non-positive one can
        // only be a bug on the other side of the boundary — answered with "no meta" rather than a
        // malformed ref lookup.
        if change <= 0 {
            states.push(None);
            continue;
        }
        let meta_ref = format!(
            "refs/remotes/{remote}/changes/{:02}/{change}/meta",
            change % 100
        );
        let records = read_meta_history(&git, &meta_ref)?;
        let state = parse_meta_history(change as u64, &records).map(|mut state| {
            state.url = url_base.map(|base| format!("{base}{change}"));
            state
        });
        states.push(state);
    }
    Ok(states)
}

/// The local change refs of a remote (`refs/remotes/<remote>/changes/**`), each with the hash it
/// points at, read in one in-process scan of the ref store.
///
/// This is the engine counterpart of `git for-each-ref refs/remotes/<remote>/changes/`, which the
/// Gerrit integration runs both to list the locally cached changes (the offline cache rebuild, and
/// the "ls-remote returned nothing" unreachable-remote check) and to resolve every NoteDb meta ref
/// hash in bulk — each use costing one child process on the extension host otherwise.
///
/// Symbolic refs under the prefix are skipped: change refs are always direct, and the common
/// symbolic ref of a remote (`refs/remotes/<remote>/HEAD`) lives outside the `changes/` tree.
pub fn list_change_refs(repo: &Repo, remote: &str) -> Result<Vec<(String, String)>> {
    let git = repo.borrow();
    let prefix = format!("refs/remotes/{remote}/changes/");
    let platform = git.references().git_ctx("Could not read references")?;
    let mut refs = Vec::new();
    for reference in platform
        .prefixed(prefix.as_str())
        .git_ctx("Could not read the Gerrit change refs")?
        .filter_map(std::result::Result::ok)
    {
        if let gix::refs::TargetRef::Object(id) = reference.target() {
            refs.push((reference.name().as_bstr().to_string(), id.to_string()));
        }
    }
    Ok(refs)
}

/// Read one NoteDb meta history, newest first, as `git log <meta-ref>` would print it.
///
/// NoteDb histories are linear chains Gerrit appends to, so the history is walked parent by
/// parent rather than through a commit-time-sorted queue: a chain whose commits share a timestamp
/// (a fixture, or a fast Gerrit) must still come out child-first, exactly as `git log` orders a
/// linear history — the parser's "newest record wins" rules depend on that order.
///
/// A missing ref yields an empty history (the caller treats the change as having no local meta).
fn read_meta_history(git: &gix::Repository, meta_ref: &str) -> Result<Vec<MetaCommitRecord>> {
    let Some(mut reference) = git
        .try_find_reference(meta_ref)
        .git_ctx("Could not read the NoteDb meta ref")?
    else {
        return Ok(Vec::new());
    };
    let mut id = reference
        .peel_to_id()
        .git_ctx("Could not resolve the NoteDb meta ref")?
        .detach();

    let mut records = Vec::new();
    loop {
        // A missing object (a shallow clone's boundary) truncates the history rather than failing
        // the whole parse; so does a meta ref that points at something other than a commit.
        let Ok(commit) = git.find_commit(id) else {
            break;
        };
        let committer = commit
            .committer()
            .git_ctx("Could not decode the meta commit committer")?;
        let message = commit
            .message_raw()
            .git_ctx("Could not decode the meta commit message")?;
        records.push(MetaCommitRecord {
            committer: committer.name.to_string(),
            timestamp: committer.time().map(|time| time.seconds).unwrap_or(0),
            message: message.to_string(),
        });
        let parent = commit.parent_ids().next().map(|parent| parent.detach());
        match parent {
            Some(parent) => id = parent,
            None => break,
        }
    }
    Ok(records)
}

/* ---------- The NoteDb message grammar ---------- */

/// Parse a single NoteDb meta commit message into an event plus its state fields.
///
/// Returns `None` when the message is not a recognised review event.
pub fn parse_meta_commit(record: &MetaCommitRecord) -> Option<ParsedMetaCommit> {
    let message = &record.message;
    let lines = split_lines(message);
    let header = lines.first().copied().unwrap_or("").trim();

    let mut parsed = ParsedMetaCommit {
        event: GerritChangeEvent {
            kind: "comment".to_string(),
            patchset: 0,
            reviewer: Some(record.committer.clone()),
            labels: None,
            timestamp: record.timestamp,
            raw: header.to_string(),
            raw_full: message.clone(),
        },
        patchset: 0,
        status: None,
        wip: None,
        commit_hash: None,
    };

    // Footer fields (NoteDb metas use "Key: value" lines, often in a trailer block)
    for line in &lines {
        let line = line.trim();
        if let Some(m) = regex_patch_set_footer().captures(line) {
            parsed.patchset = parse_u32(&m[1]);
        }
        if let Some(m) = regex_status_footer().captures(line) {
            parsed.status = Some(match &m[1] {
                "new" => "new",
                "merged" => "merged",
                _ => "abandoned",
            });
        }
        if let Some(m) = regex_commit_footer().captures(line) {
            parsed.commit_hash = Some(m[1].to_string());
        }
        if let Some(m) = regex_wip_footer().captures(line) {
            parsed.wip = Some(&m[1] == "true");
        }
    }

    let mut header_patchset: Option<u32> = None;
    if let Some(m) = regex_uploaded_header().captures(header) {
        header_patchset = Some(parse_u32(&m[1]));
    }
    if let Some(m) = regex_patch_set_header().captures(header) {
        header_patchset = Some(parse_u32(&m[1]));
    }
    if let Some(patchset) = header_patchset {
        parsed.patchset = patchset;
    }

    // Submit events: Gerrit writes "Change has been successfully merged by <name>" into the BODY of
    // the meta commit (its subject is usually just "Update patch set N"), so scan every line for it
    let mut merged_by: Option<String> = None;
    for line in &lines {
        if let Some(m) = regex_merged_by().captures(line.trim()) {
            merged_by = Some(m[1].trim().to_string());
            break;
        }
    }

    // Labels (votes): "Label: Code-Review=+2" footers, and/or "Patch Set N: Code-Review+2" headers
    let mut labels: Vec<GerritVote> = Vec::new();
    for m in regex_label_footer().captures_iter(message) {
        labels.push(GerritVote {
            name: m[1].to_string(),
            value: m[2].parse().unwrap_or(0),
        });
    }
    if let Some(m) = regex_header_vote().captures(header) {
        let name = m[1].to_string();
        if !labels.iter().any(|label| label.name == name) {
            labels.push(GerritVote {
                name,
                value: m[2].parse().unwrap_or(0),
            });
        }
    }

    if !labels.is_empty() {
        parsed.event.kind = "vote".to_string();
        parsed.event.labels = Some(labels);
    } else if regex_create_change().is_match(header) {
        parsed.event.kind = "created".to_string();
        parsed.event.patchset = 1;
        parsed.patchset = 1;
    } else if regex_start_wip().is_match(header) {
        // The WIP shapes of an upload must be classified before the generic "Uploaded patch set"
        // one, which would otherwise swallow them (the WIP flag itself comes from the footer).
        parsed.event.kind = "wip".to_string();
        parsed.wip = Some(true);
    } else if regex_uploaded().is_match(header) {
        parsed.event.kind = "patchset".to_string();
    } else if regex_merged_header().is_match(header) || parsed.status == Some("merged") {
        parsed.event.kind = "merged".to_string();
        parsed.status = Some("merged");
    } else if regex_abandoned().is_match(header) || parsed.status == Some("abandoned") {
        parsed.event.kind = "abandoned".to_string();
        parsed.status = Some("abandoned");
    } else if regex_restored().is_match(header)
        || regex_restored_exact().is_match(header)
        || (parsed.status == Some("new") && regex_unabor().is_match(header))
    {
        parsed.event.kind = "restored".to_string();
        parsed.status = Some("new");
    } else if parsed.wip == Some(true) {
        // A WIP transition carried only by the footer of an otherwise generic record
        parsed.event.kind = "wip".to_string();
    } else if regex_ready().is_match(header) {
        parsed.event.kind = "ready".to_string();
        parsed.wip = Some(false);
    } else if regex_rebase().is_match(header)
        || regex_patch_set_rebase().is_match(header)
        || regex_uploaded_any().is_match(header)
    {
        parsed.event.kind = "patchset".to_string();
    } else if header.is_empty()
        && lines
            .iter()
            .all(|line| regex_footer_like().is_match(line.trim()))
    {
        return None; // not a recognised review event
    }

    // Resolve the submitter of a merge: prefer the name from the "Change has been successfully ...
    // by <name>" line (usually in the body rather than the subject), then the "Submitted-by: Name
    // <email>" footer, and only then the (often anonymous) meta commit committer. Applies to vote
    // commits that Gerrit batched with the submit into a single meta commit as well, so they show
    // the submitter.
    if let Some(merged_by) = merged_by {
        parsed.event.reviewer = Some(merged_by);
    } else if parsed.event.kind == "merged" {
        if let Some(m) = regex_submitted_by().captures(message) {
            parsed.event.reviewer = Some(m[1].trim().to_string());
        }
    }

    parsed.event.patchset = parsed.patchset;
    if parsed.patchset == 0 {
        return None;
    }
    Some(parsed)
}

/// Parse the full NoteDb meta history of a change into its state.
///
/// `records` are newest first, as the history walk and `git log` produce them.
pub fn parse_meta_history(change: u64, records: &[MetaCommitRecord]) -> Option<GerritChangeState> {
    if records.is_empty() {
        return None;
    }

    let mut events: Vec<GerritChangeEvent> = Vec::new();
    let mut status = "new";
    let mut wip = false;
    let mut latest_patchset = 0;
    let mut status_determined = false;
    let mut wip_determined = false;
    // The vote values per label, in the order the (newest-first) records carry them.
    let mut cr_votes: Vec<i32> = Vec::new();
    let mut v_votes: Vec<i32> = Vec::new();
    // The first-seen (i.e. newest) `Commit:` hash of each patchset. The head hash cannot be picked
    // in passing: a record referencing an OLDER patchset (a late vote on it) can be newer than the
    // latest patchset's upload, and must not win over the latest patchset's own hash.
    let mut commit_by_patchset: HashMap<u32, String> = HashMap::new();

    for record in records {
        let Some(parsed) = parse_meta_commit(record) else {
            continue;
        };

        if parsed.patchset > latest_patchset {
            latest_patchset = parsed.patchset;
        }
        // Records are iterated newest first: the first (i.e. most recent) status/wip transition wins
        if let Some(parsed_status) = parsed.status {
            if !status_determined {
                status = parsed_status;
                status_determined = true;
            }
        }
        if let Some(parsed_wip) = parsed.wip {
            if !wip_determined {
                wip = parsed_wip;
                wip_determined = true;
            }
        }
        if let Some(hash) = parsed.commit_hash {
            commit_by_patchset.entry(parsed.patchset).or_insert(hash);
        }
        if parsed.event.kind == "vote" {
            if let Some(labels) = &parsed.event.labels {
                for label in labels {
                    if label.name == "Code-Review" {
                        cr_votes.push(label.value);
                    } else if label.name == "Verified" {
                        v_votes.push(label.value);
                    }
                }
            }
        }
        events.push(parsed.event);
    }

    // The head hash of the change is the newest `Commit:` referencing the latest patchset.
    let head_hash = match commit_by_patchset.get(&latest_patchset) {
        Some(hash) => hash.clone(),
        None => {
            // Fall back to any commit hash found in the history
            let mut fallback = None;
            for record in records {
                if let Some(m) = regex_commit_multiline().captures(&record.message) {
                    fallback = Some(m[1].to_string());
                    break;
                }
            }
            fallback?
        }
    };

    Some(GerritChangeState {
        change,
        patchset: latest_patchset,
        code_review: strongest_vote(&cr_votes),
        verified: strongest_vote(&v_votes),
        status: status.to_string(),
        wip,
        head_hash,
        events,
        url: None,
    })
}

/// The strongest vote of one label: the value with the greatest absolute value (ties broken by
/// recency, so the first seen wins — the values are newest first).
fn strongest_vote(values: &[i32]) -> i32 {
    let mut best: i32 = 0;
    for &value in values {
        if value.abs() > best.abs() {
            best = value;
        }
    }
    best
}

/// Split a message the way the JavaScript parser's `/\r?\n/` does (CRLF and LF, not a lone CR).
fn split_lines(message: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut rest = message;
    while let Some(index) = rest.find('\n') {
        let mut line = &rest[..index];
        if line.ends_with('\r') {
            line = &line[..line.len() - 1];
        }
        lines.push(line);
        rest = &rest[index + 1..];
    }
    lines.push(rest);
    lines
}

/// `parseInt` of the grammar's digits: always well-formed, defaulting to 0 the way `NaN → 0` did.
fn parse_u32(value: &str) -> u32 {
    value.parse().unwrap_or(0)
}

/* The grammar's patterns, each matching its counterpart in src/gerrit.ts exactly. */

macro_rules! grammar_regex {
    ($fn_name:ident, $pattern:expr) => {
        fn $fn_name() -> &'static Regex {
            static REGEX: OnceLock<Regex> = OnceLock::new();
            REGEX
                .get_or_init(|| Regex::new($pattern).expect("a static grammar pattern cannot fail"))
        }
    };
}

grammar_regex!(regex_patch_set_footer, r"^Patch-set:\s*(\d+)\s*$");
grammar_regex!(
    regex_status_footer,
    r"^Status:\s*(new|merged|abandoned)\s*$"
);
grammar_regex!(regex_commit_footer, r"^Commit:\s*([0-9a-f]{4,40})\s*$");
grammar_regex!(regex_wip_footer, r"^Work-in-progress:\s*(true|false)\s*$");
grammar_regex!(regex_uploaded_header, r"^Uploaded patch set (\d+)\.");
grammar_regex!(regex_patch_set_header, r"^Patch Set (\d+):");
grammar_regex!(
    regex_merged_by,
    r"^Change has been successfully (?:merged|cherry-picked|pushed)(?:\s+as\s+[0-9a-f]{4,40})?\s+by\s+(.+?)(?:\s*<[^>]*>)?\s*$"
);
grammar_regex!(
    regex_label_footer,
    r"(?m)^Label: ([A-Za-z0-9-]+)\s*=\s*([+-]?\d+)\s*$"
);
grammar_regex!(
    regex_header_vote,
    r"^Patch Set \d+:.*?\b([A-Za-z][A-Za-z0-9-]*)\s+([+-]\d)\b"
);
grammar_regex!(regex_create_change, r"^Create change");
grammar_regex!(
    regex_start_wip,
    r"^Start Work In Progress|^Uploaded patch set \d+ \(WIP\)"
);
grammar_regex!(regex_uploaded, r"^Uploaded patch set \d+");
grammar_regex!(
    regex_merged_header,
    r"^Change has been successfully (merged|cherry-picked|pushed)"
);
grammar_regex!(regex_abandoned, r"^Abandoned$");
grammar_regex!(regex_restored, r"Restore(d| Ready for Review)?$");
grammar_regex!(regex_restored_exact, r"^Restored$");
grammar_regex!(regex_unabor, r"^Unabor");
grammar_regex!(
    regex_ready,
    r"Restore Ready for Review|^Remove WIP|^Ready for review change"
);
grammar_regex!(regex_rebase, r"^Rebase");
grammar_regex!(regex_patch_set_rebase, r"^Patch Set \d+: Rebase");
grammar_regex!(regex_uploaded_any, r"^Uploaded patch set");
grammar_regex!(regex_footer_like, r"^[A-Za-z-]+:");
grammar_regex!(
    regex_submitted_by,
    r"(?m)^Submitted-by:\s*([^<]+?)(?:\s*<[^>]*>)?\s*$"
);
grammar_regex!(
    regex_commit_multiline,
    r"(?m)^Commit:\s*([0-9a-f]{4,40})\s*$"
);
