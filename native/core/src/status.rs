//! The state of the working tree: what `git status --porcelain` reports, without the process.
//!
//! Three questions are answered here, and they have very different costs:
//!
//! - **How many things are uncommitted?** ([`count_changes`]) The graph needs only this to decide
//!   whether to draw the "Uncommitted Changes" row, and it is on the critical path of every view
//!   load, so it stops as soon as it has the count.
//! - **Which files are untracked or deleted?** ([`status_files`]) Neither is visible to a
//!   tree-to-tree diff, so the Commit Details view layers them on top of one.
//! - **What changed against a revision?** ([`uncommitted_changes`]) The full file list, combining
//!   the staged and unstaged sides.

use std::collections::BTreeMap;

use gix::bstr::ByteSlice;
use serde::Serialize;

use crate::error::{Result, ResultExt};
use crate::repository::Repo;
use crate::types::{GitFileChange, GitFileStatus, GitStatusFiles};

/// One path's state, as the two halves of a porcelain status code.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct PathState {
    /// The change between HEAD and the index (git's first column).
    staged: Option<GitFileStatus>,
    /// The change between the index and the working tree (git's second column).
    unstaged: Option<GitFileStatus>,
    untracked: bool,
    /// The index holds conflict stages for the path (a merge / rebase / cherry-pick stopped on
    /// it); git shows it as `UU` / `AA` / … and lists it under "Unmerged paths".
    conflicted: bool,
    /// The pre-rename path, when `staged` is `Renamed` — the current path (the map key) is the
    /// destination, so the source has to be carried separately.
    old_path: Option<String>,
}

/// Scan the working tree, collapsing every finding onto the path it concerns.
///
/// git prints one porcelain line per path however many ways that path changed, and the view counts
/// those lines, so the states are keyed by path here for the same reason.
///
/// `renames` picks how staged deletions and additions are paired: [`Renames::AsStatus`] follows the
/// configuration exactly as `git status` does, [`Renames::Always`] pairs them as
/// `git diff --find-renames` does whatever the configuration says.
fn scan(
    repo: &Repo,
    include_untracked: bool,
    renames: Renames,
) -> Result<BTreeMap<String, PathState>> {
    let git = repo.borrow();
    let mut states: BTreeMap<String, PathState> = BTreeMap::new();

    // A bare repository has no working tree, so nothing can be uncommitted in it.
    if git.workdir().is_none() {
        return Ok(states);
    }

    // `git status` pairs staged deletions and additions into renames unless `status.renames` (or,
    // when that is unset, `diff.renames`) turns it off — and then prints both halves, which the
    // count must see as two lines. Resolved here rather than left to gix's own reading of the keys,
    // which kept pairing renames with `status.renames=false` set.
    let renames_off = {
        let config = git.config_snapshot();
        config
            .boolean("status.renames")
            .or_else(|| config.boolean("diff.renames"))
            == Some(false)
    };
    let track_renames = match renames {
        Renames::AsStatus if renames_off => gix::status::tree_index::TrackRenames::Disabled,
        Renames::AsStatus => gix::status::tree_index::TrackRenames::AsConfigured,
        Renames::Always => {
            gix::status::tree_index::TrackRenames::Given(gix::diff::Rewrites::default())
        }
    };
    let platform = git
        .status(gix::progress::Discard)
        .git_ctx("Could not read the working tree status")?
        .tree_index_track_renames(track_renames)
        .untracked_files(if include_untracked {
            gix::status::UntrackedFiles::Files
        } else {
            gix::status::UntrackedFiles::None
        });

    let iter = platform
        .into_iter(None)
        .git_ctx("Could not read the working tree status")?;

    for item in iter {
        let item = item.git_ctx("Could not read the working tree status")?;
        match item {
            gix::status::Item::TreeIndex(change) => {
                let (path, status, old_path) = classify_staged(&change);
                let state = states.entry(path).or_default();
                state.staged = Some(status);
                if old_path.is_some() {
                    state.old_path = old_path;
                }
            }
            gix::status::Item::IndexWorktree(item) => {
                if let Some((path, status, untracked)) = classify_unstaged(&item) {
                    let state = states.entry(path).or_default();
                    state.unstaged = Some(status);
                    state.untracked |= untracked;
                    state.conflicted |= is_conflict(&item);
                }
            }
        }
    }

    Ok(states)
}

