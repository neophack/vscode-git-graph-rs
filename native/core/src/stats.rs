//! The Statistics view's two reads: commits-per-author and the commit-activity heatmap.
//!
//! Both walk every commit reachable from `--all`'s real ref coverage (branches, tags,
//! remote-tracking, HEAD, *and* the stash - `refs/stash` is a plain ref under `refs/`, so real
//! `git --all` walks it too, even though `log::all_tips` alone does not enumerate it), excluding
//! merge commits, mirroring `git shortlog -sne --all --no-merges` and
//! `git log --all --format=%aI --no-merges` respectively - the CLI backend this engine path is
//! ported from, and which cross-backend tests assert stays in agreement with it.

use std::collections::HashMap;

use crate::error::{Result, ResultExt};
use crate::log::{all_tips, stash_tip};
use crate::repository::Repo;
use crate::types::{GitActivityCell, GitAuthorStat};

/// `all_tips` plus the stash tip (if any), deduplicated - the same merge `search_history`
/// performs, duplicated here rather than factored out so this module cannot change that
/// already-tested walk's behaviour.
fn all_tips_with_stash(repo: &Repo) -> Result<Vec<gix::ObjectId>> {
    let mut tips = all_tips(repo, true, true)?;
    if let Some(stash) = stash_tip(repo) {
        if !tips.contains(&stash) {
            tips.push(stash);
        }
    }
    Ok(tips)
}

/// Commit counts per author, across all refs, merge commits excluded - what
/// `git shortlog -sne --all --no-merges` aggregates into.
pub fn author_stats(repo: &Repo) -> Result<Vec<GitAuthorStat>> {
    let tips = all_tips_with_stash(repo)?;
    let git = repo.borrow();

    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    for info in git
        .rev_walk(tips.iter().copied())
        .all()
        .git_ctx("Could not walk the commit graph")?
    {
        let info = match info {
            Ok(info) => info,
            Err(_) => break,
        };
        let Ok(commit) = git.find_commit(info.id) else {
            continue;
        };
        // --no-merges: a commit with more than one parent is excluded.
        if commit.parent_ids().count() > 1 {
            continue;
        }
        let Ok(author) = commit.author() else {
            continue;
        };
        *counts
            .entry((author.name.to_string(), author.email.to_string()))
            .or_insert(0) += 1;
    }

    let mut stats: Vec<GitAuthorStat> = counts
        .into_iter()
        .map(|((name, email), commits)| GitAuthorStat {
            name,
            email,
            commits,
        })
        .collect();
    stats.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.name.cmp(&b.name)));
    Ok(stats)
}

/// Commit activity binned by each commit's AUTHOR-LOCAL weekday/hour, across all refs, merge
/// commits excluded - what `git log --all --format=%aI --no-merges` is binned into.
///
/// Deliberately computed from the author date's local civil components (`seconds + offset`,
/// decomposed as if that sum were itself a UTC instant) rather than the true UTC instant alone -
/// the same rule the ported TypeScript/CLI implementation applies to `%aI`'s printed digits, so a
/// commit made at 11pm in the author's timezone bins as "night" regardless of what time it was
/// for whoever happens to be viewing the graph.
pub fn activity_heatmap(repo: &Repo) -> Result<Vec<GitActivityCell>> {
    let tips = all_tips_with_stash(repo)?;
    let git = repo.borrow();

    let mut counts: HashMap<(u8, u8), usize> = HashMap::new();
    for info in git
        .rev_walk(tips.iter().copied())
        .all()
        .git_ctx("Could not walk the commit graph")?
    {
        let info = match info {
            Ok(info) => info,
            Err(_) => break,
        };
        let Ok(commit) = git.find_commit(info.id) else {
            continue;
        };
        if commit.parent_ids().count() > 1 {
            continue;
        }
        let Ok(author) = commit.author() else {
            continue;
        };
        let Ok(time) = author.time() else {
            continue;
        };

        let local_seconds = time.seconds + i64::from(time.offset);
        let days_since_epoch = local_seconds.div_euclid(86400);
        let hour = (local_seconds.rem_euclid(86400) / 3600) as u8;
        // 1970-01-01 (epoch day 0) was a Thursday (weekday 4 in the 0=Sunday scheme); +4 aligns
        // day 0 to weekday 4, and rem_euclid keeps the result in 0..7 for commits before 1970 too.
        let weekday = ((days_since_epoch + 4).rem_euclid(7)) as u8;

        *counts.entry((weekday, hour)).or_insert(0) += 1;
    }

    Ok(counts
        .into_iter()
        .map(|((weekday, hour), count)| GitActivityCell {
            weekday,
            hour,
            count,
        })
        .collect())
}
