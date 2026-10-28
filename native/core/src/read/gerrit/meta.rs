//! Reading a `NoteDb` meta history and parsing each message through Gerrit's grammar.

use std::sync::OnceLock;

use regex::Regex;

use crate::error::{Result, ResultExt};
use crate::model::{GerritChangeEvent, GerritVote};

/// One commit of a `NoteDb` meta history: who acted, when, and the verbatim message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MetaCommitRecord {
    /// The Gerrit user that performed the action (e.g. "Gerrit User 1000018").
    pub committer: String,
    /// The commit timestamp, in seconds since the Unix epoch.
    pub timestamp: i64,
    /// The full commit message.
    pub message: String,
}

/// A meta commit parsed into an event plus the state transitions it carries.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ParsedMetaCommit {
    pub event: GerritChangeEvent,
    pub patchset: u32,
    pub status: Option<&'static str>,
    pub wip: Option<bool>,
    pub commit_hash: Option<String>,
}

/// Read one `NoteDb` meta history, newest first, as `git log <meta-ref>` would print it.
///
/// `NoteDb` histories are linear chains Gerrit appends to, so the history is walked parent by
/// parent rather than through a commit-time-sorted queue: a chain whose commits share a timestamp
/// (a fixture, or a fast Gerrit) must still come out child-first, exactly as `git log` orders a
/// linear history — the parser's "newest record wins" rules depend on that order.
///
/// A missing ref yields an empty history (the caller treats the change as having no local meta).
pub(super) fn read_meta_history(
    git: &gix::Repository,
    meta_ref: &str,
) -> Result<Vec<MetaCommitRecord>> {
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

/// Parse a single `NoteDb` meta commit message into an event plus its state fields.
///
/// Returns `None` when the message is not a recognised review event.
pub(crate) fn parse_meta_commit(record: &MetaCommitRecord) -> Option<ParsedMetaCommit> {
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
    } else if regex_ready().is_match(header) {
        // "Restore Ready for Review" readies the change in the same record that restores it, so
        // it must be classified BEFORE the plain "Restore" fallback — that branch's regex also
        // matches this header and would leave `wip` stuck at true, hiding the ready change.
        parsed.event.kind = "ready".to_string();
        parsed.wip = Some(false);
        if regex_restore_prefix().is_match(header) {
            parsed.status = Some("new");
        }
    } else if regex_restored().is_match(header)
        || regex_restored_exact().is_match(header)
        || (parsed.status == Some("new") && regex_unabor().is_match(header))
    {
        parsed.event.kind = "restored".to_string();
        parsed.status = Some("new");
    } else if parsed.wip == Some(true) {
        // A WIP transition carried only by the footer of an otherwise generic record
        parsed.event.kind = "wip".to_string();
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
        pub(super) fn $fn_name() -> &'static Regex {
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
// `(?m)` so the SAME pattern serves both the per-line footer scan here and the whole-message
// scan in state.rs (on a single line, the multi-line anchors behave exactly like plain ones).
grammar_regex!(regex_commit_footer, r"(?m)^Commit:\s*([0-9a-f]{4,40})\s*$");
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
    // `\s*` (not `\s+`): Gerrit writes the canonical header vote with NO space —
    // "Patch Set 2: Code-Review+2" — and a miss here degrades the record to a comment, so
    // every modern vote would silently vanish from the badges. Mirrors src/gerrit.ts.
    r"^Patch Set \d+:.*?\b([A-Za-z][A-Za-z0-9-]*)\s*([+-]\d)\b"
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
grammar_regex!(regex_restored, r"Restore(d)?$");
grammar_regex!(regex_restored_exact, r"^Restored$");
grammar_regex!(regex_unabor, r"^Unabor");
grammar_regex!(regex_restore_prefix, r"^Restore");
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