/// How [`scan`] pairs staged deletions and additions into renames.
#[derive(Clone, Copy)]
enum Renames {
    /// As `git status` does: `status.renames`, then `diff.renames`, may turn it off.
    AsStatus,
    /// As `git diff --find-renames` does, whatever the configuration.
    Always,
}

/// Returns the path, its status, and — for a rename — the source path it was renamed from.
fn classify_staged(change: &gix::diff::index::Change) -> (String, GitFileStatus, Option<String>) {
    use gix::diff::index::Change;
    match change {
        Change::Addition { location, .. } => (location.to_string(), GitFileStatus::Added, None),
        Change::Deletion { location, .. } => (location.to_string(), GitFileStatus::Deleted, None),
        Change::Modification { location, .. } => {
            (location.to_string(), GitFileStatus::Modified, None)
        }
        Change::Rewrite {
            location,
            source_location,
            ..
        } => (
            location.to_string(),
            GitFileStatus::Renamed,
            Some(source_location.to_string()),
        ),
    }
}

/// Whether an index-to-worktree finding is a path the index holds conflict stages for.
fn is_conflict(item: &gix::status::index_worktree::Item) -> bool {
    matches!(
        item,
        gix::status::index_worktree::Item::Modification {
            status: gix::status::plumbing::index_as_worktree::EntryStatus::Conflict { .. },
            ..
        }
    )
}

/// Classify one index-to-worktree finding, returning `None` for the ones that are not changes.
fn classify_unstaged(
    item: &gix::status::index_worktree::Item,
) -> Option<(String, GitFileStatus, bool)> {
    use gix::status::index_worktree::Item;
    use gix_status_types::Change as WorktreeChange;

    match item {
        Item::Modification {
            rela_path, status, ..
        } => {
            let path = rela_path.to_str_lossy().into_owned();
            match status {
                gix::status::plumbing::index_as_worktree::EntryStatus::Change(change) => {
                    match change {
                        WorktreeChange::Removed => Some((path, GitFileStatus::Deleted, false)),
                        // A submodule whose checked-out HEAD, worktree or untracked files differ
                        // from what the superproject records is a modification, just like git
                        // itself reports it (`git status` prints "modified: <path> (...)").
                        WorktreeChange::SubmoduleModification(_) => {
                            Some((path, GitFileStatus::Modified, false))
                        }
                        _ => Some((path, GitFileStatus::Modified, false)),
                    }
                }
                gix::status::plumbing::index_as_worktree::EntryStatus::Conflict { .. } => {
                    Some((path, GitFileStatus::Modified, false))
                }
                // `git add -N`: the index records the path with no content yet, and git lists it
                // as an addition the working tree has not staged (` A`).
                gix::status::plumbing::index_as_worktree::EntryStatus::IntentToAdd => {
                    Some((path, GitFileStatus::Added, false))
                }
                // `NeedsUpdate` means only the cached stat is stale; the content is unchanged, and
                // git would print nothing for it.
                _ => None,
            }
        }
        Item::DirectoryContents { entry, .. } => {
            if entry.status == gix::dir::entry::Status::Untracked {
                let mut path = entry.rela_path.to_str_lossy().into_owned();
                // Only a directory that cannot be expanded (a nested repository) is reported
                // whole, and git spells it with a trailing slash (`?? inner/`).
                if entry.disk_kind.is_some_and(|kind| kind.is_dir()) && !path.ends_with('/') {
                    path.push('/');
                }
                Some((path, GitFileStatus::Untracked, true))
            } else {
                None
            }
        }
        Item::Rewrite { dirwalk_entry, .. } => {
            let path = dirwalk_entry.rela_path.to_str_lossy().into_owned();
            Some((path, GitFileStatus::Renamed, false))
        }
    }
}

impl PathState {
    /// Removed from the index (`git rm --cached`) yet still on disk: git prints this path twice,
    /// once as the staged deletion (`D  path`) and once as untracked (`?? path`).
    fn deleted_and_untracked(&self) -> bool {
        self.untracked && self.staged == Some(GitFileStatus::Deleted)
    }
}

