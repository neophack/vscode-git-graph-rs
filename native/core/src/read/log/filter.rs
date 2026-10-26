//! The author and path filters, and the re-parenting that keeps a filtered history connected.

use std::collections::{HashMap, HashSet};

use gix::ObjectId;

use crate::error::{Result, ResultExt};
use crate::model::CommitRecord;
use crate::repository::Shallow;

/// `git log --author=<name>` runs as `--author=<name> <`, so the CLI backend matches a literal
/// "Name <" prefix of "Name <email>" rather than "Name" as a free-floating substring — without the
/// trailing "<", a name that is a textual prefix of another author's name (e.g. "Bob" inside
/// "Bobby <bobby@x.com>") would match commits it should not. This mirrors that exactly, case-
/// insensitively (case sensitivity is the one place this still deviates from a bare `git log`).
pub(super) fn commit_matches_author(commit: &gix::Commit<'_>, authors: &[String]) -> Result<bool> {
    let author = commit
        .author()
        .git_ctx("Could not decode the commit author")?;
    let haystack = format!("{} <{}>", author.name, author.email).to_lowercase();
    Ok(authors
        .iter()
        .any(|author| haystack.contains(&format!("{} <", author.to_lowercase()))))
}

/// Did this commit change anything below one of `paths`?
///
/// `git log -- <paths>` default history simplification judges a commit by the *filtered* tree: it
/// is shown only when it is not treesame to **any** parent. A merge that merely carries a branch's
/// changes in is treesame against that branch's side and stays out of the log, which is why the
/// comparison here runs against every parent rather than just the first — except under
/// `first_parent_only`, where the walk never reads the other parents and git judges the commit
/// against the first one alone (a merge that kept the second parent's version of a filtered path
/// still shows when its first parent changed it).
///
/// A root commit is compared against the empty tree, which is what makes the commit that first
/// added a file show up in its filtered history.
pub(super) fn touches_paths(
    git: &gix::Repository,
    commit: &gix::Commit<'_>,
    shallow: &Shallow,
    paths: &[String],
    first_parent_only: bool,
) -> Result<bool> {
    let tree = commit.tree().git_ctx("Could not read the commit tree")?;
    let mut parents = shallow.parents(commit).to_vec();
    if parents.is_empty() {
        return changes_paths(git, None, &tree, paths);
    }
    if first_parent_only {
        parents.truncate(1);
    }
    for parent in &parents {
        let parent_tree = git.find_commit(*parent).ok().and_then(|c| c.tree().ok());
        if !changes_paths(git, parent_tree.as_ref(), &tree, paths)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Does `tree` differ from `parent_tree` (nothing, when `None`) below any of `paths`?
fn changes_paths(
    git: &gix::Repository,
    parent_tree: Option<&gix::Tree<'_>>,
    tree: &gix::Tree<'_>,
    paths: &[String],
) -> Result<bool> {
    for path in paths {
        if changes_path(git, parent_tree, tree, path.trim_end_matches('/'))? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// An entry of a tree, as far as comparing two of them goes: the mode and the object id are the
/// whole of a tree entry's content.
type PathEntry = (gix::object::tree::EntryMode, ObjectId);

/// The entry named `component` in `tree`, if there is one.
fn entry_named(tree: &gix::Tree<'_>, component: &str) -> Option<PathEntry> {
    tree.find_entry(component)
        .map(|entry| (entry.mode(), entry.oid().to_owned()))
}

/// Does `tree` differ from `parent_tree` (nothing, when `None`) below `path`?
///
/// Trees are content-addressed: two entries with the same mode and object id are identical, and
/// for a directory that reaches all the way down — a matching subtree means everything below the
/// path is unchanged. Walking the two trees down the path's components and comparing entries
/// therefore answers the question without diffing them, and stops at the first component whose
/// entries agree, which for the commits a filtered walk drops — nearly all of them on a large
/// repository — is the first component. A per-commit tree diff instead touches every tree the
/// commit changed anywhere in the repository, which is what made filtered history unaffordable
/// there.
fn changes_path(
    git: &gix::Repository,
    parent_tree: Option<&gix::Tree<'_>>,
    tree: &gix::Tree<'_>,
    path: &str,
) -> Result<bool> {
    let mut components = path
        .split('/')
        .filter(|component| !component.is_empty())
        .peekable();
    if components.peek().is_none() {
        // An empty pathspec matches every location, so the question collapses to whether the trees
        // differ at all: identical root trees cannot hide a change below them.
        return Ok(parent_tree.map(|tree| tree.id) != Some(tree.id));
    }

    // The tree to keep looking the path up in on each side. `None` also covers "the path passes
    // through a file here, or through a directory that does not exist": in every one of those
    // cases the path itself cannot exist on that side, so lookups there simply stay empty.
    let mut here = Some(tree.clone());
    let mut there = parent_tree.cloned();

    let descend = |entry: Option<PathEntry>| -> Result<Option<gix::Tree<'_>>> {
        match entry {
            Some((mode, oid)) if mode.is_tree() => git
                .find_tree(oid)
                .git_ctx("Could not read the commit tree")
                .map(Some),
            _ => Ok(None),
        }
    };

    while let Some(component) = components.next() {
        let here_entry = here.as_ref().and_then(|tree| entry_named(tree, component));
        let there_entry = there.as_ref().and_then(|tree| entry_named(tree, component));

        // The entries below this component are identical — or equally absent — so nothing under
        // the path can differ, however different the rest of the repository is.
        if here_entry == there_entry {
            return Ok(false);
        }
        // The path's final component differs from its counterpart: the path itself changed.
        if components.peek().is_none() {
            return Ok(true);
        }
        here = descend(here_entry)?;
        there = descend(there_entry)?;
    }
    unreachable!("the loop returns on the final component")
}

/// Re-parent each commit onto its nearest ancestor that survived filtering.
///
/// This is what `git log --simplify-merges` does: without it, git prints the *original* parent
/// hashes of every shown commit, which point at commits that are themselves hidden, and the graph
/// renders as disconnected fragments.
///
/// `visited` holds the parents of every commit the walk read, in walk order, so that a chain of
/// several hidden commits can be traced through rather than just a single one.
pub(super) fn rewrite_parents(records: &mut [CommitRecord], visited: &[(String, Vec<String>)]) {
    let shown: HashSet<&str> = records.iter().map(|record| record.hash.as_str()).collect();

    // The walk is newest-first, so a commit's ancestors are always read after it. Resolving from
    // the oldest backwards means every lookup a commit needs is already resolved.
    let mut nearest: HashMap<&str, Vec<String>> = HashMap::new();
    for (hash, parents) in visited.iter().rev() {
        let mut resolved: Vec<String> = Vec::new();
        for parent in parents {
            if shown.contains(parent.as_str()) {
                if !resolved.contains(parent) {
                    resolved.push(parent.clone());
                }
            } else if let Some(ancestors) = nearest.get(parent.as_str()) {
                // The hidden parent's own nearest shown ancestors take its place.
                for ancestor in ancestors {
                    if !resolved.contains(ancestor) {
                        resolved.push(ancestor.clone());
                    }
                }
            }
        }
        nearest.insert(hash.as_str(), resolved);
    }

    for record in records.iter_mut() {
        if let Some(parents) = nearest.get(record.hash.as_str()) {
            record.parents = parents.clone();
        }
    }
}
