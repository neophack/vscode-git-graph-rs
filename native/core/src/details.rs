//! The Commit Details view: one commit in full, with the files it changed.

use std::collections::BTreeMap;
use std::ops::Deref;

use crate::diff;
use crate::error::{Error, Result, ResultExt};
use crate::repository::Repo;
use crate::types::{
    GitCommitDetails, GitCommitStash, GitCommitSummary, GitFileStatus, GitSignature,
    GitSignatureStatus, GitTagDetails, UNCOMMITTED,
};

/// Read a commit in full, including the diff against its first parent.
pub fn commit_details(repo: &Repo, hash: &str) -> Result<GitCommitDetails> {
    let mut details = commit_details_base(repo, hash)?;
    details.file_changes = diff::diff_commit(repo, hash)?;
    Ok(details)
}

/// Read the commit's own fields, without touching its diff.
pub fn commit_details_base(repo: &Repo, hash: &str) -> Result<GitCommitDetails> {
    let id = repo.resolve_commit(hash)?;
    let git = repo.borrow();
    let commit = git.find_commit(id).git_ctx("Could not read the commit")?;

    let author = commit
        .author()
        .git_ctx("Could not decode the commit author")?;
    let committer = commit
        .committer()
        .git_ctx("Could not decode the commit committer")?;
    let body = commit
        .message_raw()
        .git_ctx("Could not decode the commit message")?;

    Ok(GitCommitDetails {
        hash: commit.id().detach().to_string(),
        parents: commit
            .parent_ids()
            .map(|parent| parent.detach().to_string())
            .collect(),
        author: author.name.to_string(),
        author_email: author.email.to_string(),
        author_date: author.time().map(|time| time.seconds).unwrap_or(0),
        committer: committer.name.to_string(),
        committer_email: committer.email.to_string(),
        committer_date: committer.time().map(|time| time.seconds).unwrap_or(0),
        signature: read_signature(&commit),
        body: body.to_string(),
        file_changes: Vec::new(),
    })
}

/// The details of a stash entry.
///
/// A stash is diffed against the commit it was taken from rather than against its own first
/// parent, and — when it was taken with `--include-untracked` — the files recorded in its third
/// parent are appended as untracked rather than as added.
pub fn stash_details(repo: &Repo, hash: &str, stash: &GitCommitStash) -> Result<GitCommitDetails> {
    let mut details = commit_details_base(repo, hash)?;

    let base = repo.resolve_commit(&stash.base_hash)?;
    let stash_id = repo.resolve_commit(hash)?;
    details.file_changes = diff::diff_commits(repo, Some(base), stash_id)?;

    if let Some(untracked) = &stash.untracked_files_hash {
        // The untracked-files commit holds them as a tree of its own, so they appear as additions
        // against the empty tree.
        if let Ok(untracked_id) = repo.resolve_commit(untracked) {
            for mut change in diff::diff_commits(repo, None, untracked_id)? {
                if change.kind == GitFileStatus::Added {
                    change.kind = GitFileStatus::Untracked;
                    details.file_changes.push(change);
                }
            }
        }
    }

    Ok(details)
}

/// The details of the "Uncommitted Changes" row.
///
/// There is no commit to read, so every field but the file list is empty — which is what the view
/// renders for it.
pub fn uncommitted_details(repo: &Repo) -> Result<GitCommitDetails> {
    Ok(GitCommitDetails {
        hash: UNCOMMITTED.to_string(),
        parents: Vec::new(),
        author: String::new(),
        author_email: String::new(),
        author_date: 0,
        committer: String::new(),
        committer_email: String::new(),
        committer_date: 0,
        signature: None,
        body: String::new(),
        file_changes: crate::status::uncommitted_changes(repo)?,
    })
}

/// Report whether a commit carries a signature.
///
/// ### Deviation
///
/// The signature is reported as present but **unverified**. Verifying it needs a full OpenPGP and
/// SSH signature implementation plus access to the user's keyring. The status reported is `E`
/// ("cannot be checked"), which is what git itself reports when the key is unavailable — rather
/// than claiming a signature is good without having checked it.
fn read_signature(commit: &gix::Commit<'_>) -> Option<GitSignature> {
    let (_signature, _signed_data) = commit.signature().ok().flatten()?;
    Some(unverified_signature())
}

