//! The traversal: walking from the tips and reading the commits the page is cut from.

use gix::ObjectId;

use crate::cancel::Cancel;
use crate::error::{Result, ResultExt};
use crate::model::CommitRecord;
use crate::repository::{Repo, Shallow};
use crate::text::{self, CommitEncoding};

use super::filter::{commit_matches_author, rewrite_parents, touches_paths};
use super::window::{window_size, FILTERED_WALK_LIMIT};
use super::WalkResult;

#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    /// The maximum number of commits to return.
    pub limit: usize,
    /// Follow only the first parent of each merge.
    pub first_parent_only: bool,
    /// Keep only commits whose author name matches one of these (case-insensitive substring, as
    /// `git log --author` matches).
    pub authors: Option<Vec<String>>,
    /// Keep only commits that changed one of these repository-relative paths.
    pub filter_paths: Vec<String>,
    /// The request's cancellation state, checked every [`crate::cancel::CHECK_INTERVAL`]
    /// iterations; [`Cancel::none`] (the default) makes the walk uncancellable, as before.
    pub cancel: Cancel,
}

/// Walk from `tips`, answering the page of commits the view should render together with the
/// window the page was cut from (the incremental cache continues from that window).
pub fn walk_windowed(repo: &Repo, tips: &[ObjectId], options: &WalkOptions) -> Result<WalkResult> {
    if options.limit == 0 || tips.is_empty() {
        return Ok(WalkResult::default());
    }
    let git = repo.borrow();
    // An empty path and an empty author list are no filter at all, exactly as the CLI backend
    // reads them: it drops empty paths before `-- <paths>` and passes no `--author` for an empty
    // list. Taken literally they would instead filter out every empty commit and every commit.
    let filter_paths: Vec<String> = options
        .filter_paths
        .iter()
        .filter(|path| !path.is_empty())
        .cloned()
        .collect();
    let authors = options
        .authors
        .as_deref()
        .filter(|authors| !authors.is_empty());
    let filtering = !filter_paths.is_empty();
    // An author filter has the same problem as a path filter: matches can be sparse, so a fixed
    // window can run dry and silently return fewer commits than asked for (and hide "Load More"
    // even though more matches exist deeper in history) instead of searching until the page is
    // full, the way `git log --author` does.
    let searching = filtering || authors.is_some();

    // A filtered walk cannot know in advance how deep it must go to fill a page, so it walks until
    // the page is full (or the safety limit is hit) instead of taking a fixed window.
    let window = if searching {
        FILTERED_WALK_LIMIT
    } else {
        window_size(options.limit)
    };

    let mut platform =
        git.rev_walk(tips.iter().copied())
            .sorting(gix::revision::walk::Sorting::ByCommitTime(
                gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
            ));
    if options.first_parent_only {
        platform = platform.first_parent_only();
    }
    let walk = platform.all().git_ctx("Could not walk the commit graph")?;
    let shallow = Shallow::of(&git);

    let mut records: Vec<CommitRecord> = Vec::new();
    // While filtering, the parents of every commit the walk *reads* are kept, not just of the
    // ones it keeps: re-parenting a shown commit means tracing through the hidden commits
    // between it and its nearest shown ancestor, which requires their parents too.
    let mut visited_parents: Vec<(String, Vec<String>)> = Vec::new();
    let mut visited = 0usize;
    for info in walk {
        let info = match info {
            Ok(info) => info,
            // A missing object (a shallow clone's boundary, or a corrupt pack) truncates the walk
            // rather than failing the whole view.
            Err(_) => break,
        };
        visited += 1;
        if visited > window {
            break;
        }
        // The cancellation checkpoint (task 2.9): a relaxed flag read every CHECK_INTERVAL-th
        // commit, so a cancelled traversal unwinds promptly without costing the walk measurably.
        options.cancel.check(visited)?;

        let commit = match git.find_commit(info.id) {
            Ok(commit) => commit,
            Err(_) => continue,
        };

        // The filters judge a commit on its identity alone — author, parents, the object ids below
        // its tree — so the message and the dates of the commits about to be dropped are never
        // decoded. On a filtered walk through a large repository that is nearly every commit it
        // reads.
        if searching {
            let author_ok = match authors {
                Some(authors) => commit_matches_author(&commit, authors)?,
                None => true,
            };
            if filtering {
                visited_parents.push((
                    commit.id().detach().to_string(),
                    shallow
                        .parents(&commit)
                        .iter()
                        .map(ToString::to_string)
                        .collect(),
                ));
            }
            if !author_ok {
                continue;
            }
            if filtering
                && !touches_paths(
                    &git,
                    &commit,
                    &shallow,
                    &filter_paths,
                    options.first_parent_only,
                )?
            {
                continue;
            }
        }

        records.push(read_commit(&commit, &shallow)?);
        if searching && records.len() >= options.limit {
            break;
        }
    }

    if filtering {
        // History simplification: a commit whose parent was filtered out is re-parented onto its
        // nearest shown ancestor, so the graph stays connected instead of breaking into fragments.
        rewrite_parents(&mut records, &visited_parents);
    }

    // The page itself — the window ordered and cut — is derived by `read::graph`, which owns the
    // page assembly for every walk (full and incremental alike).
    Ok(WalkResult { window: records })
}

/// Read the fields the graph renders out of a commit object.
///
/// `shallow` is the repository's shallow boundary: a boundary commit is reported without parents,
/// as git reports it, rather than with parents that were never fetched.
pub fn read_commit(commit: &gix::Commit<'_>, shallow: &Shallow) -> Result<CommitRecord> {
    let author = commit
        .author()
        .git_ctx("Could not decode the commit author")?;
    let committer = commit
        .committer()
        .git_ctx("Could not decode the commit committer")?;
    let encoding = CommitEncoding::of(commit);

    Ok(CommitRecord {
        hash: commit.id().detach().to_string(),
        parents: shallow
            .parents(commit)
            .iter()
            .map(ToString::to_string)
            .collect(),
        author: encoding.decode(author.name),
        email: encoding.decode(author.email),
        // The graph's date column follows git's default and shows the *committer* date.
        date: committer.time().map(|time| time.seconds).unwrap_or(0),
        author_date: author.time().map(|time| time.seconds).unwrap_or(0),
        message: text::commit_subject(commit, &encoding),
    })
}
