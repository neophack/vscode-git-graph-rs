//! Tree diffing: the file lists behind the Commit Details and Commit Comparison views.
//!
//! The original extension ran two `git diff` processes per commit — one for `--name-status` and
//! one for `--numstat` — and merged their output by path. Here one tree diff produces both the
//! statuses and the line counts, so the whole file list costs a single pass.

use crate::error::{Error, Result, ResultExt};
use crate::repository::Repo;
use crate::types::{GitFileChange, GitFileStatus, GitStatusFiles, UNCOMMITTED};

/// The similarity below which two files are no longer considered a rename. Matches git's default
/// (`-M50%`), so the rename detection the view shows agrees with the command line.
const RENAME_SIMILARITY: f32 = 0.5;

/// Diff two revisions.
///
/// `to` may be [`UNCOMMITTED`] or empty, which compares `from` against the working tree, as
/// `git diff <from>` does.
pub fn diff_revisions(repo: &Repo, from: &str, to: &str) -> Result<Vec<GitFileChange>> {
    if to.is_empty() || to == UNCOMMITTED {
        return diff_against_worktree(repo, from);
    }
    let from_id = repo.resolve_commit(from)?;
    let to_id = repo.resolve_commit(to)?;
    diff_commits(repo, Some(from_id), to_id)
}

/// Where a file has been renamed to between a commit and the working tree, or `None` when it has
/// not been renamed (or no longer exists).
///
/// This backs the code-review view's file tracking: when the reviewed file was renamed since the
/// revision under review, the review follows it to its new path rather than losing it.
///
/// A rename is recognised by the paths alone, rather than by the change's status: a file that was
/// renamed *and then modified in the working tree* is layered into a modification record by the
/// worktree overlay, but it still carries the pre-rename path on its old side — which is exactly
/// the rename this question asks about.
pub fn new_path_of_renamed_file(
    repo: &Repo,
    commit_hash: &str,
    old_file_path: &str,
) -> Result<Option<String>> {
    let changes = diff_revisions(repo, commit_hash, "")?;
    Ok(changes.into_iter().find_map(|change| {
        (change.old_file_path == old_file_path && change.new_file_path != old_file_path)
            .then_some(change.new_file_path)
    }))
}

/// The file changes a commit introduced, compared against its first parent.
///
/// A root commit is compared against the empty tree, which is how the commit that created a
/// repository shows its files as added rather than showing nothing at all.
pub fn diff_commit(repo: &Repo, hash: &str) -> Result<Vec<GitFileChange>> {
    let id = repo.resolve_commit(hash)?;
    let git = repo.borrow();
    let commit = git.find_commit(id).git_ctx("Could not read the commit")?;
    let parent = commit.parent_ids().next().map(|parent| parent.detach());
    diff_commits(repo, parent, id)
}

/// Diff the trees of two commits, `from` being `None` for the empty tree.
pub fn diff_commits(
    repo: &Repo,
    from: Option<gix::ObjectId>,
    to: gix::ObjectId,
) -> Result<Vec<GitFileChange>> {
    let git = repo.borrow();
    let to_tree = git
        .find_commit(to)
        .git_ctx("Could not read the commit")?
        .tree()
        .git_ctx("Could not read the commit tree")?;
    let from_tree = match from {
        Some(from) => git
            .find_commit(from)
            .git_ctx("Could not read the parent commit")?
            .tree()
            .git_ctx("Could not read the parent tree")?,
        None => git.empty_tree(),
    };

    collect_changes(&git, &from_tree, &to_tree)
}

/// Compare a revision against the working tree, as `git diff <revision>` does.
///
/// The tracked changes come from a tree diff, and the untracked and deleted files are layered on
/// top from the working-tree scan — the same two sources the original extension combined, because
/// neither alone describes an uncommitted state completely.
///
/// ### Deviation
///
/// A file modified in the working tree but not staged is listed, but without line counts: getting
/// those means hashing the worktree file, which costs more than the counts are worth on the
/// critical path of the view. Line counts for committed changes are exact.
fn diff_against_worktree(repo: &Repo, from: &str) -> Result<Vec<GitFileChange>> {
    let from_id = repo.resolve_commit(from)?;
    let head = repo.resolve_commit("HEAD").ok();

    // Everything committed between the revision and HEAD is a plain tree diff, with exact counts.
    let mut changes = match head {
        Some(head) if head != from_id => diff_commits(repo, Some(from_id), head)?,
        _ => Vec::new(),
    };

    // Everything uncommitted on top of HEAD is only visible to the working-tree scan.
    for change in crate::status::uncommitted_changes(repo)? {
        match changes
            .iter_mut()
            .find(|existing| existing.new_file_path == change.new_file_path)
        {
            // The file already differs from the revision; the worktree state decides how it reads
            // now, and the counts no longer describe the whole difference.
            Some(existing) => {
                existing.kind = change.kind;
                existing.additions = None;
                existing.deletions = None;
            }
            None => changes.push(change),
        }
    }

    Ok(changes)
}