/// The signature record for "a signature is present but was not checked", shared by commits and
/// tags. See [`read_signature`] for why it is never reported as valid.
fn unverified_signature() -> GitSignature {
    GitSignature {
        key: String::new(),
        signer: String::new(),
        status: GitSignatureStatus::CannotBeChecked,
    }
}

/* ---------- On-demand commit reads ---------- */

/// The full commit message of each of the given commits, keyed by hash.
///
/// The commit list only carries subjects (full bodies would dominate its output size on a large
/// repository), so the bodies are read when they are actually displayed — one engine call for the
/// whole batch, where the original spawned `git log --no-walk` and parsed separator-delimited
/// records.
///
/// A hash that does not resolve fails the whole call, matching `git log --no-walk <bad-hash>`.
pub fn commit_bodies(repo: &Repo, hashes: &[String]) -> Result<BTreeMap<String, String>> {
    let git = repo.borrow();
    let mut bodies = BTreeMap::new();
    for hash in hashes {
        let id = crate::repository::resolve_commit_in(&git, hash)?;
        let commit = git.find_commit(id).git_ctx("Could not read the commit")?;
        // git's `%B` ends with the message's trailing newline, which the caller strips; strip it
        // here so the two spellings of "the body" agree byte for byte.
        let body = commit
            .message_raw()
            .git_ctx("Could not decode the commit message")?
            .to_string();
        bodies.insert(commit.id().detach().to_string(), strip_one_newline(body));
    }
    Ok(bodies)
}

/// The subject of one commit, whitespace-normalised the way the original extension normalised
/// `git log --format=%s` output (trimmed, runs of whitespace collapsed to one space).
pub fn commit_subject(repo: &Repo, hash: &str) -> Result<String> {
    let git = repo.borrow();
    let id = crate::repository::resolve_commit_in(&git, hash)?;
    let commit = git.find_commit(id).git_ctx("Could not read the commit")?;
    let message = commit
        .message()
        .git_ctx("Could not decode the commit message")?;
    Ok(collapse_whitespace(message.summary().to_string()))
}

/// The summary of each of the given commits (author, email, author date, full message), keyed by
/// hash — what the Commit Comparison View titles its two sides with.
pub fn commit_summaries(
    repo: &Repo,
    hashes: &[String],
) -> Result<BTreeMap<String, GitCommitSummary>> {
    let git = repo.borrow();
    let mut summaries = BTreeMap::new();
    for hash in hashes {
        let id = crate::repository::resolve_commit_in(&git, hash)?;
        let commit = git.find_commit(id).git_ctx("Could not read the commit")?;
        let author = commit
            .author()
            .git_ctx("Could not decode the commit author")?;
        let message = commit
            .message_raw()
            .git_ctx("Could not decode the commit message")?
            .to_string();
        let summary = GitCommitSummary {
            hash: commit.id().detach().to_string(),
            author: author.name.to_string(),
            email: author.email.to_string(),
            date: author.time().map(|time| time.seconds).unwrap_or(0),
            // `git show --format=%B` output is trimmed before use.
            message: message.trim().to_string(),
        };
        summaries.insert(summary.hash.clone(), summary);
    }
    Ok(summaries)
}

/* ---------- Tag details ---------- */

