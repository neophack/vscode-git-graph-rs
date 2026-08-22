//! Reading the stash.
//!
//! A stash is a commit that no branch points at, recorded in the reflog of `refs/stash`. The graph
//! shows one row per entry, so both halves are needed: the reflog supplies the `stash@{N}`
//! selector the Git commands take, and the commit object supplies everything the row renders.
//!
//! A stash commit's parents encode its structure: the first is the commit the stash was taken
//! from, the second is the index state, and a third — present only when `--include-untracked` was
//! used — is a tree of the untracked files. The view needs the first and the third.

use crate::error::Result;
use crate::repository::Repo;
use crate::types::GitStash;

/// Read every stash entry, newest first.
///
/// A repository with no stash has no `refs/stash` at all, which is not an error: it returns an
/// empty list, and the view simply shows no stash rows.
pub fn read_stashes(repo: &Repo) -> Result<Vec<GitStash>> {
    let git = repo.borrow();
    let Ok(Some(reference)) = git.try_find_reference("refs/stash") else {
        return Ok(Vec::new());
    };

    let mut platform = reference.log_iter();
    let Ok(Some(entries)) = platform.rev() else {
        return Ok(Vec::new());
    };

    let mut stashes = Vec::new();
    for (index, entry) in entries.enumerate() {
        let Ok(entry) = entry else { break };
        let hash = entry.new_oid;

        let Ok(commit) = git.find_commit(hash) else {
            continue;
        };
        let parents: Vec<gix::ObjectId> =
            commit.parent_ids().map(|parent| parent.detach()).collect();
        let Some(base) = parents.first() else {
            continue;
        };

        let Ok(author) = commit.author() else {
            continue;
        };
        let Ok(committer) = commit.committer() else {
            continue;
        };
        let Ok(message) = commit.message() else {
            continue;
        };

        stashes.push(GitStash {
            hash: hash.to_string(),
            base_hash: base.to_string(),
            // Only a stash taken with `--include-untracked` has the third parent.
            untracked_files_hash: parents.get(2).map(ToString::to_string),
            selector: format!("refs/stash@{{{index}}}"),
            author: author.name.to_string(),
            email: author.email.to_string(),
            date: committer.time().map(|time| time.seconds).unwrap_or(0),
            message: message.summary().to_string(),
        });
    }

    Ok(stashes)
}
