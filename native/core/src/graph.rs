//! Assembling the graph the view renders.
//!
//! This is where the pieces come together: the refs, the commit walk, the stashes and the working
//! tree state become one [`GitCommitData`] with every commit carrying the branch, tag and remote
//! labels that belong on it.
//!
//! The *lane* layout — which column a commit's dot sits in, and how the lines between them curve —
//! deliberately stays in the webview. It is a rendering decision that depends on the viewport, and
//! the engine's job ends at producing the commits and their parent relationships.

use std::collections::HashMap;

use crate::error::Result;
use crate::log::{self, WalkOptions};
use crate::refs::read_refs;
use crate::repository::Repo;
use crate::stash::read_stashes;
use crate::status;
use crate::types::{
    GitCommit, GitCommitData, GitCommitRemote, GitCommitStash, GitCommitTag, GitRefData,
    GitRepoInfo, GitStash, LogOptions, RefReadOptions, UNCOMMITTED,
};

/// Everything the view's `loadRepoInfo` request needs.
///
/// The branches and tags come from the same ref scan that the `loadCommits` request immediately
/// after this one needs, rather than from a `git branch -a` and a `git tag --list` that would each
/// walk the repository's refs all over again.
pub fn repo_info(
    repo: &Repo,
    ref_options: &RefReadOptions,
    show_stashes: bool,
) -> Result<GitRepoInfo> {
    let snapshot = read_refs(repo, ref_options).unwrap_or_default();
    let stashes = if show_stashes {
        read_stashes(repo).unwrap_or_default()
    } else {
        Vec::new()
    };

    Ok(GitRepoInfo {
        branches: snapshot.branches,
        head: snapshot.ref_data.head,
        remotes: repo.remote_names(),
        stashes,
        tags: snapshot.tag_names,
        error: None,
    })
}

/// Load a page of the graph.
pub fn load_commits(repo: &Repo, options: &LogOptions) -> Result<GitCommitData> {
    let ref_options = RefReadOptions {
        show_remote_branches: options.show_remote_branches,
        show_remote_heads: options.show_remote_heads,
        hide_remotes: options.hide_remotes.clone(),
        show_change_refs: options.gerrit_show_change_refs,
    };
    let snapshot = read_refs(repo, &ref_options).unwrap_or_default();
    let stashes = read_stashes(repo).unwrap_or_default();

    let tips = resolve_tips(repo, options, &snapshot.ref_data, &stashes)?;
    if tips.is_empty() {
        // A repository with no commits yet renders an empty graph rather than an error.
        return Ok(GitCommitData {
            head: snapshot.ref_data.head,
            ..Default::default()
        });
    }

    // One extra commit is requested so that the view can tell whether a "Load More" button is
    // needed, without a second query to find out.
    let walk_options = WalkOptions {
        limit: options.max_commits as usize + 1,
        ordering: options.commit_ordering,
        first_parent_only: options.only_follow_first_parent,
        authors: options.authors.clone(),
        filter_paths: options.filter_paths.clone(),
    };
    let mut records = log::walk(repo, &tips, &walk_options)?;

    let more_commits_available = records.len() > options.max_commits as usize;
    if more_commits_available {
        records.pop();
    }

    let mut commits: Vec<GitCommit> = records
        .into_iter()
        .map(|record| GitCommit {
            hash: record.hash,
            parents: record.parents,
            author: record.author,
            email: record.email,
            date: record.date,
            message: record.message,
            heads: Vec::new(),
            tags: Vec::new(),
            remotes: Vec::new(),
            stash: None,
        })
        .collect();

    insert_uncommitted_row(repo, options, &snapshot.ref_data, &mut commits)?;
    insert_stashes(&stashes, &mut commits);
    annotate_refs(&snapshot.ref_data, options, &mut commits);

    let mut tags: Vec<String> = Vec::new();
    for tag in &snapshot.ref_data.tags {
        if !tags.contains(&tag.name) {
            tags.push(tag.name.clone());
        }
    }

    Ok(GitCommitData {
        commits,
        head: snapshot.ref_data.head,
        tags,
        more_commits_available,
        error: None,
    })
}

/// The revisions the walk starts from.
fn resolve_tips(
    repo: &Repo,
    options: &LogOptions,
    ref_data: &GitRefData,
    stashes: &[GitStash],
) -> Result<Vec<gix::ObjectId>> {
    let mut revisions: Vec<String> = Vec::new();

    match &options.branches {
        // A specific set of branches is shown.
        Some(branches) => revisions.extend(branches.iter().cloned()),
        None => {
            // Show all: the local branches always, the tags and remote-tracking branches only when
            // the view is showing them.
            revisions.extend(ref_data.heads.iter().map(|head| head.hash.clone()));
            if options.show_tags && options.show_commits_only_referenced_by_tags {
                revisions.extend(ref_data.tags.iter().map(|tag| tag.hash.clone()));
            }
            if options.show_remote_branches {
                // Gerrit change refs are never walked from wholesale — a Gerrit repository holds
                // tens of thousands of them, and walking them all would bury the branches the user
                // actually asked to see. The ones the Gerrit integration selected are added below.
                revisions.extend(
                    ref_data
                        .remotes
                        .iter()
                        .filter(|remote| !remote.name.contains("/changes/"))
                        .map(|remote| remote.hash.clone()),
                );
            }
            // Stashes hang off commits that may not be reachable from any branch.
            for stash in stashes {
                revisions.push(stash.base_hash.clone());
            }
            revisions.push("HEAD".to_string());
        }
    }

    // The Gerrit change refs allowed through the filter are walked whether the view is showing all
    // refs or a specific set of branches.
    if let Some(gerrit_refs) = &options.gerrit_refs {
        revisions.extend(gerrit_refs.iter().cloned());
    }

    log::resolve_tips(repo, &revisions)
}

