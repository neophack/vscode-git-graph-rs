//! Single-file reads: the content of a file at one revision, and its unified diff.
//!
//! The Commit Details view lets the user open one file of a commit — either its full content at
//! that revision, or just the changes that commit made to it. The original extension spawned
//! `git show <hash>:<path>` and `git diff <parent> <hash> -- <path>` for each click; here both
//! answers come from the tree walk and blob-diff machinery the engine already uses.

use gix::diff::blob::unified_diff::{ConsumeHunk, ContextSize, DiffLineKind, HunkHeader};
use gix::diff::blob::{diff_with_slider_heuristics, Algorithm, InternedInput, UnifiedDiff};

use crate::diff;
use crate::error::{Error, Result, ResultExt};
use crate::repository::Repo;
use crate::types::CommitFile;

/// How far into a blob git looks before deciding it is binary: a NUL byte within the first 8000
/// bytes marks the blob binary, everything else is diffed as text.
const BINARY_SNIFF_LEN: usize = 8000;

/// The context lines shown around each hunk, matching `git diff`'s default of three.
const CONTEXT_LINES: u32 = 3;

/* ---------- File content at a revision ---------- */

/// Read one file of a commit's tree.
///
/// A file that is not valid UTF-8 cannot be handed to the webview as a string, so it is reported
/// as binary with `contents: None` — the view shows its "cannot display binary" presentation,
/// exactly as it does for the `git` backend's binary output.
pub fn commit_file(repo: &Repo, hash: &str, file_path: &str) -> Result<CommitFile> {
    let id = repo.resolve_commit(hash)?;
    let git = repo.borrow();
    let tree = git
        .find_commit(id)
        .git_ctx("Could not read the commit")?
        .tree()
        .git_ctx("Could not read the commit tree")?;

    let data = blob_at(&git, &tree, file_path)?
        .ok_or_else(|| Error::not_found(format!("'{file_path}' is not in commit {hash}")))?;

    // git's own notion of binary comes first: a NUL byte is valid UTF-8 but still not text a
    // user wants to read, so the sniff decides before the UTF-8 check does.
    if is_binary(&data) {
        return Ok(CommitFile {
            contents: None,
            binary: true,
        });
    }
    match String::from_utf8(data) {
        Ok(contents) => Ok(CommitFile {
            contents: Some(contents),
            binary: false,
        }),
        Err(_) => Ok(CommitFile {
            contents: None,
            binary: true,
        }),
    }
}

/// Read one file's raw bytes at a commit, whatever they are — unlike [`commit_file`], a binary
/// blob is not discarded. The byte-level comparison views (the hex viewer, the hex/image
/// comparison) need the original content precisely because it is not text.
///
/// `None` when the path does not exist in the commit's tree, which is how the missing side of
/// an added or deleted file reads: not an error, just nothing to show there.
pub fn commit_file_bytes(repo: &Repo, hash: &str, file_path: &str) -> Result<Option<Vec<u8>>> {
    let id = repo.resolve_commit(hash)?;
    let git = repo.borrow();
    let tree = git
        .find_commit(id)
        .git_ctx("Could not read the commit")?
        .tree()
        .git_ctx("Could not read the commit tree")?;
    blob_at(&git, &tree, file_path)
}

/* ---------- Single-file unified diff ---------- */

/* ---------- File content in the index ---------- */

/// Read one file's staged copy — what the index holds, between "Modified" and "Staged".
///
/// The same text/binary contract as [`commit_file`]: a blob that is binary or not valid UTF-8
/// comes back with `contents: None`.
pub fn index_file(repo: &Repo, file_path: &str) -> Result<CommitFile> {
    let git = repo.borrow();
    let index = git.index().git_ctx("Could not read the index")?;
    let entry = index
        .entry_by_path(file_path.as_bytes().into())
        .ok_or_else(|| Error::not_found(format!("'{file_path}' is not in the index")))?;

    let data = git
        .find_blob(entry.id)
        .git_ctx("Could not read the blob")?
        .data
        .to_vec();

    if is_binary(&data) {
        return Ok(CommitFile {
            contents: None,
            binary: true,
        });
    }
    match String::from_utf8(data) {
        Ok(contents) => Ok(CommitFile {
            contents: Some(contents),
            binary: false,
        }),
        Err(_) => Ok(CommitFile {
            contents: None,
            binary: true,
        }),
    }
}

