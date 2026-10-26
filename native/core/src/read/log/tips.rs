//! Resolving the revisions a walk starts from: the view's tips and the full ref set.

use std::collections::HashSet;

use gix::ObjectId;

use crate::error::{Error, Result, ResultExt};
use crate::repository::Repo;

/// Resolve the revisions a view load starts its walk from.
///
/// Anything that does not resolve is skipped rather than failing the load: a stale branch name in
/// the view's saved state should not stop the graph from rendering.
pub fn resolve_tips(repo: &Repo, revisions: &[String]) -> Result<Vec<ObjectId>> {
    // Borrowed once for the whole list: a repository with a few hundred tags resolves a few
    // hundred revisions per view load, and each borrow would rebuild the object cache.
    let git = repo.borrow();
    let mut tips = Vec::new();
    let mut seen = HashSet::new();
    // An annotated tag contributes two revisions (the tag object and the commit it peels to), and
    // a branch and its remote-tracking counterpart usually contribute the same hash twice, so the
    // list is deduplicated before anything is resolved rather than after.
    let mut requested = HashSet::new();
    for revision in revisions {
        if !requested.insert(revision.as_str()) {
            continue;
        }
        if let Ok(id) = crate::repository::resolve_commit_in(&git, revision) {
            if seen.insert(id) {
                tips.push(id);
            }
        }
    }
    Ok(tips)
}

/// Every ref the graph walks from when the view is showing all branches.
pub fn all_tips(repo: &Repo, include_tags: bool, include_remotes: bool) -> Result<Vec<ObjectId>> {
    let git = repo.borrow();
    let mut tips = Vec::new();
    let mut seen = HashSet::new();

    let add = |id: ObjectId, tips: &mut Vec<ObjectId>, seen: &mut HashSet<ObjectId>| {
        if seen.insert(id) {
            tips.push(id);
        }
    };

    if let Ok(head) = git.head_id() {
        add(head.detach(), &mut tips, &mut seen);
    }

    let prefixes: &[&str] = match (include_tags, include_remotes) {
        (true, true) => &["refs/heads/", "refs/tags/", "refs/remotes/"],
        (true, false) => &["refs/heads/", "refs/tags/"],
        (false, true) => &["refs/heads/", "refs/remotes/"],
        (false, false) => &["refs/heads/"],
    };

    for prefix in prefixes {
        let platform = git.references().git_ctx("Could not read references")?;
        for mut reference in platform
            .prefixed(*prefix)
            .git_ctx("Could not read references")?
            .filter_map(std::result::Result::ok)
        {
            // Tags are peeled because a tag object is not a commit and cannot be walked from. A tag
            // can also name a tree or a blob, which `git log --all` passes over; handed to the
            // walk, it would fail the whole walk ("expected commit, got blob").
            if let Ok(id) = reference.peel_to_id() {
                let id = id.detach();
                let is_commit = git
                    .find_header(id)
                    .is_ok_and(|header| header.kind() == gix::object::Kind::Commit);
                if is_commit {
                    add(id, &mut tips, &mut seen);
                }
            }
        }
    }

    if tips.is_empty() {
        return Err(Error::not_found("The repository has no commits"));
    }
    Ok(tips)
}

/// The commit `refs/stash` points at, if a stash exists.
pub(crate) fn stash_tip(repo: &Repo) -> Option<ObjectId> {
    let git = repo.borrow();
    git.try_find_reference("refs/stash")
        .ok()
        .flatten()
        .and_then(|mut reference| reference.peel_to_id().ok())
        .map(|id| id.detach())
}