/// A tag in full, for the Tag Details dialogue.
///
/// An annotated tag is read from its tag object (tagger, message, signature presence). A
/// lightweight tag has none of those: the hash is the tagged commit and the message is the
/// commit's — the fields `for-each-ref` fills in for a ref that points straight at a commit.
///
/// ### Deviation
///
/// As with commit signatures, a tag signature is reported as present but unverified (`E`) rather
/// than verified.
pub fn tag_details(repo: &Repo, tag_name: &str) -> Result<GitTagDetails> {
    if !is_safe_tag_name(tag_name) {
        return Err(Error::invalid_argument(format!(
            "Invalid tag name was provided: {tag_name}"
        )));
    }

    let git = repo.borrow();
    let full_name = format!("refs/tags/{tag_name}");
    let reference = git
        .find_reference(full_name.as_str())
        .map_err(|_| Error::not_found(format!("Could not find the tag {tag_name}")))?;
    // The ref's own target, unpeeled: an annotated tag names its tag object here, a lightweight
    // tag its commit, which is whose hash `for-each-ref %(objectname)` reports.
    let id = match reference.target() {
        gix::refs::TargetRef::Object(id) => id.to_owned(),
        gix::refs::TargetRef::Symbolic(_) => {
            return Err(Error::not_found(format!("The tag {tag_name} is symbolic")))
        }
    };

    let object = git
        .find_object(id)
        .git_ctx("Could not read the tagged object")?;
    let not_a_tag = || {
        Error::not_found(format!(
            "The tag {tag_name} does not point at a tag or a commit"
        ))
    };
    match object.kind {
        gix::object::Kind::Tag => {
            let tag = object.try_into_tag().map_err(|_| not_a_tag())?;
            let tag = tag.decode().git_ctx("Could not decode the tag object")?;
            let tagger = tag
                .tagger
                .map(|raw| gix::actor::SignatureRef::from_bytes(raw.deref()))
                .transpose()
                .map_err(|e| Error::git(format!("Could not decode the tagger: {e}")))?;
            Ok(GitTagDetails {
                hash: id.to_string(),
                tagger_name: tagger.map(|t| t.name.to_string()).unwrap_or_default(),
                tagger_email: tagger.map(|t| t.email.to_string()).unwrap_or_default(),
                tagger_date: tagger.map(|t| t.seconds()).unwrap_or(0),
                // The decoded message excludes the signature, which is what the message the
                // dialogue shows must exclude.
                message: strip_trailing_blank_lines(tag.message.to_string()),
                signature: tag.pgp_signature.map(|_| unverified_signature()),
            })
        }
        gix::object::Kind::Commit => {
            // A lightweight tag has no tag object: the fields `for-each-ref` fills in for a ref
            // that points straight at a commit are the commit's own.
            let commit = object.try_into_commit().map_err(|_| not_a_tag())?;
            let message = commit
                .message_raw()
                .git_ctx("Could not decode the commit message")?
                .to_string();
            Ok(GitTagDetails {
                hash: id.to_string(),
                tagger_name: String::new(),
                tagger_email: String::new(),
                tagger_date: 0,
                message: strip_trailing_blank_lines(message),
                signature: None,
            })
        }
        _ => Err(not_a_tag()),
    }
}

/// A tag name is the part of a refname below `refs/tags/`, and follows git's own
/// `check-ref-format` rules — which *allow* slashes (hierarchical names like `release/v1`), while
/// rejecting empty or dot-led components, `..`, `.lock` endings, the reserved characters, and a
/// leading `-` (which the caller could mistake for an option).
fn is_safe_tag_name(name: &str) -> bool {
    fn bad_component(component: &str) -> bool {
        component.is_empty() || component.starts_with('.') || component.ends_with(".lock")
    }
    !name.is_empty()
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains('\\')
        && !name.bytes().any(|b| {
            b < 0x20
                || b == 0x7f
                || b == b' '
                || b == b'~'
                || b == b'^'
                || b == b':'
                || b == b'?'
                || b == b'['
                || b == b'*'
        })
        && !name.split('/').any(bad_component)
}

fn strip_one_newline(mut body: String) -> String {
    // Only the final line break goes, exactly as the original's `replace(/\n$/, '')`; a `\r\n`
    // ending keeps its `\r`, as it did there.
    if body.ends_with('\n') {
        body.pop();
    }
    body
}

/// Remove the trailing blank lines of a message, as the original's tag-details parsing did before
/// handing the message to the dialogue.
fn strip_trailing_blank_lines(message: String) -> String {
    // Split the way the original's `EOL_REGEX` (`\r\n|\r|\n`) splits, drop the trailing empty
    // lines, and re-join with plain newlines.
    let mut lines: Vec<&str> = message
        .split("\r\n")
        .flat_map(|line| line.split('\n'))
        .flat_map(|line| line.split('\r'))
        .collect();
    while lines.last() == Some(&"") {
        lines.pop();
    }
    lines.join("\n")
}

/// Trim and collapse every run of whitespace into a single space.
fn collapse_whitespace(text: String) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