/// The same as [`commit_file_bytes`], for the staged copy: `None` when the path is not in the
/// index.
pub fn index_file_bytes(repo: &Repo, file_path: &str) -> Result<Option<Vec<u8>>> {
    let git = repo.borrow();
    let index = git.index().git_ctx("Could not read the index")?;
    let Some(entry) = index.entry_by_path(file_path.as_bytes().into()) else {
        return Ok(None);
    };
    let data = git
        .find_blob(entry.id)
        .git_ctx("Could not read the blob")?
        .data
        .to_vec();
    Ok(Some(data))
}

/// The unified diff of one file between a commit and its first parent.
///
/// Mirrors `git diff <parent> <commit> -- <file>`: a file the commit renamed is diffed across the
/// rename (both the old and the new path match), a root commit is compared against the empty
/// tree, and a file the commit did not touch yields empty output rather than an error.
pub fn commit_file_diff(repo: &Repo, hash: &str, file_path: &str) -> Result<String> {
    // The tree diff already knows how the commit touched every path, including renames, so the
    // change record for this file is looked up rather than re-derived.
    let change = diff::diff_commit(repo, hash)?
        .into_iter()
        .find(|change| change.new_file_path == file_path || change.old_file_path == file_path);
    let Some(change) = change else {
        return Ok(String::new());
    };

    let id = repo.resolve_commit(hash)?;
    let git = repo.borrow();
    let commit = git.find_commit(id).git_ctx("Could not read the commit")?;
    let new_tree = commit.tree().git_ctx("Could not read the commit tree")?;
    let old_tree = match crate::repository::Shallow::of(&git)
        .parents(&commit)
        .first()
    {
        Some(&parent) => git
            .find_commit(parent)
            .git_ctx("Could not read the parent commit")?
            .tree()
            .git_ctx("Could not read the parent tree")?,
        // A root commit is diffed against the empty tree, which shows its files as added.
        None => git.empty_tree(),
    };

    let old_path = change.old_file_path.as_str();
    let new_path = change.new_file_path.as_str();
    let old_entry = file_entry_at(&old_tree, old_path)?;
    let new_entry = file_entry_at(&new_tree, new_path)?;
    let old_data = entry_data(&git, old_entry)?;
    let new_data = entry_data(&git, new_entry)?;

    // The same header git prints, with `/dev/null` standing in for a side that does not exist,
    // which is how additions and deletions are rendered.
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{old_path} b/{new_path}\n"));
    match (old_entry, new_entry) {
        (None, Some((mode, _))) => out.push_str(&format!("new file mode {}\n", octal(mode))),
        (Some((mode, _)), None) => out.push_str(&format!("deleted file mode {}\n", octal(mode))),
        (Some((old_mode, _)), Some((new_mode, _))) if old_mode != new_mode => {
            out.push_str(&format!(
                "old mode {}\nnew mode {}\n",
                octal(old_mode),
                octal(new_mode)
            ))
        }
        _ => {}
    }
    if change.kind == crate::types::GitFileStatus::Renamed {
        out.push_str(&format!("rename from {old_path}\nrename to {new_path}\n"));
    }

    // git decides "binary" and the diff algorithm per path: `.gitattributes` can mark a text file
    // `binary` / `-diff`, and `diff.algorithm` picks the algorithm (Myers unless configured). The
    // resource cache applies both; a gitlink is never binary, it diffs as its one-line summary.
    let (binary, algorithm) = match (old_entry, new_entry) {
        (Some((mode, _)), _) | (_, Some((mode, _))) if mode.is_commit() => {
            (false, Algorithm::Myers)
        }
        _ => diff_decision(&git, old_path, old_entry, new_path, new_entry)?,
    };
    if binary {
        out.push_str(&format!(
            "Binary files a/{old_path} and b/{new_path} differ\n"
        ));
        return Ok(out);
    }

    // A pure rename or mode change has no content difference, and git prints no `---`/`+++`
    // lines for it: the header above is the whole diff.
    if old_data.is_some() && old_data == new_data {
        return Ok(out);
    }
    let old = old_data.clone().unwrap_or_default();
    let new = new_data.clone().unwrap_or_default();
    out.push_str(&format!(
        "--- {}\n+++ {}\n",
        side_path('a', old_path, old_data.is_some()),
        side_path('b', new_path, new_data.is_some()),
    ));

    // `InternedInput` borrows the blobs, so they must outlive the diff; both are owned above.
    let input = InternedInput::new(old.as_slice(), new.as_slice());
    let computed = diff_with_slider_heuristics(algorithm, &input);
    UnifiedDiff::new(
        &computed,
        &input,
        HunkSink { out: &mut out },
        ContextSize::symmetrical(CONTEXT_LINES),
    )
    .consume()
    .git_ctx("Could not render the diff")?;

    Ok(out)
}

