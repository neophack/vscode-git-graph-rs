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

use crate::error::{Result, ResultExt};
use crate::repository::Repo;
use crate::types::{GitFileChange, GitFileStatus, GitStatusFiles};

/// One path's state, as the two halves of a porcelain status code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct PathState {
    /// The change between HEAD and the index (git's first column).
    staged: Option<GitFileStatus>,
    /// The change between the index and the working tree (git's second column).
    unstaged: Option<GitFileStatus>,
    untracked: bool,
}

/// Scan the working tree, collapsing every finding onto the path it concerns.
///
/// git prints one porcelain line per path however many ways that path changed, and the view counts
/// those lines, so the states are keyed by path here for the same reason.
fn scan(repo: &Repo, include_untracked: bool) -> Result<BTreeMap<String, PathState>> {
    let git = repo.borrow();
    let mut states: BTreeMap<String, PathState> = BTreeMap::new();

    // A bare repository has no working tree, so nothing can be uncommitted in it.
    if git.workdir().is_none() {
        return Ok(states);
    }

    let platform = git
        .status(gix::progress::Discard)
        .git_ctx("Could not read the working tree status")?
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
                let (path, status) = classify_staged(&change);
                states.entry(path).or_default().staged = Some(status);
            }
            gix::status::Item::IndexWorktree(item) => {
                if let Some((path, status, untracked)) = classify_unstaged(&item) {
                    let state = states.entry(path).or_default();
                    state.unstaged = Some(status);
                    state.untracked |= untracked;
                }
            }
        }
    }

    Ok(states)
}

fn classify_staged(change: &gix::diff::index::Change) -> (String, GitFileStatus) {
    use gix::diff::index::Change;
    match change {
        Change::Addition { location, .. } => (location.to_string(), GitFileStatus::Added),
        Change::Deletion { location, .. } => (location.to_string(), GitFileStatus::Deleted),
        Change::Modification { location, .. } => (location.to_string(), GitFileStatus::Modified),
        Change::Rewrite { location, .. } => (location.to_string(), GitFileStatus::Renamed),
    }
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
                        WorktreeChange::SubmoduleModification(_) => None,
                        _ => Some((path, GitFileStatus::Modified, false)),
                    }
                }
                gix::status::plumbing::index_as_worktree::EntryStatus::Conflict { .. } => {
                    Some((path, GitFileStatus::Modified, false))
                }
                // `NeedsUpdate` means only the cached stat is stale; the content is unchanged, and
                // git would print nothing for it.
                _ => None,
            }
        }
        Item::DirectoryContents { entry, .. } => {
            if entry.status == gix::dir::entry::Status::Untracked {
                let path = entry.rela_path.to_str_lossy().into_owned();
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

/// How many uncommitted changes are there?
///
/// This is the number of lines `git status --porcelain` would print, which is what the
/// "Uncommitted Changes (N)" row shows.
pub fn count_changes(repo: &Repo, include_untracked: bool) -> Result<usize> {
    Ok(scan(repo, include_untracked)?.len())
}

/// The untracked and deleted files of the working tree.
pub fn status_files(repo: &Repo, include_untracked: bool) -> Result<GitStatusFiles> {
    let states = scan(repo, include_untracked)?;
    let mut files = GitStatusFiles::default();
    for (path, state) in states {
        if state.untracked {
            files.untracked.push(path);
        } else if state.staged == Some(GitFileStatus::Deleted)
            || state.unstaged == Some(GitFileStatus::Deleted)
        {
            files.deleted.push(path);
        }
    }
    Ok(files)
}

/// The complete list of uncommitted file changes, staged and unstaged together.
///
/// The staged side wins when a path changed on both, because it describes the change relative to
/// HEAD — which is what the view is comparing against.
pub fn uncommitted_changes(repo: &Repo) -> Result<Vec<GitFileChange>> {
    let states = scan(repo, true)?;
    let mut changes = Vec::with_capacity(states.len());
    for (path, state) in states {
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

        changes.push(GitFileChange {
            old_file_path: path.clone(),
            new_file_path: path,
            kind,
            additions: None,
            deletions: None,
        });
    }
    Ok(changes)
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