/// How many uncommitted changes are there?
///
/// This is the number of lines `git status --porcelain` would print, which is what the
/// "Uncommitted Changes (N)" row shows.
pub fn count_changes(repo: &Repo, include_untracked: bool) -> Result<usize> {
    Ok(scan(repo, include_untracked, Renames::AsStatus)?
        .values()
        .map(|state| 1 + usize::from(state.deleted_and_untracked()))
        .sum())
}

/// The untracked and deleted files of the working tree.
pub fn status_files(repo: &Repo, include_untracked: bool) -> Result<GitStatusFiles> {
    let states = scan(repo, include_untracked, Renames::AsStatus)?;
    let mut files = GitStatusFiles::default();
    for (path, state) in states {
        if state.staged == Some(GitFileStatus::Deleted)
            || state.unstaged == Some(GitFileStatus::Deleted)
        {
            files.deleted.push(path.clone());
        }
        if state.untracked {
            files.untracked.push(path);
        }
    }
    Ok(files)
}

/// The complete list of uncommitted file changes, staged and unstaged together.
///
/// The staged side wins when a path changed on both, because it describes the change relative to
/// HEAD — which is what the view is comparing against.
pub fn uncommitted_changes(repo: &Repo) -> Result<Vec<GitFileChange>> {
    // Renames are always paired here, as the CLI backend's `git diff --find-renames HEAD` pairs
    // them: the rename configuration only changes how `git status` lists them.
    let states = scan(repo, true, Renames::Always)?;
    let mut changes = Vec::with_capacity(states.len());
    for (path, state) in states {
        if state.deleted_and_untracked() {
            changes.push(GitFileChange {
                old_file_path: path.clone(),
                new_file_path: path.clone(),
                kind: GitFileStatus::Deleted,
                additions: None,
                deletions: None,
            });
        }
        let kind = if state.untracked {
            GitFileStatus::Untracked
        } else if let Some(staged) = state.staged {
            // A file staged as added and then deleted from the working tree is gone overall.
            if state.unstaged == Some(GitFileStatus::Deleted) {
                GitFileStatus::Deleted
            } else {
                staged
            }
        } else if let Some(unstaged) = state.unstaged {
            unstaged
        } else {
            continue;
        };

        let old_file_path = state.old_path.unwrap_or_else(|| path.clone());

        changes.push(GitFileChange {
            old_file_path,
            new_file_path: path,
            kind,
            additions: None,
            deletions: None,
        });
    }
    Ok(changes)
}

/// One path as the Source Control view lists it: the staged and unstaged halves of its change
/// kept apart (git's two porcelain columns), in the lowercase status names that view speaks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScmChange {
    pub path: String,
    pub old_path: Option<String>,
    pub staged: Option<&'static str>,
    pub unstaged: Option<&'static str>,
    pub untracked: bool,
    /// The path is unmerged (a merge, rebase or cherry-pick stopped on it): the Source Control
    /// view lists it under "Merge Changes" and opens it in the merge editor.
    pub conflicted: bool,
}

fn status_name(status: GitFileStatus) -> &'static str {
    match status {
        GitFileStatus::Added => "added",
        GitFileStatus::Modified => "modified",
        GitFileStatus::Deleted => "deleted",
        GitFileStatus::Renamed => "renamed",
        GitFileStatus::Untracked => "untracked",
    }
}

/// The working tree's changes as the Source Control view lists them, staged and unstaged halves
/// separate, so it can fill its two sections without a second read.
pub fn scm_changes(repo: &Repo) -> Result<Vec<ScmChange>> {
    let states = scan(repo, true, Renames::AsStatus)?;
    Ok(states
        .into_iter()
        .map(|(path, state)| ScmChange {
            path,
            old_path: state.old_path,
            staged: state.staged.map(status_name),
            unstaged: state.unstaged.map(status_name),
            untracked: state.untracked,
            conflicted: state.conflicted,
        })
        .collect())
}

/// Is anything uncommitted at all?
///
/// Cheaper than [`count_changes`] when only the yes/no answer is wanted, because it stops at the
/// first finding.
pub fn is_dirty(repo: &Repo) -> Result<bool> {
    let git = repo.borrow();
    git.is_dirty()
        .git_ctx("Could not read the working tree status")
}

/// The plumbing types the status items carry, re-exported under a short name for the matches above.
mod gix_status_types {
    pub use gix::status::plumbing::index_as_worktree::Change;
}