/// Add the "Uncommitted Changes" row above HEAD, when there is anything uncommitted.
///
/// The row is only added when HEAD is actually on screen: it is drawn as a child of HEAD, and a
/// child with no parent in the graph would render as a disconnected dot.
fn insert_uncommitted_row(
    repo: &Repo,
    options: &LogOptions,
    ref_data: &GitRefData,
    commits: &mut Vec<GitCommit>,
) -> Result<()> {
    if !options.show_uncommitted_changes || options.defer_uncommitted_changes {
        return Ok(());
    }
    let Some(head) = &ref_data.head else {
        return Ok(());
    };
    if !commits.iter().any(|commit| &commit.hash == head) {
        return Ok(());
    }

    let count = status::count_changes(repo, options.show_untracked_files)?;
    if count == 0 {
        return Ok(());
    }

    commits.insert(
        0,
        GitCommit {
            hash: UNCOMMITTED.to_string(),
            parents: vec![head.clone()],
            author: "*".to_string(),
            email: String::new(),
            date: now_seconds(),
            message: format!("Uncommitted Changes ({count})"),
            heads: Vec::new(),
            tags: Vec::new(),
            remotes: Vec::new(),
            stash: None,
        },
    );
    Ok(())
}

/// Attach the stashes to the graph.
///
/// A stash whose own commit is on screen is marked in place. One whose commit is not, but whose
/// base commit is, gets a row of its own inserted directly above that base — which is where the
/// user expects to see it, hanging off the commit it was taken from.
fn insert_stashes(stashes: &[GitStash], commits: &mut Vec<GitCommit>) {
    let lookup: HashMap<String, usize> = commits
        .iter()
        .enumerate()
        .map(|(index, commit)| (commit.hash.clone(), index))
        .collect();

    let mut to_insert: Vec<(usize, &GitStash)> = Vec::new();
    for stash in stashes {
        if let Some(&index) = lookup.get(&stash.hash) {
            commits[index].stash = Some(GitCommitStash {
                selector: stash.selector.clone(),
                base_hash: stash.base_hash.clone(),
                untracked_files_hash: stash.untracked_files_hash.clone(),
            });
        } else if let Some(&index) = lookup.get(&stash.base_hash) {
            to_insert.push((index, stash));
        }
    }

    // Several stashes can share a base commit; the newest is listed first, as git does. Inserting
    // from the bottom up keeps the earlier indices valid as the list grows.
    to_insert.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.date.cmp(&a.1.date)));
    for (index, stash) in to_insert.into_iter().rev() {
        commits.insert(
            index,
            GitCommit {
                hash: stash.hash.clone(),
                parents: vec![stash.base_hash.clone()],
                author: stash.author.clone(),
                email: stash.email.clone(),
                date: stash.date,
                message: stash.message.clone(),
                heads: Vec::new(),
                tags: Vec::new(),
                remotes: Vec::new(),
                stash: Some(GitCommitStash {
                    selector: stash.selector.clone(),
                    base_hash: stash.base_hash.clone(),
                    untracked_files_hash: stash.untracked_files_hash.clone(),
                }),
            },
        );
    }
}

/// Hang the branch, tag and remote labels on the commits they point at.
fn annotate_refs(ref_data: &GitRefData, options: &LogOptions, commits: &mut [GitCommit]) {
    let lookup: HashMap<&str, usize> = commits
        .iter()
        .enumerate()
        .map(|(index, commit)| (commit.hash.as_str(), index))
        .collect();
    // Cloned up front because the loops below borrow `commits` mutably.
    let lookup: HashMap<String, usize> = lookup
        .into_iter()
        .map(|(hash, index)| (hash.to_string(), index))
        .collect();

    for head in &ref_data.heads {
        if let Some(&index) = lookup.get(&head.hash) {
            commits[index].heads.push(head.name.clone());
        }
    }

    if options.show_tags {
        for tag in &ref_data.tags {
            if let Some(&index) = lookup.get(&tag.hash) {
                commits[index].tags.push(GitCommitTag {
                    name: tag.name.clone(),
                    annotated: tag.annotated,
                });
            }
        }
    }

    for remote in &ref_data.remotes {
        if let Some(&index) = lookup.get(&remote.hash) {
            // The ref name starts with the remote it belongs to, unless that remote has since been
            // removed and only its tracking refs are left behind.
            let owner = options
                .remotes
                .iter()
                .find(|name| remote.name.starts_with(&format!("{name}/")))
                .cloned();
            commits[index].remotes.push(GitCommitRemote {
                name: remote.name.clone(),
                remote: owner,
            });
        }
    }
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}
