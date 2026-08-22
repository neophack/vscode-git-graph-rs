//! The Commit Details view: one commit in full, with the files it changed.

use crate::diff;
use crate::error::{Result, ResultExt};
use crate::repository::Repo;
use crate::types::{
    GitCommitDetails, GitCommitStash, GitFileStatus, GitSignature, GitSignatureStatus, UNCOMMITTED,
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
    Some(GitSignature {
        key: String::new(),
        signer: String::new(),
        status: GitSignatureStatus::CannotBeChecked,
    })
}
