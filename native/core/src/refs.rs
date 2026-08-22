//! Reading the references a view load needs, in one pass.
//!
//! Refs dominate the cost of opening the view on a large repository — particularly a Gerrit one,
//! where the `changes/` tree of a remote can hold tens of thousands of refs. Two things keep this
//! affordable, and both are about *not* doing work:
//!
//! 1. **Names are filtered before any object is read.** A ref the view is not showing costs the
//!    price of a string comparison and nothing more.
//! 2. **Remote-tracking refs are never peeled.** Peeling means an object lookup per ref, several
//!    times the cost of the scan itself. Only tags — local ones, and the rare
//!    `refs/remotes/<remote>/tags/*` created by an explicit fetch refspec — are peeled, because
//!    only tags can point at something other than a commit.

use crate::error::{Result, ResultExt};
use crate::repository::Repo;
use crate::types::{GitRef, GitRefData, GitTagRef, RefReadOptions, RefSnapshot};

/// Read every ref the Git Graph View needs.
///
/// The result carries both the raw [`GitRefData`] the graph annotates commits with, and the branch
/// and tag name lists the dropdowns are populated from, so that `loadRepoInfo` and `loadCommits`
/// share a single scan.
pub fn read_refs(repo: &Repo, options: &RefReadOptions) -> Result<RefSnapshot> {
    let git = repo.borrow();
    let mut ref_data = GitRefData::default();
    let mut branches: Vec<String> = Vec::new();
    let mut tag_names: Vec<String> = Vec::new();

    /* HEAD */
    // A detached HEAD still resolves to a commit; an unborn branch (a fresh repository with no
    // commits) resolves to nothing, and the view renders an empty graph rather than an error.
    ref_data.head = git.head_id().ok().map(|id| id.detach().to_string());
    let branch_head = git.head_name().ok().flatten().and_then(|name| {
        name.as_bstr()
            .strip_prefix(b"refs/heads/".as_slice())
            .map(bstr_to_string)
    });

    /* Local branches */
    let platform = git.references().git_ctx("Could not read references")?;
    for reference in platform
        .prefixed("refs/heads/")
        .git_ctx("Could not read branches")?
        .filter_map(std::result::Result::ok)
    {
        let name = match reference
            .name()
            .as_bstr()
            .strip_prefix(b"refs/heads/".as_slice())
        {
            Some(name) => bstr_to_string(name),
            None => continue,
        };
        // Branches point straight at a commit, so the target is the hash: no object read needed.
        if let Some(hash) = direct_target(&reference) {
            ref_data.heads.push(GitRef {
                hash,
                name: name.clone(),
            });
            branches.push(name);
        }
    }

    /* Local tags */
    // Both records `git show-ref --tags -d` prints are reproduced: the tag ref itself, and — for an
    // annotated tag — the peeled record pointing at the commit. The graph attaches a tag label by
    // matching hashes, so an annotated tag only finds its commit through the peeled record.
    let platform = git.references().git_ctx("Could not read references")?;
    for mut reference in platform
        .prefixed("refs/tags/")
        .git_ctx("Could not read tags")?
        .filter_map(std::result::Result::ok)
    {
        let name = match reference
            .name()
            .as_bstr()
            .strip_prefix(b"refs/tags/".as_slice())
        {
            Some(name) => bstr_to_string(name),
            None => continue,
        };
        let Some(hash) = direct_target(&reference) else {
            continue;
        };
        ref_data.tags.push(GitTagRef {
            hash: hash.clone(),
            name: name.clone(),
            annotated: false,
        });
        tag_names.push(name.clone());

        if let Ok(peeled) = reference.peel_to_id() {
            let peeled = peeled.detach().to_string();
            if peeled != hash {
                ref_data.tags.push(GitTagRef {
                    hash: peeled,
                    name,
                    annotated: true,
                });
            }
        }
    }

    /* Remote-tracking refs */
    if options.show_remote_branches {
        read_remote_refs(&git, options, &mut ref_data, &mut branches)?;
    }

    /* The checked-out branch is listed first, as `git branch` lists it */
    if let Some(head) = &branch_head {
        if let Some(index) = branches.iter().position(|branch| branch == head) {
            if index != 0 {
                let name = branches.remove(index);
                branches.insert(0, name);
            }
        }
    }

    tag_names.sort();
    Ok(RefSnapshot {
        ref_data,
        branches,
        branch_head,
        tag_names,
    })
}