/// Look a path up in a tree and return its blob data, or `None` when the tree has no such file.
///
/// A path that resolves to a subtree (a directory) is not a file and reads as absent, which is
/// also how `git show <rev>:<dir>` fails.
fn blob_at(git: &gix::Repository, tree: &gix::Tree<'_>, path: &str) -> Result<Option<Vec<u8>>> {
    let entry = tree
        .lookup_entry(path.split('/'))
        .git_ctx("Could not look up the path in the tree")?;
    match entry {
        Some(entry) if entry.mode().is_blob() => {
            let data = git
                .find_blob(entry.id())
                .git_ctx("Could not read the blob")?
                .data
                .to_vec();
            Ok(Some(data))
        }
        _ => Ok(None),
    }
}

/// A path's non-directory entry in a tree — a blob, a symlink or a gitlink — as its mode and id.
fn file_entry_at(
    tree: &gix::Tree<'_>,
    path: &str,
) -> Result<Option<(gix::object::tree::EntryMode, gix::ObjectId)>> {
    let entry = tree
        .lookup_entry(path.split('/'))
        .git_ctx("Could not look up the path in the tree")?;
    Ok(entry
        .filter(|entry| !entry.mode().is_tree())
        .map(|entry| (entry.mode(), entry.id().detach())))
}

/// What one side of a diff contains: the blob, or for a gitlink the line git diffs in its place.
fn entry_data(
    git: &gix::Repository,
    entry: Option<(gix::object::tree::EntryMode, gix::ObjectId)>,
) -> Result<Option<Vec<u8>>> {
    match entry {
        None => Ok(None),
        Some((mode, id)) if mode.is_commit() => {
            Ok(Some(format!("Subproject commit {id}\n").into_bytes()))
        }
        Some((_, id)) => Ok(Some(
            git.find_blob(id)
                .git_ctx("Could not read the blob")?
                .data
                .to_vec(),
        )),
    }
}

/// A tree entry mode the way git's diff headers print it (`100644`, `100755`, `120000`, …).
fn octal(mode: gix::object::tree::EntryMode) -> String {
    format!("{:06o}", mode.value())
}

