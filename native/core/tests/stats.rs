//! The Statistics view's two reads, checked against what they're meant to reproduce:
//! `git shortlog -sne --all --no-merges` and `git log --all --format=%aI --no-merges` binned by
//! author-local weekday/hour.

#[macro_use]
mod common;

use git_graph_core::repository::Repo;
use git_graph_core::stats;

use common::TestRepo;

fn open(repo: &TestRepo) -> Repo {
    Repo::discover(repo.path()).expect("could not open the fixture repository")
}

#[test]
fn counts_commits_per_author_like_git_shortlog() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first"); // fixture default author
    repo.git(&[
        "commit",
        "--quiet",
        "--allow-empty",
        "--author=Bob <bob@example.com>",
        "-m",
        "by bob",
    ]);
    repo.git(&[
        "commit",
        "--quiet",
        "--allow-empty",
        "--author=Bob <bob@example.com>",
        "-m",
        "by bob again",
    ]);

    let engine = open(&repo);
    let stats = stats::author_stats(&engine).expect("author_stats failed");

    let bob = stats
        .iter()
        .find(|s| s.email == "bob@example.com")
        .expect("bob's commits must be counted");
    assert_eq!(bob.name, "Bob");
    assert_eq!(bob.commits, 2);

    // Sorted by commit count descending: bob (2 commits) before the fixture's single commit.
    assert_eq!(stats[0].email, "bob@example.com");
}

#[test]
fn excludes_merge_commits_from_the_author_count() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "base");
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    repo.commit_file("feature.txt", "f", "feature work");
    repo.git(&["checkout", "--quiet", "main"]);
    repo.commit_file("main.txt", "m", "main work");
    repo.git(&[
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        "merge feature",
        "feature",
    ]);

    let engine = open(&repo);
    let stats = stats::author_stats(&engine).expect("author_stats failed");
    // 4 real commits (base, feature work, main work) + the merge commit itself, which must be
    // excluded: --no-merges means the total across all authors is 3, not 4.
    let total: usize = stats.iter().map(|s| s.commits).sum();
    assert_eq!(total, 3, "the merge commit itself must not be counted");
}

#[test]
fn walks_refs_stash_matching_real_all_ref_coverage() {
    require_git!();
    // A stash creates a 2-parent "On <branch>: ..." commit (refs/stash's own target - a merge of
    // the base and an "index on ..." commit holding the staged state), plus that "index on ..."
    // commit itself, reachable only by walking refs/stash's parents (it has no ref of its own).
    // Verified directly against `git log --all --no-merges` before writing this test: the
    // "On <branch>: ..." tip is itself EXCLUDED by --no-merges (it has 2 parents), while the
    // "index on ..." commit survives (1 parent) - so of the two commits `refs/stash` newly makes
    // reachable, exactly one is counted. This pins that `stats::author_stats` walks refs/stash at
    // all (log::all_tips alone does not enumerate it - only stats::author_stats's extra merge-in
    // does), not that stashing conceptually "adds one commit".
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "base");
    repo.write("a.txt", "changed");
    repo.git(&["stash", "push", "--quiet", "-m", "the stash"]);

    let engine = open(&repo);
    let stats = stats::author_stats(&engine).expect("author_stats failed");
    let total: usize = stats.iter().map(|s| s.commits).sum();
    assert_eq!(
        total, 2,
        "base + the stash's non-merge \"index on ...\" commit"
    );
}

#[test]
fn bins_activity_by_the_committed_weekday_and_hour_digits_not_the_true_utc_instant() {
    require_git!();
    let repo = TestRepo::new();
    // 2024-01-01 was a Monday (weekday 1). The literal hour digit is 23, even though the +05:00
    // offset means the true UTC instant is already the next calendar day (2024-01-01T18:30Z -
    // still Monday, but 18:00, not 23:00). The printed digits, not the UTC instant, must win.
    repo.git(&[
        "commit",
        "--quiet",
        "--allow-empty",
        "--date=2024-01-01T23:30:00+05:00",
        "-m",
        "late commit",
    ]);

    let engine = open(&repo);
    let cells = stats::activity_heatmap(&engine).expect("activity_heatmap failed");

    let cell = cells
        .iter()
        .find(|c| c.weekday == 1 && c.hour == 23)
        .unwrap_or_else(|| panic!("expected a Monday/23:00 cell, got: {cells:?}"));
    assert_eq!(cell.count, 1);
}

#[test]
fn aggregates_two_commits_in_the_same_cell() {
    require_git!();
    let repo = TestRepo::new();
    for _ in 0..2 {
        repo.git(&[
            "commit",
            "--quiet",
            "--allow-empty",
            "--date=2024-01-01T10:00:00+00:00", // a Monday
            "-m",
            "same slot",
        ]);
    }

    let engine = open(&repo);
    let cells = stats::activity_heatmap(&engine).expect("activity_heatmap failed");
    let monday_ten = cells
        .iter()
        .find(|c| c.weekday == 1 && c.hour == 10)
        .expect("expected a Monday/10:00 cell");
    assert_eq!(monday_ten.count, 2);
}

#[test]
fn never_emits_a_zero_count_cell() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first");
    repo.commit_file("b.txt", "2", "second");

    let engine = open(&repo);
    let cells = stats::activity_heatmap(&engine).expect("activity_heatmap failed");
    assert!(cells.iter().all(|c| c.count > 0));
}