/// Scan `refs/remotes/`, the one unavoidably broad pass, and classify each ref.
fn read_remote_refs(
    git: &gix::Repository,
    options: &RefReadOptions,
    ref_data: &mut GitRefData,
    branches: &mut Vec<String>,
) -> Result<()> {
    // Refs that need peeling are collected and peeled at the end, so the common case — a
    // repository with no remote tag refs at all — pays nothing for them.
    let mut remote_tags_to_peel: Vec<(usize, String)> = Vec::new();

    let platform = git.references().git_ctx("Could not read references")?;
    for reference in platform
        .prefixed("refs/remotes/")
        .git_ctx("Could not read remote branches")?
        .filter_map(std::result::Result::ok)
    {
        let full_name = reference.name().as_bstr().to_string();
        let Some(remote_ref) = full_name.strip_prefix("refs/remotes/") else {
            continue;
        };

        if options
            .hide_remotes
            .iter()
            .any(|remote| remote_ref.starts_with(&format!("{remote}/")))
        {
            continue;
        }
        if !options.show_remote_heads && remote_ref.ends_with("/HEAD") {
            continue;
        }
        let Some(hash) = direct_target(&reference) else {
            continue;
        };

        if let Some(tags_index) = remote_ref.find("/tags/") {
            // `refs/remotes/<remote>/tags/<tag>` is displayed as the tag `<remote>/<tag>`.
            let name = format!(
                "{}/{}",
                &remote_ref[..tags_index],
                &remote_ref[tags_index + 6..]
            );
            remote_tags_to_peel.push((ref_data.tags.len(), full_name.clone()));
            ref_data.tags.push(GitTagRef {
                hash,
                name,
                annotated: false,
            });
        } else if remote_ref.contains("/changes/") {
            // A Gerrit change ref, shown as a remote branch ref when "Show Refs" is enabled (the
            // NoteDb meta refs never are). They are deliberately never offered as branches: a
            // Gerrit repository can hold tens of thousands of them, which would swamp the
            // Branches dropdown.
            if options.show_change_refs && !remote_ref.ends_with("/meta") {
                ref_data.remotes.push(GitRef {
                    hash,
                    name: remote_ref.to_string(),
                });
            }
        } else {
            ref_data.remotes.push(GitRef {
                hash,
                name: remote_ref.to_string(),
            });
            branches.push(format!("remotes/{remote_ref}"));
        }
    }

    /* Peel the (rare) remote tag refs, so that their commits carry the tag label */
    for (index, full_name) in remote_tags_to_peel {
        let Ok(Some(mut reference)) = git.try_find_reference(full_name.as_str()) else {
            continue;
        };
        let Ok(peeled) = reference.peel_to_id() else {
            continue;
        };
        let peeled = peeled.detach().to_string();
        if peeled != ref_data.tags[index].hash {
            let name = ref_data.tags[index].name.clone();
            ref_data.tags.push(GitTagRef {
                hash: peeled,
                name,
                annotated: true,
            });
        }
    }

    Ok(())
}

/// The object a ref points at, without following symbolic refs or reading any object.
///
/// Symbolic refs (`refs/remotes/<remote>/HEAD` is the common one) return `None`: the view shows
/// them only for the sake of the label, and the branch they alias is already listed in its own
/// right.
fn direct_target(reference: &gix::Reference<'_>) -> Option<String> {
    match reference.target() {
        gix::refs::TargetRef::Object(id) => Some(id.to_string()),
        gix::refs::TargetRef::Symbolic(_) => None,
    }
}

fn bstr_to_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