/// Layer the untracked and deleted files of the working tree onto a diff.
///
/// A file deleted in the working tree but still in the index shows as deleted rather than
/// unchanged, and untracked files are appended — neither is visible to a tree-to-tree diff.
pub fn apply_worktree_status(changes: &mut Vec<GitFileChange>, status: &GitStatusFiles) {
    for path in &status.deleted {
        match changes
            .iter_mut()
            .find(|change| &change.new_file_path == path)
        {
            Some(change) => change.kind = GitFileStatus::Deleted,
            None => changes.push(GitFileChange {
                old_file_path: path.clone(),
                new_file_path: path.clone(),
                kind: GitFileStatus::Deleted,
                additions: None,
                deletions: None,
            }),
        }
    }
    for path in &status.untracked {
        changes.push(GitFileChange {
            old_file_path: path.clone(),
            new_file_path: path.clone(),
            kind: GitFileStatus::Untracked,
            additions: None,
            deletions: None,
        });
    }
}

/// Run one tree diff and turn every change into the record the view renders.
fn collect_changes(
    git: &gix::Repository,
    from_tree: &gix::Tree<'_>,
    to_tree: &gix::Tree<'_>,
) -> Result<Vec<GitFileChange>> {
    let mut changes = from_tree.changes().git_ctx("Could not diff the trees")?;
    changes.options(|options| {
        options.track_rewrites(Some(gix::diff::Rewrites {
            copies: None,
            percentage: Some(RENAME_SIMILARITY),
            ..Default::default()
        }));
    });

    // The resource cache holds the blob data the line counting reads, and is reused across every
    // file of the diff rather than being rebuilt per file.
    let mut cache = git
        .diff_resource_cache_for_tree_diff()
        .git_ctx("Could not prepare the diff")?;

    let mut collected: Vec<GitFileChange> = Vec::new();
    let outcome = changes.for_each_to_obtain_tree(to_tree, |change| {
        if let Some(mut record) = classify(&change) {
            // Binary files keep `None` counts, exactly as `git diff --numstat` prints `-` for them.
            if let Ok(mut platform) = change.diff(&mut cache) {
                if let Ok(Some(counts)) = platform.line_counts() {
                    record.additions = Some(counts.insertions);
                    record.deletions = Some(counts.removals);
                }
            }
            collected.push(record);
        }
        Ok::<_, std::convert::Infallible>(std::ops::ControlFlow::Continue(()))
    });
    outcome.map_err(|e| Error::git(format!("Could not diff the trees: {e}")))?;

    Ok(collected)
}

/// Turn one tree change into a file change record, or `None` for changes the view does not list.
fn classify(change: &gix::object::tree::diff::Change<'_, '_, '_>) -> Option<GitFileChange> {
    use gix::object::tree::diff::Change;

    let record = match change {
        Change::Addition {
            location,
            entry_mode,
            ..
        } => {
            // A directory becoming present is not a file change; only its entries are.
            if entry_mode.is_tree() {
                return None;
            }
            let path = location.to_string();
            GitFileChange {
                old_file_path: path.clone(),
                new_file_path: path,
                kind: GitFileStatus::Added,
                additions: None,
                deletions: None,
            }
        }
        Change::Deletion {
            location,
            entry_mode,
            ..
        } => {
            if entry_mode.is_tree() {
                return None;
            }
            let path = location.to_string();
            GitFileChange {
                old_file_path: path.clone(),
                new_file_path: path,
                kind: GitFileStatus::Deleted,
                additions: None,
                deletions: None,
            }
        }
        Change::Modification {
            location,
            entry_mode,
            ..
        } => {
            if entry_mode.is_tree() {
                return None;
            }
            let path = location.to_string();
            GitFileChange {
                old_file_path: path.clone(),
                new_file_path: path,
                kind: GitFileStatus::Modified,
                additions: None,
                deletions: None,
            }
        }
        Change::Rewrite {
            source_location,
            location,
            copy,
            ..
        } => {
            // A copy is reported by git as an addition unless `-C` was asked for, and the view
            // has no separate presentation for one.
            GitFileChange {
                old_file_path: source_location.to_string(),
                new_file_path: location.to_string(),
                kind: if *copy {
                    GitFileStatus::Added
                } else {
                    GitFileStatus::Renamed
                },
                additions: None,
                deletions: None,
            }
        }
    };
    Some(record)
}