/// Whether git would diff this pair as binary, and with which algorithm — both read through the
/// diff resource cache, which honours `.gitattributes` (`binary`, `-diff`) and `diff.algorithm`.
fn diff_decision(
    git: &gix::Repository,
    old_path: &str,
    old: Option<(gix::object::tree::EntryMode, gix::ObjectId)>,
    new_path: &str,
    new: Option<(gix::object::tree::EntryMode, gix::ObjectId)>,
) -> Result<(bool, Algorithm)> {
    use gix::diff::blob::platform::prepare_diff::Operation;
    use gix::diff::blob::ResourceKind;

    let mut cache = git
        .diff_resource_cache_for_tree_diff()
        .git_ctx("Could not prepare the diff")?;
    cache.options.skip_internal_diff_if_external_is_configured = false;
    let null = gix::ObjectId::null(git.object_hash());
    // A missing side is a null id at the other side's path and kind, which the cache reads as
    // "no data" — the shape an addition or a deletion takes in a tree diff.
    let kind = |entry: Option<(gix::object::tree::EntryMode, gix::ObjectId)>| {
        entry
            .or(old)
            .or(new)
            .and_then(|(mode, _)| mode.kind().into())
            .unwrap_or(gix::object::tree::EntryKind::Blob)
    };
    cache
        .set_resource(
            old.map_or(null, |(_, id)| id),
            kind(old),
            old_path.into(),
            ResourceKind::OldOrSource,
            &git.objects,
        )
        .git_ctx("Could not read the old side of the diff")?;
    cache
        .set_resource(
            new.map_or(null, |(_, id)| id),
            kind(new),
            new_path.into(),
            ResourceKind::NewOrDestination,
            &git.objects,
        )
        .git_ctx("Could not read the new side of the diff")?;
    let prepared = cache.prepare_diff().git_ctx("Could not prepare the diff")?;
    Ok(match prepared.operation {
        Operation::InternalDiff { algorithm } => (false, algorithm),
        Operation::SourceOrDestinationIsBinary => (true, Algorithm::Myers),
        Operation::ExternalCommand { .. } => (false, Algorithm::Myers),
    })
}

/// The label a side of the diff carries: the path prefixed with the side's letter, or
/// `/dev/null` when that side does not exist (an addition or a deletion).
fn side_path(side: char, path: &str, present: bool) -> String {
    if present {
        format!("{side}/{path}")
    } else {
        "/dev/null".to_string()
    }
}

/// git's binary heuristic: a NUL byte early in the blob marks it binary.
fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(BINARY_SNIFF_LEN)].contains(&0)
}

/// Appends each hunk to the diff output in unified format.
struct HunkSink<'a> {
    out: &'a mut String,
}

/// One side of a hunk header, spelled the way `git diff` spells it: an empty side is `0,0`, and a
/// single line is written as its start alone (`+1`, not `+1,1`).
fn git_range(start: u32, len: u32) -> String {
    if len == 0 {
        "0,0".to_string()
    } else if len == 1 {
        start.to_string()
    } else {
        format!("{start},{len}")
    }
}

impl ConsumeHunk for HunkSink<'_> {
    type Out = ();

    fn consume_hunk(
        &mut self,
        header: HunkHeader,
        lines: &[(DiffLineKind, &[u8])],
    ) -> std::io::Result<()> {
        self.out.push_str(&format!(
            "@@ -{} +{} @@\n",
            git_range(header.before_hunk_start, header.before_hunk_len),
            git_range(header.after_hunk_start, header.after_hunk_len)
        ));
        for (kind, content) in lines {
            let prefix = match kind {
                DiffLineKind::Context => ' ',
                DiffLineKind::Add => '+',
                DiffLineKind::Remove => '-',
            };
            self.out.push(prefix);
            // The token bytes do not include the diff prefix; the newline is part of the token
            // except for a file that lacks a trailing one, where git prints the marker instead.
            if content.ends_with(b"\n") {
                self.out.push_str(&String::from_utf8_lossy(content));
            } else {
                self.out.push_str(&String::from_utf8_lossy(content));
                self.out.push_str("\n\\ No newline at end of file\n");
            }
        }
        Ok(())
    }

    fn finish(self) {}
}
